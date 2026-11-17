// readAheadWindows.ts - read-ahead transcription with a sliding window, the way
// Whisper handles long recordings: transcribe ~28 s from a cursor, keep the
// sentences that ended well before the window's edge, and start the next window
// at the last one kept. The unfinished tail is heard again with its context, so
// nothing is cut mid-word or lost between segments (narration rarely pauses
// long enough for a VAD to cut cleanly).

export interface TimedText {
  text: string;
  /** Seconds: relative to the window for complete(), video time in what it returns. */
  start: number;
  end: number;
}

const RATE = 16000;
/** Whisper pads every call to 30 s; a 28 s window uses nearly all of it. */
export const WINDOW_S = 28;
/** Sentences ending this close to a full window's edge are held back for the next window. */
const HOLD_S = 1.5;
/** When the playhead is this close to the cursor, don't wait for a full window... */
const NEAR_S = 8;
/** ...but for at least this much audio (a lone second cuts words and invites hallucinations), */
const SHORT_WINDOW_S = 6;
/** unless the playhead is about to arrive, or no new audio came for a while (the buffer stalled). */
const URGENT_S = 2;
const STALLED_MS = 1500;
const MIN_WINDOW_S = 1;

interface Run {
  start: number;
  chunks: Float32Array[];
  samples: number;
}

export class ReadAheadWindows {
  private run: Run | null = null;
  private cursor = 0;
  private inFlight: { start: number; end: number; partial: boolean; final: boolean } | null = null;
  private lastPushMs = 0;

  private get runEnd(): number {
    return this.run ? this.run.start + this.run.samples / RATE : -Infinity;
  }

  /** Audio from the tap, in order; a gap starts a new run there. */
  push(t: number, pcm: Float32Array, nowMs = 0): void {
    this.lastPushMs = nowMs;
    if (!this.run || Math.abs(t - this.runEnd) > 0.05) {
      this.run = { start: t, chunks: [], samples: 0 };
      this.cursor = t;
      this.inFlight = null;
    }
    this.run.chunks.push(pcm);
    this.run.samples += pcm.length;
  }

  reset(): void {
    this.run = null;
    this.inFlight = null;
  }

  /** The next window to transcribe, or null (one in flight, or not worth sending yet). */
  next(playhead: number, nowMs = 0): { start: number; audio: Float32Array } | null {
    if (this.inFlight || !this.run) return null;
    if (this.cursor < playhead) this.cursor = Math.min(playhead, this.runEnd); // already heard: skip
    const available = this.runEnd - this.cursor;
    const lead = this.cursor - playhead;
    // A short window is final (keeps everything) when the playhead is about to arrive or the audio stalled.
    const final = available >= MIN_WINDOW_S && (lead < URGENT_S || nowMs - this.lastPushMs >= STALLED_MS);
    let end: number;
    let partial = true;
    if (available >= WINDOW_S) {
      end = this.cursor + WINDOW_S;
      partial = false;
    } else if (lead < NEAR_S && (available >= SHORT_WINDOW_S || final)) {
      end = this.runEnd;
    } else return null;
    this.inFlight = { start: this.cursor, end, partial, final: partial && final };
    return { start: this.cursor, audio: this.slice(this.cursor, end) };
  }

  /** The job for the window in flight was lost (dropped or failed): the same window goes again. */
  abort(): void {
    this.inFlight = null;
  }

  /** Whisper's sentences for the window in flight (times relative to it) -> captions in video time. */
  complete(sentences: TimedText[]): TimedText[] {
    const win = this.inFlight;
    this.inFlight = null;
    if (!win) return [];
    const abs = sentences
      .filter(s => Number.isFinite(s.start))
      .map(s => ({ text: s.text.trim(), start: win.start + s.start, end: win.start + (Number.isFinite(s.end) ? s.end : win.end - win.start) }));
    let kept = win.final ? abs : abs.filter(s => s.end <= win.end - HOLD_S);
    if (!kept.length && abs.length && !win.partial) kept = abs; // one sentence fills a full window: keep it, move past it
    if (kept.length) this.cursor = Math.max(this.cursor, kept[kept.length - 1].end);
    else if (!abs.length) this.cursor = win.final ? win.end : Math.max(this.cursor, win.end - HOLD_S); // silence or music: move on
    // (a short window whose only sentence is unfinished keeps the cursor: the next one hears it whole)
    this.trim();
    const cleaned = kept
      .filter(s => !isLoopNoise(s.text)) // before collapsing, which would hide the loop
      .map(s => ({ ...s, text: collapseRepeats(s.text) }))
      .filter(s => s.text && s.end > s.start);
    return mergeShort(cleaned);
  }

  private slice(a: number, b: number): Float32Array {
    const run = this.run!;
    const from = Math.max(0, Math.round((a - run.start) * RATE));
    const to = Math.min(run.samples, Math.round((b - run.start) * RATE));
    const out = new Float32Array(Math.max(0, to - from));
    let offset = 0;
    for (const c of run.chunks) {
      const lo = Math.max(from, offset);
      const hi = Math.min(to, offset + c.length);
      if (hi > lo) out.set(c.subarray(lo - offset, hi - offset), lo - from);
      offset += c.length;
      if (offset >= to) break;
    }
    return out;
  }

  /** Drops audio more than a second before the cursor (bounded memory). */
  private trim(): void {
    const run = this.run;
    if (!run) return;
    while (run.chunks.length > 1 && run.start + run.chunks[0].length / RATE < this.cursor - 1) {
      run.start += run.chunks[0].length / RATE;
      run.samples -= run.chunks[0].length;
      run.chunks.shift();
    }
  }
}

/** One short word looped three or more times ("뒤! 뒤! 뒤!"): game sounds or shouting, not a caption. */
export function isLoopNoise(text: string): boolean {
  const words = text.split(/[\s,.!?~…-]+/u).filter(Boolean).map(w => w.toLowerCase());
  return words.length >= 3 && words.every(w => w === words[0]) && [...words[0]].length <= 6;
}

/** Whisper sometimes loops on a phrase; three or more repeats in a row are kept once. */
export function collapseRepeats(text: string): string {
  return text
    .replace(/(.{2,40}?)(?:\s*\1){2,}/gu, (match, unit: string) => (/^[\d\s.,]+$/.test(unit) ? match : unit))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const MERGE_GAP_S = 0.3;
const MERGE_MAX_S = 4;
const MERGE_MAX_CHARS = 42;

/** Back-to-back short sentences become one readable line (fast talkers otherwise flash by). */
export function mergeShort(sentences: TimedText[]): TimedText[] {
  const out: TimedText[] = [];
  for (const s of sentences) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= MERGE_GAP_S && s.end - last.start <= MERGE_MAX_S && last.text.length + 1 + s.text.length <= MERGE_MAX_CHARS) {
      last.text = `${last.text} ${s.text}`;
      last.end = s.end;
    } else out.push({ ...s });
  }
  return out;
}
