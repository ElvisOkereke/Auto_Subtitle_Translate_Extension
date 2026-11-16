// Live audio captions follow the video (spec 2026-11-13, audio live fallback):
// nothing new appears while paused or during an ad, nothing from before a seek,
// nothing whose speech ended more than 5 s ago, nothing out of order; at most
// two lines, each staying for its reading time - all counted in video time,
// so a pause freezes the lines on screen.
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
}

interface Line {
  id: string;
  until: number;
  speechEnd: number;
}

export class CaptionPolicy {
  private lines: Line[] = [];
  private newestSpeechEnd = -Infinity;

  /** Whether a caption may appear now; when shown it joins the roll (a third line pushes out the oldest). */
  offer(c: OfferedCaption, now: VideoNow): 'show' | 'drop' {
    if (now.paused || now.adShowing || now.seekedSinceSpeech) return 'drop';
    const speechEnd = c.speechEndVideo ?? now.videoTime;
    if (now.videoTime - speechEnd > STALE_AFTER_S) return 'drop';
    if (speechEnd < this.newestSpeechEnd) return 'drop';
    this.newestSpeechEnd = speechEnd;
    this.lines.push({ id: c.id, until: now.videoTime + minDisplaySeconds(c.text), speechEnd });
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

  /** A better translation of a visible line keeps its timing; false if the line is gone. */
  upgrade(id: string, _text?: string): boolean {
    return this.lines.some(l => l.id === id);
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
