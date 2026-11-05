import { Module } from '@nestjs/common';
import { EnrollmentSyncController } from './sync/enrollment-sync.controller.js';
import { EnrollmentSyncService } from './sync/enrollment-sync.service.js';
import { EnrollmentWebhookGuard } from './sync/enrollment-webhook.guard.js';

/**
 * Registers the enrollment routes. In Nest the module + controller decorators
 * are the router: this module mounts EnrollmentSyncController, which serves
 * POST /api/v1/enrollments/sync (global prefix "api" + URI version "v1").
 */
@Module({
  controllers: [EnrollmentSyncController],
  providers: [EnrollmentSyncService, EnrollmentWebhookGuard],
  exports: [EnrollmentSyncService],
})
export class EnrollmentsModule {}
