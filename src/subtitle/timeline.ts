// Per-video record of subtitle lines read so far (time range, source text, translation).

export type TranslationQuality = 'none' | 'fast' | 'better';

export interface TimelineLine {
  start: number;
  end: number | null; // null while the line is still on screen
  source: string;
  translation: string | null;
  quality: TranslationQuality;
}

const RANK: Record<TranslationQuality, number> = { none: 0, fast: 1, better: 2 };

export class Timeline {
  private lines: TimelineLine[];

  constructor(lines: TimelineLine[] = []) {
    this.lines = [...lines].sort((a, b) => a.start - b.start);
  }

  toJSON(): TimelineLine[] {
    return this.lines.map(l => ({ ...l }));
  }

  get size(): number {
    return this.lines.length;
  }

  at(t: number): TimelineLine | null {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i];
      if (line.start <= t) return line.end === null || t < line.end ? line : null;
    }
    return null;
  }

  upsert(line: Omit<TimelineLine, 'quality' | 'translation'>): TimelineLine {
    const existing = this.lines.find(l => l.start === line.start);
    if (existing) {
      if (existing.source !== line.source) {
        existing.translation = null;
        existing.quality = 'none';
      }
      existing.source = line.source;
      existing.end = line.end;
      return existing;
    }
    const created: TimelineLine = { ...line, translation: null, quality: 'none' };
    const index = this.lines.findIndex(l => l.start > line.start);
    this.lines.splice(index === -1 ? this.lines.length : index, 0, created);
    return created;
  }

  setTranslation(start: number, text: string, quality: 'fast' | 'better'): void {
    const line = this.lines.find(l => l.start === start);
    if (!line || RANK[quality] < RANK[line.quality]) return;
    line.translation = text;
    line.quality = quality;
  }

  /**
   * Lines saved while still on screen (tab closed, crash) have no end; give each
   * one the next line's start, capped at maxDuration, so none stretches forever.
   */
  closeOpenLines(maxDuration: number): void {
    this.lines.forEach((line, i) => {
      if (line.end !== null) return;
      const next = this.lines[i + 1];
      line.end = Math.min(line.start + maxDuration, next ? next.start : Infinity);
    });
  }

  /** Live line objects matching a predicate (callers may update them through this timeline). */
  matching(pred: (line: TimelineLine) => boolean): TimelineLine[] {
    return this.lines.filter(pred);
  }

  close(start: number, end: number): void {
    const line = this.lines.find(l => l.start === start);
    if (line) line.end = end;
  }

  neighbours(start: number, n: number): { previous: string[]; next: string[] } {
    const index = this.lines.findIndex(l => l.start === start);
    if (index === -1) return { previous: [], next: [] };
    return {
      previous: this.lines.slice(Math.max(0, index - n), index).map(l => l.source),
      next: this.lines.slice(index + 1, index + 1 + n).map(l => l.source),
    };
  }
}

const DB_NAME = 'ast-subtitles';
const STORE = 'timelines';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Where SubtitleMode persists timelines (the content script talks to the extension-origin store). */
export interface TimelineStorage {
  load(videoId: string): Promise<Timeline>;
  save(videoId: string, timeline: Timeline): Promise<void>;
}

/**
 * IndexedDB persistence, keyed by video id. Runs in the extension's origin
 * (the hidden OCR iframe) so the website can't read or alter saved subtitles.
 */
export class TimelineStore implements TimelineStorage {
  private constructor(private db: IDBDatabase) {}

  static async open(): Promise<TimelineStore> {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    return new TimelineStore(await request(req));
  }

  async load(videoId: string): Promise<Timeline> {
    const tx = this.db.transaction(STORE, 'readonly');
    const lines = (await request(tx.objectStore(STORE).get(videoId))) as TimelineLine[] | undefined;
    return new Timeline(lines ?? []);
  }

  async save(videoId: string, timeline: Timeline): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite');
    await request(tx.objectStore(STORE).put(timeline.toJSON(), videoId));
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite');
    await request(tx.objectStore(STORE).clear());
  }
}
