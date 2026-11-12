# Screen Translate: Popup Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Screen Translate's on-page control panel entirely and move all of its controls (armed/ready-to-redraw status text, "Draw New Box") into the extension popup, which queries the content script for live state every time it opens.

**Architecture:** `src/types/index.ts` gains two message types and a response type. `src/realTimeTranslate.ts` replaces the on-page panel (`showControlPanel`/`updateControlPanel`/`hideControlPanel`) with an internal `screenTranslateState` field, a state-aware crosshair cursor, a new `drawNewBox()` method, and a `GET_SCREEN_TRANSLATE_STATE` query handler. `popup.html`/`src/popup.ts` add a "Draw New Box" button and a persistent status element, queried/updated via a new `refreshScreenTranslateState()` on popup open and rendered by a single `renderScreenTranslateState()` helper that both the toggle handler and the draw-new-box handler reuse.

**Tech Stack:** TypeScript, Chrome Extension content script + popup (Manifest V3), webpack, Jest + ts-jest (jsdom environment) — no new test infrastructure is introduced; see Global Constraints.

## Global Constraints

- The on-page panel (`showControlPanel`/`updateControlPanel`/`hideControlPanel`) is deleted, not hidden — no dead code path (spec Decisions).
- The crosshair cursor is state-aware: `'crosshair'` while armed, `''` while ready-to-redraw (spec Decisions).
- "Draw New Box" is a separate popup button from the existing "Screen Translate" toggle button, hidden unless Screen Translate is on and the content script reports `ready-to-redraw` (spec Decisions).
- The popup queries the content script for current state every time it opens via `GET_SCREEN_TRANSLATE_STATE`; a failed/missing response is treated as `inactive` (spec Decisions).
- Status text lives in a new, non-auto-hiding element (`#screenTranslateStatus`), never the existing `#status` toast (spec Decisions).
- No changes to `showTranslationOverlay()`, `updateTranslationOverlay()`, `refreshOverlay()`, `extractTextAtRect()`, or the click guard (`installClickGuard`/`removeClickGuard`) (spec Non-goals).
- No changes to any other popup setting (subtitles, languages, provider, API keys) and no new `chrome.storage` persistence for Screen Translate state (spec Non-goals).
- `realTimeTranslate.ts` and `popup.ts` have no existing unit tests and this plan does not add any. Each task verifies with `npm run type-check`, `npm test` (confirming the existing test suite is unaffected), and `npm run build:dev`. The manual smoke test happens after all tasks land, done by a human loading the unpacked extension — it is not a subagent step.

---

### Task 1: Message types for state query and redraw

**Files:**
- Modify: `src/types/index.ts:7-29` (`MessageType` union)
- Modify: `src/types/index.ts:102-106` (insert new interfaces after `TranslateSelectedTextMessage`)

**Interfaces:**
- Produces: `GetScreenTranslateStateMessage` (`type: 'GET_SCREEN_TRANSLATE_STATE'`), `DrawNewBoxMessage` (`type: 'DRAW_NEW_BOX'`), `ScreenTranslateStateResponse` (`{ state: 'inactive' | 'armed' | 'ready-to-redraw' }`) — consumed by Task 2 (content script) and Task 3 (popup).
- Consumes: nothing new — extends the existing `ExtensionMessage` base interface.

- [ ] **Step 1: Add the two new message types to the `MessageType` union**

In `src/types/index.ts`, find (current lines 18-21):

```ts
  | 'TOGGLE_SCREEN_TRANSLATION'
  | 'START_ROI_SELECTION'
  | 'END_ROI_SELECTION'
  | 'TRANSLATE_SELECTED_TEXT'
```

Replace with:

```ts
  | 'TOGGLE_SCREEN_TRANSLATION'
  | 'START_ROI_SELECTION'
  | 'END_ROI_SELECTION'
  | 'TRANSLATE_SELECTED_TEXT'
  | 'GET_SCREEN_TRANSLATE_STATE'
  | 'DRAW_NEW_BOX'
```

- [ ] **Step 2: Add the message and response interfaces**

Find (current lines 102-106):

