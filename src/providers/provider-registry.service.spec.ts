import { ProviderRegistry } from './provider-registry.service';
import { IDnsProvider } from './dns-provider.interface';
import { ConsoleLoggerService } from '../logger.service';
import { createMock, DeepMocked } from '@golevelup/ts-jest';

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
  let mikrotikProvider: IDnsProvider;
  let sut: ProviderRegistry;

  beforeEach(() => {
    logger = createMock<ConsoleLoggerService>();
    cfProvider = makeProvider('cf', true);
    mikrotikProvider = makeProvider('mikrotik', false);
    sut = new ProviderRegistry([cfProvider, mikrotikProvider], logger);
  });

  describe('initialize', () => {
    it('registers configured providers and initializes them', () => {
      sut.initialize();
      expect(cfProvider.initialize).toHaveBeenCalledTimes(1);
      expect(mikrotikProvider.initialize).not.toHaveBeenCalled();
    });

    it('throws when no providers are configured', () => {
      const emptyRegistry = new ProviderRegistry(
        [makeProvider('cf', false), makeProvider('mikrotik', false)],
        logger,
      );
      expect(() => emptyRegistry.initialize()).toThrow('No providers configured');
    });
  });

  describe('getAll', () => {
    it('returns all registered providers', () => {
      sut.initialize();
      expect(sut.getAll()).toHaveLength(1);
      expect(sut.getAll()[0].providerKey).toBe('cf');
    });
  });

  describe('resolve', () => {
    beforeEach(() => sut.initialize());

    it('resolves a known configured provider', () => {
      expect(sut.resolve(['cf'])).toHaveLength(1);
    });

    it('returns empty and warns for unknown provider', () => {
      const result = sut.resolve(['unknown']);
      expect(result).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("unknown or unconfigured provider 'unknown'"),
      );
    });

    it('returns empty and warns for unconfigured provider', () => {
      const result = sut.resolve(['mikrotik']);
      expect(result).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('resolves "all" to all registered providers', () => {
      expect(sut.resolve(['all'])).toHaveLength(1);
    });

    it('resolves multiple keys', () => {
      const bothConfigured = new ProviderRegistry(
        [makeProvider('cf', true), makeProvider('mikrotik', true)],
        logger,
      );
      bothConfigured.initialize();
      expect(bothConfigured.resolve(['cf', 'mikrotik'])).toHaveLength(2);
    });
  });
});
