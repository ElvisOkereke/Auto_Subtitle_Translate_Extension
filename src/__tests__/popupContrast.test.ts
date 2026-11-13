import fs from 'fs';
import path from 'path';

// Text colours in popup.css must stay readable (WCAG AA, 4.5:1) on both
// backgrounds in both themes.
const css = fs.readFileSync(path.join(__dirname, '../../popup.css'), 'utf8');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1], m[2]]));
}
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
const darkStart = css.indexOf(":root[data-theme='dark']");
const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('}', darkStart))) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('popup colour contrast', () => {
  for (const [name, theme] of [['light', light], ['dark', dark]] as const) {
    it(`text colours reach 4.5:1 in the ${name} theme`, () => {
      expect(theme.bg).toBeDefined();
      for (const text of ['ink', 'muted', 'good', 'bad']) {
        for (const bg of ['bg', 'surface']) {
          expect(`${text} on ${bg}: ${contrast(theme[text], theme[bg]) >= 4.5}`).toBe(`${text} on ${bg}: true`);
        }
      }
      expect(contrast(theme.bad, theme['bad-bg'])).toBeGreaterThanOrEqual(4.5);
    });
  }
});
