// Theme and styles for the panels the extension draws on web pages (Screen
// Translate result, its loading/error chips, the selection box). Same tokens as
// the popup; the panel follows the Theme setting (System follows the OS).
// Things drawn over video (subtitle overlay, live captions) keep the caption look.
import { resolveTheme, ThemeChoice } from '../theme';

export const PAGE_STYLE_ID = 'ast-page-ui';

const TOKENS_LIGHT = `--ast-surface:#ffffff;--ast-ink:#171a21;--ast-muted:#5e6573;--ast-line:#dfe3ea;--ast-hover:#e8ebf0;--ast-bad:#c23a3a;--ast-bad-bg:#fbeaea;--ast-shadow:0 8px 28px rgba(16,18,24,.18);`;
const TOKENS_DARK = `--ast-surface:#20242d;--ast-ink:#eceef2;--ast-muted:#a3aab8;--ast-line:#2e3440;--ast-hover:#272c36;--ast-bad:#f07171;--ast-bad-bg:#3a2326;--ast-shadow:0 8px 28px rgba(0,0,0,.5);`;

// Scoped under .ast-ui so ours can't leak out. Page rules aimed at p/div/button
// would still reach in, so every element first reverts to browser defaults
// (all: revert) and then takes only our styles; class selectors outrank the
// page's element selectors.
const CSS = `
.ast-ui,.ast-ui *{all:revert;}
.ast-ui{${TOKENS_LIGHT}--ast-caption-bg:rgba(16,18,24,.92);--ast-caption-text:#ffd23f;box-sizing:border-box;font:400 14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:normal;text-align:left;text-transform:none;}
.ast-ui[data-ast-theme="dark"]{${TOKENS_DARK}}
.ast-ui *{box-sizing:border-box;font:inherit;}
.ast-panel{position:fixed;width:min(320px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;padding:12px 12px 10px;border:1px solid var(--ast-line);border-radius:12px;background:var(--ast-surface);color:var(--ast-ink);box-shadow:var(--ast-shadow);z-index:2147483000;}
.ast-panel__head{display:flex;align-items:center;gap:6px;margin:0 0 6px;}
.ast-panel__title{flex:1;font-size:12px;color:var(--ast-muted);}
.ast-panel__translated{margin:0;color:var(--ast-ink);font-size:15px;font-weight:700;line-height:1.35;overflow-wrap:anywhere;}
.ast-panel__original{margin:8px 0 0;padding-top:8px;border-top:1px solid var(--ast-line);font-size:12.5px;color:var(--ast-muted);overflow-wrap:anywhere;}
.ast-icon-button{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--ast-muted);cursor:pointer;font-size:16px;line-height:1;}
.ast-icon-button:hover{background:var(--ast-hover);color:var(--ast-ink);}
.ast-icon-button:focus-visible{outline:2px solid #2f6fe4;outline-offset:1px;}
.ast-icon-button[disabled]{opacity:.5;cursor:default;}
.ast-chip{position:fixed;max-width:min(360px,calc(100vw - 16px));overflow-wrap:anywhere;padding:6px 10px;border-radius:6px;background:var(--ast-caption-bg);color:var(--ast-caption-text);font-size:13px;font-weight:700;z-index:2147483001;}
.ast-chip--error{background:var(--ast-bad-bg);color:var(--ast-bad);border:1px solid var(--ast-bad);}
@media (prefers-reduced-motion:no-preference){.ast-chip--busy{animation:ast-pulse 1s ease-in-out infinite;}}
@keyframes ast-pulse{50%{opacity:.6}}
.ast-selection{position:fixed;border:2px dashed #ffd23f;background:rgba(255,210,63,.12);box-shadow:0 0 0 1px rgba(16,18,24,.6);border-radius:4px;z-index:2147483002;pointer-events:none;}
`;

/** Adds the panel stylesheet to the page once. */
export function ensurePageStyles(doc: Document = document): void {
  if (doc.getElementById(PAGE_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

async function storedTheme(): Promise<ThemeChoice> {
  const { theme } = await chrome.storage.sync.get({ theme: 'system' });
  return theme as ThemeChoice;
}

/** Marks an on-page element with the resolved theme (data-ast-theme). */
export async function themePageElement(
  el: HTMLElement,
  readTheme: () => Promise<ThemeChoice> = storedTheme,
  prefersDark: boolean = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
): Promise<void> {
  let choice: ThemeChoice = 'system';
  try {
    choice = await readTheme();
  } catch {
    // storage unavailable (e.g. extension reloaded): follow the OS
  }
  el.dataset.astTheme = resolveTheme(choice, prefersDark);
}
