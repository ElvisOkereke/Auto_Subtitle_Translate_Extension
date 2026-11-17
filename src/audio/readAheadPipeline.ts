// readAheadPipeline.ts - the offscreen document's side of audio read-ahead,
// kept free of Chrome APIs so it can be tested: audio in, one Whisper job at a
// time, captions out in video time. Only the result of the job in flight is
// used; one that comes back after a seek (reset) belongs to the old position
// and is ignored, never shifted onto the new one.
import { ReadAheadWindows, TimedText } from './readAheadWindows';
import { isLikelyHallucination, isNonSpeech } from './nonSpeech';

export interface ReadAheadDeps {
  nextId(): number;
  transcribe(segmentId: number, audio: Float32Array): void;
  emit(caption: TimedText): void;
  now?: () => number;
}

/** The page reports health every second; without a report for this long, read-ahead counts as down. */
const STATE_TTL_MS = 3000;
const MAX_KNOWN = 256;

export class ReadAheadPipeline {
  private windows = new ReadAheadWindows();
  private inFlight: number | null = null;
  /** Ids of jobs this pipeline sent (a result for one of them is read-ahead's, even if stale). */
  private known = new Set<number>();
  private playhead = 0;
  private healthyFlag = false;
  private stateAt = -Infinity;
  nonSpeech = 0;
  windowsSent = 0;
  resets = 0;
  stale = 0;

  constructor(private readonly deps: ReadAheadDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  get healthy(): boolean {
    return this.healthyFlag && this.now() - this.stateAt < STATE_TTL_MS;
  }

  audio(t: number, pcm: Float32Array): void {
    this.windows.push(t, pcm, this.now());
    this.pump();
  }

  state(healthy: boolean, playhead: number): void {
    this.healthyFlag = healthy;
    this.playhead = playhead;
    this.stateAt = this.now();
    this.pump();
  }

  /** A seek or a new source: what was buffered is dropped; a job in flight becomes stale. */
  reset(): void {
    this.resets++;
    this.windows.reset();
    this.inFlight = null;
  }

  private pump(): void {
    if (this.inFlight !== null) return;
    const win = this.windows.next(this.playhead, this.now());
    if (!win) return;
    const id = this.deps.nextId();
    this.inFlight = id;
    this.known.add(id);
    if (this.known.size > MAX_KNOWN) this.known.delete(this.known.values().next().value!);
    this.windowsSent++;
    this.deps.transcribe(id, win.audio);
  }

  /** Whisper's result; true when it was read-ahead's job (stale ones are swallowed, not passed to live). */
  result(segmentId: number, chunks: { text: string; start: number; end: number | null }[] | undefined): boolean {
    if (!this.known.has(segmentId)) return false;
    this.known.delete(segmentId);
    if (segmentId !== this.inFlight) {
      this.stale++;
      return true; // from before a seek: belongs to the old position
    }
    this.inFlight = null;
    const sentences = (Array.isArray(chunks) ? chunks : []).map(c => ({ text: c.text, start: c.start, end: c.end === null ? NaN : c.end }));
    for (const c of this.windows.complete(sentences)) {
      if (isNonSpeech(c.text) || isLikelyHallucination(c.text)) this.nonSpeech++;
      else this.deps.emit(c);
    }
    this.pump();
    return true;
  }

  /** The worker dropped the job: the same window goes again. */
  dropped(segmentId: number | undefined): void {
    if (segmentId === undefined || segmentId !== this.inFlight) return;
    this.windows.abort();
    this.inFlight = null;
    this.pump();
  }

  /** A job failed (or, without an id, the worker itself): free the window; it is retried on the next audio or report. */
  error(segmentId: number | undefined): void {
    if (this.inFlight === null) return;
    if (segmentId !== undefined && segmentId !== this.inFlight) return;
    this.windows.abort();
    this.inFlight = null;
  }
}
