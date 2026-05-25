import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DockerService } from './docker/docker.service';
import { DockerFactory } from './docker/docker.factory';
import { AppService } from './app.service';
import { ConsoleLoggerService } from './logger.service';
import { DdnsService } from './ddns/ddns.service';
import { ProviderRegistry } from './providers/provider-registry.service';
import { buildWebhookProviders } from './webhook-provider/registry';
import { HealthController } from './health/health.controller';

/**
 * Module that registers all the services and factories for the application.
 * Every DNS provider (Cloudflare, MikroTik, RFC2136, and any future sidecar)
 * registers dynamically through buildWebhookProviders via WEBHOOK_<NAME>_URL
 * env vars. The operator no longer carries an in-process DNS implementation.
 */
@Module({
  controllers: [HealthController],
  providers: [
    DockerService,
    DockerFactory,
    AppService,
    ConsoleLoggerService,
    DdnsService,
    {
      provide: ProviderRegistry,
      useFactory: (logger: ConsoleLoggerService, config: ConfigService) => {
        const webhookInstances = buildWebhookProviders(
          process.env,
          {
            timeoutMs:
              Number(config.get('WEBHOOK_TIMEOUT_SECONDS') ?? 15) * 1000,
            ownershipLabel: `${config.get('PROJECT_LABEL') ?? 'docker-dns-operator'}:${config.get('INSTANCE_ID') ?? '1'}`,
          },
          logger,
        );
        return new ProviderRegistry([...webhookInstances], logger);
      },
      inject: [ConsoleLoggerService, ConfigService],
    },
  ],
})
export class AppModule {}
