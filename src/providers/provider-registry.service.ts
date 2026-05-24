import { Injectable } from '@nestjs/common';
import { IDnsProvider } from './dns-provider.interface';
import { ConsoleLoggerService } from '../logger.service';

@Injectable()
export class ProviderRegistry {
  private readonly registry = new Map<string, IDnsProvider>();

  constructor(
    private readonly providers: IDnsProvider[],
    private readonly loggerService: ConsoleLoggerService,
  ) {}

  initialize(): void {
    // eslint-disable-next-line no-restricted-syntax
    for (const provider of this.providers) {
      if (provider.isConfigured()) {
        provider.initialize();
        this.registry.set(provider.providerKey, provider);
      }
    }
    if (this.registry.size === 0) {
      throw new Error(
        'ProviderRegistry: No providers configured. Set credentials for at least one provider (CloudFlare in-process, or any WEBHOOK_<NAME>_URL sidecar).',
      );
    }
  }

  getAll(): IDnsProvider[] {
    return [...this.registry.values()];
  }
}
