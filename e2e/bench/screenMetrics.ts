// screenMetrics.ts - scores what a viewer actually saw. Each sample is a moment
// of playback: the burned-in subtitle (read from the bare video frame) and the
// translated subtitle visible on screen (read from a screenshot). A judge maps
// each English line to the Korean line it translates; this file does the rest
// deterministically.

export interface FrameSample {
  /** Video time of the sample (seconds). */
  t: number;
  /** The burned-in subtitle in the video picture, or null. */
  burned: string | null;
  /** The extension's translated subtitle visible on screen, or null. */
  overlay: string | null;
}

export interface Line {
  text: string;
  from: number;
  to: number;
}

export interface Alignment {
  overlayIndex: number;
  /** The Korean line it translates, or null (it translates nothing on screen). */
  koreanIndex: number | null;
  /** The translation is acceptable. */
  correct: boolean;
}

export interface ScreenMetrics {
  /** Moments with a burned-in subtitle on screen (the ones scored). */
  scored: number;
  /** Shares of the scored moments. */
  right: number;
  late: number;
  missing: number;
  wrong: number;
  /** Seconds from a Korean line's appearance to its translation's (P50 / P90), over lines that got one. */
  lagP50: number | null;
  lagP90: number | null;
  /** Share of Korean lines that got a correct translation on screen at some point. */
  linesTranslated: number;
}

const GRACE_S = 0.5;

const norm = (s: string) => s.replace(/[\s.,!?。、…·'"「」『』()\[\]-]/g, '').toLowerCase();

function similar(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return x === y;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  // Character overlap: OCR of the same line differs in a character or two.
  const counts = new Map<string, number>();
  for (const c of x) counts.set(c, (counts.get(c) ?? 0) + 1);
  let common = 0;
  for (const c of y) {
    const n = counts.get(c) ?? 0;
    if (n > 0) {
      common++;
      counts.set(c, n - 1);
    }
  }
  return common / Math.max(x.length, y.length) >= 0.8;
}

/** The lines that were on screen: consecutive samples with the same text, each lasting until the next sample. */
export function lineTimeline(samples: FrameSample[], key: 'burned' | 'overlay', sampleSeconds = 0.5): Line[] {
  const lines: Line[] = [];
  let current: Line | null = null;
  for (const sample of [...samples].sort((a, b) => a.t - b.t)) {
    const text = sample[key];
    if (text && current && similar(current.text, text) && sample.t - current.to <= sampleSeconds * 1.5) {
      current.to = sample.t + sampleSeconds;
      continue;
    }
    current = null;
    if (text) {
      current = { text, from: sample.t, to: sample.t + sampleSeconds };
      lines.push(current);
    }
  }
  return lines;
}

const at = (lines: Line[], t: number) => lines.findIndex(l => l.from <= t && t < l.to);

export function screenMetrics(samples: FrameSample[], korean: Line[], overlay: Line[], alignment: Alignment[]): ScreenMetrics {
  const mapOf = new Map(alignment.map(a => [a.overlayIndex, a]));
  let scored = 0;
  const counts = { right: 0, late: 0, missing: 0, wrong: 0 };
  for (const sample of samples) {
    const k = at(korean, sample.t);
    if (k < 0) continue;
    scored++;
    const o = sample.overlay ? at(overlay, sample.t) : -1;
    if (o < 0) {
      counts.missing++;
      continue;
    }
    const a = mapOf.get(o);
    if (!a || a.koreanIndex === null || !a.correct) counts.wrong++;
    else if (a.koreanIndex === k) counts.right++;
    else if (a.koreanIndex === k - 1 && sample.t - korean[k].from < GRACE_S) counts.right++; // the line just changed
    else if (a.koreanIndex < k) counts.late++;
    else counts.wrong++;
  }
  const lags: number[] = [];
  let translated = 0;
  korean.forEach((line, k) => {
    const firsts = alignment.filter(a => a.koreanIndex === k && a.correct).map(a => overlay[a.overlayIndex]?.from).filter((x): x is number => x !== undefined);
    if (!firsts.length) return;
    translated++;
    lags.push(Math.max(0, Math.min(...firsts) - line.from));
  });
  lags.sort((a, b) => a - b);
  const pct = (q: number) => (lags.length ? lags[Math.max(0, Math.ceil(lags.length * q) - 1)] : null);
  const share = (n: number) => (scored ? n / scored : 0);
  return {
    scored,
    right: share(counts.right),
    late: share(counts.late),
    missing: share(counts.missing),
    wrong: share(counts.wrong),
    lagP50: pct(0.5),
    lagP90: pct(0.9),
    linesTranslated: korean.length ? translated / korean.length : 0,
  };
}
