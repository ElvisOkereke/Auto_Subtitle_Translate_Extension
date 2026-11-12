# Screen Translate: On-Page Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Screen Translate's single status banner with a persistent on-page control panel that carries the user through each step, adding a "Draw New Box" button to redraw without leaving Screen Translate mode and a "Stop" button to exit it from the page directly.

**Architecture:** Both changes live entirely in `src/realTimeTranslate.ts`. Task 1 replaces `showStatusIndicator`/`hideStatusIndicator` with a `showControlPanel`/`updateControlPanel`/`hideControlPanel` trio that renders state-dependent messaging and buttons, and fixes a latent bug where `stopTranslation()` never disarmed an in-progress `ROISelector` drag. Task 2 adds a required `onSelectionEnded` callback to `ROISelector`, invoked unconditionally at the end of every drag, which is what flips the panel from "armed" to "ready-to-redraw" — including for too-small or textless drags that previously left the user stuck with no feedback.

**Tech Stack:** TypeScript, Chrome Extension content script (Manifest V3), webpack, Jest + ts-jest (jsdom environment) — no new test infrastructure is introduced; see Global Constraints.

## Global Constraints

- The first box is auto-armed on toggle-on — no "Draw New Box" click is required to draw the very first box (spec Decisions).
- Every box after the first requires clicking "Draw New Box" — dragging is disarmed unconditionally after any drag ends, regardless of whether a valid ROI was found (spec Decisions).
- Drawing a new box replaces the previous overlay — "Draw New Box" clears any existing overlay immediately, it does not wait for the new translation to land (spec Decisions).
- The panel's "Stop" button calls the existing `stopTranslation()` method directly — no new `chrome.runtime` message types are introduced (spec Decisions).
- The panel and its buttons carry `data-rtt-owned` so the existing click guard (`installClickGuard`/`removeClickGuard`, unchanged by this plan) lets clicks on them through (spec Decisions).
- No changes to any other popup UI (subtitles toggle, language/provider/API-key settings), no OCR, no touch/mobile event handling (spec Non-goals).
- `realTimeTranslate.ts` has no existing unit tests and this plan does not add any. Each task verifies with `npm run type-check`, `npm test` (confirming the existing 18 tests remain unaffected), and `npm run build:dev`. Manual in-browser verification happens after both tasks land, done by a human loading the unpacked extension — it is not a subagent step.

---

### Task 1: On-page control panel (replaces status banner)

**Files:**
- Modify: `src/realTimeTranslate.ts:92-107` (`startTranslation`, `stopTranslation`)
- Modify: `src/realTimeTranslate.ts:202-230` (remove `showStatusIndicator`/`hideStatusIndicator`, add `showControlPanel`/`updateControlPanel`/`hideControlPanel`)

**Interfaces:**
- Produces: `RealTimeTranslator.showControlPanel(): void`, `RealTimeTranslator.updateControlPanel(state: 'armed' | 'ready-to-redraw'): void`, `RealTimeTranslator.hideControlPanel(): void` — all private. `updateControlPanel` is consumed by Task 2's `ROISelector` callback wiring (called as `this.updateControlPanel('ready-to-redraw')`).
- Consumes: nothing new — reuses existing `this.clearAllOverlays()` and `this.roiSelector.startSelection()`/`stopSelection()`.

- [ ] **Step 1: Replace `showStatusIndicator`/`hideStatusIndicator` with the control panel methods**

In `src/realTimeTranslate.ts`, find the existing methods (current lines 202-230):

```ts
  private showStatusIndicator(message: string): void {
    let indicator = document.getElementById('translation-status-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'translation-status-indicator';
      indicator.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #4CAF50;
        color: white;
        padding: 10px 15px;
        border-radius: 5px;
        z-index: 999999;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      `;
      document.body.appendChild(indicator);
    }
    indicator.textContent = message;
  }

  private hideStatusIndicator(): void {
    const indicator = document.getElementById('translation-status-indicator');
    if (indicator) {
      indicator.remove();
    }
  }
