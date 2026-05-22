import { readFileSync } from 'fs';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import each from 'jest-each';
import { getConfigModuleImport } from './app.configuration';
import * as ConfigurationModule from './app.configuration';
import { NestedError } from './errors/nested-error';

jest.mock('fs');

const mockReadFileSync = readFileSync as jest.MockedFunction<
  typeof readFileSync
>;
const mockReadFileSyncValue = 'valid_api-token_response';

describe('App Configuration', () => {
  const apiTokenInvalidTestCases = [
    '', // empty
    '           ', // empty
    'abcd_FG32', // too short
    'ab_dEFghij cb', // space
    'ab_dEFghij  cb', // tab
    'ab_dEFghij%cb', // symbol
    'JUlKWclrbFlLGdDAo57KUmvoJAV0VcudsJrga62NMfxV8UoTn_VoHDuuJ3VNXiGIVlg4z7KZScbdaYnyL12CLZ1h2GcG0drQXc17xnrAlRyDOKcwNGO3zkGlwD4NA6TPq', // too long
    `ab_dEFghij
      klmnop`, // line feed
  ];

  beforeAll(() => {
    mockReadFileSync.mockReturnValue(mockReadFileSyncValue);
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // configure boolean default environment variables
    process.env.PRESERVE_STOPPED = 'false';
  });

  /**
   * Similar to beforeEach buy has to occur as act to force the module to load.
   * @returns {ConfigService} config service
   */
  async function getSystemUnderTest() {
    const app: TestingModule = await Test.createTestingModule({
      imports: [getConfigModuleImport()],
    }).compile();

    return app.get<ConfigService>(ConfigService);
  }

  function setEnvironmentVariable(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  each([
    [
      'new.project-label_1',
      'instance-id2',
      120,
      60,
      mockReadFileSyncValue,
      undefined,
      'true',
    ],
    [
      'new.project-label_1',
      'instance-id2',
      120,
      60,
      undefined,
      '/run/secrets/API_TOKEN_FILE',
      'false',
    ],
  ]).it(
    `should validate: { PROJECT_LABEL: "%p", INSTANCE_ID: "%p", EXECUTION_FREQUENCY_SECONDS: "%p",
    DDNS_EXECUTION_FREQUENCY_MINUTES: "%p", API_TOKEN: "%p", API_TOKEN_FILE: "%p" }`,
    async (
      projectLabel,
      instanceId,
      executionFrequencySeconds,
      ddnsExecutionFrequencyMinutes,
      apiToken,
      apiTokenFile,
      preserveStopped,
    ) => {
      // arrange

      // note due to LOG_LEVEL being constrained to an enum, it has it's own tests

      // ensures the custom configuration isn't parsed as this mutates the configuration
      // and has behaviour associated with specific values being set.
      const spyLoadConfigurationApiTokenFile = jest
        .spyOn(ConfigurationModule, 'loadConfigurationApiTokenFile')
        .mockReturnValue({});
      const spyLoadConfigurationComposedConstants = jest
        .spyOn(ConfigurationModule, 'loadConfigurationComposedConstants')
        .mockReturnValue({ ENTRY_IDENTIFIER: '' });

      process.env.PROJECT_LABEL = projectLabel;
      process.env.INSTANCE_ID = instanceId;
      process.env.EXECUTION_FREQUENCY_SECONDS = executionFrequencySeconds;
      process.env.DDNS_EXECUTION_FREQUENCY_MINUTES =
        ddnsExecutionFrequencyMinutes;
      process.env.PRESERVE_STOPPED = preserveStopped;
      setEnvironmentVariable('API_TOKEN', apiToken);
      setEnvironmentVariable('API_TOKEN_FILE', apiTokenFile);
      process.env.LOG_LEVEL = 'error';

      // act
      const sut = await getSystemUnderTest();

      // assert
      expect(sut.get('PROJECT_LABEL', { infer: true })).toEqual(
        process.env.PROJECT_LABEL,
      );
      expect(sut.get('INSTANCE_ID', { infer: true })).toEqual(
        process.env.INSTANCE_ID,
      );
      expect(sut.get('EXECUTION_FREQUENCY_SECONDS', { infer: true })).toEqual(
        Number.parseInt(process.env.EXECUTION_FREQUENCY_SECONDS as string, 10),
      );
      expect(
        sut.get('DDNS_EXECUTION_FREQUENCY_MINUTES', { infer: true }),
      ).toEqual(
        Number.parseInt(
          process.env.DDNS_EXECUTION_FREQUENCY_MINUTES as string,
          10,
        ),
      );
      expect(sut.get('PRESERVE_STOPPED', { infer: true })).toBe(
        preserveStopped === 'true',
      );
      expect(sut.get('API_TOKEN', { infer: true })).toEqual(
        process.env.API_TOKEN,
      );
      expect(sut.get('API_TOKEN_FILE', { infer: true })).toEqual(
        process.env.API_TOKEN_FILE,
      );

      // clean up
      spyLoadConfigurationApiTokenFile.mockRestore();
      spyLoadConfigurationComposedConstants.mockRestore();
    },
  );

  it('should validate all valid LOG_LEVELS', async () => {
    // arrange
    const testCases = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'];

    // act
    for (let i = 0; i < testCases.length; i += 1) {
      // arrange
      const spyLoadConfigurationApiTokenFile = jest
        .spyOn(ConfigurationModule, 'loadConfigurationApiTokenFile')
        .mockReturnValue({});
      const spyLoadConfigurationComposedConstants = jest
        .spyOn(ConfigurationModule, 'loadConfigurationComposedConstants')
        .mockReturnValue({ ENTRY_IDENTIFIER: '' });

      process.env.PROJECT_LABEL = 'label';
      process.env.INSTANCE_ID = '1';
      process.env.EXECUTION_FREQUENCY_SECONDS = '60';
      setEnvironmentVariable('API_TOKEN', 'validtoken');
      setEnvironmentVariable('API_TOKEN_FILE', undefined);
      process.env.LOG_LEVEL = testCases[i];
      process.env.PRESERVE_STOPPED = 'false';

      // act

      // permitted in this case due to being a test case
      // eslint-disable-next-line no-await-in-loop
      const sut = await getSystemUnderTest();

      // assert
      expect(sut.get('LOG_LEVEL', { infer: true })).toEqual(
        process.env.LOG_LEVEL,
      );

      // clean up
      spyLoadConfigurationApiTokenFile.mockRestore();
      spyLoadConfigurationComposedConstants.mockRestore();
    }
  });

  it('should reject invalid LOG_LEVEL values at startup', async () => {
    const spyLoadConfigurationApiTokenFile = jest
      .spyOn(ConfigurationModule, 'loadConfigurationApiTokenFile')
      .mockReturnValue({});
    const spyLoadConfigurationComposedConstants = jest
      .spyOn(ConfigurationModule, 'loadConfigurationComposedConstants')
      .mockReturnValue({ ENTRY_IDENTIFIER: '' });

    process.env.PROJECT_LABEL = 'label';
    process.env.INSTANCE_ID = '1';
    process.env.EXECUTION_FREQUENCY_SECONDS = '60';
    setEnvironmentVariable('API_TOKEN', 'validtoken');
    setEnvironmentVariable('API_TOKEN_FILE', undefined);
    process.env.LOG_LEVEL = 'info';
    process.env.PRESERVE_STOPPED = 'false';

    await expect(getSystemUnderTest()).rejects.toThrow(/LOG_LEVEL/);

    spyLoadConfigurationApiTokenFile.mockRestore();
    spyLoadConfigurationComposedConstants.mockRestore();
  });

  each([
    [
      'project&label',
      'valid',
      60,
      120,
      mockReadFileSyncValue,
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      '{tag}_%value%',
      60,
      120,
      mockReadFileSyncValue,
      undefined,
      'debug',
      'false',
    ],
    ['valid', 'valid', 60, 120, undefined, 'invalid', 'debug', 'false'],
    [
      'valid',
      'valid',
      60,
      120,
      apiTokenInvalidTestCases[2],
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      60,
      120,
      apiTokenInvalidTestCases[3],
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      60,
      120,
      apiTokenInvalidTestCases[4],
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      60,
      120,
      apiTokenInvalidTestCases[5],
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      60,
      120,
      apiTokenInvalidTestCases[6],
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      60,
      120,
      apiTokenInvalidTestCases[7],
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      0,
      120,
      mockReadFileSyncValue,
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      120,
      'SomethingNotNumeric',
      mockReadFileSyncValue,
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      'SomethingNotNumeric',
      120,
      mockReadFileSyncValue,
      undefined,
      'unknown',
      'false',
    ],
    [
      'valid',
      'valid',
      120,
      0,
      mockReadFileSyncValue,
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      120,
      'SomethingNotNumeric',
      mockReadFileSyncValue,
      undefined,
      'debug',
      'false',
    ],
    [
      'valid',
      'valid',
      120,
      'SomethingNotNumeric',
      mockReadFileSyncValue,
      undefined,
      'unknown',
      'false',
    ],
    ['valid', 'valid', 120, 60, mockReadFileSyncValue, undefined, 'debug', '1'],
    ['valid', 'valid', 120, 60, mockReadFileSyncValue, undefined, 'debug', '0'],
    [
      'valid',
      'valid',
      120,
      60,
      mockReadFileSyncValue,
      undefined,
      'debug',
      '1=1',
    ],
    [
      'valid',
      'valid',
      120,
      60,
      mockReadFileSyncValue,
      undefined,
      'debug',
      'NotABoolean',
    ],
  ]).it(
    `should invalidate: { PROJECT_LABEL: "%p", INSTANCE_ID: "%p", EXECUTION_FREQUENCY_SECONDS: "%p", 
    DDNS_EXECUTION_FREQUENCY_MINUTES: "%p", API_TOKEN: "%p", API_TOKEN_FILE: "%p", LOG_LEVEL: "%p", PRESERVE_STOPPED: "%p" }`,
    async (
      projectLabel,
      instanceId,
      executionFrequencySeconds,
      ddnsExecutionFrequencyMinutes,
      apiToken,
      apiTokenFile,
      logLevel,
      preserveStopped,
    ) => {
      // arrange
      process.env.PROJECT_LABEL = projectLabel;
      process.env.INSTANCE_ID = instanceId;
      process.env.EXECUTION_FREQUENCY_SECONDS = executionFrequencySeconds;
      process.env.DDNS_EXECUTION_FREQUENCY_MINUTES =
        ddnsExecutionFrequencyMinutes;
      setEnvironmentVariable('API_TOKEN', apiToken);
      setEnvironmentVariable('API_TOKEN_FILE', apiTokenFile);
      process.env.LOG_LEVEL = logLevel;
      process.env.PRESERVE_STOPPED = preserveStopped;

      // act / assert
      await expect(async () => getSystemUnderTest()).rejects.toThrow();
    },
  );

  it('should use defaults when values are undefined', async () => {
    // arrange
    delete process.env.PROJECT_LABEL;
    delete process.env.INSTANCE_ID;
    delete process.env.EXECUTION_FREQUENCY_SECONDS;
    delete process.env.DDNS_EXECUTION_FREQUENCY_MINUTES;
    process.env.API_TOKEN = mockReadFileSyncValue;
    delete process.env.LOG_LEVEL;
    delete process.env.PRESERVE_STOPPED;
    delete process.env.DOCKER_SWARM_MODE;

    // act
    const sut = await getSystemUnderTest();

    // act
    expect(sut.get('PROJECT_LABEL', { infer: true })).toEqual(
      'docker-dns-operator',
    );
    expect(sut.get('INSTANCE_ID', { infer: true })).toEqual('1');
    expect(sut.get('EXECUTION_FREQUENCY_SECONDS', { infer: true })).toEqual(60);
    expect(
      sut.get('DDNS_EXECUTION_FREQUENCY_MINUTES', { infer: true }),
    ).toEqual(60);
    expect(sut.get('LOG_LEVEL', { infer: true })).toEqual('error');
    expect(sut.get('PRESERVE_STOPPED', { infer: true })).toBe(false);
    expect(sut.get('DOCKER_SWARM_MODE', { infer: true })).toBe(false);
  });

  each(['', '     ']).it(
    `should use defaults when values are empty, value: "%p"`,
    async (element) => {
      // arrange
      process.env.PROJECT_LABEL = element;
      process.env.INSTANCE_ID = element;
      process.env.EXECUTION_FREQUENCY_SECONDS = '';
      process.env.DDNS_EXECUTION_FREQUENCY_MINUTES = '';
      process.env.API_TOKEN = mockReadFileSyncValue;
      process.env.LOG_LEVEL = element;

      // act
      const sut = await getSystemUnderTest();

      // assert
      expect(sut.get('PROJECT_LABEL', { infer: true })).toEqual(
        'docker-dns-operator',
      );
      expect(sut.get('INSTANCE_ID', { infer: true })).toEqual('1');
      expect(sut.get('EXECUTION_FREQUENCY_SECONDS', { infer: true })).toEqual(
        60,
      );
      expect(
        sut.get('DDNS_EXECUTION_FREQUENCY_MINUTES', { infer: true }),
      ).toEqual(60);
      expect(sut.get('LOG_LEVEL', { infer: true })).toEqual('error');
    },
  );

  it('should validate when only MikroTik vars are set (no CF creds required)', async () => {
    delete process.env.API_TOKEN;
    delete process.env.API_TOKEN_FILE;
    process.env.MIKROTIK_BASEURL = 'https://192.168.1.1';
    process.env.MIKROTIK_USERNAME = 'admin';
    process.env.MIKROTIK_PASSWORD = 'secret';

    const sut = await getSystemUnderTest();

    expect(sut.get('MIKROTIK_BASEURL', { infer: true })).toBe(
      'https://192.168.1.1',
    );
    expect(sut.get('MIKROTIK_USERNAME', { infer: true })).toBe('admin');

    // cleanup
    delete process.env.MIKROTIK_BASEURL;
    delete process.env.MIKROTIK_USERNAME;
    delete process.env.MIKROTIK_PASSWORD;
  });

  it('should reject partial MikroTik config (only baseurl set)', async () => {
    delete process.env.API_TOKEN;
    delete process.env.API_TOKEN_FILE;
    process.env.MIKROTIK_BASEURL = 'https://192.168.1.1';
    delete process.env.MIKROTIK_USERNAME;
    delete process.env.MIKROTIK_PASSWORD;

    await expect(getSystemUnderTest()).rejects.toThrow();

    delete process.env.MIKROTIK_BASEURL;
  });

  it('should use MikroTik defaults', async () => {
    delete process.env.API_TOKEN;
    delete process.env.API_TOKEN_FILE;
    process.env.MIKROTIK_BASEURL = 'https://192.168.1.1';
    process.env.MIKROTIK_USERNAME = 'admin';
    process.env.MIKROTIK_PASSWORD = 'secret';
    delete process.env.MIKROTIK_SKIP_TLS_VERIFY;
    delete process.env.MIKROTIK_DEFAULT_TTL;

    const sut = await getSystemUnderTest();

    expect(sut.get('MIKROTIK_SKIP_TLS_VERIFY', { infer: true })).toBe(false);
    expect(sut.get('MIKROTIK_DEFAULT_TTL', { infer: true })).toBe(3600);

    delete process.env.MIKROTIK_BASEURL;
    delete process.env.MIKROTIK_USERNAME;
    delete process.env.MIKROTIK_PASSWORD;
  });

  describe('RFC2136 configuration', () => {
    const rfc2136Keys = [
      'RFC2136_TRANSPORT_URL',
      'RFC2136_AUTH_MODE',
      'RFC2136_HOSTS',
      'RFC2136_PORT',
      'RFC2136_ZONES',
      'RFC2136_KERBEROS_REALM',
      'RFC2136_KERBEROS_PRINCIPAL',
      'RFC2136_KEYTAB_FILE',
      'RFC2136_KRB5_CONF',
      'RFC2136_DEFAULT_TTL',
      'RFC2136_MIN_TTL',
      'RFC2136_AXFR_TIMEOUT_SECONDS',
      'RFC2136_UPDATE_TIMEOUT_SECONDS',
      'RFC2136_CIRCUIT_BREAKER_THRESHOLD',
      'RFC2136_DRY_RUN',
      'RFC2136_TAXFR',
      'RFC2136_DOMAIN_FILTER',
    ];

    beforeEach(() => {
      delete process.env.API_TOKEN;
      delete process.env.API_TOKEN_FILE;
      rfc2136Keys.forEach((key) => {
        delete process.env[key];
      });
    });

    afterEach(() => {
      rfc2136Keys.forEach((key) => {
        delete process.env[key];
      });
    });

    function setValidRfc2136Env() {
      process.env.RFC2136_TRANSPORT_URL = 'http://transport:9090';
      process.env.RFC2136_AUTH_MODE = 'gss-tsig';
      process.env.RFC2136_HOSTS = 'dc01.corp.example.com,dc02.corp.example.com';
      process.env.RFC2136_ZONES = 'corp.example.com';
      process.env.RFC2136_KERBEROS_REALM = 'CORP.EXAMPLE.COM';
      process.env.RFC2136_KERBEROS_PRINCIPAL = 'svc-dns@CORP.EXAMPLE.COM';
      process.env.RFC2136_KEYTAB_FILE = '/run/secrets/rfc2136_keytab';
    }

    it('accepts a complete valid RFC2136 config', async () => {
      setValidRfc2136Env();

      const sut = await getSystemUnderTest();

      expect(sut.get('RFC2136_TRANSPORT_URL', { infer: true })).toBe(
        'http://transport:9090',
      );
      expect(sut.get('RFC2136_AUTH_MODE', { infer: true })).toBe('gss-tsig');
      expect(sut.get('RFC2136_PORT', { infer: true })).toBe(53);
      expect(sut.get('RFC2136_KRB5_CONF', { infer: true })).toBe(
        '/etc/krb5.conf',
      );
      expect(sut.get('RFC2136_DEFAULT_TTL', { infer: true })).toBe(3600);
      expect(sut.get('RFC2136_MIN_TTL', { infer: true })).toBe(60);
      expect(sut.get('RFC2136_AXFR_TIMEOUT_SECONDS', { infer: true })).toBe(30);
      expect(sut.get('RFC2136_UPDATE_TIMEOUT_SECONDS', { infer: true })).toBe(
        15,
      );
      expect(
        sut.get('RFC2136_CIRCUIT_BREAKER_THRESHOLD', { infer: true }),
      ).toBe(3);
      expect(sut.get('RFC2136_DRY_RUN', { infer: true })).toBe(false);
    });

    it('throws on partial RFC2136 config', async () => {
      process.env.RFC2136_TRANSPORT_URL = 'http://transport:9090';
      process.env.RFC2136_AUTH_MODE = 'gss-tsig';
      // missing HOSTS, ZONES, REALM, PRINCIPAL, KEYTAB_FILE

      await expect(getSystemUnderTest()).rejects.toThrow(
        /RFC2136 partial config/,
      );
    });

    it('throws when principal realm does not match configured realm', async () => {
      setValidRfc2136Env();
      process.env.RFC2136_KERBEROS_PRINCIPAL = 'svc-dns@WRONG.REALM';

      await expect(getSystemUnderTest()).rejects.toThrow(/does not match/);
    });

    it('rejects IP address in RFC2136_HOSTS with FQDN-required error', async () => {
      setValidRfc2136Env();
      process.env.RFC2136_HOSTS = '10.0.0.1';

      await expect(getSystemUnderTest()).rejects.toThrow(/FQDN/);
    });

    it('rejects bare hostname (no dot) in RFC2136_HOSTS', async () => {
      setValidRfc2136Env();
      process.env.RFC2136_HOSTS = 'dc01';

      await expect(getSystemUnderTest()).rejects.toThrow(/FQDN/);
    });

    it('rejects unsupported auth mode', async () => {
      setValidRfc2136Env();
      process.env.RFC2136_AUTH_MODE = 'magic-mode';

      await expect(getSystemUnderTest()).rejects.toThrow();
    });
  });

  describe('loadConfigurationApiTokenFile', () => {
    const envApiTokenFile = '/run/secrets/API_TOKEN_FILE';

    beforeEach(() => {
      delete process.env.API_TOKEN;
      process.env.API_TOKEN_FILE = envApiTokenFile;
    });

    each([
      `${mockReadFileSyncValue}\n`,
      `${mockReadFileSyncValue}\r`,
      `${mockReadFileSyncValue}\r\n`,
      mockReadFileSyncValue,
    ]).it(
      'should load API_TOKEN from API_TOKEN_FILE',
      async (readFileSyncValue) => {
        // arrange
        mockReadFileSync.mockReturnValueOnce(readFileSyncValue);

        // act
        const sut = await getSystemUnderTest();

        // assert
        expect(mockReadFileSync).toHaveBeenCalledTimes(1);
        expect(mockReadFileSync).toHaveBeenCalledWith(envApiTokenFile, {
          encoding: 'utf8',
        });
        expect(sut.get('API_TOKEN', { infer: true })).toBe(
          mockReadFileSyncValue,
        );
      },
    );

    it("should error if API_TOKEN_FILE doesn't resolve to a file", async () => {
      // arrange
      const error = new Error('file-read-error');
      mockReadFileSync.mockImplementationOnce(() => {
        throw error;
      });

      const expected = new NestedError(
        `app.configuration, customConfiguration: Failed trying to read file ${envApiTokenFile}`,
        error,
      );

      // act / assert
      await expect(async () => getSystemUnderTest()).rejects.toThrow(expected);
    });

    each([
      '', // empty
      '           ', // empty
      'abcd_FG32', // too short
      'ab_dEFghij cb', // space
      'ab_dEFghij  cb', // tab
      'ab_dEFghij%cb', // symbol
      'JUlKWclrbFlLGdDAo57KUmvoJAV0VcudsJrga62NMfxV8UoTn_VoHDuuJ3VNXiGIVlg4z7KZScbdaYnyL12CLZ1h2GcG0drQXc17xnrAlRyDOKcwNGO3zkGlwD4NA6TPq', // too long
      `ab_dEFghij
      klmnop`, // line feed
    ]).it(
      'should error if API_TOKEN_FILE contents is invalid (%p)',
      async (fileContents) => {
        // arrange
        mockReadFileSync.mockReturnValueOnce(fileContents);

        // act / assert
        await expect(async () => getSystemUnderTest()).rejects.toThrow(
          `app.configuration, customConfiguration: Failed validating ${envApiTokenFile} as an API_TOKEN`,
        );
      },
    );
  });

  describe('loadConfigurationComposedConstants', () => {
    it('should compose ENTRY_IDENTIFIER', async () => {
      // arrange
      const paramProjectLabel = 'project-label';
      const paramInstanceId = 'instance-id';

      const spyLoadConfigurationApiTokenFile = jest
        .spyOn(ConfigurationModule, 'loadConfigurationApiTokenFile')
        .mockReturnValue({});

      process.env.PROJECT_LABEL = paramProjectLabel;
      process.env.INSTANCE_ID = paramInstanceId;
      setEnvironmentVariable('API_TOKEN', mockReadFileSyncValue);
      setEnvironmentVariable('API_TOKEN_FILE', undefined);
      process.env.LOG_LEVEL = 'debug';

      // act
      const sut = await getSystemUnderTest();

      // assert
      expect(sut.get('ENTRY_IDENTIFIER', { infer: true })).toEqual(
        `${paramProjectLabel}:${paramInstanceId}`,
      );

      // clean up
      spyLoadConfigurationApiTokenFile.mockRestore();
    });
  });
});
