// modelWatchdog.ts - a speech model that never finishes loading (no progress,
// no error: seen in a signed-in profile with hardware acceleration off) must
// not leave Audio mode silently dead. After STALL_MS without progress, retry
// once with a fresh download; stalled again, report a failure.

/** A large model reports download progress every 5%; on a slow connection that can take over a minute. */
export const STALL_MS = 180_000;

export type WatchdogVerdict = 'ok' | 'retry' | 'fail';

export class ModelWatchdog {
  private lastSign: number | null = null;
  private retried = false;
  private reported = false;
  private loaded = false;

  /** Loading started (or restarted). */
  started(now: number): void {
    this.lastSign = now;
    this.loaded = false;
  }

  progress(now: number): void {
    this.lastSign = now;
  }

  ready(): void {
    this.loaded = true;
  }

  check(now: number): WatchdogVerdict {
    if (this.loaded || this.lastSign === null || this.reported) return 'ok';
    if (now - this.lastSign < STALL_MS) return 'ok';
    if (!this.retried) {
      this.retried = true;
      this.lastSign = now;
      return 'retry';
    }
    this.reported = true;
    return 'fail';
  }
}
