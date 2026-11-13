// realTimeTranslate.ts - Content script for real-time text translation

import {
  ToggleScreenTranslationMessage,
  TranslateSelectedTextMessage,
  GetScreenTranslateStateMessage,
  DrawNewBoxMessage,
  DrawSubtitleBoxMessage,
  ROIData
} from './types';
import { ensurePageStyles, themePageElement } from './ui/pageTheme';
import { placePanel } from './ui/placement';

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

type ScreenTranslateState = 'inactive' | 'armed' | 'ready-to-redraw';

class RealTimeTranslator {
  private isActive: boolean;
  /** What the current box is for: page text (Screen Translate) or video subtitles (popup "Draw subtitle box"). */
  private intent: 'screen' | 'subtitle' = 'screen';
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
    this.roiSelector = new ROISelector(
      () => {
        this.screenTranslateState = 'ready-to-redraw';
        document.body.style.cursor = '';
      },
      roi => {
        void this.onRegionDrawn(roi);
      }
    );
    this.setupMessageListener();
    this.setupTextSelectionListener();
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (
        message: ToggleScreenTranslationMessage |
          TranslateSelectedTextMessage |
          GetScreenTranslateStateMessage |
          DrawNewBoxMessage |
          DrawSubtitleBoxMessage,
        sender,
        sendResponse
      ) => {
        switch (message.type) {
          case 'TOGGLE_SCREEN_TRANSLATION':
            this.intent = 'screen';
            this.toggleTranslation();
            sendResponse({ state: this.screenTranslateState });
            break;

          case 'TRANSLATE_SELECTED_TEXT':
            this.translateSelectedText(message.text, message.rect);
            break;

          case 'GET_SCREEN_TRANSLATE_STATE':
            sendResponse({ state: this.screenTranslateState });
            return true;

          case 'DRAW_SUBTITLE_BOX':
            this.intent = 'subtitle';
            if (this.isActive) this.drawNewBox();
            else this.startTranslation();
            sendResponse({ state: this.screenTranslateState });
            break;

          case 'DRAW_NEW_BOX':
            this.drawNewBox();
            sendResponse({ state: this.screenTranslateState });
            break;
        }
      }
    );
  }

  private setupTextSelectionListener(): void {
    document.addEventListener('mouseup', this.handleTextSelection.bind(this));
    document.addEventListener('keydown', this.handleKeyDown.bind(this));
  }

  private toggleTranslation(): void {
    if (this.isActive) {
      this.stopTranslation();
    } else {
      this.startTranslation();
    }
  }

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

  private handleTextSelection(): void {
    if (!this.isActive) return;

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      const text = selection.toString().trim();
      if (text.length > 0) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        this.translateAndShowText(text, rect);
        selection.removeAllRanges();
      }
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.isActive) {
      this.stopTranslation();
    }
  }

  /**
   * A box over a <video> starts subtitle mode (continuous OCR of burned-in
   * subtitles, src/subtitle); anywhere else it is a one-shot translation of
   * the page text under the box.
   */
  private async onRegionDrawn(roi: ROIData): Promise<void> {
    const rect = new DOMRect(roi.x, roi.y, roi.width, roi.height);
    const subtitleMode = (globalThis as any).__astSubtitleMode as
      | { startFromRect(r: { x: number; y: number; width: number; height: number }): Promise<'started' | 'too-small' | 'not-over-video'> }
      | undefined;
    if (subtitleMode && roi.width > 0 && roi.height > 0) {
      try {
        const result = await subtitleMode.startFromRect({ x: roi.x, y: roi.y, width: roi.width, height: roi.height });
        if (result === 'started') {
          this.stopTranslation();
          return;
        }
        if (result === 'too-small') {
          this.showError('Box too small - draw it around the subtitles', rect);
          return;
        }
      } catch (error) {
        console.error('Subtitle mode failed to start:', error);
        this.showError(`Subtitle mode failed: ${error instanceof Error ? error.message : String(error)}`, rect);
        return;
      }
    }
    if (this.intent === 'subtitle') {
      this.showError("Draw the box over the video's subtitles", rect);
      return;
    }
    if (roi.width > 10 && roi.height > 10) {
      const text = extractTextAtRect(rect);
      if (text) await this.translateAndShowText(text, rect);
    }
  }

  private async translateAndShowText(text: string, rect: DOMRect): Promise<void> {
    try {
      // Show loading indicator
      this.showLoadingIndicator(rect);

      const translation = await this.fetchTranslation(text);

      // Hide loading indicator
      this.hideLoadingIndicator();

      if (translation.success) {
        this.showTranslationOverlay(text, translation.translatedText, rect);
      } else {
        this.showError(translation.error || 'Translation failed', rect);
      }
    } catch (error) {
      this.hideLoadingIndicator();
      console.error('Error translating text:', error);
      this.showError('Translation error', rect);
    }
  }

  private async translateSelectedText(text: string, rect: DOMRect): Promise<void> {
    await this.translateAndShowText(text, rect);
  }

  private async fetchTranslation(
    text: string
  ): Promise<{ success: true; translatedText: string } | { success: false; error?: string }> {
    const settings = await chrome.runtime.sendMessage({
      type: 'GET_SETTINGS'
    });

    const targetLang = settings?.targetLanguage || 'en';

    const translation = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_TEXT',
      text,
      targetLang
    });

    return translation ?? { success: false, error: 'No response from extension background' };
  }

  /** Places an on-page element next to the selected area, kept inside the viewport. */
  /** Call after the element is in the page, so its real size is known. */
  private placeNear(el: HTMLElement, rect: DOMRect): void {
    const { top, left } = placePanel(rect, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  private showLoadingIndicator(rect: DOMRect): void {
    ensurePageStyles();
    const loader = document.createElement('div');
    loader.id = 'translation-loading';
    loader.className = 'ast-ui ast-chip ast-chip--busy';
    loader.setAttribute('role', 'status');
    loader.textContent = 'Translating…';
    void themePageElement(loader);
    document.body.appendChild(loader);
    this.placeNear(loader, rect);
  }

  private hideLoadingIndicator(): void {
    const loader = document.getElementById('translation-loading');
    if (loader) {
      loader.remove();
    }
  }

  private showTranslationOverlay(originalText: string, translatedText: string, rect: DOMRect): void {
    ensurePageStyles();
    const overlayId = `translation-${Date.now()}`;
    const overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = 'ast-ui ast-panel';
    overlay.setAttribute('data-rtt-owned', '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Translation');
    void themePageElement(overlay);

    // Translation first (what the reader came for), the original underneath.
    const head = document.createElement('div');
    head.className = 'ast-panel__head';
    const title = document.createElement('span');
    title.className = 'ast-panel__title';
    title.textContent = 'Translation';
    const refresh = document.createElement('button');
    refresh.id = `refresh-${overlayId}`;
    refresh.className = 'ast-icon-button';
    refresh.setAttribute('data-rtt-owned', '');
    refresh.title = 'Translate again';
    refresh.setAttribute('aria-label', 'Translate again');
    refresh.textContent = '⟳';
    const close = document.createElement('button');
    close.id = `close-${overlayId}`;
    close.className = 'ast-icon-button';
    close.setAttribute('data-rtt-owned', '');
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    head.append(title, refresh, close);
    const translated = document.createElement('p');
    translated.className = 'ast-panel__translated';
    translated.dataset.role = 'translated-text';
    translated.textContent = translatedText;
    const original = document.createElement('p');
    original.className = 'ast-panel__original';
    original.dataset.role = 'original-text';
    original.textContent = originalText;
    overlay.append(head, translated, original);

    document.body.appendChild(overlay);
    this.placeNear(overlay, rect);
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

  private updateTranslationOverlay(overlayId: string, originalText: string, translatedText: string): void {
    const overlay = this.translationOverlays.get(overlayId);
    if (!overlay) return;

    const originalDiv = overlay.querySelector<HTMLElement>('[data-role="original-text"]');
    const translatedDiv = overlay.querySelector<HTMLElement>('[data-role="translated-text"]');
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
      refreshBtn.textContent = '…';
      refreshBtn.setAttribute('disabled', 'true');
    }

    try {
      const textContent = extractTextAtRect(rect);
      if (!textContent) {
        this.showError('No text found to translate', rect);
        return;
      }

      const translation = await this.fetchTranslation(textContent);

      if (translation.success) {
        this.updateTranslationOverlay(overlayId, textContent, translation.translatedText);
      } else {
        this.showError(translation.error || 'Translation failed', rect);
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

  private showError(message: string, rect: DOMRect): void {
    ensurePageStyles();
    const errorDiv = document.createElement('div');
    errorDiv.className = 'ast-ui ast-chip ast-chip--error';
    errorDiv.setAttribute('data-rtt-owned', '');
    errorDiv.setAttribute('role', 'alert');
    void themePageElement(errorDiv);
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    this.placeNear(errorDiv, rect);

    setTimeout(() => {
      if (errorDiv.parentNode) {
        errorDiv.remove();
      }
    }, 3000);
  }

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

}

class ROISelector {
  private isSelecting: boolean;
  private startPoint: { x: number; y: number } | null;
  private selectionBox: HTMLDivElement | null;
  private onSelectionEnded: () => void;
  private onRegionDrawn: (roi: ROIData) => void;

  constructor(onSelectionEnded: () => void, onRegionDrawn: (roi: ROIData) => void) {
    this.isSelecting = false;
    this.startPoint = null;
    this.selectionBox = null;
    this.onSelectionEnded = onSelectionEnded;
    this.onRegionDrawn = onRegionDrawn;
  }

  startSelection(): void {
    this.isSelecting = true;
    document.addEventListener('mousedown', this.handleMouseDown, true);
    document.addEventListener('mousemove', this.handleMouseMove, true);
    document.addEventListener('mouseup', this.handleMouseUp, true);
    document.body.style.userSelect = 'none';
  }

  stopSelection(): void {
    this.isSelecting = false;
    this.removeSelectionBox();
    document.removeEventListener('mousedown', this.handleMouseDown, true);
    document.removeEventListener('mousemove', this.handleMouseMove, true);
    document.removeEventListener('mouseup', this.handleMouseUp, true);
    document.body.style.userSelect = '';
  }

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.isSelecting) return;

    this.startPoint = { x: event.clientX, y: event.clientY };
    this.createSelectionBox(event.clientX, event.clientY);
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.isSelecting || !this.startPoint || !this.selectionBox) return;

    const currentX = event.clientX;
    const currentY = event.clientY;

    const left = Math.min(this.startPoint.x, currentX);
    const top = Math.min(this.startPoint.y, currentY);
    const width = Math.abs(currentX - this.startPoint.x);
    const height = Math.abs(currentY - this.startPoint.y);

    this.selectionBox.style.left = `${left}px`;
    this.selectionBox.style.top = `${top}px`;
    this.selectionBox.style.width = `${width}px`;
    this.selectionBox.style.height = `${height}px`;
  };

  private handleMouseUp = (event: MouseEvent): void => {
    if (!this.isSelecting || !this.startPoint) return;

    const roi: ROIData = {
      x: Math.min(this.startPoint.x, event.clientX),
      y: Math.min(this.startPoint.y, event.clientY),
      width: Math.abs(event.clientX - this.startPoint.x),
      height: Math.abs(event.clientY - this.startPoint.y)
    };

    // The translator decides what the box is for (subtitle mode, page text, or too small).
    this.onRegionDrawn(roi);

    this.stopSelection();
    this.onSelectionEnded();
  };

  private createSelectionBox(x: number, y: number): void {
    ensurePageStyles();
    this.selectionBox = document.createElement('div');
    this.selectionBox.setAttribute('data-rtt-owned', '');
    this.selectionBox.className = 'ast-ui ast-selection';
    this.selectionBox.style.left = `${x}px`;
    this.selectionBox.style.top = `${y}px`;
    this.selectionBox.style.width = '0';
    this.selectionBox.style.height = '0';
    document.body.appendChild(this.selectionBox);
  }

  private removeSelectionBox(): void {
    if (this.selectionBox) {
      this.selectionBox.remove();
      this.selectionBox = null;
    }
    this.startPoint = null;
  }
}

// Initialize translator when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new RealTimeTranslator();
  });
} else {
  new RealTimeTranslator();
}

