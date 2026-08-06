// content.ts - Content script for subtitle overlay

import {
  ExtensionMessage,
  CaptureStartedMessage,
  CaptureStoppedMessage,
  DisplaySubtitleMessage,
  UpdateStyleMessage,
  CaptionErrorMessage,
  CaptionStatusMessage
} from './types';

class SubtitleOverlay {
  private isActive: boolean;
  private overlay: HTMLDivElement | null;

  constructor() {
    this.isActive = false;
    this.overlay = null;
    this.setupMessageListener();
    this.detectVideoElements();
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (message: ExtensionMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
        switch (message.type) {
          case 'TOGGLE_SUBTITLES':
            this.toggleSubtitles();
            break;

          case 'TOGGLE_SCREEN_TRANSLATION':
            // Forwarded to RealTimeTranslator, handled by realTimeTranslate.js
            break;

          case 'CAPTURE_STARTED':
            this.onCaptureStarted((message as CaptureStartedMessage).streamId);
            break;

          case 'CAPTURE_STOPPED':
            this.onCaptureStopped();
            break;

          case 'DISPLAY_SUBTITLE': {
            const displayMsg = message as DisplaySubtitleMessage;
            this.displaySubtitle(displayMsg.text, displayMsg.language);
            break;
          }

          case 'CAPTION_ERROR':
            this.showError((message as CaptionErrorMessage).message);
            break;

          case 'CAPTION_STATUS':
            this.showStatus((message as CaptionStatusMessage).message);
            break;

          case 'UPDATE_STYLE':
            this.updateSubtitleStyle((message as UpdateStyleMessage).style);
            break;
        }
      }
    );
  }

  detectVideoElements() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;
            const videos = element.tagName === 'VIDEO' ? [element] : element.querySelectorAll('video');
            videos.forEach(video => this.setupVideoListener(video as HTMLVideoElement));
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    document.querySelectorAll('video').forEach(video => {
      this.setupVideoListener(video);
    });
  }

  setupVideoListener(video: HTMLVideoElement) {
    video.addEventListener('play', () => {
      if (this.isActive) {
        this.startAudioCapture();
      }
    });

    video.addEventListener('ended', () => {
      this.stopAudioCapture();
    });
  }

  async toggleSubtitles() {
    this.isActive = !this.isActive;

    if (this.isActive) {
      this.createOverlay();
      await this.startAudioCapture();
    } else {
      this.removeOverlay();
      await this.stopAudioCapture();
    }
  }

  createOverlay() {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
    this.overlay.id = 'subtitle-overlay-extension';
    this.overlay.className = 'subtitle-overlay';

    this.overlay.style.cssText = `
      position: fixed;
      bottom: 10%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 999999;
      pointer-events: none;
      max-width: 80%;
      text-align: center;
    `;

    document.body.appendChild(this.overlay);
  }

  removeOverlay() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  async startAudioCapture() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_CAPTURE'
      });

      if (!response.success) {
        console.error('Failed to start capture:', response.error);
        this.showError(response.error);
      }
    } catch (error) {
      console.error('Error starting audio capture:', error);
      this.showError('Failed to start audio capture');
    }
  }

  async stopAudioCapture() {
    try {
      await chrome.runtime.sendMessage({
        type: 'STOP_CAPTURE'
      });
    } catch (error) {
      console.error('Error stopping audio capture:', error);
    }
  }

  onCaptureStarted(streamId: string): void {
    this.showStatus('Listening for audio...');
  }

  onCaptureStopped(): void {
    this.showStatus('Audio capture stopped');
  }

  displaySubtitle(text: string, language: string): void {
    if (!this.overlay || !text) return;

    this.overlay.innerHTML = '';

    const subtitleElement = document.createElement('div');
    subtitleElement.className = 'subtitle-text';
    subtitleElement.textContent = text;
    this.overlay.appendChild(subtitleElement);

    setTimeout(() => {
      if (subtitleElement.parentNode) {
        subtitleElement.remove();
      }
    }, 5000);
  }

  updateSubtitleStyle(style: Partial<CSSStyleDeclaration>) {
    if (!this.overlay) return;
    Object.assign(this.overlay.style, style);
  }

  showError(message: string) {
    if (!this.overlay) this.createOverlay();

    const errorElement = document.createElement('div');
    errorElement.className = 'subtitle-error';
    errorElement.textContent = `Error: ${message}`;
    errorElement.style.color = '#ff4444';

    if (this.overlay) {
      this.overlay.appendChild(errorElement);
    }

    setTimeout(() => {
      if (errorElement.parentNode) {
        errorElement.remove();
      }
    }, 3000);
  }

  showStatus(message: string) {
    if (!this.overlay) this.createOverlay();

    const statusElement = document.createElement('div');
    statusElement.className = 'subtitle-status';
    statusElement.textContent = message;
    statusElement.style.opacity = '0.7';

    if (this.overlay) {
      this.overlay.appendChild(statusElement);
    }

    setTimeout(() => {
      if (statusElement.parentNode) {
        statusElement.remove();
      }
    }, 2000);
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