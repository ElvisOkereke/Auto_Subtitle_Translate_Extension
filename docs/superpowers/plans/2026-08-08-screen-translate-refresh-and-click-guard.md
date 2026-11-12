# Screen Translate: Manual Refresh + Click-Through Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a refresh control to each Screen Translate overlay that re-reads and re-translates the text at its original location, and stop drag/click events used to draw a selection box from reaching the underlying page (e.g. so drawing a box over a video doesn't toggle its playback).

**Architecture:** Both changes live entirely in `src/realTimeTranslate.ts`. Task 1 adds per-overlay rect/timer bookkeeping, a shared text-extraction helper, and a refresh button that updates the existing overlay in place. Task 2 adds a single document-level capture-phase event guard (installed for the lifetime of `isActive`) that blocks all mouse events except ones targeting the extension's own tagged UI elements.

**Tech Stack:** TypeScript, Chrome Extension content script (Manifest V3), webpack, Jest + ts-jest (jsdom environment) — no new test infrastructure is introduced; see Global Constraints.

## Global Constraints

- Refresh re-extracts text from the page at click time — it must never simply resend the originally captured text (spec Decisions).
- Refresh must update the **same** overlay element in place (same `overlayId`, same DOM node) — it must never create a second overlay next to the first.
- Refresh must reset the overlay's 10-second auto-dismiss timer.
- The click guard blocks `mousedown`/`mouseup`/`click` on the page for the **entire time** `RealTimeTranslator.isActive` is true — not scoped narrowly to the drag gesture itself (spec Decisions).
- The click guard must never block clicks on the extension's own UI: the in-progress selection box and the translation overlay (including its buttons).
- No OCR, no new `chrome.runtime` message types, no changes to `content.ts`'s `SubtitleOverlay`, no touch-event handling, no fix for the existing "one box per toggle-on session" limitation (spec Non-goals).
- `realTimeTranslate.ts` has no existing unit tests and this plan does not add any — DOM-heavy content-script code with no current coverage in this codebase. Each task verifies with `npm run type-check`, `npm test` (confirming the existing 18 tests remain unaffected), and `npm run build:dev`. Manual in-browser verification happens after both tasks land, done by a human loading the unpacked extension — it is not a subagent step.

---

### Task 1: Refresh button and update-in-place overlay

**Files:**
- Modify: `src/realTimeTranslate.ts:11` (insert module-level helper)
- Modify: `src/realTimeTranslate.ts:13-27` (class fields + constructor)
- Modify: `src/realTimeTranslate.ts:228-281` (`showTranslationOverlay`)
- Modify: `src/realTimeTranslate.ts:307-322` (`removeOverlay`, `clearAllOverlays`)
- Modify: `src/realTimeTranslate.ts:425-445` (`ROISelector.processROI`)

**Interfaces:**
- Produces: module-level `function extractTextAtRect(rect: DOMRect): string | null` — returns the trimmed `textContent` of the first element with non-empty text found via `document.elementsFromPoint()` at the rect's center, or `null` if none. Used by both `ROISelector.processROI` and `RealTimeTranslator.refreshOverlay` (Task 1), and referenced again by Task 2's plan text only for context (Task 2 does not call it).
- Produces: `RealTimeTranslator.refreshOverlay(overlayId: string): Promise<void>` and `RealTimeTranslator.updateTranslationOverlay(overlayId: string, originalText: string, translatedText: string): void` — both private, not consumed outside this file.

- [x] **Step 1: Add the shared text-extraction helper**

In `src/realTimeTranslate.ts`, immediately after the closing of the `import { ... } from './types';` block (after line 10, before `class RealTimeTranslator {` on line 12), insert:

```ts

function extractTextAtRect(rect: DOMRect): string | null {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const elements = document.elementsFromPoint(centerX, centerY);

  for (const element of elements) {
    if (element.textContent) {
      const text = element.textContent.trim();
      if (text) return text;
    }
  }

  return null;
}
```

