// sessionCache.ts - small pure helpers for the OCR worker's session management.

/** Caches one promise per key; a rejected promise is evicted so the next call retries. */
export class PromiseCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  get(key: string, create: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      const created = create();
      entry = created;
      this.entries.set(key, created);
      created.catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key);
      });
    }
    return entry;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Counts failures in a row; failure() returns true once `limit` is reached. */
export class ConsecutiveFailures {
  private count = 0;

  constructor(private readonly limit: number) {}

  success(): void {
    this.count = 0;
  }

  failure(): boolean {
    this.count++;
    return this.count >= this.limit;
  }
}
