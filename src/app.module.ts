import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DockerService } from './docker/docker.service';
import { DockerFactory } from './docker/docker.factory';
import { CloudFlareService } from './cloud-flare/cloud-flare.service';
import { CloudFlareFactory } from './cloud-flare/cloud-flare.factory';
import { MikrotikService } from './mikrotik/mikrotik.service';
import { MikrotikFactory } from './mikrotik/mikrotik.factory';
import { AppService } from './app.service';
import { ConsoleLoggerService } from './logger.service';
import { DdnsService } from './ddns/ddns.service';
import { ProviderRegistry } from './providers/provider-registry.service';
import { buildWebhookProviders } from './webhook-provider/registry';

/**
 * Module that registers all the services and factories for the application.
 * Webhook-style providers (RFC2136, and any future sidecar) register
 * dynamically through buildWebhookProviders via WEBHOOK_<NAME>_URL env vars.
 */
@Module({
  providers: [
    DockerService,
    DockerFactory,
    CloudFlareService,
    CloudFlareFactory,
    MikrotikService,
    MikrotikFactory,
    AppService,
    ConsoleLoggerService,
    DdnsService,
    {
      provide: ProviderRegistry,
      useFactory: (
        cf: CloudFlareService,
        mt: MikrotikService,
        logger: ConsoleLoggerService,
        config: ConfigService,
      ) => {
        const webhookInstances = buildWebhookProviders(
          process.env,
          {
            timeoutMs:
              Number(config.get('WEBHOOK_TIMEOUT_SECONDS') ?? 15) * 1000,
            ownershipLabel: `${config.get('PROJECT_LABEL') ?? 'docker-dns-operator'}:${config.get('INSTANCE_ID') ?? '1'}`,
          },
          logger,
        );
        return new ProviderRegistry([cf, mt, ...webhookInstances], logger);
      },
      inject: [
        CloudFlareService,
        MikrotikService,
        ConsoleLoggerService,
        ConfigService,
      ],
    },
  ],
})
export class AppModule {}