```

Replace them with:

```ts
  private showControlPanel(): void {
    let panel = document.getElementById('screen-translate-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'screen-translate-panel';
      panel.setAttribute('data-rtt-owned', '');
      panel.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #4CAF50;
        color: white;
        padding: 10px 15px;
        border-radius: 5px;
        z-index: 999999;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      `;
      document.body.appendChild(panel);
    }
    this.updateControlPanel('armed');
  }

  private updateControlPanel(state: 'armed' | 'ready-to-redraw'): void {
    const panel = document.getElementById('screen-translate-panel');
    if (!panel) return;

    const message = state === 'armed'
      ? 'Screen Translate active — drag a box around text to translate.'
      : "Click 'Draw New Box' to translate another area.";

    const drawNewBoxButton = state === 'ready-to-redraw'
      ? `<button id="screen-translate-draw-btn" data-rtt-owned style="
          background: #2196F3;
          color: white;
          border: none;
          padding: 4px 10px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 12px;
          margin-right: 6px;
        ">Draw New Box</button>`
      : '';

    panel.innerHTML = `
      <div style="margin-bottom: 8px;">${message}</div>
      <div style="text-align: right;">
        ${drawNewBoxButton}
        <button id="screen-translate-stop-btn" data-rtt-owned style="
          background: #f44336;
          color: white;
          border: none;
          padding: 4px 10px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 12px;
        ">Stop</button>
      </div>
    `;

    if (state === 'ready-to-redraw') {
      const drawBtn = document.getElementById('screen-translate-draw-btn');
      if (drawBtn) {
        drawBtn.addEventListener('click', () => {
          this.clearAllOverlays();
          this.roiSelector.startSelection();
          this.updateControlPanel('armed');
        });
      }
    }

    const stopBtn = document.getElementById('screen-translate-stop-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        this.stopTranslation();
      });
    }
  }

  private hideControlPanel(): void {
    const panel = document.getElementById('screen-translate-panel');
    if (panel) {
      panel.remove();
    }
  }
```

- [ ] **Step 2: Wire the panel into `startTranslation`/`stopTranslation`, and disarm `ROISelector` on stop**

Find (current lines 92-107):

```ts
  private startTranslation(): void {
    this.isActive = true;
    this.showStatusIndicator('Screen translation active - Draw a rectangle to select area');
    document.body.style.cursor = 'crosshair';
    // Start ROI selection
    this.roiSelector.startSelection();
    this.installClickGuard();
  }

  private stopTranslation(): void {
    this.isActive = false;
    this.clearAllOverlays();
    this.hideStatusIndicator();
    document.body.style.cursor = '';
    this.removeClickGuard();
  }
```

Replace with:

```ts
  private startTranslation(): void {
    this.isActive = true;
    this.showControlPanel();
    document.body.style.cursor = 'crosshair';
    // Start ROI selection
    this.roiSelector.startSelection();
    this.installClickGuard();
  }

  private stopTranslation(): void {
    this.isActive = false;
    this.roiSelector.stopSelection();
    this.clearAllOverlays();
    this.hideControlPanel();
    document.body.style.cursor = '';
    this.removeClickGuard();
  }
```

`this.roiSelector.stopSelection()` is new here — previously, clicking "Stop" (or toggling off) before completing a drag left `ROISelector.isSelecting` stuck `true` forever, meaning a later drag on the page would still silently run ROI extraction and send a translation request even though Screen Translate was supposedly off. Calling it unconditionally in `stopTranslation()` guarantees `isSelecting` is reset and any half-drawn selection box is removed, regardless of what state the drag was in. `stopSelection()` is idempotent (guarded by `this.selectionBox`/`this.startPoint` null checks), so calling it when no drag was in progress is a no-op beyond resetting `isSelecting` and `userSelect`.

- [ ] **Step 3: Verify**

Run, in order:
- `npm run type-check` — expect PASS, 0 errors.
- `npm test` — expect PASS, all 18 existing tests unaffected (no tests reference `realTimeTranslate.ts`).
- `npm run build:dev` — expect PASS; confirm `dist/realTimeTranslate.js` was rebuilt.

- [ ] **Step 4: Commit**

```bash
git add src/realTimeTranslate.ts
git commit -m "feat: replace Screen Translate status banner with an on-page control panel"
```

---

### Task 2: Guided redraw via `ROISelector.onSelectionEnded`

**Files:**
- Modify: `src/realTimeTranslate.ts:462-471` (`ROISelector` class fields + constructor)
- Modify: `src/realTimeTranslate.ts:514-530` (`ROISelector.handleMouseUp`)
- Modify: `src/realTimeTranslate.ts:43` (`RealTimeTranslator` constructor — `ROISelector` instantiation)

**Interfaces:**
- Consumes: `RealTimeTranslator.updateControlPanel('ready-to-redraw' | 'armed')` from Task 1.
- Produces: `ROISelector`'s constructor now requires `onSelectionEnded: () => void` — the only call site (`RealTimeTranslator`'s constructor) is updated in this task; no other code instantiates `ROISelector`.

- [ ] **Step 1: Add the `onSelectionEnded` field and require it in the constructor**

Find (current lines 462-471):

```ts
class ROISelector {
  private isSelecting: boolean;
  private startPoint: { x: number; y: number } | null;
  private selectionBox: HTMLDivElement | null;

