import { ProviderSelector, RegisteredProviderMeta } from './provider-selector';

describe('ProviderSelector', () => {
  const registered: RegisteredProviderMeta[] = [
    { providerKey: 'cf-main', tags: ['cloudflare', 'public'] },
    { providerKey: 'cf-backup', tags: ['cloudflare', 'public'] },
    { providerKey: 'tech-home', tags: ['technitium', 'internal'] },
    { providerKey: 'tech-office', tags: ['technitium', 'internal'] },
    { providerKey: 'tech-dmz', tags: ['technitium', 'dmz'] },
  ];
  const selector = new ProviderSelector(registered);

  const keys = (p?: string[], t?: string[]) =>
    [...selector.resolve(p, t).keys].sort();

  describe('backward-compat default', () => {
    it('defaults to ["cf"] when neither providers nor tags are given', () => {
      const res = selector.resolve(undefined, undefined);
      // 'cf' is not registered here, so it surfaces as unknown — proving the
      // default is applied (not silently dropped).
      expect(res.unknownProviders).toEqual(['cf']);
      expect(res.keys.size).toBe(0);
    });

    it('does NOT apply the cf default when only tags are given', () => {
      const res = selector.resolve(undefined, ['technitium']);
      expect(res.unknownProviders).toEqual([]);
      expect([...res.keys].sort()).toEqual([
        'tech-dmz',
        'tech-home',
        'tech-office',
      ]);
    });
  });

  describe('explicit provider keys', () => {
    it('resolves known keys verbatim', () => {
      expect(keys(['cf-main', 'tech-dmz'])).toEqual(['cf-main', 'tech-dmz']);
    });

    it('reports unknown provider keys without dropping the whole entry', () => {
      const res = selector.resolve(['cf-main', 'nope'], undefined);
      expect(res.unknownProviders).toEqual(['nope']);
      expect([...res.keys]).toEqual(['cf-main']);
    });

    it('"all" fans out to every registered provider', () => {
      expect(keys(['all'])).toEqual([
        'cf-backup',
        'cf-main',
        'tech-dmz',
        'tech-home',
        'tech-office',
      ]);
    });
  });

  describe('tags', () => {
    it('resolves a tag to every provider carrying it', () => {
      expect(keys(undefined, ['cloudflare'])).toEqual(['cf-backup', 'cf-main']);
    });

    it('reports an unknown tag (matches zero providers) as loud, not silent', () => {
      const res = selector.resolve(undefined, ['publik']);
      expect(res.unknownTags).toEqual(['publik']);
      expect(res.keys.size).toBe(0);
    });
  });

  describe('union of providers and tags', () => {
    it('unions explicit keys with tag matches, de-duplicating', () => {
      // cf-main explicit + internal tag (tech-home, tech-office)
      expect(keys(['cf-main'], ['internal'])).toEqual([
        'cf-main',
        'tech-home',
        'tech-office',
      ]);
    });

    it('a provider reached by both a key and a tag appears once', () => {
      expect(keys(['tech-dmz'], ['dmz'])).toEqual(['tech-dmz']);
    });

    it('reports unknowns from both fields together', () => {
      const res = selector.resolve(['nope'], ['publik']);
      expect(res.unknownProviders).toEqual(['nope']);
      expect(res.unknownTags).toEqual(['publik']);
    });
  });
});
