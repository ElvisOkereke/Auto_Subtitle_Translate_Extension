// textSize.ts - learns how tall this video's subtitle text is, so text of another
// size in the OCR region (game notices like "skill not ready", stream overlays)
// is not read as a subtitle. OCR is told the expected height and prefers text of
// that size (src/ocr/detect.ts, selectSubtitleBoxes).
//
// Every text OCR finds is evidence, whether it was accepted or not: the size is
// the one shared by the most *different* texts. Subtitles change all the time;
// game and stream UI repeats the same few words or is a key letter or a number,
// so the subtitles outvote it within a few lines even when UI text came first.
import { isSameLine } from './textSimilarity';
import { SIZE_BAND } from '../ocr/detect';

const MIN_SAMPLES = 3; // different texts seen before the size counts
const KEEP = 12; // the size follows the most recent texts
const MIN_LETTERS = 2; // key letters and timers ("B", "F57") are no evidence

/** Text of this height is not the subtitle size `expected` (both fractions of the frame). */
export function isOffSize(height: number, expected: number): boolean {
  return height < SIZE_BAND[0] * expected || height > SIZE_BAND[1] * expected;
}

/** Edit distance of `short` against its best-matching part of `long`. */
function bestPartDistance(long: string[], short: string[]): number {
  let prev: number[] = new Array(long.length + 1).fill(0);
  for (let i = 1; i <= short.length; i++) {
    const cur = [i];
    for (let j = 1; j <= long.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (short[i - 1] === long[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return Math.min(...prev);
}

/** Two OCR reads of the same text: with slips, or one a cut-off / faded part of the other (at least 4 characters and a third of it). */
export function similarText(a: string, b: string): boolean {
  if (isSameLine(a, b, 0.3)) return true;
  const x = [...a.replace(/\s+/g, '')];
  const y = [...b.replace(/\s+/g, '')];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 4 || short.length * 3 < long.length) return false;
  return bestPartDistance(long, short) <= 0.3 * short.length;
}

const median = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

interface Sample {
  text: string;
  height: number;
}

export class TextSizeModel {
  private samples: Sample[] = [];

  /** This video's subtitle text height (fraction of the frame); null until known. */
  expected(): number | null {
    if (this.samples.length < MIN_SAMPLES) return null;
    let best: Sample[] = [];
    let bestHeight = 0;
    for (const s of this.samples) {
      const members = this.samples.filter(o => !isOffSize(o.height, s.height));
      if (members.length > best.length || (members.length === best.length && s.height > bestHeight)) {
        best = members;
        bestHeight = s.height;
      }
    }
    return median(best.map(s => s.height));
  }

  /** OCR found `text`, `height` tall (fraction of the frame). Returns whether it is of the subtitle size. */
  accept(text: string, height: number): boolean {
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    if (letters >= MIN_LETTERS && !this.samples.some(s => similarText(s.text, text))) {
      this.samples.push({ text, height });
      if (this.samples.length > KEEP) this.samples.shift();
    }
    const expected = this.expected();
    return expected === null || !isOffSize(height, expected);
  }

  reset(): void {
    this.samples = [];
  }
}
