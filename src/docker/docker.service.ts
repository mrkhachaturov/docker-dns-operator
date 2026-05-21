import { Inject, Injectable, LoggerService } from '@nestjs/common';
import Docker from 'dockerode';
import { ConfigService } from '@nestjs/config';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConsoleLoggerService } from '../logger.service';
import { DnsCnameEntry } from '../dto/dnscname-entry';
import { DnsMxEntry } from '../dto/dnsmx-entry';
import { DnsNsEntry } from '../dto/dnsns-entry';
import { DnsbaseEntry, DNSTypes } from '../dto/dnsbase-entry';
import { IConfiguration } from '../app.configuration';
import { NestedError } from '../errors/nested-error';
import { DockerFactory } from './docker.factory';
import { DnsaEntry } from '../dto/dnsa-entry';
import { DnsAaaaEntry } from '../dto/dnsaaaa-entry';
import { DnsBaseCloudflareEntry } from '../dto/dnsbase-entry.spec';
import { getLogClassDecorator } from '../utility.functions';
import {
  normalizeProviders,
  normalizeProviderOptions,
} from './label-normalizer';
import { DockerSource } from './docker-source';

let loggerPointer: LoggerService;
const LogDecorator = getLogClassDecorator(() => loggerPointer);

/**
 * Possibe states of the docker service
 */
export enum States {
  Unintialized,
  Initialized,
}

/**
 * Adapter over dockerode to expose a minimal API for the purpose of this application.
 * Responsible for any interaction with dockerode, including:
 * - Initializing dockerode
 * - Encapsulating exceptions
 * - Querying for containers with labels based on our criteria
 * - Deserializing and validating the JSON labels
 */
@LogDecorator()
@Injectable()
export class DockerService {
  private docker: Docker;

  private dockerLabel: string;

  private preserveStopped: boolean;

  private swarmMode: boolean;

  private state = States.Unintialized;

  constructor(
    @Inject() private readonly dockerFactory: DockerFactory,
    @Inject() private readonly configService: ConfigService<IConfiguration>,
    private loggerService: ConsoleLoggerService,
  ) {
    loggerPointer = this.loggerService;
  }

  /**
   * Initializes the class by fetching the docker instance
   * @throws { Error } If service is already initialized
   * @throws { NestedError } throws if err initializing docker
   */
  initialize(): void {
    if (this.state !== States.Unintialized)
      throw new Error(
        'DockerService, initialize: Failed initializing docker service, service alread initialized',
      );

    try {
      this.docker = this.dockerFactory.get();
    } catch (error) {
      throw new NestedError(
        'DockerService, initialize: Failed initializing docker service',
        error,
      );
    }

    this.dockerLabel = this.configService.get('ENTRY_IDENTIFIER', {
      infer: true,
    }) as string;
    this.preserveStopped = this.configService.get('PRESERVE_STOPPED', {
      infer: true,
    }) as boolean;
    this.swarmMode = this.configService.get('DOCKER_SWARM_MODE', {
      infer: true,
    }) as boolean;

    if (this.swarmMode && this.preserveStopped) {
      this.loggerService.warn(
        'DockerService, initialize: PRESERVE_STOPPED has no effect in DOCKER_SWARM_MODE',
      );
    }

    this.state = States.Initialized;
  }

  /**
   * Returns all sources (containers or swarm services) that have the DNS label.
   * In container mode: calls listContainers.
   * In swarm mode: calls listServices and maps each to DockerSource.
   * @returns Promise resolving to DockerSource array
   * @throws {Error} If service hasn't been initialized
   * @throws {NestedError} If docker throws an error
   */
  async getSources(): Promise<DockerSource[]> {
    if (this.state !== States.Initialized)
      throw new Error(
        'DockerService, getSources: not initialized, must call initialize',
      );

    try {
      if (!this.swarmMode) {
        return await this.docker.listContainers({
          all: this.preserveStopped,
          filters: JSON.stringify({ label: [this.dockerLabel] }),
        });
      }

      // Swarm mode: listServices uses a raw object filter (NOT JSON.stringify).
      const services = await this.docker.listServices({
        filters: { label: [this.dockerLabel] },
      });

      // Only use Spec.Labels (set by deploy.labels in compose).
      const sources = services
        .map((service): DockerSource | null => {
          const labels = service.Spec?.Labels;
          if (!labels) {
            this.loggerService.warn(
              `DockerService, getSources: service ${service.ID} has no labels, skipping`,
            );
            return null;
          }
          return { Id: service.ID, Labels: labels };
        })
        .filter((source): source is DockerSource => source !== null);
      return sources;
    } catch (error) {
      throw new NestedError(
        'DockerService, getSources: Failed getting sources',
        error,
      );
    }
  }

