import { ctcGreedyDecode } from '../ctc';

// charset is index-aligned with the model's output classes: [blank, ...chars].
const charset = ['', 'a', 'b'];

function logits(rows: number[][]): Float32Array {
  return Float32Array.from(rows.flat());
}

describe('ctcGreedyDecode', () => {
  it('collapses repeats and drops blanks', () => {
    // steps: a, a, blank, a, b
    const out = ctcGreedyDecode(
      logits([
        [0.1, 0.8, 0.1],
        [0.1, 0.7, 0.2],
        [0.9, 0.05, 0.05],
        [0.2, 0.6, 0.2],
        [0.1, 0.1, 0.8],
      ]),
      5,
      3,
      charset
    );
    expect(out.text).toBe('aab');
  });

  it('reports confidence as the mean max-probability of emitted steps', () => {
    const out = ctcGreedyDecode(logits([[0.1, 0.8, 0.1], [0.9, 0.05, 0.05], [0.1, 0.1, 0.6]]), 3, 3, charset);
    expect(out.text).toBe('ab');
    expect(out.confidence).toBeCloseTo((0.8 + 0.6) / 2, 6);
  });

  it('returns empty text and zero confidence when every step is blank', () => {
    const out = ctcGreedyDecode(logits([[0.9, 0.05, 0.05], [0.8, 0.1, 0.1]]), 2, 3, charset);
    expect(out).toEqual({ text: '', confidence: 0 });
  });
});
