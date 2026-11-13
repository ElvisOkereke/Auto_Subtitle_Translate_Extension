import { applyTheme, resolveTheme } from '../theme';

function fakeMedia(matches: boolean) {
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  return {
    matches,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.splice(listeners.indexOf(fn), 1),
    change(next: boolean) {
      this.matches = next;
      listeners.forEach(fn => fn({ matches: next }));
    },
    listeners,
  };
}

describe('theme', () => {
  it('resolves system from the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('explicit light/dark ignore the OS', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('applyTheme sets data-theme and follows OS changes in system mode', () => {
    const root = document.createElement('div');
    const media = fakeMedia(false);
    const stop = applyTheme(root, 'system', media as unknown as MediaQueryList);
    expect(root.dataset.theme).toBe('light');
    media.change(true);
    expect(root.dataset.theme).toBe('dark');
    stop();
    expect(media.listeners).toHaveLength(0);
    media.change(false);
    expect(root.dataset.theme).toBe('dark'); // no longer following
  });

  it('applyTheme with an explicit choice does not listen to the OS', () => {
    const root = document.createElement('div');
    const media = fakeMedia(true);
    applyTheme(root, 'light', media as unknown as MediaQueryList);
    expect(root.dataset.theme).toBe('light');
    expect(media.listeners).toHaveLength(0);
  });
});
