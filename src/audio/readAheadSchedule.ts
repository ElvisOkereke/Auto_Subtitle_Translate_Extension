// readAheadSchedule.ts - read-ahead captions are made before their words are
// spoken; this decides which are on screen at a given video time (spec: Audio
// mode read-ahead). A caption shows from the start of its speech until its end
// (plus a beat) or its minimum reading time, whichever is later; at most two
// lines, the newer below. Captions are kept, so a seek back shows them again
// without transcribing twice; a pause freezes video time and so the screen.
import { minDisplaySeconds } from '../subtitle/displayPolicy';

export interface ScheduledCaption {
  id: string;
  text: string;
  start: number;
  end: number;
}

interface Item extends ScheduledCaption {
  until: number;
  rate: number;
}

const END_BEAT_S = 0.3;
const MAX_LINES = 2;
const MAX_STORED = 1500;

export class ReadAheadSchedule {
  private items: Item[] = [];

  get size(): number {
    return this.items.length;
  }

  private untilOf(c: ScheduledCaption, rate: number): number {
    return Math.max(c.end + END_BEAT_S, c.start + minDisplaySeconds(c.text) * rate);
  }

  /** `rate`: playback rate when it arrived (reading time is real seconds). */
  add(c: ScheduledCaption, rate = 1): void {
    const r = rate > 0 ? rate : 1;
    this.items = this.items.filter(i => i.id !== c.id);
    this.items.push({ ...c, rate: r, until: this.untilOf(c, r) });
    this.items.sort((a, b) => a.start - b.start);
    while (this.items.length > MAX_STORED) {
      // The one furthest from the newest goes first.
      this.items.shift();
    }
  }

  upgrade(id: string, text: string): boolean {
    const item = this.items.find(i => i.id === id);
    if (!item) return false;
    item.text = text;
    item.until = Math.max(item.until, this.untilOf(item, item.rate));
    return true;
  }

  has(id: string): boolean {
    return this.items.some(i => i.id === id);
  }

  /** On screen at video time t: the newest two showing, oldest first. */
  visibleAt(t: number): ScheduledCaption[] {
    const ms = (x: number) => Math.round(x * 1000);
    const showing = this.items.filter(i => ms(i.start) <= ms(t) && ms(t) < ms(i.until));
    return showing.slice(-MAX_LINES).map(({ id, text, start, end }) => ({ id, text, start, end }));
  }

  /** Whether a caption arriving now is already over (it would never be seen). */
  isOver(c: ScheduledCaption, t: number, rate = 1): boolean {
    return this.untilOf(c, rate > 0 ? rate : 1) <= t;
  }

  clear(): void {
    this.items = [];
  }
}
