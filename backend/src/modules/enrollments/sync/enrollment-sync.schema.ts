import { z } from 'zod';

/**
 * Contract for POST /api/v1/enrollments/sync.
 *
 * {
 *   "event_id": "evt_01JC9W6Q3M",
 *   "occurred_at": "2026-11-05T09:30:00Z",
 *   "student": { "external_id": "cus_8812", "email": "Jane@Example.com", "full_name": "Jane Doe" },
 *   "enrollments": [
 *     { "action": "GRANT",  "course_id": "prod_react_mastery", "expires_at": "2027-11-05T00:00:00Z", "order_id": "ord_771" },
 *     { "action": "REVOKE", "course_id": "prod_node_basics",   "reason": "REFUND", "order_id": "ord_640" }
 *   ]
 * }
 *
 * - `course_id` is the payment platform's identifier, resolved through
 *   course_external_refs. Internal UUIDs are never accepted from outside.
 * - Every object is strict: unknown keys are rejected, so a sender cannot
 *   smuggle fields like `role` or `password` through this endpoint.
 */

/** Opaque identifiers coming from the payment platform. */
const externalId = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[A-Za-z0-9_.:@/-]+$/, 'Unsupported characters in identifier');

const isoDateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const note = z.string().trim().max(500).optional();

const grantItem = z.strictObject({
  action: z.literal('GRANT'),
  course_id: externalId,
  /** Required key. `null` means lifetime access; send a new GRANT to extend or shorten. */
  expires_at: isoDateTime.nullable(),
  order_id: externalId.optional(),
  reason: z.enum(['PURCHASE', 'RENEWAL', 'MANUAL', 'OTHER']).default('PURCHASE'),
  note,
});

const suspendItem = z.strictObject({
  action: z.literal('SUSPEND'),
  course_id: externalId,
  order_id: externalId.optional(),
  reason: z.enum(['CHARGEBACK', 'MANUAL', 'OTHER']).default('MANUAL'),
  note,
});

const revokeItem = z.strictObject({
  action: z.literal('REVOKE'),
  course_id: externalId,
  order_id: externalId.optional(),
  /** Refund flags from the payment platform map to `REFUND` / `CHARGEBACK`. */
  reason: z.enum(['REFUND', 'CHARGEBACK', 'MANUAL', 'OTHER']),
  note,
});

export const enrollmentItemSchema = z.discriminatedUnion('action', [grantItem, suspendItem, revokeItem]);

export const enrollmentSyncSchema = z
  .strictObject({
    event_id: externalId,
    occurred_at: isoDateTime,
    student: z.strictObject({
      external_id: externalId,
      email: z
        .string()
        .trim()
        .max(254)
        .pipe(z.email())
        .transform((email) => email.toLowerCase()),
      full_name: z.string().trim().min(1).max(200).optional(),
      phone: z
        .string()
        .trim()
        .regex(/^\+?[0-9 ()-]{6,24}$/, 'Invalid phone number')
        .optional(),
    }),
    enrollments: z.array(enrollmentItemSchema).min(1).max(50),
  })
  .superRefine((payload, ctx) => {
    const seen = new Set<string>();
    payload.enrollments.forEach((item, index) => {
      if (seen.has(item.course_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['enrollments', index, 'course_id'],
          message: 'Each course may appear only once per event',
        });
      }
      seen.add(item.course_id);

      if (item.action === 'GRANT' && item.expires_at && item.expires_at <= payload.occurred_at) {
        ctx.addIssue({
          code: 'custom',
          path: ['enrollments', index, 'expires_at'],
          message: 'expires_at must be later than occurred_at',
        });
      }
    });
  });

export type EnrollmentSyncPayload = z.output<typeof enrollmentSyncSchema>;
export type EnrollmentSyncItem = z.output<typeof enrollmentItemSchema>;
