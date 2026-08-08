# Screen Translate: Manual Refresh + Click-Through Prevention

Date: 2026-08-08
Status: Approved, ready for implementation planning

## Context

Screen Translate (`src/realTimeTranslate.ts`) lets a user drag a box over any
part of the page; `ROISelector.processROI()` grabs whatever text sits at the
box's center point via `document.elementsFromPoint()` and translates it,
showing the result in a floating overlay (`RealTimeTranslator.
showTranslationOverlay()`) that auto-dismisses after 10 seconds.

Two problems today:

1. The overlay's text is a one-shot snapshot. If the underlying content
   changes (e.g. a video's captions advance) there's no way to get an
   updated translation for the same box without redrawing it from scratch.
2. Drawing a box involves real `mousedown`/`mouseup` events on the
   underlying page, and nothing stops those events from propagating. If the
   box is drawn over a `<video>`, the page's own click-to-toggle-playback
   handler fires too — so selecting a region on a video also plays/pauses
   it.

## Goals

- Add a refresh control to each translation overlay that re-reads the
  current text at that overlay's original screen location and re-translates
  it, updating the same overlay in place.
- Refreshing resets the overlay's 10-second auto-dismiss timer.
- While Screen Translate is toggled on, no mouse event used for drawing a
  selection box (or any other click on the page during that time) should
  reach the underlying page's own handlers — e.g. drawing over a video must
  never toggle its playback.
- The overlay's own controls (close, refresh) must keep working normally —
  click-through prevention must not block clicks on our own UI.

## Non-goals

- No change to how text is extracted (`document.elementsFromPoint`) — no
  OCR, no `window.getSelection()`-based path added or removed.
- No fix for the existing limitation that only one box can be drawn per
  Screen-Translate toggle-on session — unrelated to this request.
- No touch/mobile event handling — this extension targets desktop Chrome
  with mouse input, matching all existing ROI code.
- No changes to the separate audio-caption subtitle overlay
  (`content.ts`'s `SubtitleOverlay`) — this only touches the Screen
  Translate ROI overlay in `realTimeTranslate.ts`.

## Decisions

- **Refresh re-extracts, it doesn't just resend** — re-run the same
  `elementsFromPoint` extraction at click time rather than re-sending the
  originally captured text, so a refresh reflects whatever is on screen
  now.
- **Refresh updates the existing overlay in place** — it does not create a
  second overlay next to the first. This requires storing the rect that
  produced each overlay in the DOM.
- **Refresh resets the 10s auto-dismiss timer** — otherwise a refresh could
  land moments before the box vanishes anyway.
- **Click-through prevention is blanket while the feature is toggled on**,
  not scoped to only the exact drag gesture — a single capture-phase
  listener on `document` swallows `mousedown`/`mouseup`/`click` for the
  entire time `RealTimeTranslator.isActive` is true, not just between one
  `ROISelector.startSelection()`/`stopSelection()` pair. This still allows
  clicks on our own overlay/selection-box elements through.

## Architecture

### Refresh button

`RealTimeTranslator.showTranslationOverlay()` (`src/realTimeTranslate.ts`,
currently lines 228-281) gains a second footer button alongside the
existing `close-${overlayId}` button, built the same way (inline HTML
string, then `getElementById` + `addEventListener` after the overlay is
appended):

```html
<button id="refresh-${overlayId}" data-rtt-owned title="Refresh">⟳</button>
```

Its click handler:
1. Sets a brief disabled/`...` state on the button (guards against
   double-click while a request is in flight).
2. Looks up the stored rect for this overlay (see below).
3. Re-runs the extraction helper (see below) to get current text at that
   rect's center point.
4. Runs the same `GET_SETTINGS` → `TRANSLATE_TEXT` round trip
   `translateAndShowText()` already uses.
5. On success, calls a new `updateTranslationOverlay(overlayId,
   originalText, translatedText)` — finds the existing overlay div by id,
   replaces its original/translation text content, and restarts the 10s
   `setTimeout` that calls `removeOverlay(overlayId)`. It does **not**
   create a new div or a new id.
6. On failure, reuses the existing `showError()` path.
7. Re-enables the button.

### Storing the originating rect

`processROI()`'s extraction step (currently `document.elementsFromPoint`
inline in `ROISelector.processROI()`, lines ~425-445) is factored into a
standalone helper, e.g. `extractTextAtRect(rect: DOMRect): string | null`,
callable both from the original drag flow and from refresh.

`RealTimeTranslator` gains a new `private overlayRects: Map<string,
DOMRect>` alongside the existing `translationOverlays: Map<string,
HTMLDivElement>`. `showTranslationOverlay(rect, ...)` records the rect
under the overlay's id when it creates the overlay; `removeOverlay()`
deletes from both maps together so they never drift out of sync.

### Click-through prevention

A new method, e.g. `RealTimeTranslator.installClickGuard()` /
`removeClickGuard()`, attaches/detaches one `document`-level listener
(capture phase, `{ capture: true }`) shared across `mousedown`, `mouseup`,
and `click`:

```ts
private handleGuardedEvent = (event: Event) => {
  const target = event.target as Element | null;
  if (target?.closest('[data-rtt-owned]')) return; // let our own UI through
  event.stopPropagation();
  event.preventDefault();
};
```

- Installed in `startTranslation()` (alongside the existing crosshair
  cursor / status banner setup) and removed in `stopTranslation()` — so it
  spans the whole time Screen Translate is toggled on, independent of
  `ROISelector`'s own per-drag listener lifecycle (which today attaches and
  detaches around a single drag via `startSelection()`/`stopSelection()`).
- Any element that should remain clickable while the guard is active — the
  in-progress selection box, the translation overlay div, and both its
  buttons — gets the `data-rtt-owned` attribute so `closest()` finds it and
  the guard steps aside.
- Because this is a single shared handler independent of the drag
  lifecycle, it keeps blocking stray clicks on the page even in the gap
  between drags (e.g. right after one box is drawn, before the user has
  toggled Screen Translate off) — not just during the literal
  mousedown-to-mouseup window.

## Testing Approach

`realTimeTranslate.ts` has no existing unit tests and this design doesn't
introduce test infrastructure for it — DOM-heavy content-script code with
no current coverage in this codebase (consistent with how the popup UI is
already untested). Verification is manual: type-check, build, and a
manual smoke test in a loaded extension (draw a box over a video and
confirm it doesn't play/pause; click refresh and confirm the overlay
updates and the auto-dismiss timer restarts; click close and confirm it
still works while the guard is active).

## Self-Review

**Placeholder scan**: no TBD/TODO markers; every decision is concrete.

**Internal consistency**: the refresh flow reuses the same
`GET_SETTINGS`/`TRANSLATE_TEXT` messages and `showError()` path the
existing translate flow already uses — no new message types are
introduced, keeping `background.ts` completely unchanged.

**Scope check**: single focused change (one UI control + one guard
mechanism) confined to `realTimeTranslate.ts` — no decomposition needed.

**Ambiguity check**: the two judgment calls in this space — whether refresh
re-extracts vs. resends, and how broadly click-through prevention should
apply — were both raised explicitly and resolved in the Decisions section
above rather than left for implementation time to guess at.
