import { describe, expect, it } from 'vitest';
import { type CurrentAccessState, decideAccessTransition, hasActiveAccess } from './access-transition.js';

const now = new Date('2026-11-05T12:00:00Z');
const t = (iso: string) => new Date(iso);

const state = (overrides: Partial<CurrentAccessState> = {}): CurrentAccessState => ({
  status: 'ACTIVE',
  expiresAt: null,
  lastAccessEventAt: t('2026-11-01T00:00:00Z'),
  ...overrides,
});

describe('decideAccessTransition', () => {
  it('creates an active enrollment for a first purchase', () => {
    const d = decideAccessTransition(null, { action: 'GRANT', expiresAt: t('2027-11-05T00:00:00Z'), occurredAt: now }, now);
    expect(d).toEqual({ outcome: 'CREATED', status: 'ACTIVE', expiresAt: t('2027-11-05T00:00:00Z') });
  });

  it('creates an EXPIRED enrollment when the delivered expiry already passed', () => {
    const d = decideAccessTransition(null, { action: 'GRANT', expiresAt: t('2026-11-05T11:00:00Z'), occurredAt: t('2026-10-01T00:00:00Z') }, now);
    expect(d).toMatchObject({ outcome: 'CREATED', status: 'EXPIRED' });
  });

  it('records a revoke for a course the student never had (tombstone)', () => {
    const d = decideAccessTransition(null, { action: 'REVOKE', occurredAt: now }, now);
    expect(d).toEqual({ outcome: 'CREATED', status: 'REVOKED', expiresAt: null });
  });

  it('revokes on refund and keeps the expiry for the record', () => {
    const d = decideAccessTransition(state({ expiresAt: t('2027-01-01T00:00:00Z') }), { action: 'REVOKE', occurredAt: now }, now);
    expect(d).toEqual({ outcome: 'UPDATED', status: 'REVOKED', expiresAt: t('2027-01-01T00:00:00Z') });
  });

  it('ignores an older event delivered after a newer one', () => {
    const current = state({ status: 'REVOKED', lastAccessEventAt: t('2026-11-04T00:00:00Z') });
    const d = decideAccessTransition(current, { action: 'GRANT', expiresAt: null, occurredAt: t('2026-11-03T00:00:00Z') }, now);
    expect(d).toEqual({ outcome: 'STALE_IGNORED' });
  });

  it('re-opens a revoked enrollment on a newer purchase', () => {
    const current = state({ status: 'REVOKED' });
    const d = decideAccessTransition(current, { action: 'GRANT', expiresAt: null, occurredAt: now }, now);
    expect(d).toEqual({ outcome: 'UPDATED', status: 'ACTIVE', expiresAt: null });
  });

  it('never downgrades REVOKED to SUSPENDED', () => {
    const d = decideAccessTransition(state({ status: 'REVOKED' }), { action: 'SUSPEND', occurredAt: now }, now);
    expect(d).toEqual({ outcome: 'UNCHANGED', status: 'REVOKED', expiresAt: null });
  });

  it('extends expiry on renewal', () => {
    const current = state({ expiresAt: t('2026-12-01T00:00:00Z') });
    const d = decideAccessTransition(current, { action: 'GRANT', expiresAt: t('2027-12-01T00:00:00Z'), occurredAt: now }, now);
    expect(d).toEqual({ outcome: 'UPDATED', status: 'ACTIVE', expiresAt: t('2027-12-01T00:00:00Z') });
  });

  it('reports UNCHANGED for an identical grant', () => {
    const current = state({ expiresAt: t('2027-12-01T00:00:00Z') });
    const d = decideAccessTransition(current, { action: 'GRANT', expiresAt: t('2027-12-01T00:00:00Z'), occurredAt: now }, now);
    expect(d.outcome).toBe('UNCHANGED');
  });
});

describe('hasActiveAccess', () => {
  it('requires ACTIVE status and an unexpired window', () => {
    expect(hasActiveAccess({ status: 'ACTIVE', expiresAt: null }, now)).toBe(true);
    expect(hasActiveAccess({ status: 'ACTIVE', expiresAt: t('2026-11-05T11:59:59Z') }, now)).toBe(false);
    expect(hasActiveAccess({ status: 'SUSPENDED', expiresAt: null }, now)).toBe(false);
  });
});
