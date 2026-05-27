import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';

// Joi validation schema for environment variables
export const validationSchema = Joi.object({
  PROJECT_LABEL: Joi.string()
    .pattern(/^[A-Za-z0-9-_.]+$/)
    .trim()
    .empty('')
    .default('docker-dns-operator'),
  INSTANCE_ID: Joi.string()
    .pattern(/^[A-Za-z0-9-_]+$/)
    .trim()
    .empty('')
    .default('1'),
  // Fallback reconcile interval. Docker events are the primary trigger; this
  // timer is the safety net for missed events AND the only mechanism that
  // propagates DDNS public-IP changes (which have no Docker event). Keep low
  // (default 60s) unless you don't use DDNS — DDNS IP propagation latency is
  // bounded by this value.
  EXECUTION_FREQUENCY_SECONDS: Joi.number()
    .integer()
    .min(1)
    .empty('')
    .default(60),
  // Coalesces bursts of Docker events (e.g. a stack deploy creating 10
  // services at once) into a single reconcile pass. Larger values reduce CPU
  // and provider API load but increase reaction latency.
  RECONCILE_DEBOUNCE_MS: Joi.number()
    .integer()
    .min(50)
    .max(10000)
    .empty('')
    .default(500),
  DDNS_EXECUTION_FREQUENCY_MINUTES: Joi.number()
    .integer()
    .min(1)
    .empty('')
    .default(60),
  PRESERVE_STOPPED: Joi.boolean().default(false),

  // HTTP port for the liveness endpoint (GET /healthz). 9090 mirrors the
  // sidecars so probes are uniform across all containers. Bound on 0.0.0.0
  // by the bootstrap so peer containers can curl it for debugging.
  HEALTH_PORT: Joi.number().integer().min(1).max(65535).default(9090),
  // Swarm vs container mode is auto-detected at runtime from `docker info`;
  // no env var. See DockerService.resolveSwarmMode().

  // Generic webhook providers — N instances declared via WEBHOOK_<NAME>_URL.
  // No Joi validation on those keys (they're dynamic); see
  // webhook-provider/registry.ts for parsing and URL validation.
  WEBHOOK_TIMEOUT_SECONDS: Joi.number().integer().min(1).default(15),

  // Accepts the standard NestJS levels plus `info` as a familiar alias
  // for `log` (pino/bunyan/winston call the standard operational level
  // "info"). The alias is normalized to `log` so downstream code sees
  // the native NestJS value. `.custom()` owns both validation and
  // transformation — `.valid()` would short-circuit before normalization.
  LOG_LEVEL: Joi.string()
    .trim()
    .empty('')
    .lowercase()
    .default('error')
    .custom((value: string, helpers) => {
      const normalized = value === 'info' ? 'log' : value;
      const accepted = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'];
      if (!accepted.includes(normalized)) {
        return helpers.error('any.only', {
          valids: [...accepted, 'info'],
        });
      }
      return normalized;
    }),

  // Cloudflare, MikroTik, RFC2136 (and any other webhook sidecar) register
  // through the generic WEBHOOK_<NAME>_URL mechanism — see
  // src/webhook-provider/registry.ts. All provider-specific env vars
  // (API tokens, hosts, zones, kerberos, etc.) moved into the corresponding
  // sidecar's own environment.
});

/**
 * Dynamically computes configuration entries from other configuration entries.
 * @returns Composed configuration values to be accessible from ConfigService
 */
export const loadConfigurationComposedConstants = () => {
  const { PROJECT_LABEL, INSTANCE_ID } = process.env;
  return {
    ENTRY_IDENTIFIER: `${PROJECT_LABEL}:${INSTANCE_ID}`,
  };
};

/**
 * Configures the ConfigModule for NestJS to load dynamic configuration values and validate them.
 * @returns ConfigModule import configuration for NestJS.
 */
export const getConfigModuleImport = () =>
  ConfigModule.forRoot({
    load: [loadConfigurationComposedConstants],
    cache: false,
    ignoreEnvVars: false,
    ignoreEnvFile: true,
    validationSchema,
  });

// type definition for configuration
export interface IConfiguration {
  PROJECT_LABEL: string;
  INSTANCE_ID: string;
  ENTRY_IDENTIFIER: string;
  PRESERVE_STOPPED: boolean;
  HEALTH_PORT: number;
  RECONCILE_DEBOUNCE_MS: number;
  WEBHOOK_TIMEOUT_SECONDS: number;
}
