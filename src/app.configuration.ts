import { ConfigModule } from '@nestjs/config';
import { readFileSync } from 'fs';
import Joi from 'joi';
import { NestedError } from './errors/nested-error';

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
  // Swarm vs container mode is auto-detected at runtime from `docker info`;
  // no env var. See DockerService.resolveSwarmMode().

  // Generic webhook providers — N instances declared via WEBHOOK_<NAME>_URL.
  // No Joi validation on those keys (they're dynamic); see
  // webhook-provider/registry.ts for parsing and URL validation.
  WEBHOOK_TIMEOUT_SECONDS: Joi.number().integer().min(1).default(15),
  // CloudFlare — both optional at schema level; runtime check in CloudFlareService.isConfigured()
  API_TOKEN: Joi.string()
    .pattern(/^[A-Za-z0-9_-]+$/)
    .min(10)
    .max(128)
    .trim()
    .optional(),
  API_TOKEN_FILE: Joi.string()
    .pattern(/^\/run\/secrets\/[A-Za-z0-9-_]+$/)
    .trim()
    .optional(),
  LOG_LEVEL: Joi.string()
    .trim()
    .empty('')
    .default('error')
    .valid('log', 'error', 'warn', 'debug', 'verbose', 'fatal'),

  // MikroTik — all optional at schema level; partial config guard below.
  // *_FILE variants resolve to *_USERNAME / *_PASSWORD via loadConfigurationMikrotikSecretFiles().
  MIKROTIK_BASEURL: Joi.string().uri().optional(),
  MIKROTIK_USERNAME: Joi.string().min(1).trim().optional(),
  MIKROTIK_USERNAME_FILE: Joi.string()
    .pattern(/^\/run\/secrets\/[A-Za-z0-9-_]+$/)
    .trim()
    .optional(),
  MIKROTIK_PASSWORD: Joi.string().min(1).optional(),
  MIKROTIK_PASSWORD_FILE: Joi.string()
    .pattern(/^\/run\/secrets\/[A-Za-z0-9-_]+$/)
    .trim()
    .optional(),
  MIKROTIK_SKIP_TLS_VERIFY: Joi.boolean().default(false),
  MIKROTIK_DEFAULT_TTL: Joi.number().integer().min(1).default(3600),

  // RFC2136 (and any other webhook sidecar) is now registered via the
  // generic WEBHOOK_<NAME>_URL mechanism — see src/webhook-provider/registry.ts.
  // All RFC2136-specific env vars (hosts, zones, kerberos, etc.) moved
  // into the ddo-rfc2136 sidecar's own environment.
}).custom((value, helpers) => {
  // Partial MikroTik config check: all-or-nothing.
  // *_FILE variants count as the corresponding credential being supplied.
  const {
    MIKROTIK_BASEURL,
    MIKROTIK_USERNAME,
    MIKROTIK_USERNAME_FILE,
    MIKROTIK_PASSWORD,
    MIKROTIK_PASSWORD_FILE,
  } = value;
  const hasUsername = !!(MIKROTIK_USERNAME || MIKROTIK_USERNAME_FILE);
  const hasPassword = !!(MIKROTIK_PASSWORD || MIKROTIK_PASSWORD_FILE);
  const mikrotikSetCount = [
    Boolean(MIKROTIK_BASEURL),
    hasUsername,
    hasPassword,
  ].filter(Boolean).length;
  if (mikrotikSetCount > 0 && mikrotikSetCount < 3) {
    return helpers.error('any.invalid', {
      message:
        'MIKROTIK_BASEURL, MIKROTIK_USERNAME (or _FILE), and MIKROTIK_PASSWORD (or _FILE) must all be set or all be absent',
    });
  }
  return value;
});

/**
 * Loads the configuration api token file whilst the configuration is being loaded.
 * Details can be found here: https://docs.nestjs.com/techniques/configuration
 * @throws {NestedError} if API_TOKEN fails to validate
 * @throws {NestedError} if unable to read and validate value present in API_TOKEN_FILE
 * @returns Segment of configuration to be made available by NestJS ConfigService
 */
export const loadConfigurationApiTokenFile = () => {
  // only run if API_TOKEN_FILE isn't undefined
  if (process.env.API_TOKEN_FILE === undefined) return {};
  try {
    // load the file
    const fileContent = readFileSync(process.env.API_TOKEN_FILE, {
      encoding: 'utf8',
    });
    // validate the contents
    const { error } = Joi.string()
      .pattern(/^[A-Za-z0-9_-]+$/)
      .min(10)
      .max(128)
      .trim()
      .empty()
      .validate(fileContent);
    if (error !== undefined) {
      throw new NestedError(
        `app.configuration, customConfiguration: Failed validating ${process.env.API_TOKEN_FILE} as an API_TOKEN`,
        error,
      );
    }
    // return contents, overwrite API_TOKEN value
    return {
      API_TOKEN: fileContent.trim(),
    };
  } catch (error) {
    // if already caught, just re-throw
    if (error instanceof NestedError) throw error;
    // file system error
    throw new NestedError(
      `app.configuration, customConfiguration: Failed trying to read file ${process.env.API_TOKEN_FILE}`,
      error,
    );
  }
};

function readSecretFile(envName: string, path: string): string {
  try {
    const content = readFileSync(path, { encoding: 'utf8' }).trim();
    if (content.length === 0) {
      throw new Error(`File at ${path} is empty`);
    }
    return content;
  } catch (error) {
    throw new NestedError(
      `app.configuration, ${envName}: Failed reading secret file ${path}`,
      error,
    );
  }
}

/**
 * Resolves MikroTik secret files (MIKROTIK_USERNAME_FILE, MIKROTIK_PASSWORD_FILE)
 * into MIKROTIK_USERNAME / MIKROTIK_PASSWORD. Mirrors the pattern used for
 * API_TOKEN_FILE so RouterOS credentials can be supplied as Docker secrets.
 * @throws {NestedError} if a referenced secret file is missing or empty
 */
export const loadConfigurationMikrotikSecretFiles = () => {
  const out: { MIKROTIK_USERNAME?: string; MIKROTIK_PASSWORD?: string } = {};
  if (process.env.MIKROTIK_USERNAME_FILE !== undefined) {
    out.MIKROTIK_USERNAME = readSecretFile(
      'MIKROTIK_USERNAME_FILE',
      process.env.MIKROTIK_USERNAME_FILE,
    );
  }
  if (process.env.MIKROTIK_PASSWORD_FILE !== undefined) {
    out.MIKROTIK_PASSWORD = readSecretFile(
      'MIKROTIK_PASSWORD_FILE',
      process.env.MIKROTIK_PASSWORD_FILE,
    );
  }
  return out;
};

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
    load: [
      loadConfigurationApiTokenFile,
      loadConfigurationMikrotikSecretFiles,
      loadConfigurationComposedConstants,
    ],
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
  MIKROTIK_BASEURL?: string;
  MIKROTIK_USERNAME?: string;
  MIKROTIK_USERNAME_FILE?: string;
  MIKROTIK_PASSWORD?: string;
  MIKROTIK_PASSWORD_FILE?: string;
  MIKROTIK_SKIP_TLS_VERIFY: boolean;
  MIKROTIK_DEFAULT_TTL: number;
  WEBHOOK_TIMEOUT_SECONDS: number;
}
