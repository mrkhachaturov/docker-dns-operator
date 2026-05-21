// src/rfc2136/types.ts

export type Rfc2136RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'TXT';

export type Rfc2136Rcode =
  | 'NOERROR'
  | 'FORMERR'
  | 'SERVFAIL'
  | 'NXRRSET'
  | 'YXRRSET'
  | 'NOTAUTH'
  | 'NOTZONE'
  | 'REFUSED';

export type Rfc2136Phase =
  | 'kerberos-init'
  | 'gss-negotiate'
  | 'tsig-sign'
  | 'dns-send'
  | 'dns-receive'
  | 'tsig-verify';

export interface Rfc2136Record {
  name: string; // FQDN, lowercase, trailing dot stripped
  type: Rfc2136RecordType;
  ttl: number;
  value: string; // RDATA in canonical zone-file format ("10.1.2.3", "host.example.com.", "10 mx.example.com.")
}

export interface RecordsRequest {
  host: string; // DC FQDN
  port: number;
  zone: string; // zone name, FQDN without trailing dot
}

export type RecordsResponse =
  | { ok: true; records: Rfc2136Record[] }
  | {
      ok: false;
      rcode?: Rfc2136Rcode;
      phase: Rfc2136Phase;
      message: string;
      retryable: boolean;
    };

export interface Prerequisite {
  kind: 'NXRRSET' | 'YXRRSET';
  name: string;
  type: Rfc2136RecordType;
  /** Required only when kind === 'YXRRSET' for value-specific match; omit for type-only. */
  value?: string;
}

export interface Change {
  op: 'add' | 'delete';
  record: Rfc2136Record;
}

export interface ApplyRequest {
  host: string;
  port: number;
  zone: string;
  prerequisites: Prerequisite[];
  changes: Change[];
}

export type ApplyResponse =
  | { ok: true }
  | {
      ok: false;
      rcode?: Rfc2136Rcode;
      phase: Rfc2136Phase;
      message: string;
      retryable: boolean;
    };

export interface HealthResponse {
  ok: boolean;
  kerberos: 'ready' | 'expired' | 'failed';
  detail: string;
}
