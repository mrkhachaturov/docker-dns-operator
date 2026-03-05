import {
  normalizeProviders,
  normalizeProviderOptions,
} from './label-normalizer';

describe('normalizeProviders', () => {
  it('returns ["cf"] when field is absent (backward compat)', () => {
    expect(normalizeProviders(undefined, undefined)).toEqual(['cf']);
  });

  it('normalizes singular provider string to array', () => {
    expect(normalizeProviders('mikrotik', undefined)).toEqual(['mikrotik']);
  });

  it('normalizes providers string "all"', () => {
    expect(normalizeProviders(undefined, 'all')).toEqual(['all']);
  });

  it('normalizes providers array and lowercases', () => {
    expect(normalizeProviders(undefined, ['CF', 'Mikrotik'])).toEqual([
      'cf',
      'mikrotik',
    ]);
  });

  it('returns null for empty array (malformed)', () => {
    expect(normalizeProviders(undefined, [])).toBeNull();
  });

  it('returns null for non-string/array providers (malformed)', () => {
    expect(normalizeProviders(undefined, 123)).toBeNull();
  });

  it('returns null for array with blank tokens (malformed)', () => {
    expect(normalizeProviders(undefined, ['', '  '])).toBeNull();
  });

  it('singular provider string takes precedence if providers absent', () => {
    expect(normalizeProviders('cf', undefined)).toEqual(['cf']);
  });

  it('providers array takes precedence over singular provider', () => {
    expect(normalizeProviders('cf', ['mikrotik'])).toEqual(['mikrotik']);
  });
});

describe('normalizeProviderOptions', () => {
  it('accepts boolean true', () => {
    expect(normalizeProviderOptions({ proxy: true })).toEqual({
      cf: { proxy: true },
    });
  });

  it('accepts boolean false', () => {
    expect(normalizeProviderOptions({ proxy: false })).toEqual({
      cf: { proxy: false },
    });
  });

  it('accepts string "true"', () => {
    expect(normalizeProviderOptions({ proxy: 'true' })).toEqual({
      cf: { proxy: true },
    });
  });

  it('accepts string "false"', () => {
    // Critical: Boolean("false") === true in JS — must parse explicitly
    expect(normalizeProviderOptions({ proxy: 'false' })).toEqual({
      cf: { proxy: false },
    });
  });

  it('returns null for invalid proxy type (number)', () => {
    // Reject rather than coerce — malformed input
    expect(normalizeProviderOptions({ proxy: 1 })).toBeNull();
  });

  it('returns null for invalid proxy type (object)', () => {
    expect(normalizeProviderOptions({ proxy: {} })).toBeNull();
  });

  it('extracts proxy from nested providerOptions.cf.proxy', () => {
    expect(
      normalizeProviderOptions({ providerOptions: { cf: { proxy: false } } }),
    ).toEqual({ cf: { proxy: false } });
  });

  it('returns undefined when no proxy-related fields', () => {
    expect(normalizeProviderOptions({})).toBeUndefined();
  });

  it('nested providerOptions takes precedence over top-level proxy', () => {
    expect(
      normalizeProviderOptions({
        proxy: true,
        providerOptions: { cf: { proxy: false } },
      }),
    ).toEqual({ cf: { proxy: false } });
  });
});
