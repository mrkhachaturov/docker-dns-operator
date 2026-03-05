import { Module } from '@nestjs/common';
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
    AppService,
    ConsoleLoggerService,
    DdnsService,
    {
      provide: ProviderRegistry,
      useFactory: (cf: CloudFlareService, mt: MikrotikService, logger: ConsoleLoggerService) =>
        new ProviderRegistry([cf, mt], logger),
      inject: [CloudFlareService, MikrotikService, ConsoleLoggerService],
    },
  ],
})
export class AppModule {}
