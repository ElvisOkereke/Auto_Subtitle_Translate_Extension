// audioReadAhead.ts - isolated-world side of audio read-ahead: drives the
// main-world tap (mseTap.main.ts) and accepts the 16 kHz PCM chunks it posts.
//
// Chunks arrive over window.postMessage, which the page can also post to.
// Forged audio can at worst produce wrong captions, so the defence is to bound
// it to what real playback produces: from just behind the playhead to at most
// 100 s ahead (the tap decodes up to 90 s ahead; the element's buffered range
// can't bound it - on YouTube that is the shorter video buffer), at most 1.25 s
// per chunk, never overlapping audio already accepted, and no more in total
// than playback could have buffered.

export type AudioChunkHandler = (videoTime: number, pcm: Float32Array) => void;

export const AUDIO_RATE = 16000;
const MAX_CHUNK_SECONDS = 1.25;
const MAX_AHEAD_SECONDS = 100;
const BURST_SECONDS = 120;
const SECONDS_PER_WALL_SECOND = 4;
const HEALTHY_LEAD_SECONDS = 2;
const RESET_EVERY_MS = 2000;

export class AudioReadAhead {
  /** Accepted audio, as merged [start, end] spans in video seconds. */
  private covered: [number, number][] = [];
  private acceptedSeconds = 0;
  private startedAt = 0;
  private lastResetAt = -Infinity;
  private onChunk: AudioChunkHandler | null = null;
  private onReset: ((videoTime: number) => void) | null = null;
  chunksAccepted = 0;

  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== window || !this.onChunk) return;
    const msg = event.data;
    if (msg?.astAudioReset) {
      const now = this.now();
      if (now - this.lastResetAt < RESET_EVERY_MS || typeof msg.t !== 'number') return;
      this.lastResetAt = now;
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
    if (seconds <= 0 || seconds > MAX_CHUNK_SECONDS) return false;
    if (t < this.video.currentTime - 2 || t + seconds > this.video.currentTime + MAX_AHEAD_SECONDS) return false;
    const end = t + seconds;
    if (this.covered.some(([a, b]) => Math.min(b, end) - Math.max(a, t) > 0.05)) return false;
    const budget = BURST_SECONDS + ((this.now() - this.startedAt) / 1000) * SECONDS_PER_WALL_SECOND;
    if (this.acceptedSeconds + seconds > budget + 1e-6) return false;
    this.acceptedSeconds += seconds;
    this.cover(t, end);
    return true;
  }

  private cover(a: number, b: number): void {
    const spans = [...this.covered, [a, b] as [number, number]].sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of spans) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 0.05) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    // Bounded memory on very long sessions: the oldest spans go first.
    this.covered = merged.slice(-2000);
  }

  /** Seconds of audio accepted ahead of the playhead (in the covered span holding it). */
  get lead(): number {
    const t = this.video.currentTime;
    const span = this.covered.find(([a, b]) => a <= t + 0.05 && b > t);
    return span ? span[1] - t : 0;
  }

  get healthy(): boolean {
    return this.lead >= HEALTHY_LEAD_SECONDS;
  }

  start(onChunk: AudioChunkHandler, onReset: (videoTime: number) => void): void {
    this.onChunk = onChunk;
    this.onReset = onReset;
    this.startedAt = this.now();
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
