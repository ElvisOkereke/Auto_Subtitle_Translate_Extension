// serialQueue.ts - Runs async jobs one at a time with a bounded backlog.
//
// Live captions care more about staying current than about completeness: if
// transcription falls behind real time, the oldest waiting segments are
// dropped so latency can't grow without bound. Jobs that are already running
// are never interrupted.

export interface QueuedJob<T> {
  payload: T;
  enqueuedAt: number;
}

export class SerialQueue<T> {
  private backlog: QueuedJob<T>[] = [];
  private running = false;
  private droppedCount = 0;

  constructor(
    private readonly run: (job: QueuedJob<T>) => Promise<void>,
    private readonly maxBacklog: number,
    private readonly onDrop: (job: QueuedJob<T>) => void = () => undefined,
    private readonly now: () => number = () => Date.now()
  ) {}

  get dropped(): number {
    return this.droppedCount;
  }

  get pending(): number {
    return this.backlog.length;
  }

  push(payload: T): void {
    this.backlog.push({ payload, enqueuedAt: this.now() });
    while (this.backlog.length > this.maxBacklog) {
      const dropped = this.backlog.shift()!;
      this.droppedCount++;
      this.onDrop(dropped);
    }
    void this.pump();
  }

  /** Resolves once the queue is empty and idle. */
  async drain(): Promise<void> {
    while (this.running || this.backlog.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.backlog.length) {
        const job = this.backlog.shift()!;
        try {
          await this.run(job);
        } catch {
          // run() is responsible for reporting its own errors.
        }
      }
    } finally {
      this.running = false;
    }
  }
}
