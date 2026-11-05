import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config.js';
import { formatSignatureHeader } from '../src/common/security/webhook-signature.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';

/**
 * Runs against a real, migrated PostgreSQL database:
 *   TEST_DATABASE_URL=postgresql://... npx prisma migrate deploy && npm test
 * Skipped when TEST_DATABASE_URL is not set.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const KEY_ID = 'test_key_a';
const SECRET = 'k'.repeat(48);
const PROVIDER = 'payment_engine';
const ROUTE = '/api/v1/enrollments/sync';

type Body = Record<string, unknown>;

describe.skipIf(!TEST_DATABASE_URL)(`POST ${ROUTE} (e2e)`, () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let reactCourseId: string;
  let seq = 0;

  const nowSec = () => Math.floor(Date.now() / 1000);

  function post(body: Body | string, opts: { secret?: string; keyId?: string; timestamp?: number; signBody?: string } = {}) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const ts = String(opts.timestamp ?? nowSec());
    return request(app.getHttpServer())
      .post(ROUTE)
      .set('Content-Type', 'application/json')
      .set('X-LMS-Key-Id', opts.keyId ?? KEY_ID)
      .set('X-LMS-Timestamp', ts)
      .set('X-LMS-Signature', formatSignatureHeader(opts.secret ?? SECRET, ts, opts.signBody ?? raw))
      .send(raw);
  }

  function event(overrides: Partial<Body> = {}): Body {
    seq += 1;
    return {
      event_id: `evt_${seq}_${Date.now()}`,
      occurred_at: new Date().toISOString(),
      student: { external_id: 'cus_100', email: 'Jane.Doe@Example.com', full_name: 'Jane Doe' },
      enrollments: [{ action: 'GRANT', course_id: 'prod_react', expires_at: null, order_id: 'ord_1' }],
      ...overrides,
    };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.ENROLLMENT_WEBHOOK_PROVIDER = PROVIDER;
    process.env.ENROLLMENT_WEBHOOK_KEYS = `${KEY_ID}:${SECRET}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: ['error'] });
    configureApp(app, app.get<AppConfig>(APP_CONFIG));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE users, courses, webhook_events, outbox_messages, audit_logs RESTART IDENTITY CASCADE',
    );
    const react = await prisma.course.create({
      data: {
        slug: 'react-mastery',
        title: 'React Mastery',
        status: 'PUBLISHED',
        externalRefs: { create: [{ provider: PROVIDER, externalId: 'prod_react' }] },
      },
    });
    reactCourseId = react.id;
    await prisma.course.create({
      data: {
        slug: 'node-basics',
        title: 'Node Basics',
        externalRefs: { create: [{ provider: PROVIDER, externalId: 'prod_node' }] },
      },
    });
  });

  // ---------------------------------------------------------------- security

  describe('authentication', () => {
    it('rejects a wrong secret, unknown key id and missing headers with a generic 401', async () => {
      const res1 = await post(event(), { secret: 'w'.repeat(48) });
      const res2 = await post(event(), { keyId: 'unknown_key' });
      const res3 = await request(app.getHttpServer()).post(ROUTE).set('Content-Type', 'application/json').send('{}');
      for (const res of [res1, res2, res3]) {
        expect(res.status).toBe(401);
        expect(res.body.message).toBe('Invalid webhook signature');
      }
      expect(await prisma.user.count()).toBe(0);
    });

    it('rejects a body that differs from the signed bytes', async () => {
      const signed = event();
      const tampered = { ...signed, student: { external_id: 'cus_evil', email: 'evil@example.com' } };
      const res = await post(tampered, { signBody: JSON.stringify(signed) });
      expect(res.status).toBe(401);
    });

    it('rejects a captured request replayed after the tolerance window', async () => {
      const res = await post(event(), { timestamp: nowSec() - 3_600 });
      expect(res.status).toBe(401);
    });

    it('validates only after authenticating, and rejects smuggled fields', async () => {
      const body = event({ student: { external_id: 'cus_100', email: 'a@b.co', role: 'ADMIN' } });
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_PAYLOAD');
    });
  });

  // ------------------------------------------------------------ provisioning

  describe('provisioning', () => {
    it('creates a password-less student, the enrollment and all side records atomically', async () => {
      const body = event();
      const res = await post(body);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'processed',
        student: { created: true, linked_existing_account: false },
        enrollments: [{ course_id: 'prod_react', action: 'GRANT', outcome: 'CREATED', status: 'ACTIVE', expires_at: null }],
      });

      const user = await prisma.user.findUniqueOrThrow({
        where: { email: 'jane.doe@example.com' },
        include: { externalIdentities: true, enrollments: { include: { history: true } } },
      });
      expect(user).toMatchObject({ role: 'STUDENT', status: 'PENDING_ACTIVATION', passwordHash: null });
      expect(user.externalIdentities).toEqual([expect.objectContaining({ provider: PROVIDER, externalId: 'cus_100' })]);
      expect(user.enrollments[0]).toMatchObject({ courseId: reactCourseId, status: 'ACTIVE', source: 'WEBHOOK' });
      expect(user.enrollments[0]!.history).toHaveLength(1);

      const outbox = await prisma.outboxMessage.findMany({ orderBy: { createdAt: 'asc' } });
      expect(outbox.map((m) => m.type).sort()).toEqual(['auth.send_activation_email', 'enrollment.access_changed']);

      const ledger = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: body.event_id as string } });
      expect(ledger).toMatchObject({ status: 'PROCESSED', attempts: 1, keyId: KEY_ID });
      expect(await prisma.auditLog.count({ where: { actorType: 'WEBHOOK', entityId: user.id } })).toBe(1);
    });

    it('reuses the account for a returning customer without a second activation email', async () => {
      await post(event());
      const res = await post(
        event({ enrollments: [{ action: 'GRANT', course_id: 'prod_node', expires_at: '2030-01-01T00:00:00Z' }] }),
      );
      expect(res.body.student.created).toBe(false);
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.enrollment.count()).toBe(2);
      expect(await prisma.outboxMessage.count({ where: { type: 'auth.send_activation_email' } })).toBe(1);
    });

    it('links an existing LMS student by email, but never a staff account', async () => {
      await prisma.user.create({ data: { email: 'existing@example.com', status: 'ACTIVE', passwordHash: 'x' } });
      const linked = await post(event({ student: { external_id: 'cus_200', email: 'EXISTING@example.com' } }));
      expect(linked.status).toBe(200);
      expect(linked.body.student).toMatchObject({ created: false, linked_existing_account: true });

      await prisma.user.create({ data: { email: 'admin@example.com', role: 'ADMIN', status: 'ACTIVE' } });
      const refused = await post(event({ student: { external_id: 'cus_300', email: 'admin@example.com' } }));
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('PRIVILEGED_ACCOUNT_LINK_REFUSED');
      expect(await prisma.externalIdentity.count({ where: { externalId: 'cus_300' } })).toBe(0);
    });

    it('ignores an email change coming from the storefront', async () => {
      await post(event());
      const res = await post(event({ student: { external_id: 'cus_100', email: 'attacker@example.com' } }));
      expect(res.body.warnings).toContain('EMAIL_CHANGE_IGNORED');
      expect(await prisma.user.count({ where: { email: 'attacker@example.com' } })).toBe(0);
    });
  });

  // ------------------------------------------------------- access lifecycle

  describe('access lifecycle', () => {
    it('revokes on refund and ignores an older GRANT delivered late', async () => {
      const t0 = Date.now();
      const grant = event({ occurred_at: new Date(t0 - 60_000).toISOString() });
      const refund = event({
        occurred_at: new Date(t0).toISOString(),
        enrollments: [{ action: 'REVOKE', course_id: 'prod_react', reason: 'REFUND', order_id: 'ord_1' }],
      });
      const lateRetryOfOldGrant = event({ occurred_at: new Date(t0 - 30_000).toISOString() });

      await post(grant);
      const revoked = await post(refund);
      expect(revoked.body.enrollments[0]).toMatchObject({ outcome: 'UPDATED', status: 'REVOKED' });

      const stale = await post(lateRetryOfOldGrant);
      expect(stale.body.enrollments[0]).toMatchObject({ outcome: 'STALE_IGNORED', status: 'REVOKED' });

      const enrollment = await prisma.enrollment.findFirstOrThrow({ include: { history: { orderBy: { id: 'asc' } } } });
      expect(enrollment.status).toBe('REVOKED');
      expect(enrollment.statusReason).toBe('REFUND');
      expect(enrollment.history.map((h) => `${h.fromStatus ?? '-'}>${h.toStatus}`)).toEqual(['->ACTIVE', 'ACTIVE>REVOKED']);
    });

    it('suspends and later re-grants (e.g. chargeback won)', async () => {
      await post(event({ occurred_at: new Date(Date.now() - 20_000).toISOString() }));
      const suspended = await post(
        event({
          occurred_at: new Date(Date.now() - 10_000).toISOString(),
          enrollments: [{ action: 'SUSPEND', course_id: 'prod_react', reason: 'CHARGEBACK' }],
        }),
      );
      expect(suspended.body.enrollments[0].status).toBe('SUSPENDED');
      const regranted = await post(event());
      expect(regranted.body.enrollments[0]).toMatchObject({ outcome: 'UPDATED', status: 'ACTIVE' });
    });
  });

  // ------------------------------------------------- idempotency & failures

  describe('idempotency and failure handling', () => {
    it('answers a re-delivery with the stored result and writes nothing new', async () => {
      const body = event();
      const first = await post(body);
      // Same event, re-serialised differently and signed with a new timestamp.
      const second = await post(JSON.stringify(body, null, 2), { timestamp: nowSec() + 1 });

      expect(second.status).toBe(200);
      expect(second.body).toEqual({ ...first.body, status: 'duplicate' });
      expect(await prisma.enrollmentStatusHistory.count()).toBe(1);
      expect(await prisma.outboxMessage.count()).toBe(2);
    });

    it('rejects an event_id reused with a different payload', async () => {
      const body = event();
      await post(body);
      const res = await post({ ...body, enrollments: [{ action: 'REVOKE', course_id: 'prod_react', reason: 'REFUND' }] });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('EVENT_ID_REUSED');
      expect((await prisma.enrollment.findFirstOrThrow()).status).toBe('ACTIVE');
    });

    it('fails the whole event on an unknown course, then succeeds on retry once mapped', async () => {
      const body = event({
        enrollments: [
          { action: 'GRANT', course_id: 'prod_react', expires_at: null },
          { action: 'GRANT', course_id: 'prod_unknown', expires_at: null },
        ],
      });
      const failed = await post(body);
      expect(failed.status).toBe(422);
      expect(failed.body).toMatchObject({ error: 'UNKNOWN_COURSE', course_ids: ['prod_unknown'] });
      expect(await prisma.user.count()).toBe(0); // nothing partial
      expect(await prisma.webhookEvent.findFirstOrThrow()).toMatchObject({ status: 'FAILED', attempts: 1 });

      await prisma.courseExternalRef.create({ data: { provider: PROVIDER, externalId: 'prod_unknown', courseId: reactCourseId } });
      const retried = await post(body);
      // Both external ids now map to the same course: the second GRANT is a no-op.
      expect(retried.status).toBe(200);
      expect(retried.body.enrollments.map((e: { outcome: string }) => e.outcome)).toEqual(['CREATED', 'UNCHANGED']);
      expect(await prisma.webhookEvent.findFirstOrThrow()).toMatchObject({ status: 'PROCESSED', attempts: 2 });
    });

    it('applies concurrent duplicate deliveries exactly once', async () => {
      const body = event();
      const responses = await Promise.all(Array.from({ length: 6 }, () => post(body)));

      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
      const statuses = responses.map((r) => r.body.status).sort();
      expect(statuses.filter((s) => s === 'processed')).toHaveLength(1);
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.enrollment.count()).toBe(1);
      expect(await prisma.enrollmentStatusHistory.count()).toBe(1);
    });

    it('serialises different concurrent events for the same new student', async () => {
      const a = event({ enrollments: [{ action: 'GRANT', course_id: 'prod_react', expires_at: null }] });
      const b = event({ enrollments: [{ action: 'GRANT', course_id: 'prod_node', expires_at: null }] });
      const [ra, rb] = await Promise.all([post(a), post(b)]);

      expect([ra.status, rb.status]).toEqual([200, 200]);
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.enrollment.count()).toBe(2);
      expect([ra.body.student.created, rb.body.student.created].sort()).toEqual([false, true]);
    });
  });
});
