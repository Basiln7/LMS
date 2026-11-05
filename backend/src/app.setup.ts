import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { AppConfig } from './config/app-config.js';

/**
 * HTTP pipeline shared by main.ts and the e2e tests, so tests exercise the
 * exact production configuration.
 *
 * The app must be created with `{ rawBody: true }` — webhook signatures are
 * computed over the raw bytes.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.trustProxyHops);
  app.disable('x-powered-by');
  app.use(helmet());
  app.useBodyParser('json', { limit: '256kb' });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();
}