```ts
export interface TranslateSelectedTextMessage extends ExtensionMessage {
  type: 'TRANSLATE_SELECTED_TEXT';
  text: string;
  rect: DOMRect;
}
```

Replace with:

```ts
export interface TranslateSelectedTextMessage extends ExtensionMessage {
  type: 'TRANSLATE_SELECTED_TEXT';
  text: string;
  rect: DOMRect;
}

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

- [ ] **Step 3: Verify**

Run, in order:
- `npm run type-check` — expect PASS, 0 errors.
- `npm test` — expect PASS, existing tests unaffected.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add message types for Screen Translate state query and redraw"
```

---

### Task 2: Content script state machine (replaces on-page panel)

**Files:**
- Modify: `src/realTimeTranslate.ts:3-10` (imports)
- Modify: `src/realTimeTranslate.ts:27-46` (`RealTimeTranslator` fields + constructor)
- Modify: `src/realTimeTranslate.ts:48-77` (`setupMessageListener`)
- Modify: `src/realTimeTranslate.ts:92-108` (`startTranslation`, `stopTranslation`)
- Modify: `src/realTimeTranslate.ts:203-288` (delete `showControlPanel`/`updateControlPanel`/`hideControlPanel`, add `drawNewBox`)

**Interfaces:**
- Consumes: `GetScreenTranslateStateMessage`, `DrawNewBoxMessage`, `ScreenTranslateStateResponse` from Task 1.
- Produces: `RealTimeTranslator`'s message listener responds to `GET_SCREEN_TRANSLATE_STATE` with `ScreenTranslateStateResponse` — consumed by Task 3's `refreshScreenTranslateState()`. Handles `DRAW_NEW_BOX` — consumed by Task 3's `drawNewBox()` handler.

- [ ] **Step 1: Import the new message types**

Find (current lines 3-10):

```ts
import {
  ToggleScreenTranslationMessage,
  TranslateSelectedTextMessage,
  ShowTranslationOverlayMessage,
  StartROISelectionMessage,
  EndROISelectionMessage,
  ROIData
} from './types';
```

Replace with:

```ts
import {
  ToggleScreenTranslationMessage,
  TranslateSelectedTextMessage,
  ShowTranslationOverlayMessage,
  StartROISelectionMessage,
  EndROISelectionMessage,
  GetScreenTranslateStateMessage,
  DrawNewBoxMessage,
  ROIData
} from './types';
```

- [ ] **Step 2: Add the `screenTranslateState` field and update the `ROISelector` callback**

Find (current lines 27-46):

```ts
class RealTimeTranslator {
  private isActive: boolean;
  private isSelecting: boolean;
  private selectionOverlay: HTMLDivElement | null;
  private translationOverlays: Map<string, HTMLDivElement>;
  private overlayRects: Map<string, DOMRect>;
  private overlayTimers: Map<string, number>;
  private roiSelector: ROISelector;

  constructor() {
    this.isActive = false;
    this.isSelecting = false;
    this.selectionOverlay = null;
    this.translationOverlays = new Map();
    this.overlayRects = new Map();
    this.overlayTimers = new Map();
    this.roiSelector = new ROISelector(() => this.updateControlPanel('ready-to-redraw'));
    this.setupMessageListener();
    this.setupTextSelectionListener();
  }
```

Replace with:

```ts
type ScreenTranslateState = 'inactive' | 'armed' | 'ready-to-redraw';

class RealTimeTranslator {
  private isActive: boolean;
  private isSelecting: boolean;
  private selectionOverlay: HTMLDivElement | null;
  private translationOverlays: Map<string, HTMLDivElement>;
  private overlayRects: Map<string, DOMRect>;
  private overlayTimers: Map<string, number>;
  private roiSelector: ROISelector;
  private screenTranslateState: ScreenTranslateState;

  constructor() {
    this.isActive = false;
    this.isSelecting = false;
    this.selectionOverlay = null;
    this.translationOverlays = new Map();
    this.overlayRects = new Map();
    this.overlayTimers = new Map();
    this.screenTranslateState = 'inactive';
    this.roiSelector = new ROISelector(() => {
      this.screenTranslateState = 'ready-to-redraw';
      document.body.style.cursor = '';
    });
    this.setupMessageListener();
    this.setupTextSelectionListener();
  }
```