- [x] **Step 2: Add overlay bookkeeping fields**

Replace the class field block (current lines 13-17):

```ts
  private isActive: boolean;
  private isSelecting: boolean;
  private selectionOverlay: HTMLDivElement | null;
  private translationOverlays: Map<string, HTMLDivElement>;
  private roiSelector: ROISelector;
```

with:

```ts
  private isActive: boolean;
  private isSelecting: boolean;
  private selectionOverlay: HTMLDivElement | null;
  private translationOverlays: Map<string, HTMLDivElement>;
  private overlayRects: Map<string, DOMRect>;
  private overlayTimers: Map<string, number>;
  private roiSelector: ROISelector;
```

- [x] **Step 3: Initialize the new maps in the constructor**

Replace the constructor (current lines 19-27):

```ts
  constructor() {
    this.isActive = false;
    this.isSelecting = false;
    this.selectionOverlay = null;
    this.translationOverlays = new Map();
    this.roiSelector = new ROISelector();
    this.setupMessageListener();
    this.setupTextSelectionListener();
  }
```

with:

```ts
  constructor() {
    this.isActive = false;
    this.isSelecting = false;
    this.selectionOverlay = null;
    this.translationOverlays = new Map();
    this.overlayRects = new Map();
    this.overlayTimers = new Map();
    this.roiSelector = new ROISelector();
    this.setupMessageListener();
    this.setupTextSelectionListener();
  }
```

- [x] **Step 4: Rewrite `showTranslationOverlay` to store the rect/timer and add a refresh button**

Replace the entire `showTranslationOverlay` method (current lines 228-281):

```ts
  private showTranslationOverlay(originalText: string, translatedText: string, rect: DOMRect): void {
    const overlayId = `translation-${Date.now()}`;
    const overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.style.cssText = `
      position: fixed;
      top: ${rect.bottom + window.scrollY + 5}px;
      left: ${rect.left + window.scrollX}px;
      max-width: 300px;
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 10px;
      border-radius: 5px;
      z-index: 999997;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      border: 1px solid #333;
    `;

    overlay.innerHTML = `
      <div style="font-size: 12px; opacity: 0.7; margin-bottom: 5px;">Original:</div>
      <div style="margin-bottom: 8px; font-style: italic;">${this.escapeHtml(originalText)}</div>
      <div style="font-size: 12px; opacity: 0.7; margin-bottom: 5px;">Translation:</div>
      <div style="font-weight: bold;">${this.escapeHtml(translatedText)}</div>
      <div style="text-align: right; margin-top: 8px;">
        <button id="close-${overlayId}" style="
          background: #f44336;
          color: white;
          border: none;
          padding: 2px 8px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 11px;
        ">×</button>
      </div>
    `;

    document.body.appendChild(overlay);
    this.translationOverlays.set(overlayId, overlay);

    // Auto-hide after 10 seconds
    setTimeout(() => {
      this.removeOverlay(overlayId);
    }, 10000);

    // Add close button functionality
    const closeBtn = document.getElementById(`close-${overlayId}`);
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.removeOverlay(overlayId);
      });
    }
  }
```

with:

