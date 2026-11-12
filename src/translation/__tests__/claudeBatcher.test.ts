import { ClaudeBatcher } from '../claudeBatcher';
import type { LineRequest } from '../types';

const line = (id: string): LineRequest => ({ id, text: `text ${id}`, previous: [], next: [] });
const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('ClaudeBatcher', () => {
  it('batches read-ahead lines up to maxLines', async () => {
    const batches: string[][] = [];
    const batcher = new ClaudeBatcher({
      maxLines: 3,
      windowMs: 1000,
      run: async (_key, lines) => {
        batches.push(lines.map(l => l.id));
        return new Map(lines.map(l => [l.id, `T(${l.id})`]));
      },
    });
    const results = await Promise.all(['a', 'b', 'c'].map(id => batcher.add('v', line(id), 'readahead')));
    expect(results).toEqual(['T(a)', 'T(b)', 'T(c)']);
    expect(batches).toEqual([['a', 'b', 'c']]);
  });

  it('flushes a partial read-ahead batch after the window', async () => {
    const batches: string[][] = [];
    const batcher = new ClaudeBatcher({
      maxLines: 8,
      windowMs: 30,
      run: async (_k, lines) => {
        batches.push(lines.map(l => l.id));
        return new Map(lines.map(l => [l.id, 'x']));
      },
    });
    const p = batcher.add('v', line('a'), 'readahead');
    await tick(5);
    expect(batches).toEqual([]);
    await p;
    expect(batches).toEqual([['a']]);
  });

  it('a live line is not held for the batch window', async () => {
    const started: number[] = [];
    const t0 = Date.now();
    const batcher = new ClaudeBatcher({
      maxLines: 8,
      windowMs: 500,
      run: async (_k, lines) => {
        started.push(Date.now() - t0);
        return new Map(lines.map(l => [l.id, 'x']));
      },
    });
    await batcher.add('v', line('live'), 'live');
    expect(started[0]).toBeLessThan(100);
  });

  it('keeps separate batches per key and resolves missing ids as null', async () => {
    const batcher = new ClaudeBatcher({
      maxLines: 2,
      windowMs: 1000,
      run: async (key, lines) => new Map(lines.filter(l => l.id !== 'b').map(l => [l.id, `${key}:${l.id}`])),
    });
    const [a, c, b, d] = await Promise.all([
      batcher.add('v1', line('a'), 'readahead'),
      batcher.add('v2', line('c'), 'readahead'),
      batcher.add('v1', line('b'), 'readahead'),
      batcher.add('v2', line('d'), 'readahead'),
    ]);
    expect([a, b, c, d]).toEqual(['v1:a', null, 'v2:c', 'v2:d']);
  });

  it('rejects every line of a failed batch', async () => {
    const batcher = new ClaudeBatcher({ maxLines: 2, windowMs: 1000, run: async () => Promise.reject(new Error('429')) });
    const results = await Promise.allSettled([batcher.add('v', line('a'), 'readahead'), batcher.add('v', line('b'), 'readahead')]);
    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
  });
});
