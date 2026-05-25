import { DNSTypes } from './dnsbase-entry';

/**
 * Shape of a single DNS entry as it arrives from a Docker label JSON blob,
 * before normalisation/validation. Mirrors the historical Cloudflare wire
 * shape — kept as a plain type so JSON.parse can cast straight into it.
 */
export type DnsBaseCloudflareEntry = {
  zoneId: string;
  id: string;
  name: string;
  type: DNSTypes;
};
