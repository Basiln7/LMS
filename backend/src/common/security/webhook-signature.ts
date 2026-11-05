import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 request signing shared with the external payment platform.
 *
 *   signed_payload = `${timestamp}.${rawBody}`
 *   signature      = hex(HMAC_SHA256(secret, signed_payload))
 *
 * Headers sent by the platform:
 *   X-LMS-Key-Id:    which shared secret was used (enables zero-downtime rotation)
 *   X-LMS-Timestamp: unix seconds when the request was signed
 *   X-LMS-Signature: "v1=<hex signature>"
 *
 * Binding the timestamp into the MAC and rejecting stale timestamps stops
 * captured requests from being replayed later; the event_id ledger stops
 * replays inside the tolerance window.
 */

export const SIGNATURE_SCHEME = 'v1';

export type SignatureFailureReason =
  | 'MALFORMED_TIMESTAMP'
  | 'TIMESTAMP_OUT_OF_TOLERANCE'
  | 'MALFORMED_SIGNATURE'
  | 'SIGNATURE_MISMATCH';

export type SignatureCheckResult = { ok: true } | { ok: false; reason: SignatureFailureReason };

export interface SignatureCheckInput {
  secret: string;
  timestampHeader: string;
  signatureHeader: string;
  rawBody: Buffer;
  nowSeconds: number;
  toleranceSeconds: number;
}

const TIMESTAMP_PATTERN = /^\d{9,11}$/;
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;

export function computeWebhookSignature(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/** Builds the header value a sender would attach — used by tests and integration docs. */
export function formatSignatureHeader(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return `${SIGNATURE_SCHEME}=${computeWebhookSignature(secret, timestamp, rawBody)}`;
}

export function verifyWebhookSignature(input: SignatureCheckInput): SignatureCheckResult {
  if (!TIMESTAMP_PATTERN.test(input.timestampHeader)) {
    return { ok: false, reason: 'MALFORMED_TIMESTAMP' };
  }
  const timestamp = Number(input.timestampHeader);
  if (Math.abs(input.nowSeconds - timestamp) > input.toleranceSeconds) {
    return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  }

  const match = SIGNATURE_PATTERN.exec(input.signatureHeader.trim().toLowerCase());
  if (!match?.[1]) {
    return { ok: false, reason: 'MALFORMED_SIGNATURE' };
  }

  const expected = Buffer.from(computeWebhookSignature(input.secret, input.timestampHeader, input.rawBody), 'hex');
  const provided = Buffer.from(match[1], 'hex');
  // Both are exactly 32 bytes here (regex-enforced), so timingSafeEqual cannot throw.
  if (!timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  }
  return { ok: true };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