  constructor() {
    this.isSelecting = false;
    this.startPoint = null;
    this.selectionBox = null;
  }
```

Replace with:

```ts
class ROISelector {
  private isSelecting: boolean;
  private startPoint: { x: number; y: number } | null;
  private selectionBox: HTMLDivElement | null;
  private onSelectionEnded: () => void;

  constructor(onSelectionEnded: () => void) {
    this.isSelecting = false;
    this.startPoint = null;
    this.selectionBox = null;
    this.onSelectionEnded = onSelectionEnded;
  }
```

- [ ] **Step 2: Invoke the callback at the end of every drag**

Find (current lines 514-530):

```ts
  private handleMouseUp(event: MouseEvent): void {
    if (!this.isSelecting || !this.startPoint) return;

    const roi: ROIData = {
      x: Math.min(this.startPoint.x, event.clientX),
      y: Math.min(this.startPoint.y, event.clientY),
      width: Math.abs(event.clientX - this.startPoint.x),
      height: Math.abs(event.clientY - this.startPoint.y)
    };

    // Only process if the selection is large enough
    if (roi.width > 10 && roi.height > 10) {
      this.processROI(roi);
    }

    this.stopSelection();
  }
```

Replace with:

```ts
  private handleMouseUp(event: MouseEvent): void {
    if (!this.isSelecting || !this.startPoint) return;

    const roi: ROIData = {
      x: Math.min(this.startPoint.x, event.clientX),
      y: Math.min(this.startPoint.y, event.clientY),
      width: Math.abs(event.clientX - this.startPoint.x),
      height: Math.abs(event.clientY - this.startPoint.y)
    };

    // Only process if the selection is large enough
    if (roi.width > 10 && roi.height > 10) {
      this.processROI(roi);
    }

    this.stopSelection();
    this.onSelectionEnded();
  }
```

`onSelectionEnded()` fires unconditionally — even when `roi.width`/`roi.height` was too small to process — so the control panel always flips to "ready-to-redraw" the moment a drag ends, whatever the outcome. This is what fixes the dead-end case from the design spec.

- [ ] **Step 3: Wire the callback from `RealTimeTranslator`'s constructor**

Find (current line 43):

```ts
    this.roiSelector = new ROISelector();
```

Replace with:

```ts
    this.roiSelector = new ROISelector(() => this.updateControlPanel('ready-to-redraw'));
```

- [ ] **Step 4: Verify**

Run, in order:
- `npm run type-check` — expect PASS, 0 errors.
- `npm test` — expect PASS, all 18 existing tests unaffected.
- `npm run build:dev` — expect PASS; confirm `dist/realTimeTranslate.js` was rebuilt.

- [ ] **Step 5: Commit**

```bash
git add src/realTimeTranslate.ts
git commit -m "feat: flip Screen Translate panel to ready-to-redraw after every drag"
```

---

### Manual Smoke Test (after both tasks land)

Not a subagent step — done by a human loading the unpacked extension in Chrome:

1. Toggle Screen Translate on from the popup — confirm the on-page panel appears top-right with the "armed" message ("Screen Translate active — drag a box around text to translate.") and a red **Stop** button, and dragging works immediately (no "Draw New Box" click needed for the first box).
2. Drag a box over text — confirm the translation overlay appears and the panel switches to "Click 'Draw New Box' to translate another area." with both **Draw New Box** and **Stop** buttons visible.
3. Try dragging again without clicking "Draw New Box" — confirm nothing happens (dragging is disarmed).
4. Click **Draw New Box**, drag a second box elsewhere — confirm the first overlay disappears immediately when "Draw New Box" is clicked, and only the second box's overlay appears after the drag.
5. Click **Stop** on the panel — confirm the panel, any overlay, and the crosshair cursor all disappear, and clicking/dragging on the page behaves normally again (no stray selection boxes, no accidental translation requests).
6. Drag a too-small box (under 10px) or one over an element with no text — confirm the panel still flips to "ready-to-redraw" instead of leaving dragging silently disarmed with no feedback.
7. Draw a box over a `<video>` element — confirm the click guard from the prior Screen Translate work still prevents the drag from toggling playback.
