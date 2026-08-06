// background.ts - Service Worker: orchestrates the offscreen capture pipeline and translation

import {
  ExtensionMessage,
  ExtensionSettings,
  CaptureResponse,
  APIResponse,
  APIError
} from './types';
import { apiService } from './services/apiService';

class SubtitleService {
  private activeTabId: number | null = null;
  private warnedMissingKeyTabs: Set<number> = new Set();

  constructor() {
    this.setupEventListeners();
    this.initializeSettings();
  }

  private setupEventListeners(): void {
    chrome.runtime.onInstalled.addListener(this.handleInstalled.bind(this));
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
    chrome.tabs.onUpdated.addListener(this.handleTabUpdate.bind(this));
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
  }

  private async initializeSettings(): Promise<void> {
    const defaultSettings: ExtensionSettings = {
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      subtitleStyle: 'bottom',
      fontSize: 'medium',
      googleTranslateApiKey: '',
      enabled: false
    };

    const existingSettings = await chrome.storage.sync.get(Object.keys(defaultSettings));
    const missingKeys = Object.keys(defaultSettings).filter(key => !(key in existingSettings));
    if (missingKeys.length > 0) {
      await chrome.storage.sync.set({ ...defaultSettings, ...existingSettings });
    }
  }

  private handleInstalled(details: chrome.runtime.InstalledDetails): void {
    if (details.reason === 'install') {
      chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    }
  }

  private async handleMessage(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ): Promise<APIResponse | ExtensionSettings | any> {
    try {
      switch (message.type) {
        case 'START_CAPTURE':
          return await this.startAudioCapture(sender.tab?.id!);

        case 'STOP_CAPTURE':
          return await this.stopAudioCapture(sender.tab?.id!);

        case 'GET_SETTINGS': {
          const defaultSettings: ExtensionSettings = {
            sourceLanguage: 'auto',
            targetLanguage: 'en',
            subtitleStyle: 'bottom',
            fontSize: 'medium',
            googleTranslateApiKey: '',
            enabled: false
          };
          return await chrome.storage.sync.get(defaultSettings);
        }

        case 'UPDATE_SETTINGS':
          return await chrome.storage.sync.set(message.settings);

        case 'TRANSLATE_TEXT':
          return await this.translateText(message.text, message.targetLang);

        case 'TOGGLE_SCREEN_TRANSLATION':
          return { success: true };

        case 'TRANSCRIPTION_RESULT':
          await this.handleTranscriptionResult(message.text);
          return { success: true };

        case 'TRANSCRIPTION_ERROR':
          if (this.activeTabId !== null) {
            await this.safeSendMessage(this.activeTabId, {
              type: 'CAPTION_ERROR',
              message: `Transcription error: ${message.message}`
            });
          }
          return { success: true };

        case 'MODEL_LOADING_PROGRESS':
          await this.handleModelLoadingProgress(message.status);
          return { success: true };

        default:
          console.warn('Unknown message type:', message.type);
          return { success: false, error: 'Unknown message type' };
      }
    } catch (error) {
      console.error('Error handling message:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  private async ensureOffscreenDocument(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) {
      return;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture and transcribe tab audio to generate live captions'
    });
  }

  private async closeOffscreenDocument(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  }

  private async startAudioCapture(tabId: number): Promise<CaptureResponse> {
    try {
      if (this.activeTabId !== null && this.activeTabId !== tabId) {
        await this.stopAudioCapture(this.activeTabId);
      }

      const settings = await chrome.storage.sync.get(['sourceLanguage']);
      const sourceLanguage = settings.sourceLanguage || 'auto';

      const streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        });
      });

      await this.ensureOffscreenDocument();
      await chrome.runtime.sendMessage({
        type: 'START_OFFSCREEN_CAPTURE',
        streamId,
        sourceLanguage
      });

      this.activeTabId = tabId;

      await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_STARTED', streamId });

      return { success: true, streamId };
    } catch (error) {
      console.error('Failed to start audio capture:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  private async stopAudioCapture(tabId: number): Promise<{ success: boolean }> {
    if (this.activeTabId === tabId) {
      try {
        await chrome.runtime.sendMessage({ type: 'STOP_OFFSCREEN_CAPTURE' });
      } catch (error) {
        // offscreen document may already be gone
      }
      await this.closeOffscreenDocument();
      this.activeTabId = null;
      this.warnedMissingKeyTabs.delete(tabId);

      await this.safeSendMessage(tabId, { type: 'CAPTURE_STOPPED' });
    }
    return { success: true };
  }

  private async handleTranscriptionResult(text: string): Promise<void> {
    if (this.activeTabId === null || !text || !text.trim()) return;
    const tabId = this.activeTabId;
    const { text: finalText, language } = await this.maybeTranslate(text, tabId);
    await this.safeSendMessage(tabId, { type: 'DISPLAY_SUBTITLE', text: finalText, language });
  }

  private async handleModelLoadingProgress(status: string): Promise<void> {
    if (this.activeTabId === null) return;
    const statusMessages: Record<string, string> = {
      downloading: 'Loading speech model... (first time only, may take a minute)',
      ready: 'Speech model ready',
      'cpu-fallback': 'WebGPU unavailable — running in CPU mode, captions may be slower'
    };
    await this.safeSendMessage(this.activeTabId, {
      type: 'CAPTION_STATUS',
      message: statusMessages[status] || status
    });
  }

  private async maybeTranslate(text: string, tabId: number): Promise<{ text: string; language: string }> {
    const settings = await chrome.storage.sync.get(['sourceLanguage', 'targetLanguage']);
    const sourceLanguage = settings.sourceLanguage || 'auto';
    const targetLanguage = settings.targetLanguage || 'en';

    if (sourceLanguage === targetLanguage) {
      return { text, language: sourceLanguage };
    }

    try {
      const result = await apiService.translateText(text, sourceLanguage, targetLanguage);
      return { text: result.translatedText, language: targetLanguage };
    } catch (error) {
      if (error instanceof APIError && error.status === 401 && !this.warnedMissingKeyTabs.has(tabId)) {
        this.warnedMissingKeyTabs.add(tabId);
        await this.safeSendMessage(tabId, {
          type: 'CAPTION_ERROR',
          message: 'No Google Translate API key configured. Showing untranslated captions — add a key in the extension popup to enable translation.'
        });
      }
      console.error('Translation failed, falling back to untranslated text:', error);
      return { text, language: sourceLanguage };
    }
  }

  private async safeSendMessage(tabId: number, message: ExtensionMessage): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      // tab might be closed or navigating away; ignore
    }
  }

  async translateText(text: string, targetLang: string) {
    try {
      const settings = await chrome.storage.sync.get(['sourceLanguage']);
      const sourceLanguage = settings.sourceLanguage || 'auto';

      const result = await apiService.translateText(text, sourceLanguage, targetLang);
      return { success: true, translatedText: result.translatedText };
    } catch (error) {
      console.error('Translation failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  handleTabUpdate(tabId: number, changeInfo: chrome.tabs.TabChangeInfo): void {
    if (changeInfo.status === 'loading' && this.activeTabId === tabId) {
      this.stopAudioCapture(tabId);
    }
  }

  handleTabRemoved(tabId: number): void {
    if (this.activeTabId === tabId) {
      this.stopAudioCapture(tabId);
    }
  }
}

// Initialize the service
const subtitleService = new SubtitleService();
