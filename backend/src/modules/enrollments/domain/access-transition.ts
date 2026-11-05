/**
 * Pure enrollment access state machine (no I/O, no framework).
 *
 * Every access change — webhook or admin — goes through this function, so the
 * rules for ordering, refunds and expiry live in exactly one place.
 *
 *            GRANT (future/no expiry)
 *    ┌─────────────────────────────────────────┐
 *    ▼                                         │
 *  ACTIVE ──SUSPEND──▶ SUSPENDED ──GRANT───────┤
 *    │                    │                    │
 *    └──────REVOKE────────┴──▶ REVOKED ──GRANT─┘   (a newer purchase re-opens)
 *
 *  GRANT with expires_at <= now ⇒ EXPIRED. SUSPEND never downgrades REVOKED.
 */

export type EnrollmentStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';

export interface CurrentAccessState {
  status: EnrollmentStatus;
  expiresAt: Date | null;
  lastAccessEventAt: Date | null;
}

export type AccessCommand =
  | { action: 'GRANT'; expiresAt: Date | null; occurredAt: Date }
  | { action: 'SUSPEND'; occurredAt: Date }
  | { action: 'REVOKE'; occurredAt: Date };

export type AccessDecision =
  /** The event is older than the newest change already applied (out-of-order delivery). */
  | { outcome: 'STALE_IGNORED' }
  | { outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED'; status: EnrollmentStatus; expiresAt: Date | null };

export function decideAccessTransition(
  current: CurrentAccessState | null,
  command: AccessCommand,
  now: Date,
): AccessDecision {
  if (current?.lastAccessEventAt && command.occurredAt < current.lastAccessEventAt) {
    return { outcome: 'STALE_IGNORED' };
  }

  const expiresAt = command.action === 'GRANT' ? command.expiresAt : (current?.expiresAt ?? null);
  const status = nextStatus(current?.status ?? null, command, now);

  // REVOKE / SUSPEND for a course the student never had still creates a row:
  // it records the decision and makes a late, older GRANT land as STALE_IGNORED.
  if (!current) {
    return { outcome: 'CREATED', status, expiresAt };
  }
  if (current.status === status && sameInstant(current.expiresAt, expiresAt)) {
    return { outcome: 'UNCHANGED', status, expiresAt };
  }
  return { outcome: 'UPDATED', status, expiresAt };
}

function nextStatus(current: EnrollmentStatus | null, command: AccessCommand, now: Date): EnrollmentStatus {
  switch (command.action) {
    case 'GRANT':
      return command.expiresAt !== null && command.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE';
    case 'SUSPEND':
      // A refund outranks a temporary hold.
      return current === 'REVOKED' ? 'REVOKED' : 'SUSPENDED';
    case 'REVOKE':
      return 'REVOKED';
  }
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

/** Whether an enrollment currently grants content access. */
export function hasActiveAccess(e: { status: EnrollmentStatus; expiresAt: Date | null }, now: Date): boolean {
  return e.status === 'ACTIVE' && (e.expiresAt === null || e.expiresAt.getTime() > now.getTime());
}
