import { describe, expect, it } from 'vitest';
import { enrollmentSyncSchema } from './enrollment-sync.schema.js';

const valid = () => ({
  event_id: 'evt_001',
  occurred_at: '2026-11-05T09:30:00Z',
  student: { external_id: 'cus_1', email: '  Jane.Doe@Example.COM ', full_name: 'Jane Doe' },
  enrollments: [
    { action: 'GRANT', course_id: 'prod_react', expires_at: '2027-11-05T00:00:00Z' },
    { action: 'REVOKE', course_id: 'prod_node', reason: 'REFUND' },
  ],
});

describe('enrollmentSyncSchema', () => {
  it('parses, normalises the email and applies defaults', () => {
    const out = enrollmentSyncSchema.parse(valid());
    expect(out.student.email).toBe('jane.doe@example.com');
    expect(out.occurred_at).toBeInstanceOf(Date);
    expect(out.enrollments[0]).toMatchObject({ action: 'GRANT', reason: 'PURCHASE' });
  });

  it('rejects privilege-escalation attempts via unknown keys', () => {
    const body = valid();
    (body.student as Record<string, unknown>).role = 'ADMIN';
    expect(enrollmentSyncSchema.safeParse(body).success).toBe(false);
  });

  it('requires expires_at to be present on GRANT (null = lifetime)', () => {
    const body = valid();
    delete (body.enrollments[0] as Record<string, unknown>).expires_at;
    expect(enrollmentSyncSchema.safeParse(body).success).toBe(false);

    (body.enrollments[0] as Record<string, unknown>).expires_at = null;
    expect(enrollmentSyncSchema.safeParse(body).success).toBe(true);
  });

  it('requires a reason on REVOKE', () => {
    const body = valid();
    delete (body.enrollments[1] as Record<string, unknown>).reason;
    expect(enrollmentSyncSchema.safeParse(body).success).toBe(false);
  });

  it('rejects the same course twice in one event', () => {
    const body = valid();
    body.enrollments[1]!.course_id = 'prod_react';
    expect(enrollmentSyncSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an expiry that is not after occurred_at', () => {
    const body = valid();
    (body.enrollments[0] as Record<string, unknown>).expires_at = '2026-11-05T09:30:00Z';
    expect(enrollmentSyncSchema.safeParse(body).success).toBe(false);
  });

  it('rejects timestamps without a timezone', () => {
    const body = { ...valid(), occurred_at: '2026-11-05T09:30:00' };
    expect(enrollmentSyncSchema.safeParse(body).success).toBe(false);
  });
});
