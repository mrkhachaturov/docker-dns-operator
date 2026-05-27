import { DomainFilter } from './types';
import { matchDomain } from './domain-filter';

describe('matchDomain', () => {
  describe('empty / nil filter — match-all', () => {
    it('returns true when filter is null', () => {
      expect(matchDomain(null, 'anything.example.com')).toBe(true);
    });

    it('returns true when filter is undefined', () => {
      expect(matchDomain(undefined, 'anything.example.com')).toBe(true);
    });

    it('returns true when include is empty', () => {
      expect(matchDomain({}, 'anything.example.com')).toBe(true);
    });

    it('returns true when include is an empty array', () => {
      expect(matchDomain({ include: [] }, 'anything.example.com')).toBe(true);
    });
  });

  describe('include — exact and label-boundary suffix', () => {
    const f: DomainFilter = { include: ['example.com'] };

    it('matches the apex exactly', () => {
      expect(matchDomain(f, 'example.com')).toBe(true);
    });

    it('matches a subdomain at label boundary', () => {
      expect(matchDomain(f, 'app.example.com')).toBe(true);
    });

    it('matches a nested subdomain', () => {
      expect(matchDomain(f, 'a.b.c.example.com')).toBe(true);
    });

    it('does NOT match a domain that is a prefix-substring (no label boundary)', () => {
      expect(matchDomain(f, 'fakeexample.com')).toBe(false);
    });

    it('does NOT match an unrelated zone', () => {
      expect(matchDomain(f, 'other.com')).toBe(false);
    });

    it('matches multiple include zones (any match passes)', () => {
      const fm: DomainFilter = { include: ['example.com', 'other.com'] };
      expect(matchDomain(fm, 'a.other.com')).toBe(true);
      expect(matchDomain(fm, 'a.example.com')).toBe(true);
      expect(matchDomain(fm, 'a.third.com')).toBe(false);
    });
  });

  describe('include — leading-dot subdomain-only form', () => {
    const f: DomainFilter = { include: ['.example.com'] };

    it('matches a subdomain', () => {
      expect(matchDomain(f, 'app.example.com')).toBe(true);
    });

    it('does NOT match the apex itself', () => {
      // Leading-dot form is subdomain-only — apex falls outside.
      expect(matchDomain(f, 'example.com')).toBe(false);
    });

    it('matches a deeply nested subdomain', () => {
      expect(matchDomain(f, 'x.y.z.example.com')).toBe(true);
    });
  });

  describe('exclude — narrows an include', () => {
    const f: DomainFilter = {
      include: ['example.com'],
      exclude: ['internal.example.com'],
    };

    it('includes records outside the exclusion', () => {
      expect(matchDomain(f, 'public.example.com')).toBe(true);
    });

    it('excludes the excluded subdomain', () => {
      expect(matchDomain(f, 'internal.example.com')).toBe(false);
    });

    it('excludes records under the excluded subdomain', () => {
      expect(matchDomain(f, 'db.internal.example.com')).toBe(false);
    });

    it('still includes the apex', () => {
      expect(matchDomain(f, 'example.com')).toBe(true);
    });
  });

  describe('normalization', () => {
    it('is case-insensitive on the domain', () => {
      const f: DomainFilter = { include: ['example.com'] };
      expect(matchDomain(f, 'App.Example.COM')).toBe(true);
    });

    it('is case-insensitive on the filter', () => {
      const f: DomainFilter = { include: ['Example.COM'] };
      expect(matchDomain(f, 'app.example.com')).toBe(true);
    });

    it('treats trailing-dot zones as equivalent', () => {
      expect(
        matchDomain({ include: ['example.com.'] }, 'app.example.com'),
      ).toBe(true);
      expect(
        matchDomain({ include: ['example.com'] }, 'app.example.com.'),
      ).toBe(true);
    });

    it('skips empty filter strings without false-matching', () => {
      expect(
        matchDomain({ include: ['', 'example.com'] }, 'x.example.com'),
      ).toBe(true);
      expect(matchDomain({ include: [''] }, 'x.example.com')).toBe(false);
    });
  });

  describe('regex form — currently unsupported, falls back to list', () => {
    it('falls open when only regexInclude is set (no include list)', () => {
      // Sidecars in this project don't emit regex form. If one does in the
      // future, we treat it as match-all so a misconfigured sidecar never
      // silently drops records. Callers that need strict regex enforcement
      // should add it explicitly.
      expect(
        matchDomain({ regexInclude: '^app\\..*' }, 'anything.example.com'),
      ).toBe(true);
    });

    it('still honours include/exclude alongside regex fields', () => {
      const f: DomainFilter = {
        include: ['example.com'],
        regexInclude: '^x\\..*',
      };
      expect(matchDomain(f, 'app.example.com')).toBe(true);
      expect(matchDomain(f, 'app.other.com')).toBe(false);
    });
  });
});
