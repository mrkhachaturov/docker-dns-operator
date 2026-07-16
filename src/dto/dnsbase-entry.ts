import { IsEnum, IsFQDN, IsOptional, IsArray, IsString } from 'class-validator';

export interface IHasDnsType {
  type: DNSTypes;
}

export enum DNSTypes {
  A = 'A',
  AAAA = 'AAAA',
  CNAME = 'CNAME',
  MX = 'MX',
  NS = 'NS',
  Unsupported = 'Unsupported',
}

/** Provider-specific options, keyed by providerKey */
export interface IProviderOptions {
  cf?: {
    /** CloudFlare proxy toggle. Only meaningful for A and CNAME records. */
    proxy?: boolean;
  };
  [key: string]: Record<string, unknown> | undefined;
}

export abstract class DnsbaseEntry {
  @IsEnum(DNSTypes)
  type!: DNSTypes;

  // allow_wildcard lets a record name lead with `*.` (e.g. *.dev.example.com).
  // Only the record *name* may be a wildcard — CNAME/MX/NS values stay strict FQDNs.
  @IsFQDN({ allow_wildcard: true })
  name!: string;

  /**
   * Normalized list of provider keys this entry targets.
   * Values: ['cf'], ['mikrotik'], ['all'], ['cf', 'mikrotik'], etc.
   * Set by DockerService during label parsing. Not present on CloudFlare/MikroTik records.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  providers?: string[];

  /**
   * Normalized routing tags this entry targets. Each tag expands to every
   * provider declared with it via WEBHOOK_<NAME>_TAGS, unioned with
   * `providers`. Absent when the label omits `tags`. Set by DockerService
   * during label parsing.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  /**
   * Provider-specific options extracted from the Docker label.
   * Example: { cf: { proxy: true } } for CloudFlare proxy on A/CNAME records.
   */
  @IsOptional()
  providerOptions?: IProviderOptions;

  /** Composite key for set-diff matching. Separator is `:` to avoid ambiguity. */
  get Key(): string {
    return `${this.type}:${this.name}`;
  }

  abstract hasSameValue(otherEntry: DnsbaseEntry): boolean;
}
