# UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A popup and on-page panels whose controls match the real features, with System/Light/Dark themes and the caption-bar identity from the spec.

**Architecture:** Popup markup restructured into a main view and a settings view in `popup.html`, styles moved to `popup.css` (tokens on `:root`, overridden by `[data-theme]` and `prefers-color-scheme`), bundled Atkinson Hyperlegible; `src/popup.ts` keeps every element id and gains view navigation, the caption bar, the "Translate with" choice and theme application; content scripts read the theme for their panels.

**Tech Stack:** HTML/CSS/TypeScript, webpack copy, `@fontsource/atkinson-hyperlegible`, Jest + jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-ui-redesign-design.md`

## Global Constraints

- Keep every existing element id and its behaviour (logic and tests depend on them).
- Theme setting `theme: 'system' | 'light' | 'dark'` (sync, default `system`); `document.documentElement.dataset.theme` = resolved choice when not system.
- Copy: "Start live captions"/"Stop live captions", "Draw subtitle box"/"Redraw box", "Use saved box", "Stop", "Translate text on this page"/"Stop translating", sentence case, no all-caps.
- Contrast ≥ 4.5:1 for text in both themes; visible focus ring; `prefers-reduced-motion` respected.

## Review Focus

1. A user who never opens settings can still do everything everyday (mode, languages, start/stop, Screen Translate) — test: Task 2 E2E main-view flow.
2. Switching "Translate with" between subscription and own keys sets both engine settings consistently and never shows key fields for the subscription — test: Task 2 unit.
3. Theme "System" follows the OS live (media query change) — test: Task 1 unit.
4. Long texts (glossary terms, errors, emails) never overflow the 360 px popup — test: Task 2 screenshot review + CSS `overflow-wrap`.
5. On-page panels stay readable over any page in both themes — test: Task 3 screenshot.

---

### Task 1: Theme foundation

**Files:** Create `popup.css`, `src/theme.ts` (+ `src/__tests__/theme.test.ts`); modify `popup.html` (link css, remove inline `<style>`), `webpack.config.js` (copy `popup.css`, fonts), `package.json` (`@fontsource/atkinson-hyperlegible`), `src/settings.ts`/`src/types/index.ts` (`theme`).

**Interfaces — Produces:** `type ThemeChoice = 'system' | 'light' | 'dark'`; `resolveTheme(choice, prefersDark: boolean): 'light' | 'dark'`; `applyTheme(root: HTMLElement, choice, media?: MediaQueryList): () => void` (sets `data-theme`, follows media changes for system, returns unsubscribe).
- [ ] tests: `resolves system from the OS preference`, `applyTheme sets data-theme and follows OS changes in system mode`, `explicit light/dark ignore the OS`; RED → implement → GREEN; commit `feat(ui): theme tokens, bundled font, theme setting`.

### Task 2: Popup structure, caption bar, settings view, "Translate with"

**Files:** `popup.html`, `popup.css`, `src/popup.ts`, `src/__tests__/popup.test.ts`, E2E specs using settings controls or old labels (`popup.spec.ts`, `captions.spec.ts`, `account.spec.ts`, `subtitle-claude.spec.ts`).

**Interfaces — Produces:** ids `#openSettings`, `#closeSettings`, `#mainView`, `#settingsView`, `#captionBar`, `#translateWithSubscription`, `#translateWithKeys`, `#themeChoice`, `#engineSummary`, `#accountSummary`; `captionText(state): string` (exported, pure) for: audio idle/running, subtitles no box/has box/running/loading, screen-translate armed.
- [ ] tests (unit): `caption bar speaks the current state` (each state → exact copy), `settings view opens and closes and keeps focus order`, `Translate with: subscription sets both engines to subscription and hides key fields; own keys restores DeepL/key access`, `theme choice persists and applies`, `audio button reads Start live captions / Stop live captions`.
- [ ] E2E: update selectors/labels; new `popup.spec` test `everyday actions work without opening settings` and screenshots `popup-main-{light,dark}.png`, `popup-settings-{light,dark}.png` reviewed.
- [ ] commit `feat(ui): popup redesign - caption bar, main and settings views, Translate with`.

### Task 3: On-page panels themed

**Files:** `src/realTimeTranslate.ts` (Screen Translate result panel + selection hint), `src/content.ts` (notices), shared `src/ui/pageTheme.ts` (reads `theme` from sync storage, sets `data-ast-theme` on panel roots, CSS tokens).
- [ ] tests: content unit `notices use the theme tokens`; E2E screenshot of the Screen Translate panel in both themes (`screen-translate-{light,dark}.png`) reviewed; existing Screen Translate tests pass.
- [ ] commit `feat(ui): on-page panels follow the theme`.

### Task 4: Docs and verify

- [ ] README screenshots section/notes; milestones entry; `npm run verify` green; commit.
