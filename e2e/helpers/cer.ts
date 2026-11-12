/** Character error rate: Levenshtein distance over whitespace-stripped strings / reference length. */
export function charErrorRate(reference: string, hypothesis: string): { errors: number; length: number } {
  const ref = [...reference.replace(/\s+/g, '')];
  const hyp = [...hypothesis.replace(/\s+/g, '')];
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return { errors: prev[hyp.length], length: ref.length };
}
