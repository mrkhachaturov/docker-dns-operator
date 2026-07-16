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

/**
 * Reserved routing token. `providers: ["all"]` fans out to every provider, so
 * a provider must never be *tagged* "all" — that would let a `tags: ["all"]`
 * label look meaningful when it is not. Rejected at boot.
 */
const RESERVED_TAG = 'all';

export interface WebhookInstanceConfig {
  /** providerKey used in the registry and in entry `providers: [...]` lists. */
  name: string;
  /** original env var key, for diagnostics. */
  envKey: string;
  url: string;
  /**
   * Tags declared for this instance via the sibling WEBHOOK_<NAME>_TAGS env
   * (comma-separated, trimmed, lower-cased). A `tags: [...]` label targets
   * every instance carrying one of the named tags. Empty when unset.
   */
  tags: string[];
}

/**
 * Parse the sibling WEBHOOK_<NAME>_TAGS value into a canonical tag list:
 * comma-separated, each trimmed and lower-cased, blank tokens (comma
 * artifacts) dropped. Mirrors external-dns's prepareFilters — normalize once
 * here so routing never re-parses. Absent or all-blank yields [].
 */
function parseInstanceTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Parse env into a list of webhook instance configs. Pure function —
 * no validation beyond regex shape and value presence. Tags come from the
 * sibling WEBHOOK_<NAME>_TAGS env, keyed off the same raw <NAME> token.
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
    const tags = parseInstanceTags(env[`WEBHOOK_${m[1]}_TAGS`]);
    out.push({ name, envKey: key, url: value, tags });
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
    if (cfg.tags.includes(RESERVED_TAG)) {
      throw new Error(
        `Webhook registry: instance "${cfg.name}" is tagged "${RESERVED_TAG}" (${cfg.envKey.replace(/_URL$/, '_TAGS')}) — "${RESERVED_TAG}" is a reserved routing token and cannot be a tag`,
      );
    }
    seen.add(cfg.name);
    const client = new WebhookClient(cfg.url, options.timeoutMs);
    providers.push(
      new WebhookProvider(
        cfg.name,
        client,
        options.ownershipLabel,
        logger,
        cfg.tags,
      ),
    );
    logger.log(
      `Webhook registry: registered "${cfg.name}" from ${cfg.envKey} → ${cfg.url}${
        cfg.tags.length > 0 ? ` tags=[${cfg.tags.join(', ')}]` : ''
      }`,
    );
  });
  return providers;
}