`type ScreenTranslateState` is declared at module scope (above the class) so both `RealTimeTranslator` and later code can reference it without exporting it — nothing outside this file needs it.

- [ ] **Step 3: Handle `GET_SCREEN_TRANSLATE_STATE` and `DRAW_NEW_BOX` in the message listener**

Find (current lines 48-77):

```ts
  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (
        message: ToggleScreenTranslationMessage |
          TranslateSelectedTextMessage |
          StartROISelectionMessage |
          EndROISelectionMessage,
        sender,
        sendResponse
      ) => {
        switch (message.type) {
          case 'TOGGLE_SCREEN_TRANSLATION':
            this.toggleTranslation();
            break;

          case 'START_ROI_SELECTION':
            this.startSelection();
            break;

          case 'END_ROI_SELECTION':
            this.endSelection(message.roi);
            break;

          case 'TRANSLATE_SELECTED_TEXT':
            this.translateSelectedText(message.text, message.rect);
            break;
        }
      }
    );
  }
```

Replace with:

```ts
  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (
        message: ToggleScreenTranslationMessage |
          TranslateSelectedTextMessage |
          StartROISelectionMessage |
          EndROISelectionMessage |
          GetScreenTranslateStateMessage |
          DrawNewBoxMessage,
        sender,
        sendResponse
      ) => {
        switch (message.type) {
          case 'TOGGLE_SCREEN_TRANSLATION':
            this.toggleTranslation();
            break;

          case 'START_ROI_SELECTION':
            this.startSelection();
            break;

          case 'END_ROI_SELECTION':
            this.endSelection(message.roi);
            break;

          case 'TRANSLATE_SELECTED_TEXT':
            this.translateSelectedText(message.text, message.rect);
            break;

          case 'GET_SCREEN_TRANSLATE_STATE':
            sendResponse({ state: this.screenTranslateState });
            return true;

          case 'DRAW_NEW_BOX':
            this.drawNewBox();
            break;
        }
      }
    );
  }
```

`return true` on the `GET_SCREEN_TRANSLATE_STATE` case is required by the Chrome extension messaging API so the message channel stays open long enough for `sendResponse` to deliver synchronously-called results back to the popup's `await chrome.tabs.sendMessage(...)`.

- [ ] **Step 4: Track state in `startTranslation`/`stopTranslation`, remove panel calls**

Find (current lines 92-108):

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

Replace with:

```ts
  private startTranslation(): void {
    this.isActive = true;
    this.screenTranslateState = 'armed';
    document.body.style.cursor = 'crosshair';
    // Start ROI selection
    this.roiSelector.startSelection();
    this.installClickGuard();
  }

  private stopTranslation(): void {
    this.isActive = false;
    this.screenTranslateState = 'inactive';
    this.roiSelector.stopSelection();
    this.clearAllOverlays();
    document.body.style.cursor = '';
    this.removeClickGuard();
  }

  private drawNewBox(): void {
    this.screenTranslateState = 'armed';
    document.body.style.cursor = 'crosshair';
    this.clearAllOverlays();
    this.roiSelector.startSelection();
  }
```

- [ ] **Step 5: Delete the on-page panel methods**

Find and delete (current lines 203-288, the entire `showControlPanel`/`updateControlPanel`/`hideControlPanel` block):

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

Delete this block entirely — no replacement. The method immediately above it (`fetchTranslation`) and the method immediately below it (`showLoadingIndicator`) are unaffected and should now be adjacent.

- [ ] **Step 6: Verify**

Run, in order:
- `npm run type-check` — expect PASS, 0 errors (confirms no remaining references to the deleted panel methods).
- `npm test` — expect PASS, existing tests unaffected.
- `npm run build:dev` — expect PASS; confirm `dist/realTimeTranslate.js` was rebuilt.

- [ ] **Step 7: Commit**

```bash
git add src/realTimeTranslate.ts
git commit -m "refactor: replace Screen Translate on-page panel with internal state machine"
```

