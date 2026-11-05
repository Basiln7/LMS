import {
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { sha256Hex } from '../../../common/security/webhook-signature.js';
import { Prisma } from '../../../generated/prisma/client.js';
import type { WebhookEvent } from '../../../generated/prisma/client.js';
import { PrismaService, type PrismaTx } from '../../../infrastructure/prisma/prisma.service.js';
import { type AccessCommand, type EnrollmentStatus, decideAccessTransition } from '../domain/access-transition.js';
import { EventPayloadMismatchError, IdentityConflictError, UnknownCourseError } from './enrollment-sync.errors.js';
import type { EnrollmentSyncItem, EnrollmentSyncPayload } from './enrollment-sync.schema.js';
import type { WebhookAuthContext } from './enrollment-webhook.guard.js';

export type ItemOutcome = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'STALE_IGNORED';

export interface EnrollmentItemResult {
  course_id: string;
  action: EnrollmentSyncItem['action'];
  outcome: ItemOutcome;
  enrollment_id: string;
  status: EnrollmentStatus;
  expires_at: string | null;
}

export interface EnrollmentSyncResult {
  event_id: string;
  status: 'processed' | 'duplicate';
  student: { id: string; created: boolean; linked_existing_account: boolean };
  enrollments: EnrollmentItemResult[];
  warnings: string[];
}

interface StudentResolution {
  userId: string;
  created: boolean;
  linked: boolean;
  warnings: string[];
}

interface ItemContext {
  userId: string;
  courseId: string;
  item: EnrollmentSyncItem;
  occurredAt: Date;
  now: Date;
  webhookEventId: string;
}

type EventKey = { provider_eventId: { provider: string; eventId: string } };

/** Outbox message types consumed by background workers. */
export const OUTBOX = {
  sendActivationEmail: 'auth.send_activation_email',
  enrollmentAccessChanged: 'enrollment.access_changed',
} as const;

/**
 * Applies an enrollment sync event from the payment platform.
 *
 * Guarantees
 *  - Idempotent: (provider, event_id) is applied at most once; re-deliveries get
 *    the stored result back. Reusing an event_id with different content → 409.
 *  - Atomic: student, enrollments, history, audit, outbox and the event ledger
 *    commit together or not at all. Unknown course ids fail the whole event.
 *  - Race-free: concurrent events for the same student are serialised with
 *    transaction-scoped advisory locks, so "find or create" cannot duplicate.
 *  - Order-tolerant: events older than the newest applied change are ignored
 *    per enrollment (see decideAccessTransition).
 *  - Least privilege: the webhook can only create STUDENT accounts without a
 *    password, never changes a login email, and never links to staff accounts.
 */
@Injectable()
export class EnrollmentSyncService {
  private readonly logger = new Logger(EnrollmentSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sync(payload: EnrollmentSyncPayload, auth: WebhookAuthContext): Promise<EnrollmentSyncResult> {
    const provider = this.config.enrollmentWebhook.provider;
    const eventKey: EventKey = { provider_eventId: { provider, eventId: payload.event_id } };
    // Fingerprint of the *parsed* payload, so a sender re-serialising the same
    // event (different whitespace / key order / timestamp header) still matches.
    const fingerprint = sha256Hex(JSON.stringify(payload));

    // Fast path: most re-deliveries are answered without taking any lock.
    const previous = await this.prisma.webhookEvent.findUnique({ where: eventKey });
    const replay = this.replayOf(previous, fingerprint);
    if (replay) return replay;

    try {
      const courseIds = await this.resolveCourses(
        provider,
        payload.enrollments.map((e) => e.course_id),
      );
      return await this.prisma.$transaction(
        (tx) => this.applyEvent(tx, { provider, eventKey, fingerprint, payload, auth, courseIds }),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5_000,
          timeout: 15_000,
        },
      );
    } catch (error) {
      if (error instanceof EventPayloadMismatchError) throw error;
      await this.recordFailure({ provider, payload, auth, fingerprint, error });
      throw this.toHttpError(error, payload.event_id);
    }
  }

  // ---------------------------------------------------------------------------

  private async applyEvent(
    tx: PrismaTx,
    args: {
      provider: string;
      eventKey: EventKey;
      fingerprint: string;
      payload: EnrollmentSyncPayload;
      auth: WebhookAuthContext;
      courseIds: Map<string, string>;
    },
  ): Promise<EnrollmentSyncResult> {
    const { provider, eventKey, fingerprint, payload, auth, courseIds } = args;

    await this.lockStudent(tx, provider, payload.student);

    // Re-check under the lock: a concurrent delivery of this event may have just committed.
    const existing = await tx.webhookEvent.findUnique({ where: eventKey });
    const replay = this.replayOf(existing, fingerprint);
    if (replay) return replay;

    // PROCESSING is only ever visible inside this transaction; it commits as PROCESSED.
    const event = await tx.webhookEvent.upsert({
      where: eventKey,
      create: {
        provider,
        eventId: payload.event_id,
        keyId: auth.keyId,
        payloadSha256: fingerprint,
        occurredAt: payload.occurred_at,
        status: 'PROCESSING',
      },
      update: { status: 'PROCESSING', attempts: { increment: 1 }, keyId: auth.keyId, lastError: null },
      select: { id: true },
    });

    const now = new Date();
    const student = await this.resolveStudent(tx, provider, payload.student);

    const results: EnrollmentItemResult[] = [];
    for (const item of payload.enrollments) {
      const courseId = courseIds.get(item.course_id);
      if (!courseId) throw new UnknownCourseError([item.course_id]); // unreachable: resolved up-front
      results.push(
        await this.applyItem(tx, {
          userId: student.userId,
          courseId,
          item,
          occurredAt: payload.occurred_at,
          now,
          webhookEventId: event.id,
        }),
      );
    }

    if (student.created) {
      // The student chooses their own password through a one-time link. The
      // worker mints the token at send time, so no plaintext token is ever stored.
      await tx.outboxMessage.create({
        data: { type: OUTBOX.sendActivationEmail, payload: { userId: student.userId } },
      });
    }

    const changedCourseIds = results
      .filter((r) => r.outcome === 'CREATED' || r.outcome === 'UPDATED')
      .flatMap((r) => courseIds.get(r.course_id) ?? []);
    if (changedCourseIds.length > 0) {
      // Lets workers drop cached entitlements and end live playback for revoked courses.
      await tx.outboxMessage.create({
        data: {
          type: OUTBOX.enrollmentAccessChanged,
          payload: { userId: student.userId, courseIds: changedCourseIds },
        },
      });
    }

    await tx.auditLog.create({
      data: {
        actorType: 'WEBHOOK',
        actorId: auth.keyId,
        action: 'enrollment.sync',
        entityType: 'user',
        entityId: student.userId,
        ipAddress: auth.sourceIp ?? null,
        metadata: {
          eventId: payload.event_id,
          studentCreated: student.created,
          items: results.map((r) => ({ course: r.course_id, action: r.action, outcome: r.outcome })),
        },
      },
    });

    const result: EnrollmentSyncResult = {
      event_id: payload.event_id,
      status: 'processed',
      student: { id: student.userId, created: student.created, linked_existing_account: student.linked },
      enrollments: results,
      warnings: student.warnings,
    };

    await tx.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', result: result as unknown as Prisma.InputJsonObject, processedAt: now },
    });

    return result;
  }

  /**
   * Serialises concurrent events for the same person (e.g. a purchase and an
   * upsell fired together). Locks are released automatically on COMMIT /
   * ROLLBACK and taken in sorted order so two transactions cannot deadlock.
   */
  private async lockStudent(tx: PrismaTx, provider: string, student: EnrollmentSyncPayload['student']) {
    const keys = [`enrollment-sync:email:${student.email}`, `enrollment-sync:ext:${provider}:${student.external_id}`].sort();
    for (const key of keys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }
  }

  /**
   * Finds or creates the LMS account for the external customer.
   *  1. Known external id → that user (email changes from the storefront are ignored).
   *  2. Same email, not yet linked → link it (students only).
   *  3. Otherwise → new STUDENT, PENDING_ACTIVATION, no password.
   */
  private async resolveStudent(
    tx: PrismaTx,
    provider: string,
    student: EnrollmentSyncPayload['student'],
  ): Promise<StudentResolution> {
    const identity = await tx.externalIdentity.findUnique({
      where: { provider_externalId: { provider, externalId: student.external_id } },
      select: { user: { select: { id: true, email: true, fullName: true, phone: true } } },
    });
    if (identity) {
      const warnings: string[] = [];
      if (identity.user.email !== student.email) {
        // The login email is the account identity. Changing it from an
        // unverified storefront field would enable account takeover.
        warnings.push('EMAIL_CHANGE_IGNORED');
      }
      await this.fillMissingProfile(tx, identity.user, student);
      return { userId: identity.user.id, created: false, linked: false, warnings };
    }

    const byEmail = await tx.user.findUnique({
      where: { email: student.email },
      select: {
        id: true,
        role: true,
        fullName: true,
        phone: true,
        externalIdentities: { where: { provider }, select: { id: true } },
      },
    });
    if (byEmail) {
      if (byEmail.externalIdentities.length > 0) {
        throw new IdentityConflictError('EMAIL_LINKED_TO_ANOTHER_CUSTOMER');
      }
      if (byEmail.role !== 'STUDENT') {
        throw new IdentityConflictError('PRIVILEGED_ACCOUNT_LINK_REFUSED');
      }
      await tx.externalIdentity.create({
        data: { userId: byEmail.id, provider, externalId: student.external_id },
      });
      await this.fillMissingProfile(tx, byEmail, student);
      return { userId: byEmail.id, created: false, linked: true, warnings: [] };
    }

    const created = await tx.user.create({
      data: {
        email: student.email,
        fullName: student.full_name ?? null,
        phone: student.phone ?? null,
        role: 'STUDENT',
        status: 'PENDING_ACTIVATION',
        passwordHash: null,
        externalIdentities: { create: { provider, externalId: student.external_id } },
      },
      select: { id: true },
    });
    return { userId: created.id, created: true, linked: false, warnings: [] };
  }

  /** Only fills blanks: the student's own profile edits always win. */
  private async fillMissingProfile(
    tx: PrismaTx,
    user: { id: string; fullName: string | null; phone: string | null },
    student: EnrollmentSyncPayload['student'],
  ): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    if (!user.fullName && student.full_name) data.fullName = student.full_name;
    if (!user.phone && student.phone) data.phone = student.phone;
    if (Object.keys(data).length > 0) {
      await tx.user.update({ where: { id: user.id }, data });
    }
  }

  private async applyItem(tx: PrismaTx, ctx: ItemContext): Promise<EnrollmentItemResult> {
    const { item, userId, courseId, occurredAt, now, webhookEventId } = ctx;

    const current = await tx.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { id: true, status: true, expiresAt: true, lastAccessEventAt: true },
    });

    const command: AccessCommand =
      item.action === 'GRANT'
        ? { action: 'GRANT', expiresAt: item.expires_at, occurredAt }
        : { action: item.action, occurredAt };
    const decision = decideAccessTransition(current, command, now);

    const toResult = (id: string, status: EnrollmentStatus, expiresAt: Date | null, outcome: ItemOutcome) => ({
      course_id: item.course_id,
      action: item.action,
      outcome,
      enrollment_id: id,
      status,
      expires_at: expiresAt?.toISOString() ?? null,
    });

    if (!current) {
      if (decision.outcome === 'STALE_IGNORED') throw new Error('Invariant violated: stale decision without state');
      const created = await tx.enrollment.create({
        data: {
          userId,
          courseId,
          status: decision.status,
          source: 'WEBHOOK',
          accessStartsAt: now,
          expiresAt: decision.expiresAt,
          statusReason: item.reason,
          statusChangedAt: now,
          externalOrderId: item.order_id ?? null,
          lastAccessEventAt: occurredAt,
          history: {
            create: {
              fromStatus: null,
              toStatus: decision.status,
              toExpiresAt: decision.expiresAt,
              reason: item.reason,
              source: 'WEBHOOK',
              webhookEventId,
              note: item.note ?? null,
            },
          },
        },
        select: { id: true },
      });
      return toResult(created.id, decision.status, decision.expiresAt, 'CREATED');
    }

    if (decision.outcome === 'STALE_IGNORED') {
      this.logger.log(`Ignored out-of-order ${item.action} for enrollment ${current.id}`);
      return toResult(current.id, current.status, current.expiresAt, 'STALE_IGNORED');
    }

    const changed = decision.outcome === 'UPDATED';
    await tx.enrollment.update({
      where: { id: current.id },
      data: {
        lastAccessEventAt: occurredAt,
        ...(item.order_id ? { externalOrderId: item.order_id } : {}),
        ...(changed
          ? {
              status: decision.status,
              expiresAt: decision.expiresAt,
              statusReason: item.reason,
              statusChangedAt: now,
              source: 'WEBHOOK',
              history: {
                create: {
                  fromStatus: current.status,
                  toStatus: decision.status,
                  fromExpiresAt: current.expiresAt,
                  toExpiresAt: decision.expiresAt,
                  reason: item.reason,
                  source: 'WEBHOOK',
                  webhookEventId,
                  note: item.note ?? null,
                },
              },
            }
          : {}),
      },
    });
    return toResult(current.id, decision.status, decision.expiresAt, decision.outcome);
  }

  private async resolveCourses(provider: string, externalIds: string[]): Promise<Map<string, string>> {
    const refs = await this.prisma.courseExternalRef.findMany({
      where: { provider, externalId: { in: externalIds } },
      select: { externalId: true, courseId: true },
    });
    const map = new Map(refs.map((r) => [r.externalId, r.courseId]));
    const unknown = externalIds.filter((id) => !map.has(id));
    if (unknown.length > 0) throw new UnknownCourseError(unknown);
    return map;
  }

  private replayOf(
    event: Pick<WebhookEvent, 'payloadSha256' | 'status' | 'result'> | null,
    fingerprint: string,
  ): EnrollmentSyncResult | null {
    if (!event) return null;
    if (event.payloadSha256 !== fingerprint) throw new EventPayloadMismatchError();
    if (event.status === 'PROCESSED' && event.result) {
      return { ...(event.result as unknown as EnrollmentSyncResult), status: 'duplicate' };
    }
    return null; // FAILED earlier → safe to process again
  }

  /**
   * Leaves a FAILED row so operators can see and replay the event. Written
   * outside the rolled-back transaction, and never overwrites a PROCESSED row
   * that a concurrent delivery may have committed in the meantime.
   */
  private async recordFailure(args: {
    provider: string;
    payload: EnrollmentSyncPayload;
    auth: WebhookAuthContext;
    fingerprint: string;
    error: unknown;
  }): Promise<void> {
    const { provider, payload, auth, fingerprint, error } = args;
    const lastError = describeError(error).slice(0, 2_000);
    try {
      const updated = await this.prisma.webhookEvent.updateMany({
        where: { provider, eventId: payload.event_id, payloadSha256: fingerprint, status: { not: 'PROCESSED' } },
        data: { status: 'FAILED', attempts: { increment: 1 }, lastError, keyId: auth.keyId },
      });
      if (updated.count === 0) {
        await this.prisma.webhookEvent.createMany({
          data: [
            {
              provider,
              eventId: payload.event_id,
              keyId: auth.keyId,
              payloadSha256: fingerprint,
              occurredAt: payload.occurred_at,
              status: 'FAILED',
              lastError,
            },
          ],
          skipDuplicates: true,
        });
      }
    } catch (ledgerError) {
      this.logger.error(`Could not record failed webhook ${payload.event_id}: ${describeError(ledgerError)}`);
    }
  }

  private toHttpError(error: unknown, eventId: string): HttpException {
    if (error instanceof HttpException) return error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034', 'P2028'].includes(error.code)) {
      // Unique race / serialization failure / transaction timeout: safe to retry.
      this.logger.warn(`Transient failure for webhook ${eventId}: ${error.code}`);
      return new ServiceUnavailableException({ error: 'TRANSIENT_FAILURE', message: 'Please retry' });
    }
    this.logger.error(`Webhook ${eventId} failed: ${describeError(error)}`, error instanceof Error ? error.stack : undefined);
    return new InternalServerErrorException({ error: 'INTERNAL_ERROR', message: 'Please retry' });
  }
}

function describeError(error: unknown): string {
  if (error instanceof HttpException) return JSON.stringify(error.getResponse());
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
