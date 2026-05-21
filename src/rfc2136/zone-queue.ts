type Gate = (zone: string) => boolean;

const allowAll: Gate = () => true;

export class ZoneQueue {
  private chains = new Map<string, Promise<void>>();

  private gate: Gate = allowAll;

  setGate(g: Gate): void {
    this.gate = g;
  }

  async enqueue<T>(zone: string, op: () => Promise<T>): Promise<T | undefined> {
    const previous = this.chains.get(zone) ?? Promise.resolve();
    let resolveNext!: () => void;
    const next = new Promise<void>((r) => {
      resolveNext = r;
    });
    this.chains.set(zone, next);

    try {
      await previous;
      if (!this.gate(zone)) {
        return undefined;
      }
      return await op();
    } finally {
      resolveNext();
      if (this.chains.get(zone) === next) {
        this.chains.delete(zone);
      }
    }
  }
}
