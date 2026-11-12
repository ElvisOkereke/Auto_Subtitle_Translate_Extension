// background.ts - Service Worker: orchestrates the offscreen capture pipeline and translation

import { ExtensionMessage, CaptureResponse, APIError } from './types';
import { apiService, getEndpointOverrides } from './services/apiService';
import { DEFAULT_SETTINGS, getSecrets, getSettings, hostedServiceUrl, migrateSecretsFromSync, saveSettings, setSecrets } from './settings';
import { ProxyClient, proxyClaude, proxyFast } from './translation/engines/proxy';
import { JobPriority } from './utils/priorityRunner';
import { LineTranslateRequest, StorageUsageMeter, TranslationService } from './translation/translationService';
import { GlossaryStore } from './translation/glossary';
import { ClaudeEngine } from './translation/engines/claude';
import { DeepLEngine } from './translation/engines/deepl';
import { videoIdFrom } from './subtitle/videoId';
import { GoogleEngine } from './translation/engines/google';

// Fast (DeepL/Google) and best (Claude with video context + glossary) tiers;
// at most 4 requests in flight, lines on screen now first.
const glossaryStore = new GlossaryStore(chrome.storage.local);
const translation = new TranslationService({
  settings: getSettings,
  secrets: getSecrets,
  overrides: getEndpointOverrides,
  glossary: glossaryStore,
  usage: new StorageUsageMeter(chrome.storage.local),
  makeClaude: cfg => (cfg.via === 'proxy' ? proxyClaude(new ProxyClient({ baseURL: cfg.baseURL, token: cfg.auth.token }), cfg.model) : new ClaudeEngine(cfg)),
  makeFast: (provider, apiKey, endpoint) =>
    provider === 'subscription'
      ? proxyFast(new ProxyClient({ baseURL: endpoint ?? 'https://proxy.invalid', token: apiKey }))
      : provider === 'deepl'
        ? new DeepLEngine({ apiKey, endpoint })
        : new GoogleEngine({ apiKey, endpoint }),
  // The popup shows the last Claude failure (e.g. a rejected key) until Claude works again.
  reportClaudeError: error => (error ? chrome.storage.session.set({ claudeError: error }) : chrome.storage.session.remove('claudeError')),
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
  'PREPARE_TRANSLATION',
  'GET_GLOSSARY',
  'ACCOUNT_START',
  'ACCOUNT_VERIFY',
  'ACCOUNT_SIGNOUT',
  'ACCOUNT_STATUS',
  'BILLING_OPEN',
  'EDIT_GLOSSARY_ENTRY',
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

        case 'PREPARE_TRANSLATION': {
          // Identity from the sender URL (as for subtitle lines), context text from the page.
          const video = sender.tab && sender.url ? { ...(message.video ?? NO_VIDEO), url: sender.url, videoId: videoIdFrom(sender.url) } : (message.video ?? NO_VIDEO);
          void translation.prepare(video, String(message.sourceLang ?? 'auto'));
          return { success: true };
        }

        case 'ACCOUNT_START':
        case 'ACCOUNT_VERIFY':
        case 'ACCOUNT_SIGNOUT':
        case 'ACCOUNT_STATUS':
        case 'BILLING_OPEN':
          return await this.handleAccount(message);

        case 'GET_GLOSSARY': {
          const videoKey = await this.videoKeyOfTab(message.tabId);
          return videoKey ? await glossaryStore.list(videoKey) : { topic: null, entries: [], version: 0 };
        }

        case 'EDIT_GLOSSARY_ENTRY': {
          // A correction or deletion from the popup: store it, then re-translate lines using it.
          const videoKey = await this.videoKeyOfTab(message.tabId);
          if (!videoKey || typeof message.source !== 'string' || !(typeof message.target === 'string' || message.target === null)) {
            return { success: false, error: 'Invalid glossary edit' };
          }
          const target = typeof message.target === 'string' && message.target.trim() ? message.target.trim() : null;
          const version = await glossaryStore.edit(videoKey, message.source, target);
          await this.safeSendMessage(message.tabId, { type: 'GLOSSARY_CHANGED', terms: [message.source] });
          return { success: true, version };
        }

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
    const source = text.trim();
    const captionId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const translateStartedAt = performance.now();
    const plan = await translation.plan();
    const previousLines = await this.recentCaptions(tabId, source);

    if (plan.best && !plan.fast) {
      // Claude only: its version, else the fast engine's fallback, else the original.
      const best = await this.bestCaption(tabId, source, previousLines, false);
      const shown = best.success && best.translatedText ? best.translatedText : null;
      await this.safeSendMessage(tabId, {
        type: 'DISPLAY_SUBTITLE',
        text: shown ?? source,
        language: shown ? (await getSettings()).targetLanguage : 'auto',
        captionId,
        timing: { ...timing, translationMs: performance.now() - translateStartedAt }
      });
      return;
    }

    const { text: finalText, language } = await this.maybeTranslate(source, tabId);
    await this.safeSendMessage(tabId, {
      type: 'DISPLAY_SUBTITLE',
      text: finalText,
      language,
      captionId,
      timing: { ...timing, translationMs: performance.now() - translateStartedAt }
    });
    if (plan.best) {
      // Fast then best: Claude's context-aware version replaces the caption if it is still shown.
      // (no fast fallback: the fast translation is already on screen)
      const best = await this.bestCaption(tabId, source, previousLines, true);
      if (best.success && best.quality === 'better' && best.translatedText && best.translatedText !== finalText) {
        await this.safeSendMessage(tabId, { type: 'UPGRADE_SUBTITLE', captionId, text: best.translatedText });
      }
    }
  }

  /** Claude's translation of a caption with the page's video context (or the fast fallback). */
  private async bestCaption(tabId: number, source: string, previousLines: string[], noFallback: boolean) {
    const { sourceLanguage } = await getSettings();
    const video = await this.videoContextOf(tabId);
    const result = await translation.translateLine({ tier: 'best', text: source, sourceLang: sourceLanguage, previousLines, nextLines: [], priority: 'live', video, noFallback });
    if (result.warning) await this.safeSendMessage(tabId, { type: 'CAPTION_ERROR', message: result.warning });
    return result;
  }

  /** The tab's video context (title, channel, description) from the subtitle content script. */
  private async videoContextOf(tabId: number): Promise<typeof NO_VIDEO> {
    try {
      const ctx = await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_CONTEXT' }, { frameId: 0 });
      if (ctx && typeof ctx.title === 'string') {
        const tab = await chrome.tabs.get(tabId);
        // Identity from the URL Chrome reports, context text from the page.
        return { ...ctx, url: tab.url ?? ctx.url, videoId: tab.url ? videoIdFrom(tab.url) : null };
      }
    } catch {
      // no content script (e.g. restricted page)
    }
    return NO_VIDEO;
  }

  /** The hosted service (subscription): sign-in, status, sign-out, Stripe Checkout/Portal. */
  private async handleAccount(message: ExtensionMessage): Promise<unknown> {
    const overrides = await getEndpointOverrides();
    const baseURL = hostedServiceUrl(overrides.server);
    if (!baseURL) return message.type === 'ACCOUNT_STATUS' ? { success: true, available: false } : { success: false, error: 'The hosted translation service is not available in this build.' };
    const { accountToken } = await getSecrets();
    const client = new ProxyClient({ baseURL, token: accountToken || undefined });
    const m = message as ExtensionMessage & { email?: string; code?: string; plan?: 'standard' | 'pro' };
    try {
      switch (message.type) {
        case 'ACCOUNT_START':
          await client.start(String(m.email ?? ''));
          return { success: true };
        case 'ACCOUNT_VERIFY': {
          const token = await client.verify(String(m.email ?? ''), String(m.code ?? ''));
          await setSecrets({ accountToken: token });
          return { success: true, account: await new ProxyClient({ baseURL, token }).me() };
        }
        case 'ACCOUNT_SIGNOUT':
          if (accountToken) await client.signout().catch(() => undefined);
          await setSecrets({ accountToken: '' });
          return { success: true };
        case 'ACCOUNT_STATUS':
          if (!accountToken) return { success: true, available: true, signedIn: false };
          return { success: true, available: true, signedIn: true, account: await client.me() };
        case 'BILLING_OPEN': {
          const url = m.plan ? await client.checkout(m.plan) : await client.portal();
          // Only open Stripe pages (or a loopback test server).
          if (!/^https:\/\/([a-z0-9-]+\.)*stripe\.com\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
            return { success: false, error: 'Unexpected billing URL' };
          }
          await chrome.tabs.create({ url });
          return { success: true };
        }
      }
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401 && message.type !== 'ACCOUNT_VERIFY') await setSecrets({ accountToken: '' }); // session gone: signed out
      return { success: false, error: error instanceof Error ? error.message : String(error), status: status ?? null, code: (error as { code?: string }).code ?? null };
    }
    return { success: false, error: 'Unknown account message' };
  }

  /** Glossary key of the video in a tab: site-scoped video id, or the page URL. */
  private async videoKeyOfTab(tabId: unknown): Promise<string | null> {
    if (typeof tabId !== 'number') return null;
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.url ? (videoIdFrom(tab.url) ?? tab.url) : null;
    } catch {
      return null;
    }
  }

  /** The last captions of this tab (source text) as context; remembers the new one. */
  private async recentCaptions(tabId: number, source: string): Promise<string[]> {
    const key = `recentCaptions:${tabId}`;
    const stored = await chrome.storage.session.get(key);
    const previous: string[] = Array.isArray(stored[key]) ? stored[key] : [];
    await chrome.storage.session.set({ [key]: [...previous, source].slice(-3) });
    return previous;
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
      noFallback: m.noFallback === true,
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
