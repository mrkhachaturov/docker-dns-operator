import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import each from 'jest-each';
import { getConfigModuleImport } from './app.configuration';
import * as ConfigurationModule from './app.configuration';

describe('App Configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  each([
    ['new.project-label_1', 'instance-id2', 120, 60, 'true'],
    ['new.project-label_1', 'instance-id2', 120, 60, 'false'],
  ]).it(
    `should validate: { PROJECT_LABEL: "%p", INSTANCE_ID: "%p", EXECUTION_FREQUENCY_SECONDS: "%p",
    DDNS_EXECUTION_FREQUENCY_MINUTES: "%p", PRESERVE_STOPPED: "%p" }`,
    async (
      projectLabel,
      instanceId,
      executionFrequencySeconds,
      ddnsExecutionFrequencyMinutes,
      preserveStopped,
    ) => {
      const spyLoadConfigurationComposedConstants = jest
        .spyOn(ConfigurationModule, 'loadConfigurationComposedConstants')
        .mockReturnValue({ ENTRY_IDENTIFIER: '' });

      process.env.PROJECT_LABEL = projectLabel;
      process.env.INSTANCE_ID = instanceId;
      process.env.EXECUTION_FREQUENCY_SECONDS = executionFrequencySeconds;
      process.env.DDNS_EXECUTION_FREQUENCY_MINUTES =
        ddnsExecutionFrequencyMinutes;
      process.env.PRESERVE_STOPPED = preserveStopped;
      process.env.LOG_LEVEL = 'error';

      const sut = await getSystemUnderTest();

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

      spyLoadConfigurationComposedConstants.mockRestore();
    },
  );

  it('should validate all valid LOG_LEVELS', async () => {
    const testCases = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'];
    // eslint-disable-next-line no-restricted-syntax
    for (const element of testCases) {
      const spyLoadConfigurationComposedConstants = jest
        .spyOn(ConfigurationModule, 'loadConfigurationComposedConstants')
        .mockReturnValue({ ENTRY_IDENTIFIER: '' });

      process.env.PROJECT_LABEL = 'label';
      process.env.INSTANCE_ID = '1';
      process.env.EXECUTION_FREQUENCY_SECONDS = '60';
      process.env.LOG_LEVEL = element;
      process.env.PRESERVE_STOPPED = 'false';

      // eslint-disable-next-line no-await-in-loop
      const sut = await getSystemUnderTest();

      expect(sut.get('LOG_LEVEL', { infer: true })).toEqual(element);

      spyLoadConfigurationComposedConstants.mockRestore();
    }
  });

  it('should normalize LOG_LEVEL=info to "log"', async () => {
    const spyLoadConfigurationComposedConstants = jest
      .spyOn(ConfigurationModule, 'loadConfigurationComposedConstants')
      .mockReturnValue({ ENTRY_IDENTIFIER: '' });

    try {
      process.env.PROJECT_LABEL = 'label';
      process.env.INSTANCE_ID = '1';
      process.env.EXECUTION_FREQUENCY_SECONDS = '60';
      process.env.LOG_LEVEL = 'info';
      process.env.PRESERVE_STOPPED = 'false';

      const sut = await getSystemUnderTest();

      // 'info' is accepted as a familiar alias from other logging ecosystems
      // and normalized to NestJS's native 'log' level.
      expect(sut.get('LOG_LEVEL', { infer: true })).toEqual('log');
    } finally {
      spyLoadConfigurationComposedConstants.mockRestore();
    }
  });

  it('should default LOG_LEVEL to "log" (external-dns info parity) when unset', async () => {
    const spyLoadConfigurationComposedConstants = jest
      .spyOn(ConfigurationModule, 'loadConfigurationComposedConstants')
      .mockReturnValue({ ENTRY_IDENTIFIER: '' });

    try {
      process.env.PROJECT_LABEL = 'label';
      process.env.INSTANCE_ID = '1';
      process.env.EXECUTION_FREQUENCY_SECONDS = '60';
      process.env.PRESERVE_STOPPED = 'false';
      delete process.env.LOG_LEVEL;

      const sut = await getSystemUnderTest();

      expect(sut.get('LOG_LEVEL', { infer: true })).toEqual('log');
    } finally {
      spyLoadConfigurationComposedConstants.mockRestore();
    }
  });

  it('should reject LOG_LEVEL=trace as invalid', async () => {
    process.env.PROJECT_LABEL = 'label';
    process.env.INSTANCE_ID = '1';
    process.env.EXECUTION_FREQUENCY_SECONDS = '60';
    process.env.LOG_LEVEL = 'trace';
    process.env.PRESERVE_STOPPED = 'false';

    await expect(getSystemUnderTest()).rejects.toThrow(/LOG_LEVEL/);
  });

  describe('loadConfigurationComposedConstants', () => {
    it('should compose ENTRY_IDENTIFIER', async () => {
      const paramProjectLabel = 'project-label';
      const paramInstanceId = 'instance-id';

      process.env.PROJECT_LABEL = paramProjectLabel;
      process.env.INSTANCE_ID = paramInstanceId;
      process.env.LOG_LEVEL = 'debug';

      const sut = await getSystemUnderTest();

      expect(sut.get('ENTRY_IDENTIFIER', { infer: true })).toEqual(
        `${paramProjectLabel}:${paramInstanceId}`,
      );
    });
  });
});
