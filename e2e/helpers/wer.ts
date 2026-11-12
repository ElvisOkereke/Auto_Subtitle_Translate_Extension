const NUMBER_WORDS: Record<string, string> = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five',
  '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten',
};

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => NUMBER_WORDS[w] ?? w);
}

/** Word error rate: word-level edit distance / reference length. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  const d: number[][] = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]);
  for (let j = 1; j <= hyp.length; j++) d[0][j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return ref.length ? d[ref.length][hyp.length] / ref.length : 0;
}
