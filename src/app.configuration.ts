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
  EXECUTION_FREQUENCY_SECONDS: Joi.number()
    .integer()
    .min(1)
    .empty('')
    .default(60),
  DDNS_EXECUTION_FREQUENCY_MINUTES: Joi.number()
    .integer()
    .min(1)
    .empty('')
    .default(60),
  PRESERVE_STOPPED: Joi.boolean().default(false),

  // Liveness marker file — touched at the end of every reconciliation tick
  // (success or caught failure). Empty string (the default) disables the
  // feature. The Dockerfile sets a path so the bundled HEALTHCHECK has
  // something to stat without requiring caller configuration.
  LIVENESS_FILE: Joi.string().allow('').default(''),
  // Swarm vs container mode is auto-detected at runtime from `docker info`;
  // no env var. See DockerService.resolveSwarmMode().

  // Generic webhook providers — N instances declared via WEBHOOK_<NAME>_URL.
  // No Joi validation on those keys (they're dynamic); see
  // webhook-provider/registry.ts for parsing and URL validation.
  WEBHOOK_TIMEOUT_SECONDS: Joi.number().integer().min(1).default(15),

  LOG_LEVEL: Joi.string()
    .trim()
    .empty('')
    .default('error')
    .valid('log', 'error', 'warn', 'debug', 'verbose', 'fatal'),

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
  LIVENESS_FILE: string;
  WEBHOOK_TIMEOUT_SECONDS: number;
}