---

### Task 3: Popup controls (Draw New Box button + persistent status)

**Files:**
- Modify: `popup.html:152-155` (`.toggle-section`)
- Modify: `src/popup.ts:5-18` (`PopupElements` interface)
- Modify: `src/popup.ts:20-26` (`NON_SETTING_ELEMENT_KEYS`)
- Modify: `src/popup.ts:33-40` (constructor)
- Modify: `src/popup.ts:42-87` (`initializeElements`)
- Modify: `src/popup.ts:89-109` (`setupEventListeners`)
- Modify: `src/popup.ts:227-260` (`toggleScreenTranslation`)

**Interfaces:**
- Consumes: `GET_SCREEN_TRANSLATE_STATE` / `DRAW_NEW_BOX` message handling and `ScreenTranslateStateResponse` shape (`{ state: 'inactive' | 'armed' | 'ready-to-redraw' }`) from Task 2.
- Produces: `PopupController.refreshScreenTranslateState(): Promise<void>`, `PopupController.renderScreenTranslateState(state: 'inactive' | 'armed' | 'ready-to-redraw'): void`, `PopupController.drawNewBox(): Promise<void>` — none consumed elsewhere; this is the final task.

- [ ] **Step 1: Add the new elements to `popup.html`**

Find (current lines 152-155):

```html
    <div class="toggle-section">
        <button id="toggleButton" class="toggle-button">Start Subtitles</button>
        <button id="screenTranslateButton" class="toggle-button" style="margin-left: 8px; background: #38a169;">Screen Translate</button>
    </div>
```

Replace with:

```html
    <div class="toggle-section">
        <button id="toggleButton" class="toggle-button">Start Subtitles</button>
        <button id="screenTranslateButton" class="toggle-button" style="margin-left: 8px; background: #38a169;">Screen Translate</button>
        <div id="screenTranslateStatus" class="status hidden" style="margin-top: 12px;"></div>
        <button id="drawNewBoxButton" class="toggle-button hidden" style="margin-top: 8px; background: #2196F3;">Draw New Box</button>
    </div>
```

`#screenTranslateStatus` reuses the existing `.status`/`.status.success` CSS classes (defined at `popup.html:103-127`) for styling, but — unlike `#status` — it is never handed to `showStatus()`, so nothing ever schedules a `setTimeout` to re-hide it. `#drawNewBoxButton` reuses `.toggle-button`, matching `#screenTranslateButton`.

- [ ] **Step 2: Add the new elements to `PopupElements` and `NON_SETTING_ELEMENT_KEYS`**

Find (current lines 5-26):

```ts
interface PopupElements {
  toggleButton: HTMLButtonElement;
  screenTranslateButton: HTMLButtonElement;
  status: HTMLDivElement;
  sourceLanguage: HTMLSelectElement;
  targetLanguage: HTMLSelectElement;
  subtitleStyle: HTMLSelectElement;
  fontSize: HTMLSelectElement;
  translationProvider: HTMLSelectElement;
  googleTranslateApiKey: HTMLInputElement;
  deeplApiKey: HTMLInputElement;
  googleApiKeyGroup: HTMLDivElement;
  deeplApiKeyGroup: HTMLDivElement;
}

const NON_SETTING_ELEMENT_KEYS = [
  'toggleButton',
  'screenTranslateButton',
  'status',
  'googleApiKeyGroup',
  'deeplApiKeyGroup'
];
```

Replace with:

```ts
interface PopupElements {
  toggleButton: HTMLButtonElement;
  screenTranslateButton: HTMLButtonElement;
  drawNewBoxButton: HTMLButtonElement;
  screenTranslateStatus: HTMLDivElement;
  status: HTMLDivElement;
  sourceLanguage: HTMLSelectElement;
  targetLanguage: HTMLSelectElement;
  subtitleStyle: HTMLSelectElement;
  fontSize: HTMLSelectElement;
  translationProvider: HTMLSelectElement;
  googleTranslateApiKey: HTMLInputElement;
  deeplApiKey: HTMLInputElement;
  googleApiKeyGroup: HTMLDivElement;
  deeplApiKeyGroup: HTMLDivElement;
}

const NON_SETTING_ELEMENT_KEYS = [
  'toggleButton',
  'screenTranslateButton',
  'drawNewBoxButton',
  'screenTranslateStatus',
  'status',
  'googleApiKeyGroup',
  'deeplApiKeyGroup'
];
```

