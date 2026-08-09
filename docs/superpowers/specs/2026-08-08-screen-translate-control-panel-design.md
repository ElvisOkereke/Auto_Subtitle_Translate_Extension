# Screen Translate: On-Page Control Panel (Guided Redraw Flow)

Date: 2026-08-08
Status: Approved, ready for implementation planning

## Context

Screen Translate (`src/realTimeTranslate.ts`) is toggled on/off from a button
in the extension popup (`src/popup.ts`, `popup.html`). Toggling it on sends
`TOGGLE_SCREEN_TRANSLATION` to the content script, which arms
`ROISelector` to let the user drag a box on the page; on mouseup it extracts
text under the box and shows a translation overlay
(`RealTimeTranslator.showTranslationOverlay()`).

Today's on-page feedback is a single small status banner
(`showStatusIndicator()` / `hideStatusIndicator()`) reading "Screen
translation active - Draw a rectangle to select area," shown once when
toggled on and removed when toggled off. Users report that after clicking
the popup's "Screen Translate" button — which just turns red to indicate
"active" — nothing else visibly happens on the page, and it's unclear what
to do next.

Separately, `ROISelector` only supports drawing **one** box per
toggle-on session: `handleMouseUp()` unconditionally calls
`stopSelection()`, which removes its own `mousedown`/`mousemove`/`mouseup`
listeners. Drawing a second box requires toggling Screen Translate off and
back on via the popup.

This spec covers both problems by replacing the status banner with a
persistent on-page control panel that carries the user through each step
and lets them redraw without leaving the popup or losing translate mode.

## Goals

- Replace the single status banner with an on-page control panel, visible
  for the entire time Screen Translate is active, that always shows the
  user what to do next.
- Add a **"Draw New Box"** button to the panel that re-arms box-drawing on
  demand, without requiring a trip back to the popup.
- Add a **"Stop"** button to the panel so Screen Translate can be exited
  from the page directly, mirroring the popup's toggle button.
- Fix the existing dead-end where an accidental too-small drag (or a drag
  over an element with no extractable text) leaves dragging disarmed with
  no indication anything changed — the panel must always reflect the
  current armed/disarmed state.

## Non-goals

- No changes to any other part of the popup (subtitles toggle, source/
  target language, subtitle style/font size, translation provider or API
  key fields) — this spec is scoped to the Screen Translate on-page
  experience only.
- No OCR, no `window.getSelection()`-based path added or removed, no touch/
  mobile event handling — same constraints as the prior Screen Translate
  design (refresh button + click guard).
- No new `chrome.runtime` message types — panel state changes and redraw
  are handled entirely within the content script.
- No persistence of Screen Translate's on/off state across popup opens —
  out of scope, pre-existing behavior.

## Decisions

- **The first box is still auto-armed on toggle-on.** Toggling Screen
  Translate on from the popup immediately arms dragging (crosshair cursor,
  live selection) — it does not require an extra "Draw New Box" click just
  to draw the very first box.
- **Every subsequent box requires clicking "Draw New Box."** After any
  drag ends (mouseup), dragging is disarmed and stays disarmed until the
  user explicitly clicks "Draw New Box" on the panel. This is unconditional
  — it does not matter whether the drag was too small or found no text.
- **Drawing a new box replaces the previous overlay, it does not stack.**
  Clicking "Draw New Box" immediately clears any existing translation
  overlay (rather than waiting for the new translation to land), so the
  page never shows two Screen Translate overlays at once.
- **The panel's "Stop" button calls the same internal stop path as the
  popup's toggle button** (`stopTranslation()`), not a new message type —
  it tears down the panel, any overlay, the click guard, and the crosshair
  cursor.
- **The panel is tagged `data-rtt-owned`,** consistent with the existing
  overlay/selection-box/refresh-button convention, so the click-through
  guard (installed for the lifetime of `isActive`) does not block clicks on
  the panel's own buttons.

## Architecture

### Control panel lifecycle

`RealTimeTranslator` replaces its `showStatusIndicator()` /
`hideStatusIndicator()` calls with three new methods:

- `showControlPanel(): void` — creates the panel div (id
  `screen-translate-panel`, `data-rtt-owned`) fixed top-right (same
  position the status banner used), appends it to `document.body`, and
  calls `updateControlPanel('armed')`. Called from `startTranslation()` in
  place of `showStatusIndicator(...)`.
