// Live audio captions follow the video (spec 2026-11-13, audio live fallback):
// nothing new appears while paused or during an ad, nothing from before a seek,
// nothing whose speech ended more than 5 s ago, nothing out of order; at most
// two lines, each staying for its reading time. Lines live in video time, so a
// pause freezes them; the 5 s and the reading time are real seconds, so at 2x
// they span twice the video time.
import { minDisplaySeconds } from '../subtitle/displayPolicy';

export const STALE_AFTER_S = 5;
const MAX_LINES = 2;

export interface OfferedCaption {
  id: string;
  text: string;
  /** When its speech ended in video time (null when unknown: no clock yet). */
  speechEndVideo: number | null;
}

export interface VideoNow {
  videoTime: number;
  paused: boolean;
  adShowing: boolean;
  /** A seek happened after the caption's speech ended. */
  seekedSinceSpeech: boolean;
  /** Playback rate (default 1): video seconds per real second. */
  rate?: number;
}

interface Line {
  id: string;
  until: number;
  speechEnd: number;
}

export type DropReason = 'paused' | 'ad' | 'seek' | 'stale' | 'order';

export class CaptionPolicy {
  private lines: Line[] = [];
  private newestSpeechEnd = -Infinity;
  /** Captions dropped so far, by reason (read by the benchmark). */
  readonly drops: Partial<Record<DropReason, number>> = {};

  private drop(reason: DropReason): 'drop' {
    this.drops[reason] = (this.drops[reason] ?? 0) + 1;
    return 'drop';
  }

  /** Whether a caption may appear now; when shown it joins the roll (a third line pushes out the oldest). */
  offer(c: OfferedCaption, now: VideoNow): 'show' | 'drop' {
    if (now.paused) return this.drop('paused');
    if (now.adShowing) return this.drop('ad');
    if (now.seekedSinceSpeech) return this.drop('seek');
    const rate = now.rate && now.rate > 0 ? now.rate : 1;
    const known = c.speechEndVideo !== null;
    const speechEnd = c.speechEndVideo ?? now.videoTime;
    if ((now.videoTime - speechEnd) / rate > STALE_AFTER_S) return this.drop('stale');
    if (known && speechEnd < this.newestSpeechEnd) return this.drop('order');
    // An unknown speech time says nothing about order: it doesn't hold back the next caption.
    if (known) this.newestSpeechEnd = speechEnd;
    this.lines.push({ id: c.id, until: now.videoTime + minDisplaySeconds(c.text) * rate, speechEnd });
    while (this.lines.length > MAX_LINES) this.lines.shift();
    return 'show';
  }

  /** Ids of lines whose reading time is over at this video time. */
  tick(videoTime: number): string[] {
    const t = Math.round(videoTime * 1000);
    const gone = this.lines.filter(l => t >= Math.round(l.until * 1000)).map(l => l.id);
    if (gone.length) this.lines = this.lines.filter(l => !gone.includes(l.id));
    return gone;
  }

  /** A better translation of a visible line: it stays at least the new text's reading time from now; false if the line is gone. */
  upgrade(id: string, text: string, videoTime: number, rate = 1): boolean {
    const line = this.lines.find(l => l.id === id);
    if (!line) return false;
    line.until = Math.max(line.until, videoTime + minDisplaySeconds(text) * (rate > 0 ? rate : 1));
    return true;
  }

  /** Seek / stop: every line goes. */
  clear(): string[] {
    const ids = this.lines.map(l => l.id);
    this.lines = [];
    this.newestSpeechEnd = -Infinity;
    return ids;
  }

  /** Ids on screen, oldest first. */
  visible(): string[] {
    return this.lines.map(l => l.id);
  }
}
