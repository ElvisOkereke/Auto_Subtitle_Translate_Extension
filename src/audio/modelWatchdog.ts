// modelWatchdog.ts - a speech model that never finishes loading must not leave
// Audio mode silently dead. Two phases, judged differently:
// - downloading: progress arrives every 5%; nothing for STALL_MS means a stuck
//   (or corrupted) download - retry once with a fresh download;
// - preparing (after the download, setting the model up on the GPU: shader
//   compilation, weight upload): no progress events at all and, for the large
//   model the first time, minutes - allowed PREPARE_MS, then retried WITHOUT
//   deleting the download, then the smaller model is used instead.
// Seen on real hardware: the 3-minute download rule killed the large model
// while it was preparing, re-downloaded 1.6 GB, and gave up.

/** A large model reports download progress every 5%; on a slow connection that can take over a minute. */
export const STALL_MS = 180_000;
/** Setting the large model up on the GPU the first time took 7.7 min on an RTX 3070 (later loads: under 3 s); slower GPUs need more. */
export const PREPARE_MS = 900_000;

export type WatchdogVerdict = 'ok' | 'retry-fresh' | 'retry' | 'fallback' | 'fail';

export class ModelWatchdog {
  private phase: 'idle' | 'downloading' | 'preparing' | 'ready' = 'idle';
  private since = 0;
  private freshRetried = false;
  private prepareRetried = false;
  private fellBack = false;
  private reported = false;

  /** Loading started (or restarted). */
  started(now: number): void {
    this.phase = 'downloading';
    this.since = now;
  }

  progress(now: number): void {
    if (this.phase === 'downloading') this.since = now;
  }

  /** Every file is downloaded (or was cached): now it is set up on the device. */
  preparing(now: number): void {
    this.phase = 'preparing';
    this.since = now;
  }

  ready(): void {
    this.phase = 'ready';
  }

  check(now: number): WatchdogVerdict {
    if (this.reported || this.phase === 'idle' || this.phase === 'ready') return 'ok';
    if (this.phase === 'downloading') {
      if (now - this.since < STALL_MS) return 'ok';
      this.since = now;
      if (!this.freshRetried) {
        this.freshRetried = true;
        return 'retry-fresh';
      }
      return this.giveUpOrFallBack();
    }
    if (now - this.since < PREPARE_MS) return 'ok';
    this.since = now;
    if (!this.prepareRetried) {
      this.prepareRetried = true;
      return 'retry';
    }
    return this.giveUpOrFallBack();
  }

  private giveUpOrFallBack(): WatchdogVerdict {
    if (!this.fellBack) {
      this.fellBack = true;
      return 'fallback';
    }
    this.reported = true;
    return 'fail';
  }
}