- [ ] **Step 3: Grab and validate the new elements in `initializeElements`**

Find (current lines 42-87):

```ts
  initializeElements() {
    const toggleButton = document.getElementById('toggleButton') as HTMLButtonElement | null;
    const screenTranslateButton = document.getElementById('screenTranslateButton') as HTMLButtonElement | null;
    const status = document.getElementById('status') as HTMLDivElement | null;
    const sourceLanguage = document.getElementById('sourceLanguage') as HTMLSelectElement | null;
    const targetLanguage = document.getElementById('targetLanguage') as HTMLSelectElement | null;
    const subtitleStyle = document.getElementById('subtitleStyle') as HTMLSelectElement | null;
    const fontSize = document.getElementById('fontSize') as HTMLSelectElement | null;
    const translationProvider = document.getElementById('translationProvider') as HTMLSelectElement | null;
    const googleTranslateApiKey = document.getElementById('googleTranslateApiKey') as HTMLInputElement | null;
    const deeplApiKey = document.getElementById('deeplApiKey') as HTMLInputElement | null;
    const googleApiKeyGroup = document.getElementById('googleApiKeyGroup') as HTMLDivElement | null;
    const deeplApiKeyGroup = document.getElementById('deeplApiKeyGroup') as HTMLDivElement | null;

    if (
      !toggleButton ||
      !screenTranslateButton ||
      !status ||
      !sourceLanguage ||
      !targetLanguage ||
      !subtitleStyle ||
      !fontSize ||
      !translationProvider ||
      !googleTranslateApiKey ||
      !deeplApiKey ||
      !googleApiKeyGroup ||
      !deeplApiKeyGroup
    ) {
      throw new Error('One or more popup elements not found in the DOM.');
    }

    this.elements = {
      toggleButton,
      screenTranslateButton,
      status,
      sourceLanguage,
      targetLanguage,
      subtitleStyle,
      fontSize,
      translationProvider,
      googleTranslateApiKey,
      deeplApiKey,
      googleApiKeyGroup,
      deeplApiKeyGroup
    };
  }
```

Replace with:

```ts
  initializeElements() {
    const toggleButton = document.getElementById('toggleButton') as HTMLButtonElement | null;
    const screenTranslateButton = document.getElementById('screenTranslateButton') as HTMLButtonElement | null;
    const drawNewBoxButton = document.getElementById('drawNewBoxButton') as HTMLButtonElement | null;
    const screenTranslateStatus = document.getElementById('screenTranslateStatus') as HTMLDivElement | null;
    const status = document.getElementById('status') as HTMLDivElement | null;
    const sourceLanguage = document.getElementById('sourceLanguage') as HTMLSelectElement | null;
    const targetLanguage = document.getElementById('targetLanguage') as HTMLSelectElement | null;
    const subtitleStyle = document.getElementById('subtitleStyle') as HTMLSelectElement | null;
    const fontSize = document.getElementById('fontSize') as HTMLSelectElement | null;
    const translationProvider = document.getElementById('translationProvider') as HTMLSelectElement | null;
    const googleTranslateApiKey = document.getElementById('googleTranslateApiKey') as HTMLInputElement | null;
    const deeplApiKey = document.getElementById('deeplApiKey') as HTMLInputElement | null;
    const googleApiKeyGroup = document.getElementById('googleApiKeyGroup') as HTMLDivElement | null;
    const deeplApiKeyGroup = document.getElementById('deeplApiKeyGroup') as HTMLDivElement | null;

    if (
      !toggleButton ||
      !screenTranslateButton ||
      !drawNewBoxButton ||
      !screenTranslateStatus ||
      !status ||
      !sourceLanguage ||
      !targetLanguage ||
      !subtitleStyle ||
      !fontSize ||
      !translationProvider ||
      !googleTranslateApiKey ||
      !deeplApiKey ||
      !googleApiKeyGroup ||
      !deeplApiKeyGroup
    ) {
      throw new Error('One or more popup elements not found in the DOM.');
    }

    this.elements = {
      toggleButton,
      screenTranslateButton,
      drawNewBoxButton,
      screenTranslateStatus,
      status,
      sourceLanguage,
      targetLanguage,
      subtitleStyle,
      fontSize,
      translationProvider,
      googleTranslateApiKey,
      deeplApiKey,
      googleApiKeyGroup,
      deeplApiKeyGroup
    };
  }
```

