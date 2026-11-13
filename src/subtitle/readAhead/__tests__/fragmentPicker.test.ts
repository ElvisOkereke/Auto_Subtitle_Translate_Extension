import { nextFragment } from '../fragmentPicker';
import type { Fmp4Fragment } from '../fmp4';

const frag = (start: number, frames: number, fps = 60): Fmp4Fragment => ({
  start,
  samples: Array.from({ length: frames }, (_, i) => ({ time: start + i / fps, duration: 1 / fps, key: i === 0, data: new Uint8Array(1) })),
});

describe('nextFragment', () => {
  it('fresh start: the fragment holding the playhead', () => {
    const fragments = [frag(0, 300), frag(5, 300), frag(10, 300)];
    expect(nextFragment(fragments, -Infinity, 6)).toBe(fragments[1]);
  });

  it('continues with the fragment that starts where the previous ended', () => {
    const fragments = [frag(0, 300), frag(5, 300)];
    expect(nextFragment(fragments, 5, 0)).toBe(fragments[1]);
  });

  it('never picks a fragment again once it has been fed, even one shorter than the tolerance', () => {
    const short = frag(137.251, 3); // 50 ms (a 3-frame WebM cluster)
    const fragments = [frag(132.234, 301), short];
    const end = short.samples[2].time + short.samples[2].duration;
    expect(nextFragment(fragments, end, 130)).toBeUndefined();
    const after = frag(end, 300);
    expect(nextFragment([...fragments, after], end, 130)).toBe(after);
  });
});