```ts
  private showTranslationOverlay(originalText: string, translatedText: string, rect: DOMRect): void {
    const overlayId = `translation-${Date.now()}`;
    const overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.style.cssText = `
      position: fixed;
      top: ${rect.bottom + window.scrollY + 5}px;
      left: ${rect.left + window.scrollX}px;
      max-width: 300px;
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 10px;
      border-radius: 5px;
      z-index: 999997;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      border: 1px solid #333;
    `;

    overlay.innerHTML = `
      <div style="font-size: 12px; opacity: 0.7; margin-bottom: 5px;">Original:</div>
      <div data-role="original-text" style="margin-bottom: 8px; font-style: italic;">${this.escapeHtml(originalText)}</div>
      <div style="font-size: 12px; opacity: 0.7; margin-bottom: 5px;">Translation:</div>
      <div data-role="translated-text" style="font-weight: bold;">${this.escapeHtml(translatedText)}</div>
      <div style="text-align: right; margin-top: 8px;">
        <button id="refresh-${overlayId}" title="Refresh" style="
          background: #2196F3;
          color: white;
          border: none;
          padding: 2px 8px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 11px;
          margin-right: 4px;
        ">⟳</button>
        <button id="close-${overlayId}" style="
          background: #f44336;
          color: white;
          border: none;
          padding: 2px 8px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 11px;
        ">×</button>
      </div>
    `;

    document.body.appendChild(overlay);
    this.translationOverlays.set(overlayId, overlay);
    this.overlayRects.set(overlayId, rect);

    const timerId = window.setTimeout(() => {
      this.removeOverlay(overlayId);
    }, 10000);
    this.overlayTimers.set(overlayId, timerId);

    const refreshBtn = document.getElementById(`refresh-${overlayId}`);
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.refreshOverlay(overlayId);
      });
    }

    const closeBtn = document.getElementById(`close-${overlayId}`);
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.removeOverlay(overlayId);
      });
    }
  }
```

- [x] **Step 5: Add `updateTranslationOverlay` and `refreshOverlay`**

Immediately after the `showTranslationOverlay` method you just replaced (i.e. directly before `private showError(...)`), insert two new methods:

```ts
  private updateTranslationOverlay(overlayId: string, originalText: string, translatedText: string): void {
    const overlay = this.translationOverlays.get(overlayId);
    if (!overlay) return;

    const originalDiv = overlay.querySelector<HTMLDivElement>('[data-role="original-text"]');
    const translatedDiv = overlay.querySelector<HTMLDivElement>('[data-role="translated-text"]');
    if (originalDiv) originalDiv.textContent = originalText;
    if (translatedDiv) translatedDiv.textContent = translatedText;

    const existingTimer = this.overlayTimers.get(overlayId);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timerId = window.setTimeout(() => {
      this.removeOverlay(overlayId);
    }, 10000);
    this.overlayTimers.set(overlayId, timerId);
  }

  private async refreshOverlay(overlayId: string): Promise<void> {
    const rect = this.overlayRects.get(overlayId);
    if (!rect) return;

    const refreshBtn = document.getElementById(`refresh-${overlayId}`) as HTMLButtonElement | null;
    const originalLabel = refreshBtn?.textContent ?? '⟳';
    if (refreshBtn) {
      refreshBtn.textContent = '...';
      refreshBtn.setAttribute('disabled', 'true');
    }

    try {
      const textContent = extractTextAtRect(rect);
      if (!textContent) {
        this.showError('No text found to translate', rect);
        return;
      }

      const settings = await chrome.runtime.sendMessage({
        type: 'GET_SETTINGS'
      });

      const targetLang = settings.targetLanguage || 'en';

      const translation = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_TEXT',
        text: textContent,
        targetLang
      });

      if (translation.success) {
        this.updateTranslationOverlay(overlayId, textContent, translation.translatedText);
      } else {
        this.showError('Translation failed', rect);
      }
    } catch (error) {
      console.error('Error refreshing translation:', error);
      this.showError('Translation error', rect);
    } finally {
      if (refreshBtn) {
        refreshBtn.textContent = originalLabel;
        refreshBtn.removeAttribute('disabled');
      }
    }
  }
```

- [x] **Step 6: Clean up the new maps in `removeOverlay`**

Replace `removeOverlay` (current lines 307-313):

```ts
  private removeOverlay(overlayId: string): void {
    const overlay = this.translationOverlays.get(overlayId);
    if (overlay && overlay.parentNode) {
      overlay.remove();
      this.translationOverlays.delete(overlayId);
    }
  }
```

with:

```ts
  private removeOverlay(overlayId: string): void {
    const overlay = this.translationOverlays.get(overlayId);
    if (overlay && overlay.parentNode) {
      overlay.remove();
      this.translationOverlays.delete(overlayId);
    }
    this.overlayRects.delete(overlayId);

    const timerId = this.overlayTimers.get(overlayId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      this.overlayTimers.delete(overlayId);
    }
  }
```

