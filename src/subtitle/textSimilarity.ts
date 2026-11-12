// Decides whether two OCR reads are the same subtitle line (OCR jitter tolerated).

function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Same line if the whitespace-stripped texts differ in at most 25% of characters. */
export function isSameLine(a: string, b: string, tolerance = 0.25): boolean {
  const x = [...a.replace(/\s+/g, '')];
  const y = [...b.replace(/\s+/g, '')];
  if (!x.length || !y.length) return false;
  return levenshtein(x, y) / Math.max(x.length, y.length) <= tolerance;
}
