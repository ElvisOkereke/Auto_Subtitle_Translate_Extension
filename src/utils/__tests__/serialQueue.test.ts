import { SerialQueue } from '../serialQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
}

describe('SerialQueue', () => {
  it('runs jobs one at a time in order', async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const queue = new SerialQueue<string>(async job => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 5));
      order.push(job.payload);
      concurrent--;
    }, 10);

    queue.push('a');
    queue.push('b');
    queue.push('c');
    await queue.drain();

    expect(order).toEqual(['a', 'b', 'c']);
    expect(maxConcurrent).toBe(1);
  });

  it('drops the oldest waiting jobs when the backlog overflows, never the running one', async () => {
    const gate = deferred();
    const ran: number[] = [];
    const dropped: number[] = [];
    const queue = new SerialQueue<number>(
      async job => {
        if (job.payload === 1) await gate.promise;
        ran.push(job.payload);
      },
      2,
      job => dropped.push(job.payload)
    );

    queue.push(1); // starts running immediately
    queue.push(2);
    queue.push(3);
    queue.push(4); // backlog [2,3,4] > 2 -> drop 2
    queue.push(5); // drop 3
    expect(dropped).toEqual([2, 3]);
    expect(queue.dropped).toBe(2);

    gate.resolve();
    await queue.drain();
    expect(ran).toEqual([1, 4, 5]);
  });

  it('keeps going after a job throws', async () => {
    const ran: number[] = [];
    const queue = new SerialQueue<number>(async job => {
      if (job.payload === 1) throw new Error('boom');
      ran.push(job.payload);
    }, 5);
    queue.push(1);
    queue.push(2);
    await queue.drain();
    expect(ran).toEqual([2]);
  });

  it('records when each job was enqueued', async () => {
    let t = 1000;
    const seen: number[] = [];
    const queue = new SerialQueue<string>(
      async job => {
        seen.push(job.enqueuedAt);
      },
      5,
      undefined,
      () => t
    );
    queue.push('x');
    t = 2000;
    queue.push('y');
    await queue.drain();
    expect(seen).toEqual([1000, 2000]);
  });
});