- [x] **Step 7: Clean up the new maps in `clearAllOverlays`**

Replace `clearAllOverlays` (current lines 315-322):

```ts
  private clearAllOverlays(): void {
    this.translationOverlays.forEach((overlay, id) => {
      if (overlay.parentNode) {
        overlay.remove();
      }
    });
    this.translationOverlays.clear();
  }
```

with:

```ts
  private clearAllOverlays(): void {
    this.translationOverlays.forEach((overlay) => {
      if (overlay.parentNode) {
        overlay.remove();
      }
    });
    this.translationOverlays.clear();
    this.overlayRects.clear();

    this.overlayTimers.forEach((timerId) => window.clearTimeout(timerId));
    this.overlayTimers.clear();
  }
```

- [x] **Step 8: Reuse the shared helper in `ROISelector.processROI`**

Replace `processROI` (current lines 425-445):

```ts
  private processROI(roi: ROIData): void {
    // Extract text from the ROI area
    const elements = document.elementsFromPoint(roi.x + roi.width / 2, roi.y + roi.height / 2);
    let textContent = '';

    for (const element of elements) {
      if (element.textContent) {
        textContent = element.textContent.trim();
        if (textContent) break;
      }
    }

    if (textContent) {
      // Send message to translate the extracted text
      chrome.runtime.sendMessage({
        type: 'TRANSLATE_SELECTED_TEXT',
        text: textContent,
        rect: new DOMRect(roi.x, roi.y, roi.width, roi.height)
      });
    }
  }
```

with:

```ts
  private processROI(roi: ROIData): void {
    const rect = new DOMRect(roi.x, roi.y, roi.width, roi.height);
    const textContent = extractTextAtRect(rect);

    if (textContent) {
      chrome.runtime.sendMessage({
        type: 'TRANSLATE_SELECTED_TEXT',
        text: textContent,
        rect
      });
    }
  }
```

- [x] **Step 9: Verify**

Run, in order:
- `npm run type-check` — expect PASS, 0 errors.
- `npm test` — expect PASS, all 18 existing tests unaffected (no tests reference `realTimeTranslate.ts`).
- `npm run build:dev` — expect PASS; confirm `dist/realTimeTranslate.js` was rebuilt.

- [x] **Step 10: Commit**

```bash
git add src/realTimeTranslate.ts
git commit -m "feat: add refresh button to Screen Translate overlay"
```

---

### Task 2: Click-through prevention while Screen Translate is active

