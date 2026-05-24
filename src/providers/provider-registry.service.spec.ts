import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { ProviderRegistry } from './provider-registry.service';
import { IDnsProvider } from './dns-provider.interface';
import { ConsoleLoggerService } from '../logger.service';

function makeProvider(key: string, configured: boolean): IDnsProvider {
  return {
    providerKey: key,
    isConfigured: jest.fn().mockReturnValue(configured),
    initialize: jest.fn(),
    getRecords: jest.fn(),
    createEntry: jest.fn(),
    updateEntry: jest.fn(),
    deleteEntry: jest.fn(),
  };
}

describe('ProviderRegistry', () => {
  let logger: DeepMocked<ConsoleLoggerService>;
  let cfProvider: IDnsProvider;
  let otherProvider: IDnsProvider;
  let sut: ProviderRegistry;

  beforeEach(() => {
    logger = createMock<ConsoleLoggerService>();
    cfProvider = makeProvider('cf', true);
    otherProvider = makeProvider('other', false);
    sut = new ProviderRegistry([cfProvider, otherProvider], logger);
  });

  describe('initialize', () => {
    it('registers configured providers and initializes them', () => {
      sut.initialize();
      expect(cfProvider.initialize).toHaveBeenCalledTimes(1);
      expect(otherProvider.initialize).not.toHaveBeenCalled();
    });

    it('throws when no providers are configured', () => {
      const emptyRegistry = new ProviderRegistry(
        [makeProvider('cf', false), makeProvider('other', false)],
        logger,
      );
      expect(() => emptyRegistry.initialize()).toThrow(
        'No providers configured',
      );
    });
  });

  describe('getAll', () => {
    it('returns all registered providers', () => {
      sut.initialize();
      expect(sut.getAll()).toHaveLength(1);
      expect(sut.getAll()[0].providerKey).toBe('cf');
    });
  });
});
