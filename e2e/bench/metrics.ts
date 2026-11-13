// Benchmark metrics shared by the real-YouTube benchmark and the local-fixture
// tests. Pure functions over what the overlay showed (ShownRecord, recorded by
// e2e/helpers/subtitles.ts recordOverlay) and a reference timeline.
import { charErrorRate } from '../helpers/cer';
import { minDisplaySeconds } from '../../src/subtitle/displayPolicy';

export { minDisplaySeconds };

/** One overlay appearance. Times are video seconds; `wall*` are performance.now() in the page. */
export interface ShownRecord {
  shownAt: number;
  hiddenAt: number | null;
  lineStart: number;
  text: string;
  pausedAtShow: boolean;
  wallShownAt: number;
  wallHiddenAt: number | null;
  /** 'fast' (DeepL/Google) or 'better' (Claude), from the overlay. */
  quality?: string;
}

/** A reference subtitle line (absolute video seconds). `h`: text height in px at 1080p, when known. */
export interface RefLine {
  start: number;
  end: number;
  ko: string;
  en?: string;
  h?: number;
}

export interface LineMatch {
  ref: RefLine;
  shown: ShownRecord | null;
  cer: number | null;
}

/** Translations from the mock APIs carry a language tag; the rest is the source text. */
const stripTag = (text: string) => text.replace(/^\[[A-Z-]+\]\s*/, '');

/**
 * A reference line is matched by a shown line that started inside
 * [start - early, end] and whose text is within maxCer of the reference.
 */
export function matchLines(ref: RefLine[], shown: ShownRecord[], opts: { early?: number; maxCer?: number } = {}): LineMatch[] {
  const early = opts.early ?? 0.6;
  const maxCer = opts.maxCer ?? 0.5;
  return ref.map(line => {
    let best: { shown: ShownRecord; cer: number } | null = null;
    for (const s of shown) {
      if (s.lineStart < line.start - early || s.lineStart > line.end) continue;
      const { errors, length } = charErrorRate(line.ko, stripTag(s.text));
      const cer = length ? errors / length : 1;
      if (cer <= maxCer && (!best || cer < best.cer)) best = { shown: s, cer };
    }
    return { ref: line, shown: best?.shown ?? null, cer: best?.cer ?? null };
  });
}

const duration = (l: RefLine) => l.end - l.start;

function ratio(matches: LineMatch[]) {
  const matched = matches.filter(m => m.shown).length;
  return { lines: matches.length, matched, ratio: matches.length ? matched / matches.length : 1 };
}

/** Coverage for lines on screen ≥ 0.5 s (long) and < 0.5 s (short). */
export function coverageByDuration(matches: LineMatch[]) {
  return {
    long: ratio(matches.filter(m => duration(m.ref) >= 0.5)),
    short: ratio(matches.filter(m => duration(m.ref) < 0.5)),
  };
}

export type DurationBucket = '<0.5' | '0.5-1' | '1-2' | '>2';
export type SizeBucket = '<24px' | '24-40px' | '>40px' | 'unknown';

/** Missed reference lines by how long they were on screen. */
export function missBuckets(matches: LineMatch[]): Record<DurationBucket, number> {
  const out: Record<DurationBucket, number> = { '<0.5': 0, '0.5-1': 0, '1-2': 0, '>2': 0 };
  for (const m of matches) {
    if (m.shown) continue;
    const d = duration(m.ref);
    out[d < 0.5 ? '<0.5' : d < 1 ? '0.5-1' : d <= 2 ? '1-2' : '>2']++;
  }
  return out;
}

/** Missed reference lines by text height (1080p pixels), when the reference knows it. */
export function missesBySize(matches: LineMatch[]): Record<SizeBucket, number> {
  const out: Record<SizeBucket, number> = { '<24px': 0, '24-40px': 0, '>40px': 0, unknown: 0 };
  for (const m of matches) {
    if (m.shown) continue;
    const h = m.ref.h;
    out[h === undefined ? 'unknown' : h < 24 ? '<24px' : h <= 40 ? '24-40px' : '>40px']++;
  }
  return out;
}


/** Consecutive appearances of the same line (e.g. DeepL replaced in place by Claude) as one span. */
function spans(shown: ShownRecord[]): ShownRecord[] {
  const out: ShownRecord[] = [];
  for (const s of shown) {
    const last = out[out.length - 1];
    if (last && last.lineStart === s.lineStart && last.hiddenAt !== null && Math.abs(s.shownAt - last.hiddenAt) <= 0.05) {
      out[out.length - 1] = { ...last, hiddenAt: s.hiddenAt, text: s.text, quality: s.quality };
    } else out.push(s);
  }
  return out;
}

/**
 * Lines that left the screen before their minimum reading time without being
 * replaced by the next line. Lines still on screen at the end are not checked.
 */
export function timeOnScreen(shown: ShownRecord[]): { checked: number; tooShort: number } {
  const lines = spans(shown);
  let tooShort = 0;
  lines.forEach((s, i) => {
    if (s.hiddenAt === null) return;
    const next = lines[i + 1];
    const replaced = !!next && Math.abs(next.shownAt - s.hiddenAt) <= 0.05;
    if (!replaced && s.hiddenAt - s.shownAt < minDisplaySeconds(stripTag(s.text)) - 0.05) tooShort++;
  });
  return { checked: lines.length, tooShort };
}

/** Lines first shown with a fast translation and upgraded in place to Claude's. */
export function upgradesOnScreen(shown: ShownRecord[]): number {
  const upgraded = new Set<number>();
  const fastSeen = new Set<number>();
  for (const s of shown) {
    if (s.quality === 'fast') fastSeen.add(s.lineStart);
    else if (s.quality === 'better' && fastSeen.has(s.lineStart)) upgraded.add(s.lineStart);
  }
  return upgraded.size;
}

/**
 * Lines that appeared while paused and were NOT the subtitle on screen at that
 * moment (stale content: must be 0). A translation of the subtitle visible in
 * the paused frame arriving during the pause is fine.
 */
export function staleWhilePaused(shown: ShownRecord[], timeline: Array<{ start: number; end: number | null }>): number {
  return shown.filter(s => {
    if (!s.pausedAtShow) return false;
    const entry = timeline.find(t => Math.abs(t.start - s.lineStart) < 0.002);
    if (!entry) return true;
    return !(s.shownAt >= entry.start - 0.05 && (entry.end === null || s.shownAt <= entry.end + 0.05));
  }).length;
}

/** Lines that appeared while the video was paused (any). */
export function shownWhilePaused(shown: ShownRecord[]): number {
  return shown.filter(s => s.pausedAtShow).length;
}

/**
 * Share of reference lines whose timeline entry (start within [start - 0.6, end])
 * was translated before the line appeared.
 */
export function readyBeforeShown(timeline: Array<{ start: number; translatedAt: number | null }>, ref: RefLine[]): number {
  if (!ref.length) return 1;
  let ready = 0;
  for (const line of ref) {
    const entry = timeline.find(t => t.start >= line.start - 0.6 && t.start <= line.end);
    if (entry && entry.translatedAt !== null && entry.translatedAt < line.start) ready++;
  }
  return ready / ref.length;
}
