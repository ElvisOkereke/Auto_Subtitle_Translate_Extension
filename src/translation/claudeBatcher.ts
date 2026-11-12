// Groups read-ahead lines into one Claude request (fewer calls, shared cached
// prefix); live lines go out immediately on their own.
import type { LineRequest } from './types';

interface Pending {
  line: LineRequest;
  resolve: (text: string | null) => void;
  reject: (error: unknown) => void;
}

export class ClaudeBatcher {
  private readonly queues = new Map<string, { items: Pending[]; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    private readonly opts: {
      maxLines: number;
      windowMs: number;
      /** Translates one batch for `key`; returns id → translation (missing ids resolve null). */
      run: (key: string, lines: LineRequest[], priority: 'live' | 'readahead') => Promise<Map<string, string>>;
    }
  ) {}

  add(key: string, line: LineRequest, priority: 'live' | 'readahead'): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const item = { line, resolve, reject };
      if (priority === 'live') {
        void this.dispatch(key, [item], 'live');
        return;
      }
      let queue = this.queues.get(key);
      if (!queue) {
        queue = { items: [], timer: null };
        this.queues.set(key, queue);
      }
      queue.items.push(item);
      if (queue.items.length >= this.opts.maxLines) this.flush(key);
      else queue.timer ??= setTimeout(() => this.flush(key), this.opts.windowMs);
    });
  }

  private flush(key: string): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    this.queues.delete(key);
    if (queue.timer) clearTimeout(queue.timer);
    void this.dispatch(key, queue.items, 'readahead');
  }

  private async dispatch(key: string, items: Pending[], priority: 'live' | 'readahead'): Promise<void> {
    try {
      const results = await this.opts.run(
        key,
        items.map(i => i.line),
        priority
      );
      for (const i of items) i.resolve(results.get(i.line.id) ?? null);
    } catch (error) {
      for (const i of items) i.reject(error);
    }
  }
}
