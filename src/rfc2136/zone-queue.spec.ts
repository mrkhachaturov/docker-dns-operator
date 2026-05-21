import { ZoneQueue } from './zone-queue';

describe('ZoneQueue', () => {
  it('runs same-zone operations in submission order', async () => {
    const queue = new ZoneQueue();
    const log: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      await new Promise((r) => {
        setTimeout(r, ms);
      });
      log.push(label);
    };

    const a = queue.enqueue('zone1', slow('A', 20));
    const b = queue.enqueue('zone1', slow('B', 5));
    const c = queue.enqueue('zone1', slow('C', 5));
    await Promise.all([a, b, c]);

    expect(log).toEqual(['A', 'B', 'C']);
  });

  it('runs different zones in parallel', async () => {
    const queue = new ZoneQueue();
    const start = Date.now();
    const sleep = (ms: number) => () =>
      new Promise<void>((r) => {
        setTimeout(r, ms);
      });

    await Promise.all([
      queue.enqueue('zone1', sleep(40)),
      queue.enqueue('zone2', sleep(40)),
    ]);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(75);
  });

  it('skips queued operations when gate returns false', async () => {
    const queue = new ZoneQueue();
    const log: string[] = [];
    let allowed = true;
    queue.setGate(() => allowed);

    const slow = (label: string) => async () => {
      await new Promise((r) => {
        setTimeout(r, 10);
      });
      log.push(label);
    };

    const p1 = queue.enqueue('zone1', slow('A'));
    setTimeout(() => {
      allowed = false;
    }, 1);
    const p2 = queue.enqueue('zone1', slow('B'));
    const p3 = queue.enqueue('zone1', slow('C'));
    await Promise.all([p1, p2, p3]);

    expect(log).toEqual(['A']);
  });

  it('one operation throwing does not break the chain', async () => {
    const queue = new ZoneQueue();
    const log: string[] = [];
    await queue
      .enqueue('zone1', async () => {
        throw new Error('boom');
      })
      .catch(() => log.push('caught-A'));
    await queue.enqueue('zone1', async () => {
      log.push('B');
    });
    expect(log).toEqual(['caught-A', 'B']);
  });
});
