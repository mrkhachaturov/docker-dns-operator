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
        'ProviderRegistry: No providers configured. Declare at least one WEBHOOK_<NAME>_URL sidecar.',
      );
    }
  }

  /**
   * Runs each provider's optional negotiate() hook in parallel so a slow
   * sidecar can't single-handedly delay boot. Per-provider errors are
   * caught here — each provider's own negotiate() is contracted to log
   * its own WARN, but we belt-and-brace at this layer so a buggy
   * implementation that throws can't take the whole boot down.
   */
  async negotiateAll(): Promise<void> {
    const provs = [...this.registry.values()].filter(
      (p): p is IDnsProvider & { negotiate: () => Promise<void> } =>
        typeof p.negotiate === 'function',
    );
    const results = await Promise.allSettled(provs.map((p) => p.negotiate()));
    results.forEach((r, i) => {
      if (r.status !== 'rejected') return;
      const reason =
        r.reason instanceof Error ? r.reason.message : String(r.reason);
      this.loggerService.warn(
        `ProviderRegistry: negotiate threw for ${provs[i].providerKey}: ${reason} — provider will match-all by default.`,
      );
    });
  }

  getAll(): IDnsProvider[] {
    return [...this.registry.values()];
  }
}
