import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import { getConfigModuleImport } from './app.configuration';
import { ConsoleLoggerService } from './logger.service';

/**
 * Main application bootstrap.
 * RFC2136 (and any other webhook sidecar) is reached via the generic
 * WEBHOOK_<NAME>_URL mechanism; no per-provider startup probe is needed
 * — sidecar health is surfaced through the standard reconciliation
 * error path.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(
    { module: AppModule, imports: [getConfigModuleImport()] },
    {
      bufferLogs: true,
    },
  );
  app.useLogger(await app.resolve(ConsoleLoggerService));
  app.enableShutdownHooks();
  const appService = app.get(AppService);
  appService.initialize();
  appService.start();
}
bootstrap();
