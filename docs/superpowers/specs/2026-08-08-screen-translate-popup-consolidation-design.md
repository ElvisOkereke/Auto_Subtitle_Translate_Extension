# Screen Translate: Consolidate Controls into the Popup

Date: 2026-08-08
Status: Approved, ready for implementation planning

## Context

The prior "On-Page Control Panel" work
(`docs/superpowers/specs/2026-08-08-screen-translate-control-panel-design.md`)
gave Screen Translate a floating on-page panel — a persistent div with
status text, a "Draw New Box" button, and a "Stop" button — because the
popup's own toggle button gave no feedback about what to do next once
Screen Translate was active.

Feedback on that design: having controls split across two surfaces (the
popup for turning the feature on, an on-page panel for everything after)
is one UI too many. All Screen Translate controls should live in the
extension popup; the page itself should carry no interactive control
surface.

This is a second, focused revision of the same feature area — same file
(`src/realTimeTranslate.ts`), same popup file (`src/popup.ts`/
`popup.html`) — not a rebuild from scratch.

## Goals

- Remove the on-page control panel entirely — no floating div, no
  on-page buttons.
- Add a **"Draw New Box"** button to the popup, visible only when
  Screen Translate is on and a redraw is needed.
- Show the same state-dependent status text ("drag a box..." /
  "click Draw New Box...") in the popup instead of on the page.
- Keep the popup accurate even though its own JS is destroyed and
  recreated every time it closes — reopening it must reflect the content
  script's real current state, not a stale in-memory guess.
- Preserve the one functional purpose the on-page panel served beyond
  controls: some on-page indication of whether dragging currently works.
  A plain crosshair cursor (already implemented) carries this now, and it
  must reflect the true armed/disarmed state rather than staying static.

## Non-goals

- No change to the translation overlay, its refresh/close buttons, or
  `extractTextAtRect()` — those stay on-page; they're anchored to page
  content, not part of "Screen Translate controls."
- No change to the click guard (`installClickGuard`/`removeClickGuard`).
- No change to any other popup setting (subtitles, languages, provider,
  API keys).
- No new persistence layer (`chrome.storage`) for Screen Translate state —
  state lives in the content script; the popup queries it live each time
  it opens.

## Decisions

- **The on-page panel (`showControlPanel`/`updateControlPanel`/
  `hideControlPanel`) is deleted, not hidden.** No dead code path.
- **The crosshair cursor becomes state-aware.** Today it's set once in
  `startTranslation()` and never changes until `stopTranslation()`. Going
  forward: crosshair while armed (dragging works), default cursor
  (`''`) while ready-to-redraw (dragging is disarmed) — otherwise the
  only remaining on-page signal would lie about whether a drag will do
  anything.
- **The popup gets a new "Draw New Box" button, separate from the
  existing "Screen Translate" toggle button.** It's hidden unless Screen
  Translate is on and the content script reports `ready-to-redraw`.
  Clicking it: clears the current overlay, re-arms dragging, flips the
  cursor back to crosshair, and updates the popup's own status text —
  mirroring exactly what the deleted on-page button did.
- **The popup queries the content script for current state every time it
  opens**, via a new `GET_SCREEN_TRANSLATE_STATE` message
  (request/response, `chrome.tabs.sendMessage` with its Promise-returning
  form). This replaces trusting the popup's own `isScreenTranslating`
  field across reopens, which today is a guess reset to `false` on every
  open regardless of the page's actual state. If the query fails (no
  content script listening — e.g. a `chrome://` page, or Screen Translate
  was never toggled on that tab), the popup treats it as `inactive`,
  matching today's default.
- **Status text moves to a new, non-auto-hiding element**
  (`#screenTranslateStatus`), not the existing `#status` div. `#status` is
  used for transient success/error toasts and auto-hides after 3 seconds
  (`showStatus()`); a persistent "what do I do next" message needs to stay
  visible for as long as it's relevant, so it needs its own element.
- **The existing "Screen Translate" toggle button's behavior is
  unchanged** — it still just flips the whole feature on/off via
  `TOGGLE_SCREEN_TRANSLATION`. "Draw New Box" is additive, not a
  replacement.

## Architecture

### Content script (`src/realTimeTranslate.ts`)

`RealTimeTranslator` gains a private field replacing what the panel used
to render:

```ts
type ScreenTranslateState = 'inactive' | 'armed' | 'ready-to-redraw';
private screenTranslateState: ScreenTranslateState = 'inactive';
```

Transitions:
- `startTranslation()`: sets `'armed'`, cursor `'crosshair'` (unchanged
  from today), no more `showControlPanel()` call.
- `ROISelector`'s `onSelectionEnded` callback (already wired from the
  prior task): sets `'ready-to-redraw'`, cursor `''` (new — today the
  callback only updated the panel).
- A new `drawNewBox()` method: sets `'armed'`, cursor `'crosshair'`,
  clears overlays, calls `this.roiSelector.startSelection()`. Wired to a
  new `'DRAW_NEW_BOX'` message case in `setupMessageListener()`.
- `stopTranslation()`: sets `'inactive'` (new — today nothing tracked
  this), no more `hideControlPanel()` call.

