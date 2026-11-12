import { PriorityRunner } from '../priorityRunner';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

describe('PriorityRunner', () => {
  it('runs waiting live jobs before waiting read-ahead jobs', async () => {
    const runner = new PriorityRunner(1);
    const order: string[] = [];
    const gate = deferred();
    const a = runner.run(async () => { await gate.promise; order.push('A'); }, 'readahead');
    const b = runner.run(async () => { order.push('B'); }, 'readahead');
    const c = runner.run(async () => { order.push('C'); }, 'live');
    gate.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['A', 'C', 'B']);
  });

  it('never exceeds the concurrency limit', async () => {
    const runner = new PriorityRunner(2);
    let running = 0;
    let peak = 0;
    const job = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5));
      running--;
    };
    await Promise.all([1, 2, 3, 4, 5].map(i => runner.run(job, i % 2 ? 'live' : 'readahead')));
    expect(peak).toBe(2);
  });

  it('propagates results and errors to the caller', async () => {
    const runner = new PriorityRunner(1);
    await expect(runner.run(async () => 42, 'live')).resolves.toBe(42);
    await expect(runner.run(async () => { throw new Error('boom'); }, 'live')).rejects.toThrow('boom');
    await expect(runner.run(async () => 'still works', 'readahead')).resolves.toBe('still works');
  });
});
