// src/rfc2136/types.spec.ts
import { RecordsResponse, Rfc2136Rcode } from './types';

describe('rfc2136 types', () => {
  it('discriminates RecordsResponse on ok', () => {
    const ok: RecordsResponse = { ok: true, records: [] };
    const fail: RecordsResponse = {
      ok: false,
      phase: 'tsig-verify',
      message: 'bad sig',
      retryable: false,
    };
    expect(ok.ok).toBe(true);
    expect(fail.ok).toBe(false);
  });

  it('enumerates expected rcodes', () => {
    const rcodes: Rfc2136Rcode[] = [
      'NOERROR',
      'FORMERR',
      'SERVFAIL',
      'NXRRSET',
      'YXRRSET',
      'NOTAUTH',
      'NOTZONE',
      'REFUSED',
    ];
    expect(rcodes).toHaveLength(8);
  });
});
