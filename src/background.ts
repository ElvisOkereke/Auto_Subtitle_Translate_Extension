// background.ts - Service Worker: orchestrates the offscreen capture pipeline and translation

import { ExtensionMessage, CaptureResponse, APIError } from './types';
import { apiService, getEndpointOverrides } from './services/apiService';
import { DEFAULT_SETTINGS, getSecrets, getSettings, migrateSecretsFromSync, saveSettings } from './settings';
import { JobPriority } from './utils/priorityRunner';
import { LineTranslateRequest, StorageUsageMeter, TranslationService } from './translation/translationService';
import { GlossaryStore } from './translation/glossary';
import { ClaudeEngine } from './translation/engines/claude';
import { DeepLEngine } from './translation/engines/deepl';
import { videoIdFrom } from './subtitle/videoId';
import { GoogleEngine } from './translation/engines/google';

// Fast (DeepL/Google) and best (Claude with video context + glossary) tiers;
// at most 4 requests in flight, lines on screen now first.
const translation = new TranslationService({
  settings: getSettings,
  secrets: getSecrets,
  overrides: getEndpointOverrides,
  glossary: new GlossaryStore(chrome.storage.local),
  usage: new StorageUsageMeter(chrome.storage.local),
  makeClaude: cfg => new ClaudeEngine(cfg),
  makeFast: (provider, apiKey, endpoint) => (provider === 'deepl' ? new DeepLEngine({ apiKey, endpoint }) : new GoogleEngine({ apiKey, endpoint })),
});
const NO_VIDEO = { videoId: null, url: '', title: '', channel: '', description: '' };

const HANDLED_MESSAGE_TYPES = new Set<string>([
  'START_CAPTURE',
  'STOP_CAPTURE',
  'GET_SETTINGS',
  'UPDATE_SETTINGS',
  'TRANSLATE_TEXT',
  'TRANSLATE_SUBTITLE_LINE',
  'GET_TRANSLATION_PLAN',
  'TRANSCRIPTION_RESULT',
  'TRANSCRIPTION_ERROR',
  'MODEL_LOADING_PROGRESS'
]);

// MV3 service workers are killed after ~30s without events, wiping in-memory
// state - e.g. during a long pause in a video. The captioning tab therefore
// lives in chrome.storage.session, which survives worker restarts (but not a
// browser restart, when the offscreen document is gone too).
const ACTIVE_TAB_KEY = 'activeCaptureTabId';
const WARNED_TABS_KEY = 'warnedMissingKeyTabs';

async function getActiveTabId(): Promise<number | null> {
  const stored = await chrome.storage.session.get(ACTIVE_TAB_KEY);
  return typeof stored[ACTIVE_TAB_KEY] === 'number' ? stored[ACTIVE_TAB_KEY] : null;
}

async function setActiveTabId(tabId: number | null): Promise<void> {
  if (tabId === null) {
    await chrome.storage.session.remove([ACTIVE_TAB_KEY, WARNED_TABS_KEY]);
  } else {
    await chrome.storage.session.set({ [ACTIVE_TAB_KEY]: tabId });
  }
}

class SubtitleService {
  // Serialises start/stop so overlapping requests can't race each other.
  private captureLock: Promise<unknown> = Promise.resolve();

  constructor() {
    this.setupEventListeners();
    this.initializeSettings();
  }

