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

describe('normalizeProviderOptions — rfc2136', () => {
  it('parses providerOptions.rfc2136.ttl from a raw entry object', () => {
    const result = normalizeProviderOptions({
      providerOptions: { rfc2136: { ttl: 900 } },
    });
    expect(result?.rfc2136?.ttl).toBe(900);
  });

  it('coexists with cf.proxy in the same entry', () => {
    const result = normalizeProviderOptions({
      providerOptions: { cf: { proxy: false }, rfc2136: { ttl: 600 } },
    });
    expect(result?.cf?.proxy).toBe(false);
    expect(result?.rfc2136?.ttl).toBe(600);
  });

  it('returns undefined when neither cf nor rfc2136 options are set', () => {
    expect(normalizeProviderOptions({})?.rfc2136).toBeUndefined();
  });

  it('rejects non-numeric or non-positive ttl as malformed (returns null)', () => {
    expect(
      normalizeProviderOptions({
        providerOptions: { rfc2136: { ttl: 'abc' } },
      }),
    ).toBeNull();
    expect(
      normalizeProviderOptions({ providerOptions: { rfc2136: { ttl: 0 } } }),
    ).toBeNull();
    expect(
      normalizeProviderOptions({ providerOptions: { rfc2136: { ttl: -1 } } }),
    ).toBeNull();
  });
});
