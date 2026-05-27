import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import { getConfigModuleImport } from './app.configuration';
import { ConsoleLoggerService } from './logger.service';

/**
 * Main application bootstrap.
 *
 * The operator carries one HTTP route: GET /healthz, served on HEALTH_PORT
 * (default 9090, same as the sidecars). The endpoint reports whether the
 * reconcile loop is still ticking — see src/health/health.controller.ts.
 *
 * RFC2136 (and any other webhook sidecar) is reached via the generic
 * WEBHOOK_<NAME>_URL mechanism; no per-provider startup probe is needed —
 * sidecar health is surfaced through the standard reconciliation error path.
 */
async function bootstrap() {
  const app = await NestFactory.create(
    { module: AppModule, imports: [getConfigModuleImport()] },
    {
      bufferLogs: true,
    },
  );
  app.useLogger(await app.resolve(ConsoleLoggerService));
  app.enableShutdownHooks();
  const appService = app.get(AppService);
  await appService.initialize();

  // Bind /healthz first so the probe is reachable from t=0; the reconcile
  // loop's first tick can take a few seconds (Docker info, sidecar fetches).
  // Until lastTickAt is populated the controller returns 503 status=starting.
  // start_period in HEALTHCHECK covers that window.
  const port = app.get(ConfigService).get<number>('HEALTH_PORT') ?? 9090;
  await app.listen(port, '0.0.0.0');

  // start() subscribes to Docker events, arms the fallback timer, and queues
  // the initial reconcile through the same debouncer. It resolves once the
  // subscription is established; the first reconcile runs asynchronously.
  await appService.start();
}
bootstrap();