  private setupEventListeners(): void {
    chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
      if (!HANDLED_MESSAGE_TYPES.has(message.type)) {
        return false; // e.g. START_OFFSCREEN_CAPTURE, meant for the offscreen document
      }
      // Chrome only delivers an async reply if the listener returns `true`
      // synchronously and later calls sendResponse - returning a Promise
      // (an async listener) leaves the caller with `undefined`.
      this.handleMessage(message, sender).then(sendResponse);
      return true;
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === 'loading') this.stopIfActive(tabId);
    });
    chrome.tabs.onRemoved.addListener(tabId => this.stopIfActive(tabId));
  }

  private async initializeSettings(): Promise<void> {
    await migrateSecretsFromSync();
    const existingSettings = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
    const missingKeys = Object.keys(DEFAULT_SETTINGS).filter(key => !(key in existingSettings));
    if (missingKeys.length > 0) {
      await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...existingSettings });
    }
  }

  private async handleMessage(message: ExtensionMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
    try {
      switch (message.type) {
        case 'START_CAPTURE': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) return { success: false, error: 'START_CAPTURE must come from a tab' };
          return await this.withCaptureLock(() => this.startAudioCapture(tabId));
        }

        case 'STOP_CAPTURE': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) return { success: false, error: 'STOP_CAPTURE must come from a tab' };
          return await this.withCaptureLock(() => this.stopAudioCapture(tabId));
        }

        case 'GET_SETTINGS':
          return await getSettings();

        case 'UPDATE_SETTINGS':
          await saveSettings(message.settings);
          return { success: true };

        case 'TRANSLATE_TEXT':
          return await this.translateText(message.text, message.targetLang);

        case 'GET_TRANSLATION_PLAN':
          return await translation.plan();

        case 'TRANSLATE_SUBTITLE_LINE':
          return await this.translateSubtitleLine(message, sender);

        case 'TRANSCRIPTION_RESULT':
          await this.handleTranscriptionResult(message.text, message.timing);
          return { success: true };

        case 'TRANSCRIPTION_ERROR': {
          const tabId = await getActiveTabId();
          if (tabId !== null) {
            await this.safeSendMessage(tabId, {
              type: 'CAPTION_ERROR',
              message: `Transcription error: ${message.message}`
            });
          }
          return { success: true };
        }

        case 'MODEL_LOADING_PROGRESS':
          await this.handleModelLoadingProgress(message.status, message.percent);
          return { success: true };

        default:
          return { success: false, error: 'Unknown message type' };
      }
    } catch (error) {
      console.error('Error handling message:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  private withCaptureLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.captureLock.then(fn, fn);
    this.captureLock = run.catch(() => undefined);
    return run;
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
      const activeTabId = await getActiveTabId();
      if (activeTabId === tabId && (await chrome.offscreen.hasDocument())) {
        return { success: true }; // already captioning this tab
      }
      if (activeTabId !== null) {
        await this.stopAudioCapture(activeTabId);
      }

      const { sourceLanguage } = await getSettings();

      const streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        });
      });

      await this.ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({
        type: 'START_OFFSCREEN_CAPTURE',
        streamId,
        sourceLanguage
      });
      if (!response?.success) {
        await this.closeOffscreenDocument();
        throw new Error(response?.error || 'Audio capture failed to start');
      }

      await setActiveTabId(tabId);
      await this.safeSendMessage(tabId, { type: 'CAPTURE_STARTED', streamId });

      return { success: true, streamId };
    } catch (error) {
      console.error('Failed to start audio capture:', error);
      return { success: false, error: describeCaptureError(error) };
    }
  }

  private async stopAudioCapture(tabId: number): Promise<{ success: boolean }> {
    if ((await getActiveTabId()) === tabId) {
      try {
        await chrome.runtime.sendMessage({ type: 'STOP_OFFSCREEN_CAPTURE' });
      } catch (error) {
        // offscreen document may already be gone
      }
      await this.closeOffscreenDocument();
      await setActiveTabId(null);

      await this.safeSendMessage(tabId, { type: 'CAPTURE_STOPPED' });
    }
    return { success: true };
  }

  private async stopIfActive(tabId: number): Promise<void> {
    if ((await getActiveTabId()) === tabId) {
      await this.withCaptureLock(() => this.stopAudioCapture(tabId));
    }
  }

  private async handleTranscriptionResult(text: string, timing?: Record<string, number>): Promise<void> {
    const tabId = await getActiveTabId();
    if (tabId === null || !text || !text.trim()) return;
    const translateStartedAt = performance.now();
    const { text: finalText, language } = await this.maybeTranslate(text.trim(), tabId);
    await this.safeSendMessage(tabId, {
      type: 'DISPLAY_SUBTITLE',
      text: finalText,
      language,
      timing: { ...timing, translationMs: performance.now() - translateStartedAt }
    });
  }

  private async handleModelLoadingProgress(status: string, percent?: number): Promise<void> {
    const tabId = await getActiveTabId();
    if (tabId === null) return;
    const statusMessages: Record<string, string> = {
      downloading: 'Loading speech model... (first time only, may take a minute)',
      'download-progress': `Downloading speech model... ${percent ?? 0}%`,
      ready: 'Speech model ready',
      'cpu-fallback': 'WebGPU unavailable - running in CPU mode, captions may be slower'
    };
    await this.safeSendMessage(tabId, {
      type: 'CAPTION_STATUS',
      message: statusMessages[status] || status,
      // Progress updates replace each other instead of stacking up.
      replace: status === 'download-progress'
    });
  }

  private async maybeTranslate(text: string, tabId: number): Promise<{ text: string; language: string }> {
    const { sourceLanguage, targetLanguage, translationProvider } = await getSettings();
    const providerName = translationProvider === 'deepl' ? 'DeepL' : 'Google Translate';

    if (sourceLanguage === targetLanguage) {
      return { text, language: sourceLanguage };
    }

    try {
      const result = await apiService.translateText(text, sourceLanguage, targetLanguage);
      return { text: result.translatedText, language: targetLanguage };
    } catch (error) {
      if (error instanceof APIError && error.status === 401 && !(await this.alreadyWarned(tabId))) {
        await this.safeSendMessage(tabId, {
          type: 'CAPTION_ERROR',
          message: `No ${providerName} API key configured. Showing untranslated captions - add a key in the extension popup to enable translation.`
        });
      }
      console.error('Translation failed, falling back to untranslated text:', error);
      return { text, language: sourceLanguage };
    }
  }

  /** True if the missing-key warning was already shown for this tab; marks it shown otherwise. */
  private async alreadyWarned(tabId: number): Promise<boolean> {
    const stored = await chrome.storage.session.get(WARNED_TABS_KEY);
    const warned: number[] = stored[WARNED_TABS_KEY] ?? [];
    if (warned.includes(tabId)) return true;
    await chrome.storage.session.set({ [WARNED_TABS_KEY]: [...warned, tabId] });
    return false;
  }

  private async safeSendMessage(tabId: number, message: ExtensionMessage): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      // tab might be closed or navigating away; ignore
    }
  }

  /** Subtitle-mode line: source language is the subtitle language, neighbours give context. */
  async translateSubtitleLine(message: ExtensionMessage, sender?: chrome.runtime.MessageSender) {
    const m = message as Partial<LineTranslateRequest> & { text: string; sourceLang: string } & ExtensionMessage;
    let video = m.video ?? NO_VIDEO;
    if (sender?.tab && sender.url) {
      // A tab's video identity (glossary/topic keys) comes from the URL Chrome reports
      // for the sending frame, never from what the page could influence.
      video = { ...video, url: sender.url, videoId: videoIdFrom(sender.url) };
    }
    return translation.translateLine({
      tier: m.tier === 'best' ? 'best' : 'fast',
      text: m.text,
      sourceLang: m.sourceLang,
      previousLines: m.previousLines ?? [],
      nextLines: m.nextLines ?? [],
      priority: (m.priority as JobPriority) ?? 'live',
      video,
    });
  }

  async translateText(text: string, targetLang: string) {
    try {
      const { sourceLanguage } = await getSettings();
      const result = await apiService.translateText(text, sourceLanguage, targetLang);
      return { success: true, translatedText: result.translatedText };
    } catch (error) {
      console.error('Translation failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }
}

function describeCaptureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Chrome pages cannot be captured|cannot be captured/i.test(message)) {
    return "This page can't be captioned (browser and Web Store pages block audio capture).";
  }
  if (/has not been invoked|activeTab/i.test(message)) {
    return 'Open the extension popup on this tab and press Start Subtitles to allow audio capture.';
  }
  return message;
}

new SubtitleService();
