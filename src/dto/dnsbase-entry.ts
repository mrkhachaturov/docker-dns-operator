import { IsEnum, IsFQDN, IsOptional, IsArray, IsString } from 'class-validator';

export interface IHasDnsType {
  type: DNSTypes;
}

export enum DNSTypes {
  A = 'A',
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
  type: DNSTypes;

  @IsFQDN()
  name: string;

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
