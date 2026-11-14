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

export type MissCause = 'not-read' | 'misread' | 'read-not-shown' | 'shown-outside-window';

/**
 * Why each unmatched reference line was missed: nothing was read in its window,
 * what was read is too far from it (CER > 0.5), it was read but never shown
 * (e.g. a late translation dropped), or shown only outside its window.
 */
export function classifyMisses(
  matches: LineMatch[],
  timeline: Array<{ start: number; end: number | null; source: string }>,
  shown: ShownRecord[]
): { counts: Record<MissCause, number>; examples: Array<{ cause: MissCause; ref: string; at: number; read?: string; cer?: number }> } {
  const counts: Record<MissCause, number> = { 'not-read': 0, misread: 0, 'read-not-shown': 0, 'shown-outside-window': 0 };
  const examples: Array<{ cause: MissCause; ref: string; at: number; read?: string; cer?: number }> = [];
  for (const m of matches) {
    if (m.shown) continue;
    const near = timeline.filter(t => t.start <= m.ref.end && (t.end ?? t.start + 1) >= m.ref.start - 0.6);
    let cause: MissCause = 'not-read';
    let best: { source: string; start: number; cer: number } | null = null;
    for (const t of near) {
      const { errors, length } = charErrorRate(m.ref.ko, stripTag(t.source));
      const cer = length ? errors / length : 1;
      if (!best || cer < best.cer) best = { source: t.source, start: t.start, cer };
    }
    if (best) {
      if (best.cer > 0.5) cause = 'misread';
      else cause = shown.some(s => Math.abs(s.lineStart - best!.start) < 0.002) ? 'shown-outside-window' : 'read-not-shown';
    }
    counts[cause]++;
    examples.push({ cause, ref: m.ref.ko, at: m.ref.start, ...(best ? { read: best.source, cer: Math.round(best.cer * 100) / 100 } : {}) });
  }
  return { counts, examples };
}

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
 * Share of reference lines translated before they appeared. With `matches`, a
 * matched line uses the timeline entry it was actually shown from (its
 * lineStart) and an unmatched line counts as not ready; without, the first
 * entry starting within [start - 0.6, end].
 */
export function readyBeforeShown(
  timeline: Array<{ start: number; translatedAt: number | null }>,
  ref: RefLine[],
  matches?: LineMatch[]
): number {
  if (!ref.length) return 1;
  let ready = 0;
  for (const line of ref) {
    const m = matches?.find(x => x.ref === line);
    const entry = matches
      ? m?.shown
        ? timeline.find(t => Math.abs(t.start - m.shown!.lineStart) < 0.002)
        : undefined
      : timeline.find(t => t.start >= line.start - 0.6 && t.start <= line.end);
    if (entry && entry.translatedAt !== null && entry.translatedAt < line.start) ready++;
  }
  return ready / ref.length;
}

// ---- audio captions ----

const chars = (s: string) => [...stripTag(s).replace(/[\s.,!?¡¿…。、！？「」"'·-]+/g, '')];

/** Longest common subsequence length of two strings' characters (punctuation and spaces ignored). */
function lcs(a: string, b: string): number {
  const x = chars(a);
  const y = chars(b);
  if (!x.length || !y.length) return 0;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = [0];
    for (let j = 1; j <= y.length; j++) cur.push(x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]));
    prev = cur;
  }
  return prev[y.length];
}

type Caption = ShownRecord & { source?: string };
const sourceOf = (c: Caption) => c.source ?? stripTag(c.text);

/**
 * Character error rate of everything transcribed against the reference inside a
 * window, independent of how the speech was split into captions. Captions
 * shown up to 8 s after the window count (live captions lag the speech).
 */
export function transcriptCer(ref: RefLine[], shown: Caption[], window: [number, number]): number {
  const r = ref.filter(l => l.start >= window[0] && l.start < window[1]).map(l => l.ko).join('');
  const h = [...shown]
    .filter(c => c.shownAt >= window[0] && c.shownAt < window[1] + 8)
    .sort((a, b) => a.shownAt - b.shownAt)
    .map(sourceOf)
    .join('');
  const { errors, length } = charErrorRate(chars(r).join(''), chars(h).join(''));
  return length ? errors / length : 0;
}

/**
 * How long after its speech ended each caption appeared: every caption is
 * matched to the reference line it shares the most characters with (at least
 * half of that line, ending within 15 s before it appeared).
 */
export function captionDelays(ref: RefLine[], shown: Caption[]): { fromSpeechEndP50: number | null; fromSpeechEndP90: number | null; matched: number } {
  const delays: number[] = [];
  for (const c of shown) {
    let best: { line: RefLine; overlap: number } | null = null;
    for (const line of ref) {
      if (line.end > c.shownAt + 1 || line.end < c.shownAt - 15) continue;
      const overlap = lcs(line.ko, sourceOf(c));
      if (overlap >= chars(line.ko).length / 2 && (!best || overlap > best.overlap)) best = { line, overlap };
    }
    if (best) delays.push(c.shownAt - best.line.end);
  }
  delays.sort((a, b) => a - b);
  // Nearest-rank percentile.
  const at = (q: number) => (delays.length ? delays[Math.max(0, Math.ceil(delays.length * q) - 1)] : null);
  return { fromSpeechEndP50: at(0.5), fromSpeechEndP90: at(0.9), matched: delays.length };
}

/**
 * Share of the reference's characters that appeared on screen near their time:
 * for each reference line, the characters it shares with captions shown from
 * 1 s before it to 8 s after it ended.
 */
export function wordsCovered(ref: RefLine[], shown: Caption[]): number {
  let total = 0;
  let covered = 0;
  for (const line of ref) {
    const near = shown
      .filter(c => c.shownAt >= line.start - 1 && c.shownAt <= line.end + 8)
      .sort((a, b) => a.shownAt - b.shownAt)
      .map(sourceOf)
      .join('');
    total += chars(line.ko).length;
    covered += lcs(line.ko, near);
  }
  return total ? covered / total : 0;
}