`setupMessageListener()` gains a `'GET_SCREEN_TRANSLATE_STATE'` case that
calls `sendResponse({ state: this.screenTranslateState })` and returns
`true` from the listener (required so Chrome keeps the message channel
open for `sendResponse`).

`showControlPanel()`, `updateControlPanel()`, and `hideControlPanel()` are
deleted.

### Message types (`src/types/index.ts`)

Two additions to `MessageType` and their interfaces:

```ts
| 'GET_SCREEN_TRANSLATE_STATE'
| 'DRAW_NEW_BOX'
```

```ts
export interface GetScreenTranslateStateMessage extends ExtensionMessage {
  type: 'GET_SCREEN_TRANSLATE_STATE';
}

export interface DrawNewBoxMessage extends ExtensionMessage {
  type: 'DRAW_NEW_BOX';
}

export interface ScreenTranslateStateResponse {
  state: 'inactive' | 'armed' | 'ready-to-redraw';
}
```

### Popup (`popup.html` / `src/popup.ts`)

`popup.html` adds two elements inside `.toggle-section`, alongside the
existing buttons:

- `#drawNewBoxButton` — a `button.toggle-button`, `class="hidden"` by
  default.
- `#screenTranslateStatus` — a `div`, `class="hidden"` by default, styled
  like `.status` but without the auto-hide behavior (a new CSS class,
  e.g. `.persistent-status`, reusing `.status`'s color variants).

`PopupController`:
- On construction (alongside `loadSettings()`), calls a new
  `refreshScreenTranslateState()`: queries the active tab with
  `GET_SCREEN_TRANSLATE_STATE`, and on response sets `isScreenTranslating`
  and renders `#drawNewBoxButton`/`#screenTranslateStatus` to match
  (`inactive` → both hidden, button reads "Screen Translate"; `armed` →
  status shows "Drag a box around text to translate.", draw button
  hidden; `ready-to-redraw` → status shows "Click 'Draw New Box' to
  translate another area.", draw button visible). On failure/no response,
  treats it as `inactive`.
- `toggleScreenTranslation()`: unchanged message-sending logic; additionally
  resets `#drawNewBoxButton`/`#screenTranslateStatus` to the `armed`
  appearance when turning on, and hides both when turning off.
- New `drawNewBox()` handler on the button's click: sends `DRAW_NEW_BOX`
  to the active tab, then updates `#screenTranslateStatus` to the armed
  message and hides `#drawNewBoxButton` (optimistic update, same pattern
  `toggleScreenTranslation()` already uses).

### Interaction with existing overlay/refresh/click-guard work

No changes to `showTranslationOverlay()`, `updateTranslationOverlay()`,
`refreshOverlay()`, `extractTextAtRect()`, or the click guard — identical
to the prior spec's scope boundary.

## Testing Approach

Same posture as both prior Screen Translate specs: no unit tests exist
for `realTimeTranslate.ts` or `popup.ts` and this design does not add
test infrastructure for them. Verification is `npm run type-check`,
`npm test` (existing suite unaffected), `npm run build:dev`, plus a manual
smoke test in a loaded unpacked extension:

1. Toggle Screen Translate on from the popup — confirm the popup shows
   "Drag a box around text to translate.", no "Draw New Box" button, and
   the page shows a crosshair cursor with no on-page panel.
2. Drag a box over text on the page — confirm the overlay appears, the
   cursor reverts to default, and reopening the popup shows "Click 'Draw
   New Box'..." with the button visible.
3. Try dragging again without clicking "Draw New Box" — confirm nothing
   happens.
4. Click "Draw New Box" in the popup, then drag a second box elsewhere —
   confirm the first overlay disappears immediately, the cursor goes back
   to crosshair, and only the second box's overlay appears.
5. Click "Screen Translate" again to stop — confirm the crosshair cursor
   clears, any overlay is removed, and reopening the popup shows the
   inactive state (no status text, no draw button, toggle button reads
   "Screen Translate").
6. Drag a too-small box (under 10px) — confirm the popup (on next open)
   still reflects "ready-to-redraw" rather than a stuck "armed" state.
7. Toggle Screen Translate on, close the popup without dragging, then
   reopen it — confirm it still shows "armed" (proves state is queried
   live, not just assumed).

## Self-Review

**Placeholder scan**: no TBD/TODO markers; every decision is concrete.

**Internal consistency**: the state machine (`inactive` / `armed` /
`ready-to-redraw`) is defined once and every transition (start, drag-end,
draw-new-box, stop) is enumerated; the popup's rendering rules are defined
for every state.

**Scope check**: confined to `src/realTimeTranslate.ts`, `src/popup.ts`,
`popup.html`, and `src/types/index.ts` — no background/manifest changes.

**Ambiguity check**: judgment calls raised during brainstorming — what
happens on-page during an active drag (minimal crosshair-only cue vs. no
cue vs. keep the panel), how the popup learns state across reopens
(live query vs. `chrome.storage` push), and button layout (separate Draw
New Box button vs. one cycling button) — are each resolved explicitly in
Decisions above.
