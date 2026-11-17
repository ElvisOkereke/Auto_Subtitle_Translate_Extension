import { ModelWatchdog, STALL_MS } from '../modelWatchdog';

describe('ModelWatchdog (a speech model that never finishes loading must not fail silently)', () => {
  it('quiet while loading makes progress or once ready', () => {
    const w = new ModelWatchdog();
    w.started(0);
    expect(w.check(STALL_MS - 1)).toBe('ok');
    w.progress(STALL_MS - 1);
    expect(w.check(2 * STALL_MS - 2)).toBe('ok');
    w.ready();
    expect(w.check(10 * STALL_MS)).toBe('ok');
  });

  it('no progress for the stall time: retry once with a fresh download', () => {
    const w = new ModelWatchdog();
    w.started(0);
    expect(w.check(STALL_MS)).toBe('retry');
    w.started(STALL_MS); // the retry starts loading again
    expect(w.check(STALL_MS + 1000)).toBe('ok');
  });

  it('stalled again after the retry: give up and say so (once)', () => {
    const w = new ModelWatchdog();
    w.started(0);
    w.check(STALL_MS);
    w.started(STALL_MS);
    expect(w.check(2 * STALL_MS)).toBe('fail');
    expect(w.check(3 * STALL_MS)).toBe('ok'); // reported already
  });

  it('nothing to watch before loading starts', () => {
    expect(new ModelWatchdog().check(10 * STALL_MS)).toBe('ok');
  });
});
