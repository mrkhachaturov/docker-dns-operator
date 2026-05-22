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
  DOCKER_SWARM_MODE: Joi.boolean().default(false),
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

  // RFC2136 — all optional at schema level; partial config guard below
  RFC2136_TRANSPORT_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .optional(),
  RFC2136_AUTH_MODE: Joi.string().valid('gss-tsig').optional(),
  RFC2136_HOSTS: Joi.string()
    .custom((value: string, helpers) => {
      const entries = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (entries.length === 0) {
        return helpers.error('any.invalid');
      }
      // eslint-disable-next-line no-restricted-syntax
      for (const entry of entries) {
        const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(entry);
        const isIpv6 = entry.includes(':');
        const isBareLabel = !entry.includes('.');
        if (isIpv4 || isIpv6 || isBareLabel) {
          return helpers.message({
            custom: `RFC2136_HOSTS entry "${entry}" is not an FQDN. AD GSS-TSIG requires FQDN host names; expect KDC_ERR_S_PRINCIPAL_UNKNOWN with IP/short names.`,
          });
        }
        if (!/^([a-z0-9]([-a-z0-9]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(entry)) {
          return helpers.message({
            custom: `RFC2136_HOSTS entry "${entry}" is not a valid FQDN.`,
          });
        }
      }
      return value;
    })
    .optional(),
  RFC2136_PORT: Joi.number().integer().min(1).max(65535).default(53),
  RFC2136_ZONES: Joi.string().optional(),
  RFC2136_KERBEROS_REALM: Joi.string().optional(),
  RFC2136_KERBEROS_PRINCIPAL: Joi.string()
    .pattern(/^[^\s@]+@[A-Z][A-Z0-9._-]*$/)
    .optional(),
  RFC2136_KRB5_CONF: Joi.string().default('/etc/krb5.conf'),
  RFC2136_DEFAULT_TTL: Joi.number().integer().min(60).default(3600),
  RFC2136_MIN_TTL: Joi.number().integer().min(0).default(60),
  RFC2136_AXFR_TIMEOUT_SECONDS: Joi.number().integer().min(1).default(30),
  RFC2136_UPDATE_TIMEOUT_SECONDS: Joi.number().integer().min(1).default(15),
  RFC2136_CIRCUIT_BREAKER_THRESHOLD: Joi.number().integer().min(1).default(3),
  RFC2136_DRY_RUN: Joi.boolean().default(false),
  RFC2136_TAXFR: Joi.boolean().default(true),
  RFC2136_DOMAIN_FILTER: Joi.string().optional(),
})
  .custom((value, helpers) => {
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
  })
  .custom((value, helpers) => {
    // Partial RFC2136 config check: all-or-nothing
    const required = [
      'RFC2136_TRANSPORT_URL',
      'RFC2136_AUTH_MODE',
      'RFC2136_HOSTS',
      'RFC2136_ZONES',
      'RFC2136_KERBEROS_REALM',
      'RFC2136_KERBEROS_PRINCIPAL',
    ];
    const present = required.filter(
      (k) => value[k] !== undefined && value[k] !== '',
    );
    if (present.length > 0 && present.length < required.length) {
      const missing = required.filter((k) => !present.includes(k));
      return helpers.message({
        custom: `RFC2136 partial config: present=[${present.join(', ')}] missing=[${missing.join(', ')}]. All-or-nothing.`,
      });
    }
    if (present.length === required.length) {
      const principalRealm = value.RFC2136_KERBEROS_PRINCIPAL.split('@')[1];
      if (principalRealm !== value.RFC2136_KERBEROS_REALM.toUpperCase()) {
        return helpers.message({
          custom: `RFC2136_KERBEROS_PRINCIPAL realm "${principalRealm}" does not match RFC2136_KERBEROS_REALM "${value.RFC2136_KERBEROS_REALM}".`,
        });
      }
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
  DOCKER_SWARM_MODE: boolean;
  MIKROTIK_BASEURL?: string;
  MIKROTIK_USERNAME?: string;
  MIKROTIK_USERNAME_FILE?: string;
  MIKROTIK_PASSWORD?: string;
  MIKROTIK_PASSWORD_FILE?: string;
  MIKROTIK_SKIP_TLS_VERIFY: boolean;
  MIKROTIK_DEFAULT_TTL: number;
  RFC2136_TRANSPORT_URL?: string;
  RFC2136_AUTH_MODE?: 'gss-tsig';
  RFC2136_HOSTS?: string;
  RFC2136_PORT: number;
  RFC2136_ZONES?: string;
  RFC2136_KERBEROS_REALM?: string;
  RFC2136_KERBEROS_PRINCIPAL?: string;
  RFC2136_KRB5_CONF: string;
  RFC2136_DEFAULT_TTL: number;
  RFC2136_MIN_TTL: number;
  RFC2136_AXFR_TIMEOUT_SECONDS: number;
  RFC2136_UPDATE_TIMEOUT_SECONDS: number;
  RFC2136_CIRCUIT_BREAKER_THRESHOLD: number;
  RFC2136_DRY_RUN: boolean;
  RFC2136_TAXFR: boolean;
  RFC2136_DOMAIN_FILTER?: string;
}