- `updateControlPanel(state: 'armed' | 'ready-to-redraw'): void` —
  rewrites the panel's message text and button visibility for the given
  state:
  - `'armed'`: message "Screen Translate active — drag a box around text
    to translate."; only a **Stop** button rendered.
  - `'ready-to-redraw'`: message "Click 'Draw New Box' to translate
    another area."; both **Draw New Box** and **Stop** buttons rendered.
- `hideControlPanel(): void` — removes the panel from the DOM. Called from
  `stopTranslation()` in place of `hideStatusIndicator()`.

Both buttons are rendered with `data-rtt-owned` and wired the same way the
overlay's refresh/close buttons are (inline HTML, then `getElementById` +
`addEventListener` after insertion):

- **Draw New Box** click handler: `this.clearAllOverlays()`, then
  `this.roiSelector.startSelection()`, then
  `this.updateControlPanel('armed')`.
- **Stop** click handler: `this.stopTranslation()`.

### Driving the armed ↔ ready-to-redraw transition

`ROISelector`'s constructor gains a required callback parameter,
`onSelectionEnded: () => void`, stored as a private field and invoked as
the last line of `handleMouseUp()` — after the existing
`stopSelection()` call, and regardless of whether `roi.width > 10 &&
roi.height > 10` was true (i.e. it fires even when no ROI was processed).
`RealTimeTranslator`'s constructor changes from `new ROISelector()` to
`new ROISelector(() => this.updateControlPanel('ready-to-redraw'))`.

This is the mechanism that fixes the dead-end case: previously, an
accidental tiny drag or a drag over textless content silently disarmed
dragging with zero on-page feedback. Now the panel always flips to
"ready-to-redraw" the moment a drag ends, whatever the outcome.

### Interaction with existing overlay/refresh work

No changes to `showTranslationOverlay()`, `updateTranslationOverlay()`,
`refreshOverlay()`, `extractTextAtRect()`, or the click guard
(`installClickGuard()`/`removeClickGuard()`) — those stay exactly as
built in the prior "Manual Refresh + Click-Through Prevention" work. The
panel is simply a new `data-rtt-owned` element the guard already knows to
step aside for, using the same `[data-rtt-owned]` convention.

`clearAllOverlays()` (already clears `translationOverlays`,
`overlayRects`, `overlayTimers`) is reused as-is for the "replace, don't
stack" behavior — no new clearing logic needed.

## Testing Approach

Same posture as the prior Screen Translate spec: `realTimeTranslate.ts`
has no unit tests and this design does not add test infrastructure for it.
Verification is `npm run type-check`, `npm test` (existing suite
unaffected), `npm run build:dev`, plus a manual smoke test in a loaded
unpacked extension:

1. Toggle Screen Translate on from the popup — confirm the on-page panel
   appears with the "armed" message and a Stop button, and dragging works
   immediately.
2. Drag a box over text — confirm the overlay appears and the panel
   switches to "ready-to-redraw" with both buttons visible.
3. Drag without clicking "Draw New Box" first — confirm nothing happens
   (dragging is disarmed).
4. Click "Draw New Box," drag a second box elsewhere — confirm the first
   overlay disappears and only the second is shown.
5. Click "Stop" on the panel — confirm the panel, overlay, and crosshair
   cursor all disappear, and clicks on the page work normally again.
6. Drag a too-small box (under 10px) — confirm the panel still flips to
   "ready-to-redraw" instead of leaving dragging silently disarmed with no
   feedback.

## Self-Review

**Placeholder scan**: no TBD/TODO markers; every decision is concrete.

**Internal consistency**: reuses the existing `data-rtt-owned` /
click-guard convention and `clearAllOverlays()` helper from the prior
spec without modification; the new `onSelectionEnded` callback is the only
new integration point between `ROISelector` and `RealTimeTranslator`.

**Scope check**: single focused change confined to
`src/realTimeTranslate.ts` — no popup, background, or manifest changes.

**Ambiguity check**: the three judgment calls raised during brainstorming —
scope (Screen Translate only vs. whole popup), redraw semantics (explicit
button vs. auto-rearm), and overlay stacking (replace vs. multiple) — are
each resolved explicitly in Decisions above.
