import { ConsoleLoggerService } from '../logger.service';
import { WebhookClient } from './webhook-client';
import { WebhookProvider } from './webhook-provider';

/**
 * env-var name pattern for a webhook instance.
 *
 *   WEBHOOK_<NAME>_URL = http://...
 *
 * The <NAME> token becomes the instance's providerKey after lowercasing
 * and converting underscores to hyphens. Examples:
 *
 *   WEBHOOK_CF_URL              → "cf"
 *   WEBHOOK_MIKROTIK_HOME_URL   → "mikrotik-home"
 *   WEBHOOK_RFC2136_CORP_URL    → "rfc2136-corp"
 *
 * Matches one or more alphanumeric/underscore characters between the
 * WEBHOOK_ prefix and the _URL suffix. WEBHOOK_URL alone (no <NAME>)
 * is intentionally rejected — every instance needs a name so it can
 * be referenced from the providers: [...] label.
 */
const WEBHOOK_ENV_REGEX = /^WEBHOOK_([A-Z0-9][A-Z0-9_]*)_URL$/;

export interface WebhookInstanceConfig {
  /** providerKey used in the registry and in entry `providers: [...]` lists. */
  name: string;
  /** original env var key, for diagnostics. */
  envKey: string;
  url: string;
}

/**
 * Parse env into a list of webhook instance configs. Pure function —
 * no validation beyond regex shape and value presence.
 */
export function findWebhookInstanceEnvs(
  env: NodeJS.ProcessEnv,
): WebhookInstanceConfig[] {
  const out: WebhookInstanceConfig[] = [];
  Object.entries(env).forEach(([key, value]) => {
    const m = WEBHOOK_ENV_REGEX.exec(key);
    if (!m) return;
    if (!value || value.length === 0) return;
    const name = m[1].toLowerCase().replace(/_/g, '-');
    out.push({ name, envKey: key, url: value });
  });
  return out;
}

/**
 * Build WebhookProvider instances from env. Validates URLs and rejects
 * post-normalization name collisions.
 *
 * Returns an empty list if no WEBHOOK_*_URL env is set — callers wire
 * the result alongside other static providers, so an empty list means
 * "no extra webhook instances".
 */
export function buildWebhookProviders(
  env: NodeJS.ProcessEnv,
  options: { timeoutMs: number; ownershipLabel: string },
  logger: ConsoleLoggerService,
): WebhookProvider[] {
  const configs = findWebhookInstanceEnvs(env);
  const seen = new Set<string>();
  const providers: WebhookProvider[] = [];

  configs.forEach((cfg) => {
    if (seen.has(cfg.name)) {
      throw new Error(
        `Webhook registry: duplicate instance name "${cfg.name}" from ${cfg.envKey} — name normalization collided with an earlier entry`,
      );
    }
    try {
      // URL ctor is the cheapest robust URL check
      // eslint-disable-next-line no-new
      new URL(cfg.url);
    } catch {
      throw new Error(
        `Webhook registry: invalid URL in ${cfg.envKey}: "${cfg.url}"`,
      );
    }
    seen.add(cfg.name);
    const client = new WebhookClient(cfg.url, options.timeoutMs);
    providers.push(
      new WebhookProvider(cfg.name, client, options.ownershipLabel, logger),
    );
    logger.log(
      `Webhook registry: registered "${cfg.name}" from ${cfg.envKey} → ${cfg.url}`,
    );
  });
  return providers;
}
