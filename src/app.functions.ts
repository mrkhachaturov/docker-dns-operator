import { DnsbaseEntry } from './dto/dnsbase-entry';
import { IProviderRecord } from './providers/provider-record.interface';

export type SetDifference<T extends IProviderRecord = IProviderRecord> = {
  unchanged: T[];
  add: DnsbaseEntry[];
  update: { old: T; update: DnsbaseEntry }[];
  delete: T[];
};

export function computeSetDifference<T extends IProviderRecord>(
  dockerEntries: DnsbaseEntry[],
  providerRecords: T[],
): SetDifference<T> {
  const dockerIndex = dockerEntries.reduce(
    (acc, entry) => ({ ...acc, [entry.Key]: entry }),
    {} as Record<string, DnsbaseEntry>,
  );

  const matchIndex = providerRecords.reduce(
    (acc, record) => ({
      ...acc,
      [record.Key]: { provider: record, docker: dockerIndex[record.Key] },
    }),
    {} as Record<string, { docker: DnsbaseEntry | undefined; provider: T }>,
  );

  const result: SetDifference<T> = {
    add: Object.entries(dockerIndex)
      .filter(([key]) => matchIndex[key] === undefined)
      .map(([, value]) => value),
    update: [],
    delete: [],
    unchanged: [],
  };

  Object.values(matchIndex).forEach(({ docker, provider }) => {
    if (docker === undefined) {
      result.delete.push(provider);
      return;
    }
    if (provider.hasSameValue(docker)) {
      result.unchanged.push(provider);
    } else {
      result.update.push({ old: provider, update: docker });
    }
  });

  return result;
}