**Files:**
- Modify: `src/realTimeTranslate.ts` — `ROISelector.createSelectionBox` (tag the selection box)
- Modify: `src/realTimeTranslate.ts` — `showTranslationOverlay` (tag the overlay div and both buttons; this method was fully rewritten in Task 1, so match against Task 1's resulting code, not the original file)
- Modify: `src/realTimeTranslate.ts` — add `handleGuardedEvent`/`installClickGuard`/`removeClickGuard` to `RealTimeTranslator`, and wire them into `startTranslation`/`stopTranslation`

**Interfaces:**
- Consumes: nothing new from Task 1 — this task only adds a `data-rtt-owned` attribute marker convention and a document-level guard; it does not call `extractTextAtRect`, `refreshOverlay`, or `updateTranslationOverlay`.
- Produces: a `data-rtt-owned` HTML attribute (no value needed — presence-only, matched via the CSS attribute selector `[data-rtt-owned]`) applied to: the ROI selection box, the translation overlay's outer `<div>`, and its refresh/close `<button>` elements. Any future UI element that should stay clickable while the guard is active must carry this same attribute.

- [x] **Step 1: Tag the selection box**

In `ROISelector.createSelectionBox`, find:

```ts
  private createSelectionBox(x: number, y: number): void {
    this.selectionBox = document.createElement('div');
    this.selectionBox.style.cssText = `
```

and change it to:

```ts
  private createSelectionBox(x: number, y: number): void {
    this.selectionBox = document.createElement('div');
    this.selectionBox.setAttribute('data-rtt-owned', '');
    this.selectionBox.style.cssText = `
```

- [x] **Step 2: Tag the overlay div**

In `showTranslationOverlay` (as it exists after Task 1), find:

```ts
    const overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.style.cssText = `
```

and change it to:

```ts
    const overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.setAttribute('data-rtt-owned', '');
    overlay.style.cssText = `
```

- [x] **Step 3: Tag the refresh and close buttons**

In the same method's `innerHTML` template (as it exists after Task 1), find:

```html
        <button id="refresh-${overlayId}" title="Refresh" style="
```

and change it to:

```html
        <button id="refresh-${overlayId}" data-rtt-owned title="Refresh" style="
```

Find:

```html
        <button id="close-${overlayId}" style="
```

and change it to:

```html
        <button id="close-${overlayId}" data-rtt-owned style="
```

- [x] **Step 4: Add the guard methods to `RealTimeTranslator`**

Immediately after the `stopTranslation` method (directly before the existing `private startSelection(): void {` dead-code method), insert:

```ts
  private handleGuardedEvent = (event: Event): void => {
    const target = event.target as Element | null;
    if (target?.closest('[data-rtt-owned]')) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
  };

  private installClickGuard(): void {
    document.addEventListener('mousedown', this.handleGuardedEvent, true);
    document.addEventListener('mouseup', this.handleGuardedEvent, true);
    document.addEventListener('click', this.handleGuardedEvent, true);
  }

  private removeClickGuard(): void {
    document.removeEventListener('mousedown', this.handleGuardedEvent, true);
    document.removeEventListener('mouseup', this.handleGuardedEvent, true);
    document.removeEventListener('click', this.handleGuardedEvent, true);
  }
```

`handleGuardedEvent` **must** be declared as an arrow-function class field (as shown, `private handleGuardedEvent = (event: Event) => {...}`), not a regular method bound with `.bind(this)` at each call site. `removeEventListener` only detaches a listener when passed the exact same function reference used in `addEventListener` — `.bind(this)` creates a new function every time it's called, which is why the pre-existing `stopSelection()` method's own `removeEventListener` calls elsewhere in this file silently fail to detach anything (out of scope to fix per Global Constraints, but do not repeat that pattern here — the guard's removal must actually work, or Screen Translate would keep blocking every click on the page even after being toggled off).

- [x] **Step 5: Install/remove the guard around the active session**

Find:

```ts
  private startTranslation(): void {
    this.isActive = true;
    this.showStatusIndicator('Screen translation active - Draw a rectangle to select area');
    document.body.style.cursor = 'crosshair';
    // Start ROI selection
    this.roiSelector.startSelection();
  }

  private stopTranslation(): void {
    this.isActive = false;
    this.clearAllOverlays();
    this.hideStatusIndicator();
    document.body.style.cursor = '';
  }
```

and change it to:

```ts
  private startTranslation(): void {
    this.isActive = true;
    this.showStatusIndicator('Screen translation active - Draw a rectangle to select area');
    document.body.style.cursor = 'crosshair';
    this.installClickGuard();
    // Start ROI selection
    this.roiSelector.startSelection();
  }

  private stopTranslation(): void {
    this.isActive = false;
    this.clearAllOverlays();
    this.hideStatusIndicator();
    document.body.style.cursor = '';
    this.removeClickGuard();
  }
```

- [x] **Step 6: Verify**

Run, in order:
- `npm run type-check` — expect PASS, 0 errors.
- `npm test` — expect PASS, all 18 existing tests unaffected.
- `npm run build:dev` — expect PASS; confirm `dist/realTimeTranslate.js` was rebuilt.

- [x] **Step 7: Commit**

```bash
git add src/realTimeTranslate.ts
git commit -m "feat: block page clicks while Screen Translate selection is active"
```
