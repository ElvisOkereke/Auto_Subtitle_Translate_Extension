// audioReadAhead.ts - isolated-world side of audio read-ahead: drives the
// main-world tap (mseTap.main.ts) and accepts the 16 kHz PCM chunks it posts.
//
// Chunks arrive over window.postMessage, which the page can also post to. Each
// accepted second of audio becomes Whisper work and translation calls, so the
// defence bounds it to what real playback produces: from just behind the
// playhead to at most 100 s ahead (the tap decodes up to 90 s ahead; the
// element's buffered range can't bound it - on YouTube that is the shorter
// video buffer), chunks of 0.02-1.25 s, never overlapping audio already
// accepted, and a token bucket of 120 s that refills at 4 s per second (an idle
// hour saves up nothing). Each message costs at least 0.25 s, so slivers can't
// flood the pipeline; the tap's real 1 s chunks, posted in bursts, never hit it.

export type AudioChunkHandler = (videoTime: number, pcm: Float32Array) => void;

export const AUDIO_RATE = 16000;
const MIN_CHUNK_SECONDS = 0.02;
const MAX_CHUNK_SECONDS = 1.25;
const MAX_AHEAD_SECONDS = 100;
const BUCKET_SECONDS = 120;
const REFILL_PER_SECOND = 4;
const MIN_CHARGE_SECONDS = 0.25;
/** Read-ahead takes over at this much audio ahead of the playhead and gives up below the lower mark. */
const HEALTHY_UP_SECONDS = 3;
const HEALTHY_DOWN_SECONDS = 1;
/** Captions arriving too late this often in this long: read-ahead isn't keeping up. */
const LATE_STRIKES = 2;
const LATE_WINDOW_MS = 10_000;
const RESET_EVERY_MS = 2000;

/** Read-ahead runs where the main-world tap runs: YouTube, and loopback for the E2E fixture. */
export function readAheadHost(hostname: string): boolean {
  return /(^|\.)youtube\.com$/.test(hostname) || hostname === 'localhost' || hostname === '127.0.0.1';
}

export class AudioReadAhead {
  /** Accepted audio, as merged [start, end] spans in video seconds. */
  private covered: [number, number][] = [];
  private tokens = BUCKET_SECONDS;
  private tokensAt = 0;
  private lateAt: number[] = [];
  private isHealthy = false;
  private lastResetAt = -Infinity;
  private onChunk: AudioChunkHandler | null = null;
  private onReset: ((videoTime: number) => void) | null = null;
  chunksAccepted = 0;
  /** Why chunks were turned away, and how often accepted audio was forgotten (diagnostics). */
  readonly stats = { accepted: 0, outsideWindow: 0, overlap: 0, budget: 0, size: 0, forgets: 0, resets: 0 };

  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== window || !this.onChunk) return;
    const msg = event.data;
    if (msg?.astAudioReset) {
      const now = this.now();
      if (now - this.lastResetAt < RESET_EVERY_MS || typeof msg.t !== 'number') return;
      this.lastResetAt = now;
      this.stats.resets++;
      this.forget(); // the tap starts again at the playhead
      this.onReset?.(msg.t);
    } else if (msg?.astAudio) {
      if (typeof msg.t !== 'number' || !Number.isFinite(msg.t) || !(msg.pcm instanceof Float32Array)) return;
      if (!this.plausible(msg.t, msg.pcm.length / AUDIO_RATE)) return;
      this.chunksAccepted++;
      this.onChunk(msg.t, msg.pcm);
    }
  };

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly now: () => number = () => performance.now()
  ) {}

  private plausible(t: number, seconds: number): boolean {
    if (seconds < MIN_CHUNK_SECONDS || seconds > MAX_CHUNK_SECONDS) return this.reject('size');
    if (t < this.video.currentTime - 2 || t + seconds > this.video.currentTime + MAX_AHEAD_SECONDS) return this.reject('outsideWindow');
    const end = t + seconds;
    if (this.covered.some(([a, b]) => Math.min(b, end) - Math.max(a, t) > 0.05)) return this.reject('overlap');
    const now = this.now();
    this.tokens = Math.min(BUCKET_SECONDS, this.tokens + ((now - this.tokensAt) / 1000) * REFILL_PER_SECOND);
    this.tokensAt = now;
    const cost = Math.max(seconds, MIN_CHARGE_SECONDS);
    if (cost > this.tokens + 1e-6) return this.reject('budget');
    this.tokens -= cost;
    this.stats.accepted++;
    this.cover(t, end);
    return true;
  }

  private reject(reason: 'size' | 'outsideWindow' | 'overlap' | 'budget'): false {
    this.stats[reason]++;
    return false;
  }

  private cover(a: number, b: number): void {
    const spans = [...this.covered, [a, b] as [number, number]].sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of spans) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 0.05) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    this.covered = merged.slice(-2000); // bounded memory on very long sessions
  }

  /** Whether the accepted audio covers video time t. */
  covers(t: number): boolean {
    return this.covered.some(([a, b]) => a <= t + 0.05 && b > t);
  }

  /** A seek outside what was accepted, or a new source: start over (the same audio may come again). */
  forget(): void {
    this.stats.forgets++;
    this.covered = [];
    this.isHealthy = false;
  }

  /** A read-ahead caption arrived after its time (Whisper isn't keeping up). */
  noteLate(): void {
    this.lateAt.push(this.now());
    if (this.lateAt.length > 10) this.lateAt.shift();
  }

  /** Seconds of audio accepted ahead of the playhead (in the covered span holding it). */
  get lead(): number {
    const t = this.video.currentTime;
    const span = this.covered.find(([a, b]) => a <= t + 0.05 && b > t);
    return span ? span[1] - t : 0;
  }

  /** Read-ahead covers the playhead (with hysteresis), near the end covering what is left is enough. */
  get healthy(): boolean {
    const lead = this.lead;
    const left = Number.isFinite(this.video.duration) ? this.video.duration - this.video.currentTime : Infinity;
    const up = Math.min(HEALTHY_UP_SECONDS, Math.max(0, left - 0.1));
    const down = Math.min(HEALTHY_DOWN_SECONDS, up);
    if (this.isHealthy && lead < down) this.isHealthy = false;
    else if (!this.isHealthy && lead > 0 && lead >= up) this.isHealthy = true;
    const now = this.now();
    const strikes = this.lateAt.filter(at => now - at < LATE_WINDOW_MS).length;
    return this.isHealthy && strikes < LATE_STRIKES;
  }

  start(onChunk: AudioChunkHandler, onReset: (videoTime: number) => void): void {
    this.onChunk = onChunk;
    this.onReset = onReset;
    this.tokensAt = this.now();
    window.addEventListener('message', this.onMessage);
    window.postMessage({ astAudioTap: 'start' }, '*');
  }

  stop(): void {
    window.removeEventListener('message', this.onMessage);
    window.postMessage({ astAudioTap: 'stop' }, '*');
    this.onChunk = null;
    this.onReset = null;
  }
}
