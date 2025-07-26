// realTimeTranslate.ts - Content script for real-time text translation

import {
  ToggleScreenTranslationMessage,
  TranslateSelectedTextMessage,
  ShowTranslationOverlayMessage,
  StartROISelectionMessage,
  EndROISelectionMessage,
  ROIData
} from './types';

class RealTimeTranslator {
  private isActive: boolean;
  private isSelecting: boolean;
  private selectionOverlay: HTMLDivElement | null;
  private translationOverlays: Map<string, HTMLDivElement>;
  private roiSelector: ROISelector;

  constructor() {
    this.isActive = false;
    this.isSelecting = false;
    this.selectionOverlay = null;
    this.translationOverlays = new Map();
    this.roiSelector = new ROISelector();
    this.setupMessageListener();
    this.setupTextSelectionListener();
  }

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

  private startSelection(): void {
    // Enable text selection for translation
    document.addEventListener('mouseup', this.handleTextSelection.bind(this));
  }

  private endSelection(roi: ROIData): void {
    // Handle finalization of ROI selection
    document.removeEventListener('mouseup', this.handleTextSelection.bind(this));
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

  private async translateAndShowText(text: string, rect: DOMRect): Promise<void> {
    try {
      // Show loading indicator
      this.showLoadingIndicator(rect);

      // Get settings
      const settings = await chrome.runtime.sendMessage({
        type: 'GET_SETTINGS'
      });

      const targetLang = settings.targetLanguage || 'en';

      // Translate text
      const translation = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_TEXT',
        text,
        targetLang
      });

      // Hide loading indicator
      this.hideLoadingIndicator();

      if (translation.success) {
        this.showTranslationOverlay(text, translation.translatedText, rect);
      } else {
        this.showError('Translation failed', rect);
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

  private showLoadingIndicator(rect: DOMRect): void {
    const loader = document.createElement('div');
    loader.id = 'translation-loading';
    loader.style.cssText = `
      position: fixed;
      top: ${rect.bottom + window.scrollY + 5}px;
      left: ${rect.left + window.scrollX}px;
      background: #2196F3;
      color: white;
      padding: 5px 10px;
      border-radius: 3px;
      z-index: 999998;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      animation: pulse 1s infinite;
    `;
    loader.textContent = 'Translating...';

    // Add pulse animation
    if (!document.querySelector('#translation-animations')) {
      const style = document.createElement('style');
      style.id = 'translation-animations';
      style.textContent = `
        @keyframes pulse {
          0% { opacity: 0.6; }
          50% { opacity: 1; }
          100% { opacity: 0.6; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(loader);
  }

  private hideLoadingIndicator(): void {
    const loader = document.getElementById('translation-loading');
    if (loader) {
      loader.remove();
    }
  }

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

  private showError(message: string, rect: DOMRect): void {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
      position: fixed;
      top: ${rect.bottom + window.scrollY + 5}px;
      left: ${rect.left + window.scrollX}px;
      background: #f44336;
      color: white;
      padding: 5px 10px;
      border-radius: 3px;
      z-index: 999998;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
    `;
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);

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
  }

  private clearAllOverlays(): void {
    this.translationOverlays.forEach((overlay, id) => {
      if (overlay.parentNode) {
        overlay.remove();
      }
    });
    this.translationOverlays.clear();
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

class ROISelector {
  private isSelecting: boolean;
  private startPoint: { x: number; y: number } | null;
  private selectionBox: HTMLDivElement | null;

  constructor() {
    this.isSelecting = false;
    this.startPoint = null;
    this.selectionBox = null;
  }

  startSelection(): void {
    this.isSelecting = true;
    document.addEventListener('mousedown', this.handleMouseDown.bind(this));
    document.addEventListener('mousemove', this.handleMouseMove.bind(this));
    document.addEventListener('mouseup', this.handleMouseUp.bind(this));
    document.body.style.userSelect = 'none';
  }

  stopSelection(): void {
    this.isSelecting = false;
    this.removeSelectionBox();
    document.removeEventListener('mousedown', this.handleMouseDown.bind(this));
    document.removeEventListener('mousemove', this.handleMouseMove.bind(this));
    document.removeEventListener('mouseup', this.handleMouseUp.bind(this));
    document.body.style.userSelect = '';
  }

  private handleMouseDown(event: MouseEvent): void {
    if (!this.isSelecting) return;
    
    this.startPoint = { x: event.clientX, y: event.clientY };
    this.createSelectionBox(event.clientX, event.clientY);
  }

  private handleMouseMove(event: MouseEvent): void {
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
  }

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

  private createSelectionBox(x: number, y: number): void {
    this.selectionBox = document.createElement('div');
    this.selectionBox.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: 0;
      height: 0;
      border: 2px dashed #2196F3;
      background: rgba(33, 150, 243, 0.1);
      z-index: 999999;
      pointer-events: none;
    `;
    document.body.appendChild(this.selectionBox);
  }

  private removeSelectionBox(): void {
    if (this.selectionBox) {
      this.selectionBox.remove();
      this.selectionBox = null;
    }
    this.startPoint = null;
  }

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
}

// Initialize translator when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new RealTimeTranslator();
  });
} else {
  new RealTimeTranslator();
}

