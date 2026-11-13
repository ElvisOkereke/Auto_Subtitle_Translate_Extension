import { ensurePageStyles, PAGE_STYLE_ID, themePageElement } from '../ui/pageTheme';

describe('on-page panels theme', () => {
  afterEach(() => (document.head.innerHTML = '', document.body.innerHTML = ''));

  it('injects the panel styles once', () => {
    ensurePageStyles(document);
    ensurePageStyles(document);
    expect(document.querySelectorAll(`#${PAGE_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(PAGE_STYLE_ID)!.textContent).toContain('[data-ast-theme="dark"]');
  });

  it('panels follow the theme setting, and System follows the OS', async () => {
    const el = document.createElement('div');
    await themePageElement(el, async () => 'dark', false);
    expect(el.dataset.astTheme).toBe('dark');
    await themePageElement(el, async () => 'light', true);
    expect(el.dataset.astTheme).toBe('light');
    await themePageElement(el, async () => 'system', true);
    expect(el.dataset.astTheme).toBe('dark');
    await themePageElement(el, async () => { throw new Error('no storage'); }, false);
    expect(el.dataset.astTheme).toBe('light');
  });
});
