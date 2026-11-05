import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { type EnrollmentSyncPayload, enrollmentSyncSchema } from './enrollment-sync.schema.js';
import { EnrollmentSyncService } from './enrollment-sync.service.js';
import type { EnrollmentSyncResult } from './enrollment-sync.service.js';
import { EnrollmentWebhookGuard, WebhookAuth } from './enrollment-webhook.guard.js';
import type { WebhookAuthContext } from './enrollment-webhook.guard.js';

/**
 * Machine-to-machine endpoint for the external payment platform.
 *
 * Request pipeline (order matters):
 *   body-parser (256 KB cap, raw bytes kept)
 *     → ThrottlerGuard            (flood protection)
 *     → EnrollmentWebhookGuard    (HMAC + timestamp; nothing is parsed before this)
 *     → ZodValidationPipe         (strict schema, normalisation)
 *     → EnrollmentSyncService     (idempotent, transactional apply)
 *
 * No user JWT is involved here. If a global JWT guard is added later, mark this
 * route as public for that guard; the HMAC guard stays mandatory.
 */
@Controller({ path: 'enrollments', version: '1' })
@UseGuards(ThrottlerGuard, EnrollmentWebhookGuard)
export class EnrollmentSyncController {
  constructor(private readonly syncService: EnrollmentSyncService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  sync(
    @Body(new ZodValidationPipe(enrollmentSyncSchema)) payload: EnrollmentSyncPayload,
    @WebhookAuth() auth: WebhookAuthContext,
  ): Promise<EnrollmentSyncResult> {
    return this.syncService.sync(payload, auth);
  }
}
