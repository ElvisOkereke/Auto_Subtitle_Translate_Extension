// Light / dark theme: the user's choice (System, Light, Dark) resolved against
// the OS preference and written to `data-theme` on a root element, where the
// CSS tokens pick it up. System mode follows OS changes live.

export type ThemeChoice = 'system' | 'light' | 'dark';

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): 'light' | 'dark' {
  if (choice === 'light' || choice === 'dark') return choice;
  return prefersDark ? 'dark' : 'light';
}

const darkQuery = (): MediaQueryList | undefined =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;

/** Applies the theme; returns a function that stops following the OS. */
export function applyTheme(root: HTMLElement, choice: ThemeChoice, media: MediaQueryList | undefined = darkQuery()): () => void {
  root.dataset.theme = resolveTheme(choice, !!media?.matches);
  if (choice !== 'system' || !media) return () => undefined;
  const follow = (e: { matches: boolean }) => (root.dataset.theme = resolveTheme('system', e.matches));
  media.addEventListener('change', follow as (e: MediaQueryListEvent) => void);
  return () => media.removeEventListener('change', follow as (e: MediaQueryListEvent) => void);
}
