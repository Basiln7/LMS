import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { verifyWebhookSignature } from '../../../common/security/webhook-signature.js';

export const WEBHOOK_HEADERS = {
  keyId: 'x-lms-key-id',
  timestamp: 'x-lms-timestamp',
  signature: 'x-lms-signature',
} as const;

/** What the guard proved about the request, handed to the controller. */
export interface WebhookAuthContext {
  /** Which shared secret authenticated the call (recorded for audit). */
  keyId: string;
  sourceIp: string | undefined;
}

type WebhookRequest = RawBodyRequest<Request> & { webhookAuth?: WebhookAuthContext };

/**
 * Authenticates calls from the external payment platform.
 *
 * Runs before body validation, so unauthenticated callers learn nothing about
 * the payload contract. Every failure returns the same generic 401; the real
 * reason is only logged.
 */
@Injectable()
export class EnrollmentWebhookGuard implements CanActivate {
  private readonly logger = new Logger(EnrollmentWebhookGuard.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<WebhookRequest>();

    if (!req.is('application/json')) {
      throw new UnsupportedMediaTypeException('Content-Type must be application/json');
    }

    const keyId = req.header(WEBHOOK_HEADERS.keyId);
    const timestamp = req.header(WEBHOOK_HEADERS.timestamp);
    const signature = req.header(WEBHOOK_HEADERS.signature);
    if (!keyId || !timestamp || !signature) {
      return this.reject(req, keyId, 'MISSING_HEADERS');
    }

    const secret = this.config.enrollmentWebhook.keys.get(keyId);
    if (!secret) {
      return this.reject(req, keyId, 'UNKNOWN_KEY_ID');
    }

    if (!Buffer.isBuffer(req.rawBody)) {
      // NestFactory.create(..., { rawBody: true }) was not set — a deployment bug, not a client error.
      this.logger.error('rawBody unavailable: enable rawBody in NestFactory.create()');
      throw new InternalServerErrorException();
    }

    const result = verifyWebhookSignature({
      secret,
      timestampHeader: timestamp,
      signatureHeader: signature,
      rawBody: req.rawBody,
      nowSeconds: Math.floor(Date.now() / 1000),
      toleranceSeconds: this.config.enrollmentWebhook.toleranceSeconds,
    });
    if (!result.ok) {
      return this.reject(req, keyId, result.reason);
    }

    req.webhookAuth = { keyId, sourceIp: req.ip };
    return true;
  }

  private reject(req: Request, keyId: string | undefined, reason: string): never {
    this.logger.warn(`Rejected enrollment webhook: reason=${reason} keyId=${keyId ?? '-'} ip=${req.ip ?? '-'}`);
    throw new UnauthorizedException('Invalid webhook signature');
  }
}

/** Injects the {@link WebhookAuthContext} established by {@link EnrollmentWebhookGuard}. */
export const WebhookAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): WebhookAuthContext => {
  const auth = ctx.switchToHttp().getRequest<WebhookRequest>().webhookAuth;
  if (!auth) {
    throw new InternalServerErrorException('EnrollmentWebhookGuard must run before @WebhookAuth()');
  }
  return auth;
});
