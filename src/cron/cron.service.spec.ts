import { Test, TestingModule } from '@nestjs/testing';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { Injectable } from '@nestjs/common';
import { CronService, State } from './cron.service';
import { ConsoleLoggerService } from '../logger.service';

// legacyFakeTimers mocks timers using jest mocks
// allows checking for invocations etc...
jest.useFakeTimers({ legacyFakeTimers: true });

const mockClearTimeout = clearTimeout as jest.MockedFunction<
  typeof clearTimeout
>;
const mockSetTimeout = setTimeout as jest.MockedFunction<typeof setTimeout>;
const mockSetTimeoutValue = 'set-timeout-value' as unknown as NodeJS.Timeout;
mockSetTimeout.mockReturnValue(mockSetTimeoutValue);

const mockExecuteIntervalSecondsValue = 999;
const mockServiceNameValue = 'mock-service-name';

@Injectable()
class TestCronService extends CronService {
  // spy used in test! hence not mocked
  // ignored due to being test case
  // eslint-disable-next-line class-methods-use-this
  job(): Promise<void> {
    return Promise.reject(new Error('Method not implemented.'));
  }

  // ignored due to being a test case
  // eslint-disable-next-line class-methods-use-this
  override get ExecutionFrequencySeconds(): number {
    return mockExecuteIntervalSecondsValue;
  }

  // ignored due to being a test case
  // eslint-disable-next-line class-methods-use-this
  override get ServiceName(): string {
    return mockServiceNameValue;
  }
}

describe('CronService', () => {
  let sut: TestCronService;
  let mockConsoleLoggerService: DeepMocked<ConsoleLoggerService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TestCronService],
    })
      .useMocker(createMock)
      .compile();

    mockConsoleLoggerService = module.get(ConsoleLoggerService);

    sut = module.get<TestCronService>(TestCronService);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('start', () => {
    let spyJob: jest.SpyInstance;

    beforeEach(() => {
      spyJob = jest.spyOn(sut, 'job').mockResolvedValue();
    });

    afterAll(() => {
      spyJob.mockRestore();
    });

    it('should error if already started', async () => {
      // arrange
      const expected = new Error(
        `CronService (${mockServiceNameValue}), start: Service already started`,
      );
      sut['stateCron'] = State.Started;

      // act / assert
      await expect(sut.start()).rejects.toThrow(expected);
      expect(spyJob).not.toHaveBeenCalled();
      expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          method: 'start',
          service: 'CronService',
        }),
      );
    });

    it('should execute the job at regular intervals', async () => {
      // arrange
      sut['stateCron'] = State.Stopped;
      delete sut['startedTimeoutToken'];

      // act
      await sut.start();

      // assert
      expect(mockConsoleLoggerService.log).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.log).toHaveBeenCalledWith(
        `Staring CRON job for ${mockServiceNameValue}, execution frequency is every ${mockExecuteIntervalSecondsValue} seconds`,
      );
      expect(mockSetTimeout).toHaveBeenCalledTimes(1);
      expect(mockSetTimeout).toHaveBeenCalledWith(
        expect.any(Function),
        mockExecuteIntervalSecondsValue * 1000,
      );
      expect(spyJob).toHaveBeenCalledTimes(1);
      expect(sut['stateCron']).toEqual(State.Started);
      expect(sut['startedTimeoutToken']).toBe(mockSetTimeoutValue);

      // arrange
      const job = mockSetTimeout.mock.lastCall?.[0];
      if (job === undefined) throw new Error("job shouldn't be undefined");
      mockSetTimeout.mockClear();

      // act
      await job();

      // assert
      expect(spyJob).toHaveBeenCalledTimes(2);
      // verbose is fired by the @LogDecorator wrapper. Two decorated paths run:
      //   start()         → 1
      //   runJobSafely() x2 (initial + tick) → 2
      expect(mockConsoleLoggerService.verbose).toHaveBeenCalledTimes(3);
      expect(mockSetTimeout).toHaveBeenCalledTimes(1);
      expect(mockSetTimeout).toHaveBeenCalledWith(
        expect.any(Function),
        mockExecuteIntervalSecondsValue * 1000,
      );
    });
  });

  describe('job failure does not crash the cron loop', () => {
    let spyJob: jest.SpyInstance;

    beforeEach(() => {
      spyJob = jest.spyOn(sut, 'job');
    });

    afterEach(() => {
      spyJob.mockRestore();
    });

    it('initial tick that throws is caught — start() still resolves and the loop is armed', async () => {
      // arrange
      spyJob.mockRejectedValue(new Error('downstream provider is down'));
      sut['stateCron'] = State.Stopped;
      delete sut['startedTimeoutToken'];

      // act
      await expect(sut.start()).resolves.toBeUndefined();

      // assert — the rejection was swallowed and logged, the loop kept going
      expect(spyJob).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
        expect.stringContaining('job threw, continuing'),
        expect.any(String),
      );
      expect(sut['stateCron']).toEqual(State.Started);
      expect(sut['startedTimeoutToken']).toBe(mockSetTimeoutValue);
      expect(mockSetTimeout).toHaveBeenCalled();
    });

    it('subsequent tick that throws is caught — next setTimeout is still scheduled', async () => {
      // arrange — first tick succeeds, second throws
      spyJob
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('connection refused mid-run'));
      sut['stateCron'] = State.Stopped;
      delete sut['startedTimeoutToken'];
      mockSetTimeout.mockClear();
      mockConsoleLoggerService.error.mockClear();

      await sut.start();
      const tick = mockSetTimeout.mock.lastCall?.[0];
      if (!tick) throw new Error('expected setTimeout to be armed');
      mockSetTimeout.mockClear();

      // act — run the tick that will throw
      await expect((tick as () => Promise<void>)()).resolves.toBeUndefined();

      // assert — error logged, loop re-armed for the next interval
      expect(spyJob).toHaveBeenCalledTimes(2);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
        expect.stringContaining('job threw, continuing'),
        expect.any(String),
      );
      expect(mockSetTimeout).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('should error if already stopped', () => {
      // arrange
      const expected = new Error(
        `CronService (${mockServiceNameValue}), stop: Service already stopped`,
      );
      sut['stateCron'] = State.Stopped;

      // act / asse;rt
      expect(() => sut.stop()).toThrow(expected);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.error).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          method: 'stop',
          service: 'CronService',
        }),
      );
    });

    it('should stop the execution loop', async () => {
      // arrange
      sut['stateCron'] = State.Started;
      sut['startedTimeoutToken'] = mockSetTimeoutValue;

      // act
      sut.stop();

      // assert
      expect(mockConsoleLoggerService.log).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.log).toHaveBeenCalledWith(
        `Stopping CRON job for ${mockServiceNameValue}`,
      );
      expect(mockClearTimeout).toHaveBeenCalledTimes(1);
      expect(mockClearTimeout).toHaveBeenCalledWith(mockSetTimeoutValue);
      expect(sut['stateCron']).toEqual(State.Stopped);
      expect(mockConsoleLoggerService.verbose).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.verbose).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'trace',
          method: 'stop',
          service: 'CronService',
        }),
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('should stop the cron job', () => {
      // arrange
      const spyStop = jest.spyOn(sut, 'stop').mockReturnValue();

      // act
      sut.onModuleDestroy();

      // assert
      expect(spyStop).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.verbose).toHaveBeenCalledTimes(1);
      expect(mockConsoleLoggerService.verbose).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'trace',
          method: 'onModuleDestroy',
          service: 'CronService',
        }),
      );

      // clean up
      spyStop.mockRestore();
    });
  });
});
