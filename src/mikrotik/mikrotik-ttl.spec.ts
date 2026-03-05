import { secondsToMikrotikTTL, mikrotikTTLToSeconds } from './mikrotik-ttl';

describe('secondsToMikrotikTTL', () => {
  it.each([
    [0,     '0s'],
    [1,     '1s'],
    [60,    '1m'],
    [61,    '1m1s'],
    [3600,  '1h'],
    [3661,  '1h1m1s'],
    [86400, '1d'],
    [90061, '1d1h1m1s'],
    [7200,  '2h'],
  ])('converts %p seconds to "%s"', (seconds, expected) => {
    expect(secondsToMikrotikTTL(seconds)).toBe(expected);
  });

  it('throws for negative TTL', () => {
    expect(() => secondsToMikrotikTTL(-1)).toThrow();
  });
});

describe('mikrotikTTLToSeconds', () => {
  it.each([
    ['0s',        0],
    ['1s',        1],
    ['1m',        60],
    ['1m1s',      61],
    ['1h',        3600],
    ['1h1m1s',    3661],
    ['1d',        86400],
    ['1d1h1m1s',  90061],
    ['2h',        7200],
  ])('converts "%s" to %p seconds', (ttl, expected) => {
    expect(mikrotikTTLToSeconds(ttl)).toBe(expected);
  });

  it('returns 0 for empty string', () => {
    expect(mikrotikTTLToSeconds('')).toBe(0);
  });

  it('throws for invalid duration string', () => {
    expect(() => mikrotikTTLToSeconds('invalid')).toThrow();
  });

  it('throws for negative values in duration', () => {
    expect(() => mikrotikTTLToSeconds('-1h')).toThrow();
  });
});
