// Which stored fragment the read-ahead decoder takes next.
import type { Fmp4Fragment } from './fmp4';

const end = (f: Fmp4Fragment) => {
  const last = f.samples[f.samples.length - 1];
  return last.time + last.duration;
};

/**
 * Fresh start (nextTime = -Infinity): the fragment holding the playhead.
 * Otherwise the first fragment starting where the previous one ended (a small
 * tolerance for rounding) that also ends after it: a fragment shorter than the
 * tolerance (a 3-frame WebM cluster) must not be picked again and fed forever.
 */
export function nextFragment(fragments: Fmp4Fragment[], nextTime: number, now: number): Fmp4Fragment | undefined {
  if (nextTime === -Infinity) return fragments.find(f => end(f) > now - 0.5);
  return fragments.find(f => f.start >= nextTime - 0.05 && end(f) > nextTime + 1e-6);
}