  /**
   * Finds containers with the labels associated with this instance of the docker-compose-external-dns project.
   * Returns the containers information verbatim.
   * @returns Promise resolving to the docker containers
   * @throws {Error} If serivce hasn't been initialized
   * @throws {NestedError} If docker throws an error fetching containers
   * */
  async getContainers(): Promise<Docker.ContainerInfo[]> {
    if (this.state !== States.Initialized)
      throw new Error(
        'DockerService, getContainers: not initialized, must call initialize',
      );
    try {
      return await this.docker.listContainers({
        all: this.preserveStopped,
        filters: JSON.stringify({ label: [this.dockerLabel] }),
      });
    } catch (error) {
      throw new NestedError(
        'DockerService, getContainers: Failed getting containers',
        error,
      );
    }
  }

  /**
   * Contains behavior to deserialize the labels on the containers.
   * Converts to appropriate type and validates
   * @param {DockerSource[]} sources sources with labels to deserialize
   * @returns {DnsbaseEntry[]} deserialized labels
   * @throws {Error} If serivce hasn't been initialized
   */
  @LogDecorator({ level: 'debug' })
  extractDNSEntries(sources: DockerSource[]): DnsbaseEntry[] {
    if (this.state !== States.Initialized)
      throw new Error(
        'DockerService, extractDNSEntries: not initialized, must call initialize',
      );

    const allEntries: DnsbaseEntry[] = [];
    sources.forEach((source) => {
      try {
        // try to parse the JSON
        const entries = JSON.parse(
          source.Labels[this.dockerLabel],
        ) as DnsBaseCloudflareEntry[];
        if (!Array.isArray(entries)) {
          this.loggerService.warn(
            `DockerService, extractDNSEntries: source with id ${source.Id} has an unrecognised shape, check the values`,
          );
          return;
        }
        if (entries.length === 0) {
          this.loggerService.warn(
            `DockerService, extractDNSEntries: source with id ${source.Id} has empty array for a label and has been ignored`,
          );
          return;
        }
        entries.forEach((entry) => {
          if (entry.id !== undefined) {
            this.loggerService.warn(
              `DockerService, extractDNSEntries: source with id ${source.Id} has 'id' within it's JSON label, please remove it`,
            );
            return;
          }

          const rawEntry = entry as Record<string, unknown>;

          // Normalize providers
          const providers = normalizeProviders(
            rawEntry.provider,
            rawEntry.providers,
          );
          if (providers === null) {
            this.loggerService.warn(
              `DockerService, extractDNSEntries: source ${source.Id} has malformed providers field, entry skipped`,
            );
            return;
          }

          // Normalize providerOptions (null = malformed, skip entry)
          const providerOptions = normalizeProviderOptions(rawEntry);
          if (providerOptions === null) {
            this.loggerService.warn(
              `DockerService, extractDNSEntries: source ${source.Id} has malformed proxy field, entry skipped`,
            );
            return;
          }

          // Strip raw proxy/provider fields before instantiation
          const {
            proxy,
            provider,
            providers: rawProvidersField,
            providerOptions: rawProviderOptionsField,
            ...restEntry
          } = rawEntry;

          // Cast to appropriate type
          let instance: DnsbaseEntry;
          switch (entry.type) {
            case DNSTypes.A:
              instance = plainToInstance(DnsaEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.AAAA:
              instance = plainToInstance(DnsAaaaEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.CNAME:
              instance = plainToInstance(DnsCnameEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.MX:
              instance = plainToInstance(DnsMxEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.NS:
              instance = plainToInstance(DnsNsEntry, {
                ...restEntry,
                providers,
                ...(providerOptions ? { providerOptions } : {}),
              });
              break;
            case DNSTypes.Unsupported:
              this.loggerService.warn(
                `DockerService, extractDNSEntries: source with id ${source.Id} is using 'Unsupported' type, it will be ignored`,
              );
              return;
            default:
              this.loggerService.warn(
                `DockerService, extractDNSEntries: source with id ${source.Id} has an unrecognised shape, check the values`,
              );
              return;
          }
          // validate
          const errors = validateSync(instance);
          // warn and ignore if any errors
          if (errors.length !== 0) {
            this.loggerService.warn(
              `DockerService, extractDNSEntries: source with id ${source.Id} has validation errors`,
              errors,
            );
            return;
          }
          allEntries.push(instance);
        });
      } catch (error) {
        // failed to parse the JSON
        this.loggerService.warn(
          `DockerService, extractDNSEntries: source with id ${source.Id} has a non JSON formatted label`,
        );
      }
    });

    return allEntries;
  }
}