- [ ] **Step 4: Wire the "Draw New Box" click handler and query state on construction**

Find (current lines 33-40):

```ts
  constructor() {
    this.isActive = false;
    this.isScreenTranslating = false;
    this.elements = {} as PopupElements;
    this.initializeElements();
    this.loadSettings();
    this.setupEventListeners();
  }
```

Replace with:

```ts
  constructor() {
    this.isActive = false;
    this.isScreenTranslating = false;
    this.elements = {} as PopupElements;
    this.initializeElements();
    this.loadSettings();
    this.setupEventListeners();
    this.refreshScreenTranslateState();
  }
```

Find (current lines 89-109):

```ts
  setupEventListeners() {
    this.elements.toggleButton.addEventListener('click', () => {
      this.toggleSubtitles();
    });

    this.elements.screenTranslateButton.addEventListener('click', () => {
      this.toggleScreenTranslation();
    });

    this.elements.translationProvider.addEventListener('change', () => {
      this.updateApiKeyVisibility();
    });

    Object.keys(this.elements).forEach(key => {
      if (!NON_SETTING_ELEMENT_KEYS.includes(key)) {
        (this.elements[key as keyof PopupElements] as HTMLElement).addEventListener('change', () => {
          this.saveSettings();
        });
      }
    });
  }
```

Replace with:

```ts
  setupEventListeners() {
    this.elements.toggleButton.addEventListener('click', () => {
      this.toggleSubtitles();
    });

    this.elements.screenTranslateButton.addEventListener('click', () => {
      this.toggleScreenTranslation();
    });

    this.elements.drawNewBoxButton.addEventListener('click', () => {
      this.drawNewBox();
    });

    this.elements.translationProvider.addEventListener('change', () => {
      this.updateApiKeyVisibility();
    });

    Object.keys(this.elements).forEach(key => {
      if (!NON_SETTING_ELEMENT_KEYS.includes(key)) {
        (this.elements[key as keyof PopupElements] as HTMLElement).addEventListener('change', () => {
          this.saveSettings();
        });
      }
    });
  }
```

- [ ] **Step 5: Replace `toggleScreenTranslation` and add `refreshScreenTranslateState`/`renderScreenTranslateState`/`drawNewBox`**

Find (current lines 227-260):

```ts
  async toggleScreenTranslation() {
    try {
      this.isScreenTranslating = !this.isScreenTranslating;
      this.updateScreenTranslateButton();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id === 'number') {
        chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SCREEN_TRANSLATION'
        });
      } else {
        throw new Error('Active tab does not have a valid id');
      }

      this.showStatus(
        this.isScreenTranslating ? 'Screen translation activated' : 'Screen translation deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle screen translation:', error);
      const errorMsg = (error && typeof error === 'object' && 'message' in error)
        ? (error as Error).message
        : String(error);
      this.showStatus('Failed to toggle screen translation: ' + errorMsg, 'error');
      this.isScreenTranslating = !this.isScreenTranslating;
      this.updateScreenTranslateButton();
    }
  }
```

Replace with:

