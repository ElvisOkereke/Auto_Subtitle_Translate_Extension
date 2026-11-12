/**
 * Greedy CTC decoding of a recognizer's [steps x classes] probability matrix.
 * `charset` is index-aligned with the classes (index `blank` is the CTC blank).
 */
export function ctcGreedyDecode(
  logits: Float32Array,
  steps: number,
  classes: number,
  charset: string[],
  blank = 0
): { text: string; confidence: number } {
  let text = '';
  let confidenceSum = 0;
  let emitted = 0;
  let previous = -1;
  for (let t = 0; t < steps; t++) {
    const row = t * classes;
    let best = 0;
    let bestP = logits[row];
    for (let c = 1; c < classes; c++) {
      if (logits[row + c] > bestP) {
        bestP = logits[row + c];
        best = c;
      }
    }
    if (best !== blank && best !== previous) {
      text += charset[best] ?? '';
      confidenceSum += bestP;
      emitted++;
    }
    previous = best;
  }
  return { text, confidence: emitted ? confidenceSum / emitted : 0 };
}
