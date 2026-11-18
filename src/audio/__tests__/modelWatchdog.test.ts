import { ModelWatchdog, PREPARE_MS, STALL_MS } from '../modelWatchdog';

describe('ModelWatchdog: downloading (a stuck download must not fail silently)', () => {
  it('quiet while the download makes progress, and once ready', () => {
    const w = new ModelWatchdog();
    w.started(0);
    expect(w.check(STALL_MS - 1)).toBe('ok');
    w.progress(STALL_MS - 1);
    expect(w.check(2 * STALL_MS - 2)).toBe('ok');
    w.ready();
    expect(w.check(10 * STALL_MS)).toBe('ok');
  });

  it('no download progress for the stall time: retry once with a fresh download', () => {
    const w = new ModelWatchdog();
    w.started(0);
    expect(w.check(STALL_MS)).toBe('retry-fresh');
    w.started(STALL_MS);
    expect(w.check(STALL_MS + 1000)).toBe('ok');
  });

  it('nothing to watch before loading starts', () => {
    expect(new ModelWatchdog().check(10 * STALL_MS)).toBe('ok');
  });
});

describe('ModelWatchdog: preparing on the GPU (slow the first time; never re-download for it)', () => {
  it('a downloaded model preparing for minutes is left alone (no download retry)', () => {
    const w = new ModelWatchdog();
    w.started(0);
    w.preparing(60_000);
    expect(w.check(60_000 + STALL_MS + 1)).toBe('ok'); // the download stall time doesn't apply
    expect(w.check(60_000 + PREPARE_MS - 1)).toBe('ok');
  });

  it('preparing longer than its budget: retry without deleting the download', () => {
    const w = new ModelWatchdog();
    w.started(0);
    w.preparing(0);
    expect(w.check(PREPARE_MS)).toBe('retry');
  });

  it('too slow again after the retry: fall back to the smaller model', () => {
    const w = new ModelWatchdog();
    w.started(0);
    w.preparing(0);
    w.check(PREPARE_MS);
    w.started(PREPARE_MS);
    w.preparing(PREPARE_MS);
    expect(w.check(2 * PREPARE_MS)).toBe('fallback');
  });

  it('the fallback stalling too: give up and say so (once)', () => {
    const w = new ModelWatchdog();
    w.started(0);
    w.preparing(0);
    w.check(PREPARE_MS); // retry
    w.started(PREPARE_MS);
    w.preparing(PREPARE_MS);
    w.check(2 * PREPARE_MS); // fallback
    w.started(2 * PREPARE_MS);
    w.preparing(2 * PREPARE_MS);
    expect(w.check(3 * PREPARE_MS)).toBe('fail');
    expect(w.check(4 * PREPARE_MS)).toBe('ok');
  });

  it('ready ends the preparing phase', () => {
    const w = new ModelWatchdog();
    w.started(0);
    w.preparing(0);
    w.ready();
    expect(w.check(5 * PREPARE_MS)).toBe('ok');
  });
});
