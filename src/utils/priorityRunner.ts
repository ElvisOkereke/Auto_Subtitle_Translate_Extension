// Runs async jobs with a concurrency limit; waiting 'live' jobs always start
// before waiting 'readahead' jobs (a subtitle on screen now beats one coming up).

export type JobPriority = 'live' | 'readahead';

interface Job {
  run: () => Promise<unknown>;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
}

export class PriorityRunner {
  private running = 0;
  private queues: Record<JobPriority, Job[]> = { live: [], readahead: [] };

  constructor(private readonly concurrency: number) {}

  run<T>(fn: () => Promise<T>, priority: JobPriority): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[priority].push({ run: fn, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const job = this.queues.live.shift() ?? this.queues.readahead.shift();
      if (!job) return;
      this.running++;
      job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}
