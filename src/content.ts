// content.ts - Content script for the live subtitle overlay

import {
  ExtensionMessage,
  DisplaySubtitleMessage,
  UpgradeSubtitleMessage,
  UpdateStyleMessage,
  CaptionErrorMessage,
  CaptionStatusMessage,
  SubtitlePosition,
  FontSize
} from './types';

const SUBTITLE_LINGER_MS = 6000;
const STATUS_LINGER_MS = 2500;
const ERROR_LINGER_MS = 6000;
const MAX_VISIBLE_LINES = 2;

const POSITION_STYLES: Record<SubtitlePosition, Partial<CSSStyleDeclaration>> = {
  top: { top: '8%', bottom: '', transform: 'translateX(-50%)' },
  center: { top: '50%', bottom: '', transform: 'translate(-50%, -50%)' },
  bottom: { top: '', bottom: '10%', transform: 'translateX(-50%)' }
};

const FONT_SIZES: FontSize[] = ['small', 'medium', 'large', 'x-large'];

export class SubtitleOverlay {
  private isActive = false;
  private overlay: HTMLDivElement | null = null;
  private captions: HTMLDivElement | null = null;
  private notices: HTMLDivElement | null = null;
  private position: SubtitlePosition = 'bottom';
  private fontSize: FontSize = 'medium';

  constructor() {
    this.setupMessageListener();
    this.watchStyleSettings();
  }

  get active(): boolean {
    return this.isActive;
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (message: ExtensionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
        switch (message.type) {
          case 'TOGGLE_SUBTITLES':
            this.toggleSubtitles().then(() => sendResponse({ active: this.isActive }));
            return true;

          case 'GET_SUBTITLE_STATE':
            sendResponse({ active: this.isActive });
            return false;

          case 'CAPTURE_STARTED':
            this.showStatus('Listening for audio...');
            break;

          case 'CAPTURE_STOPPED':
            this.onCaptureStopped();
            break;

          case 'DISPLAY_SUBTITLE': {
            const displayMsg = message as DisplaySubtitleMessage;
            this.displaySubtitle(displayMsg.text, displayMsg.timing, displayMsg.captionId);
            break;
          }

          case 'UPGRADE_SUBTITLE': {
            // Claude's context-aware version of a caption: swap it in only while it is still shown.
            const upgrade = message as UpgradeSubtitleMessage;
            this.upgradeSubtitle(upgrade.captionId, upgrade.text);
            break;
          }

          case 'CAPTION_ERROR':
            this.showError((message as CaptionErrorMessage).message);
            break;

          case 'CAPTION_STATUS': {
            const statusMsg = message as CaptionStatusMessage;
            this.showStatus(statusMsg.message, statusMsg.replace === true);
            break;
          }

          case 'UPDATE_STYLE': {
            const style = (message as UpdateStyleMessage).style;
            this.applyStyle(style.position, style.fontSize);
            break;
          }
        }
        return false;
      }
    );
  }

  private watchStyleSettings(): void {
    chrome.storage.sync
      .get({ subtitleStyle: 'bottom', fontSize: 'medium' })
      .then(s => this.applyStyle(s.subtitleStyle, s.fontSize))
      .catch(() => undefined);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.subtitleStyle || changes.fontSize) {
        this.applyStyle(changes.subtitleStyle?.newValue, changes.fontSize?.newValue);
      }
    });
  }

  applyStyle(position?: SubtitlePosition, fontSize?: FontSize): void {
    if (position && position in POSITION_STYLES) this.position = position;
    if (fontSize && FONT_SIZES.includes(fontSize)) this.fontSize = fontSize;
    if (!this.overlay) return;
    Object.assign(this.overlay.style, POSITION_STYLES[this.position]);
    this.overlay.dataset.position = this.position;
    this.overlay.querySelectorAll('.subtitle-text').forEach(el => {
      FONT_SIZES.forEach(size => el.classList.toggle(size, size === this.fontSize));
    });
  }

  async toggleSubtitles(): Promise<void> {
    if (this.isActive) {
      this.isActive = false;
      this.removeOverlay();
      await this.sendSafely({ type: 'STOP_CAPTURE' });
      return;
    }

    this.isActive = true;
    this.createOverlay();
    const response = await this.sendSafely({ type: 'START_CAPTURE' });
    if (!response?.success) {
      this.isActive = false;
      this.showError(response?.error || 'Failed to start audio capture');
    }
  }

  private async sendSafely(message: ExtensionMessage): Promise<any> {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private onCaptureStopped(): void {
    if (!this.isActive) return;
    // Capture was stopped from elsewhere (e.g. captions started on another tab).
    this.isActive = false;
    this.showStatus('Captions stopped');
  }

  createOverlay(): void {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
    this.overlay.id = 'subtitle-overlay-extension';
    this.overlay.className = 'subtitle-overlay';
    this.overlay.style.cssText = `
      position: fixed;
      left: 50%;
      z-index: 2147483647;
      pointer-events: none;
      max-width: 80%;
      text-align: center;
    `;

    this.notices = document.createElement('div');
    this.notices.className = 'subtitle-notices';
    this.captions = document.createElement('div');
    this.captions.className = 'subtitle-captions';
    this.overlay.append(this.notices, this.captions);

    document.body.appendChild(this.overlay);
    this.applyStyle();
  }

  removeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.captions = null;
    this.notices = null;
  }

  displaySubtitle(text: string, timing?: Record<string, number>, captionId?: string): void {
    if (!this.isActive || !text) return;
    if (!this.captions) this.createOverlay();

    const line = document.createElement('div');
    line.className = `subtitle-text ${this.fontSize}`;
    line.textContent = text;
    if (captionId) line.dataset.captionId = captionId;
    if (timing) {
      // Lets the E2E/perf harness measure pipeline latency.
      line.dataset.timing = JSON.stringify({ ...timing, displayedAt: Date.now() });
    }
    this.captions!.appendChild(line);
    while (this.captions!.children.length > MAX_VISIBLE_LINES) {
      this.captions!.firstElementChild!.remove();
    }

    window.setTimeout(() => line.remove(), SUBTITLE_LINGER_MS);
  }

  upgradeSubtitle(captionId: string, text: string): void {
    if (!this.captions || !text) return;
    const line = [...this.captions.querySelectorAll<HTMLElement>('.subtitle-text')].find(el => el.dataset.captionId === captionId);
    if (line) {
      line.textContent = text;
      line.dataset.quality = 'better';
    }
  }

  showError(message: string): void {
    this.addNotice('subtitle-error', `Error: ${message}`, ERROR_LINGER_MS, false);
  }

  showStatus(message: string, replace = false): void {
    this.addNotice('subtitle-status', message, STATUS_LINGER_MS, replace);
  }

  private addNotice(className: string, text: string, lingerMs: number, replace: boolean): void {
    if (!this.notices) this.createOverlay();

    let notice: HTMLDivElement | null = replace
      ? this.notices!.querySelector<HTMLDivElement>(`.${className}[data-replaceable]`)
      : null;
    if (!notice) {
      notice = document.createElement('div');
      notice.className = className;
      if (replace) notice.dataset.replaceable = '';
      this.notices!.appendChild(notice);
    }
    notice.textContent = text;

    const el = notice;
    window.clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(
      window.setTimeout(() => {
        el.remove();
        // Once captions are off and the last notice fades, take the overlay down too.
        if (!this.isActive && this.notices && !this.notices.children.length && !this.captions?.children.length) {
          this.removeOverlay();
        }
      }, lingerMs)
    );
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SubtitleOverlay();
  });
} else {
  new SubtitleOverlay();
}
