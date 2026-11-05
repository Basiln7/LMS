import { describe, expect, it } from 'vitest';
import { formatSignatureHeader, verifyWebhookSignature } from './webhook-signature.js';

const secret = 's'.repeat(40);
const body = Buffer.from('{"event_id":"evt_1"}');
const now = 1_793_000_000;

function check(overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) {
  const timestampHeader = String(now);
  return verifyWebhookSignature({
    secret,
    timestampHeader,
    signatureHeader: formatSignatureHeader(secret, timestampHeader, body),
    rawBody: body,
    nowSeconds: now,
    toleranceSeconds: 300,
    ...overrides,
  });
}

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed request', () => {
    expect(check()).toEqual({ ok: true });
  });

  it('rejects a modified body', () => {
    expect(check({ rawBody: Buffer.from('{"event_id":"evt_2"}') })).toEqual({ ok: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects a signature made with another secret', () => {
    const forged = formatSignatureHeader('t'.repeat(40), String(now), body);
    expect(check({ signatureHeader: forged })).toEqual({ ok: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects a replay outside the tolerance window, in either direction', () => {
    expect(check({ nowSeconds: now + 301 })).toEqual({ ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' });
    expect(check({ nowSeconds: now - 301 })).toEqual({ ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' });
  });

  it('binds the timestamp into the MAC (re-stamping an old signature fails)', () => {
    const oldTs = String(now - 3_600);
    const header = formatSignatureHeader(secret, oldTs, body);
    expect(check({ signatureHeader: header })).toEqual({ ok: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it.each(['', 'v1=', 'v1=abc', 'v2=' + 'a'.repeat(64), 'a'.repeat(64), 'v1=' + 'z'.repeat(64)])(
    'rejects malformed signature header %j without throwing',
    (signatureHeader) => {
      expect(check({ signatureHeader })).toEqual({ ok: false, reason: 'MALFORMED_SIGNATURE' });
    },
  );

  it.each(['', 'abc', '1.5', '-1793000000', '17930000000000'])('rejects malformed timestamp %j', (timestampHeader) => {
    expect(check({ timestampHeader })).toEqual({ ok: false, reason: 'MALFORMED_TIMESTAMP' });
  });
});
