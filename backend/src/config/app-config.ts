import { z } from 'zod';

/**
 * Typed, validated application configuration.
 *
 * The process refuses to start on a missing or weak secret instead of failing
 * later at request time.
 */

/** DI token for {@link AppConfig}. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * `ENROLLMENT_WEBHOOK_KEYS="key_2026a:<secret>,key_2026b:<secret>"`
 *
 * Several keys can be active at once so the payment platform can rotate its
 * signing secret without downtime: add the new key, switch the sender, then
 * remove the old key.
 */
const webhookKeysSchema = z.string().transform((raw, ctx) => {
  const keys = new Map<string, string>();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const keyId = separator > 0 ? entry.slice(0, separator) : '';
    const secret = separator > 0 ? entry.slice(separator + 1) : '';
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(keyId)) {
      ctx.addIssue({ code: 'custom', message: `Invalid webhook key id "${keyId}"` });
      return z.NEVER;
    }
    if (secret.length < 32) {
      ctx.addIssue({ code: 'custom', message: `Webhook secret for "${keyId}" must be >= 32 characters` });
      return z.NEVER;
    }
    if (keys.has(keyId)) {
      ctx.addIssue({ code: 'custom', message: `Duplicate webhook key id "${keyId}"` });
      return z.NEVER;
    }
    keys.set(keyId, secret);
  }
  if (keys.size === 0) {
    ctx.addIssue({ code: 'custom', message: 'At least one webhook key is required' });
    return z.NEVER;
  }
  return keys as ReadonlyMap<string, string>;
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Number of reverse-proxy hops to trust for X-Forwarded-For (0 = none). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  ENROLLMENT_WEBHOOK_PROVIDER: z
    .string()
    .regex(/^[a-z0-9_]{2,64}$/)
    .default('payment_engine'),
  ENROLLMENT_WEBHOOK_KEYS: webhookKeysSchema,
  ENROLLMENT_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
});

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly port: number;
  readonly trustProxyHops: number;
  readonly databaseUrl: string;
  readonly enrollmentWebhook: {
    /** Logical name stored on external identities / course refs / webhook events. */
    readonly provider: string;
    readonly keys: ReadonlyMap<string, string>;
    readonly toleranceSeconds: number;
  };
}

export function loadAppConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Never echo values: they may contain secrets.
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  return Object.freeze({
    env: e.NODE_ENV,
    port: e.PORT,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    databaseUrl: e.DATABASE_URL,
    enrollmentWebhook: Object.freeze({
      provider: e.ENROLLMENT_WEBHOOK_PROVIDER,
      keys: e.ENROLLMENT_WEBHOOK_KEYS,
      toleranceSeconds: e.ENROLLMENT_WEBHOOK_TOLERANCE_SECONDS,
    }),
  });
}
