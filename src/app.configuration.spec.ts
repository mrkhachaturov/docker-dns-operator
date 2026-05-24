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
      process.env.PROJECT_LABEL = '';
      process.env.INSTANCE_ID = '';
      process.env.EXECUTION_FREQUENCY_SECONDS = '';
      process.env.DDNS_EXECUTION_FREQUENCY_MINUTES = '';
      process.env.LOG_LEVEL = element;

      // eslint-disable-next-line no-await-in-loop
      const sut = await getSystemUnderTest();

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
    }
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
