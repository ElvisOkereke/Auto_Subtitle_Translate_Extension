// content.ts - Content script for subtitle overlay and audio processing

import {
  ExtensionMessage,
  CaptureStartedMessage,
  CaptureStoppedMessage,
  DisplaySubtitleMessage,
  UpdateStyleMessage
} from './types';

class SubtitleOverlay {
  private isActive: boolean;
  private overlay: HTMLDivElement | null;
  private subtitleQueue: string[];
  private currentSubtitle: string | null;
  private audioContext: AudioContext | null;
  private mediaRecorder: MediaRecorder | null;

  constructor() {
    this.isActive = false;
    this.overlay = null;
    this.subtitleQueue = [];
    this.currentSubtitle = null;
    this.audioContext = null;
    this.mediaRecorder = null;
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
          
          case 'CAPTURE_STARTED':
            this.onCaptureStarted((message as CaptureStartedMessage).streamId);
            break;
          
          case 'CAPTURE_STOPPED':
            this.onCaptureStopped();
            break;
          
          case 'DISPLAY_SUBTITLE':
            const displayMsg = message as DisplaySubtitleMessage;
            this.displaySubtitle(displayMsg.text, displayMsg.language);
            break;
          
          case 'UPDATE_STYLE':
            this.updateSubtitleStyle((message as UpdateStyleMessage).style);
            break;
        }
      }
    );
  }

  detectVideoElements() {
    // Monitor for video elements being added to the page
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const videos = node.tagName === 'VIDEO' ? [node] : node.querySelectorAll('video');
            videos.forEach(video => this.setupVideoListener(video));
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Handle existing videos
    document.querySelectorAll('video').forEach(video => {
      this.setupVideoListener(video);
    });
  }

  setupVideoListener(video) {
    // Add event listeners to detect when video starts playing
    video.addEventListener('play', () => {
      if (this.isActive) {
        this.startAudioCapture();
      }
    });

    video.addEventListener('pause', () => {
      this.pauseAudioCapture();
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
    
    // Position overlay
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

  pauseAudioCapture() {
    // Temporarily pause processing but keep stream active
    // Implementation depends on specific requirements
  }

  onCaptureStarted(streamId) {
    console.log('Audio capture started with stream ID:', streamId);
    this.setupAudioProcessing();
    this.showStatus('Listening for audio...');
  }

  onCaptureStopped() {
    console.log('Audio capture stopped');
    this.cleanupAudioProcessing();
    this.showStatus('Audio capture stopped');
  }

  setupAudioProcessing() {
    // This is a simplified version - in practice, you'd need to handle
    // the audio stream from the background script differently
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // Note: In Manifest V3, direct access to the captured stream in content script
      // is limited. You'd typically process audio in the background script
      // and send processed chunks here for display.
      
    } catch (error) {
      console.error('Failed to setup audio processing:', error);
    }
  }

  cleanupAudioProcessing() {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  displaySubtitle(text, language) {
    if (!this.overlay || !text) return;

    // Clear existing subtitle
    this.overlay.innerHTML = '';

    // Create subtitle element
    const subtitleElement = document.createElement('div');
    subtitleElement.className = 'subtitle-text';
    subtitleElement.textContent = text;

    // Check if translation is needed
    this.handleTranslation(subtitleElement, text, language);
  }

  async handleTranslation(element, text, sourceLang) {
    try {
      const settings = await chrome.runtime.sendMessage({
        type: 'GET_SETTINGS'
      });

      const targetLang = settings.targetLanguage || 'en';
      
      // Only translate if source and target languages are different
      if (sourceLang !== targetLang && sourceLang !== 'auto') {
        const translation = await chrome.runtime.sendMessage({
          type: 'TRANSLATE_TEXT',
          text: text,
          targetLang: targetLang
        });

        if (translation.success) {
          // Show both original and translated text
          element.innerHTML = `
            <div class="original-text">${text}</div>
            <div class="translated-text">${translation.translatedText}</div>
          `;
        }
      }

      this.overlay.appendChild(element);
      
      // Auto-hide subtitle after delay
      setTimeout(() => {
        if (element.parentNode) {
          element.remove();
        }
      }, 5000);

    } catch (error) {
      console.error('Translation error:', error);
      element.textContent = text; // Fall back to original text
      this.overlay.appendChild(element);
    }
  }

  updateSubtitleStyle(style) {
    if (!this.overlay) return;

    // Apply style updates based on user preferences
    Object.assign(this.overlay.style, style);
  }

  showError(message) {
    if (!this.overlay) this.createOverlay();
    
    const errorElement = document.createElement('div');
    errorElement.className = 'subtitle-error';
    errorElement.textContent = `Error: ${message}`;
    errorElement.style.color = '#ff4444';
    
    this.overlay.appendChild(errorElement);
    
    setTimeout(() => {
      if (errorElement.parentNode) {
        errorElement.remove();
      }
    }, 3000);
  }

  showStatus(message) {
    if (!this.overlay) this.createOverlay();
    
    const statusElement = document.createElement('div');
    statusElement.className = 'subtitle-status';
    statusElement.textContent = message;
    statusElement.style.opacity = '0.7';
    
    this.overlay.appendChild(statusElement);
    
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