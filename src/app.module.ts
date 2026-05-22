import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DockerService } from './docker/docker.service';
import { DockerFactory } from './docker/docker.factory';
import { CloudFlareService } from './cloud-flare/cloud-flare.service';
import { CloudFlareFactory } from './cloud-flare/cloud-flare.factory';
import { MikrotikService } from './mikrotik/mikrotik.service';
import { MikrotikFactory } from './mikrotik/mikrotik.factory';
import { Rfc2136Service } from './rfc2136/rfc2136.service';
import { Rfc2136Factory } from './rfc2136/rfc2136.factory';
import { Rfc2136WebhookClient } from './rfc2136/webhook-client';
import { AppService } from './app.service';
import { ConsoleLoggerService } from './logger.service';
import { DdnsService } from './ddns/ddns.service';
import { ProviderRegistry } from './providers/provider-registry.service';

/**
 * Module that registers all the services and factories for the application
 */
@Module({
  providers: [
    DockerService,
    DockerFactory,
    CloudFlareService,
    CloudFlareFactory,
    MikrotikService,
    MikrotikFactory,
    Rfc2136Service,
    {
      provide: Rfc2136Factory,
      useFactory: (config: ConfigService) =>
        new Rfc2136Factory({
          ownershipLabel: `${config.get('PROJECT_LABEL') ?? 'docker-dns-operator'}:${config.get('INSTANCE_ID') ?? '1'}`,
          defaultTtl: Number(config.get('RFC2136_DEFAULT_TTL') ?? 3600),
          minTtl: Number(config.get('RFC2136_MIN_TTL') ?? 60),
        }),
      inject: [ConfigService],
    },
    {
      provide: Rfc2136WebhookClient,
      useFactory: (config: ConfigService) =>
        new Rfc2136WebhookClient(
          config.get<string>('RFC2136_WEBHOOK_URL') ?? 'http://localhost:9090',
          Number(config.get('RFC2136_UPDATE_TIMEOUT_SECONDS') ?? 15) * 1000,
        ),
      inject: [ConfigService],
    },
    AppService,
    ConsoleLoggerService,
    DdnsService,
    {
      provide: ProviderRegistry,
      useFactory: (
        cf: CloudFlareService,
        mt: MikrotikService,
        rfc: Rfc2136Service,
        logger: ConsoleLoggerService,
      ) => new ProviderRegistry([cf, mt, rfc], logger),
      inject: [
        CloudFlareService,
        MikrotikService,
        Rfc2136Service,
        ConsoleLoggerService,
      ],
    },
  ],
})
export class AppModule {}