```ts
  async toggleScreenTranslation() {
    const wasScreenTranslating = this.isScreenTranslating;

    try {
      this.renderScreenTranslateState(wasScreenTranslating ? 'inactive' : 'armed');

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id === 'number') {
        chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SCREEN_TRANSLATION'
        });
      } else {
        throw new Error('Active tab does not have a valid id');
      }

      this.showStatus(
        this.isScreenTranslating ? 'Screen translation activated' : 'Screen translation deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle screen translation:', error);
      const errorMsg = (error && typeof error === 'object' && 'message' in error)
        ? (error as Error).message
        : String(error);
      this.showStatus('Failed to toggle screen translation: ' + errorMsg, 'error');
      this.renderScreenTranslateState(wasScreenTranslating ? 'armed' : 'inactive');
    }
  }

  async refreshScreenTranslateState() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || typeof tab.id !== 'number') {
        this.renderScreenTranslateState('inactive');
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_SCREEN_TRANSLATE_STATE'
      });

      this.renderScreenTranslateState(response?.state ?? 'inactive');
    } catch (error) {
      this.renderScreenTranslateState('inactive');
    }
  }

  renderScreenTranslateState(state: 'inactive' | 'armed' | 'ready-to-redraw') {
    this.isScreenTranslating = state !== 'inactive';
    this.updateScreenTranslateButton();

    if (state === 'inactive') {
      this.elements.screenTranslateStatus.classList.add('hidden');
      this.elements.drawNewBoxButton.classList.add('hidden');
      return;
    }

    this.elements.screenTranslateStatus.textContent = state === 'armed'
      ? 'Drag a box around text to translate.'
      : "Click 'Draw New Box' to translate another area.";
    this.elements.screenTranslateStatus.className = 'status success';
    this.elements.drawNewBoxButton.classList.toggle('hidden', state !== 'ready-to-redraw');
  }

  async drawNewBox() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || typeof tab.id !== 'number') {
        throw new Error('No active tab found');
      }

      chrome.tabs.sendMessage(tab.id, {
        type: 'DRAW_NEW_BOX'
      });

      this.renderScreenTranslateState('armed');
    } catch (error) {
      console.error('Failed to draw new box:', error);
      const errorMsg = (error && typeof error === 'object' && 'message' in error)
        ? (error as Error).message
        : String(error);
      this.showStatus('Failed to draw new box: ' + errorMsg, 'error');
    }
  }
```

`renderScreenTranslateState` is the single place that sets `isScreenTranslating`, updates the toggle button, and shows/hides the status text and "Draw New Box" button — `toggleScreenTranslation`, `refreshScreenTranslateState`, and `drawNewBox` all call it instead of duplicating that logic. `refreshScreenTranslateState`'s `catch` covers the case where no content script is listening (e.g. a `chrome://` page, or Screen Translate was never toggled on that tab), matching the spec's "treat as inactive" fallback.

- [ ] **Step 6: Verify**

Run, in order:
- `npm run type-check` — expect PASS, 0 errors.
- `npm test` — expect PASS, existing tests unaffected.
- `npm run build:dev` — expect PASS; confirm `dist/popup.js` and `dist/popup.html` were rebuilt.

- [ ] **Step 7: Commit**

```bash
git add popup.html src/popup.ts
git commit -m "feat: move Screen Translate controls into the popup"
```

---

### Manual Smoke Test (after all tasks land)

Not a subagent step — done by a human loading the unpacked extension in Chrome:

1. Toggle Screen Translate on from the popup — confirm the popup shows "Drag a box around text to translate.", no "Draw New Box" button, and the page shows a crosshair cursor with no on-page panel.
2. Drag a box over text on the page — confirm the overlay appears, the cursor reverts to default, and reopening the popup shows "Click 'Draw New Box'..." with the button visible.
3. Try dragging again without clicking "Draw New Box" — confirm nothing happens.
4. Click "Draw New Box" in the popup, then drag a second box elsewhere — confirm the first overlay disappears immediately, the cursor goes back to crosshair, and only the second box's overlay appears.
5. Click "Screen Translate" again to stop — confirm the crosshair cursor clears, any overlay is removed, and reopening the popup shows the inactive state (no status text, no draw button, toggle button reads "Screen Translate").
6. Drag a too-small box (under 10px) — confirm the popup (on next open) still reflects "ready-to-redraw" rather than a stuck "armed" state.
7. Toggle Screen Translate on, close the popup without dragging, then reopen it — confirm it still shows "armed" (proves state is queried live, not just assumed).
