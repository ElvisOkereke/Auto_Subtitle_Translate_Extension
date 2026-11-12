// popup.ts - Popup interface logic

import { ExtensionSettings } from './types';
import { DEFAULT_SETTINGS, getSecrets } from './settings';
import { validateGatewayUrl } from './translation/claudeAccess';

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
  modeAudio: HTMLButtonElement;
  modeSubtitles: HTMLButtonElement;
  audioPanel: HTMLDivElement;
  subtitlePanel: HTMLDivElement;
  subtitleLanguage: HTMLSelectElement;
  startSubtitleMode: HTMLButtonElement;
  drawSubtitleBox: HTMLButtonElement;
  stopSubtitleMode: HTMLButtonElement;
  subtitleModeStatus: HTMLDivElement;
  engineMode: HTMLSelectElement;
  claudeModel: HTMLSelectElement;
  claudeAccess: HTMLSelectElement;
  anthropicApiKey: HTMLInputElement;
  claudeGatewayUrl: HTMLInputElement;
  claudeGatewayToken: HTMLInputElement;
  claudeGatewayAuth: HTMLSelectElement;
  anthropicKeyGroup: HTMLDivElement;
  claudeGatewayGroup: HTMLDivElement;
  claudeStatus: HTMLDivElement;
  glossaryTopic: HTMLDivElement;
  glossaryList: HTMLDivElement;
}

const ELEMENT_IDS: (keyof PopupElements)[] = [
  'toggleButton', 'screenTranslateButton', 'drawNewBoxButton', 'screenTranslateStatus', 'status',
  'sourceLanguage', 'targetLanguage', 'subtitleStyle', 'fontSize', 'translationProvider',
  'googleTranslateApiKey', 'deeplApiKey', 'googleApiKeyGroup', 'deeplApiKeyGroup',
  'modeAudio', 'modeSubtitles', 'audioPanel', 'subtitlePanel', 'subtitleLanguage',
  'startSubtitleMode', 'drawSubtitleBox', 'stopSubtitleMode', 'subtitleModeStatus',
  'engineMode', 'claudeModel', 'claudeAccess', 'anthropicApiKey', 'claudeGatewayUrl', 'claudeGatewayToken',
  'claudeGatewayAuth', 'anthropicKeyGroup', 'claudeGatewayGroup', 'claudeStatus', 'glossaryTopic', 'glossaryList'
];

const MODE_LABELS: Record<string, string> = {
  'fast-then-best': 'Fast then best (DeepL, then Claude)',
  fast: 'Fast only',
  best: 'Best only (Claude)',
};

/**
 * The tab the popup controls. Normally the active tab of the popup's window;
 * `popup.html?tabId=N` pins it to a specific tab (used by the E2E harness,
 * which opens the popup as a regular page rather than via the toolbar).
 */
export async function getTargetTab(): Promise<chrome.tabs.Tab | undefined> {
  const pinned = Number(new URLSearchParams(location.search).get('tabId'));
  if (Number.isInteger(pinned) && pinned > 0) {
    return chrome.tabs.get(pinned);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Turns "no content script in this tab" into something a user can act on. */
export function describeTabError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return "this page can't run the extension (browser pages, the Web Store, or tabs opened before install - try reloading the page).";
  }
  return message;
}

const NON_SETTING_ELEMENT_KEYS = [
  'toggleButton',
  'screenTranslateButton',
  'drawNewBoxButton',
  'screenTranslateStatus',
  'status',
  'googleApiKeyGroup',
  'deeplApiKeyGroup',
  'modeAudio',
  'modeSubtitles',
  'audioPanel',
  'subtitlePanel',
  'startSubtitleMode',
  'drawSubtitleBox',
  'stopSubtitleMode',
  'subtitleModeStatus',
  'anthropicKeyGroup',
  'claudeGatewayGroup',
  'claudeStatus',
  'glossaryTopic',
  'glossaryList'
];

class PopupController {
  private isActive: boolean;
  private isScreenTranslating: boolean;
  private elements: PopupElements;
  /** Bumped by every user action so a slow initial state query can't overwrite it. */
  private screenTranslateActionCount = 0;

  constructor() {
    this.isActive = false;
    this.isScreenTranslating = false;
    this.elements = {} as PopupElements;
    this.initializeElements();
    this.loadSettings();
    this.setupEventListeners();
    this.refreshScreenTranslateState();
    this.refreshSubtitleState();
    this.refreshSubtitleModeState();
    this.loadGlossary();
  }

  /** Glossary of the video in the target tab: learned names/terms, editable. */
  async loadGlossary(): Promise<void> {
    try {
      const tab = await getTargetTab();
      if (!tab?.id) return;
      const glossary = await chrome.runtime.sendMessage({ type: 'GET_GLOSSARY', tabId: tab.id });
      this.renderGlossary(tab.id, glossary);
    } catch (error) {
      console.warn('Glossary unavailable:', error);
    }
  }

  private renderGlossary(tabId: number, glossary: { topic: string | null; entries: { source: string; target: string; scope: string }[] } | undefined) {
    const list = this.elements.glossaryList;
    list.replaceChildren();
    this.elements.glossaryTopic.textContent = glossary?.topic ? `Topic: ${glossary.topic}` : '';
    const entries = glossary?.entries ?? [];
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'glossary-empty';
      empty.textContent = 'No names or terms learned for this video yet.';
      list.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'glossary-row';
      row.dataset.source = entry.source;
      const source = document.createElement('span');
      source.className = 'glossary-source';
      source.textContent = entry.source;
      const target = document.createElement('input');
      target.type = 'text';
      target.value = entry.target;
      target.maxLength = 80;
      target.setAttribute('aria-label', `Translation of ${entry.source}`);
      target.addEventListener('change', () => void this.editGlossary(tabId, entry.source, target.value));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '✕';
      remove.title = `Remove ${entry.source}`;
      remove.addEventListener('click', () => void this.editGlossary(tabId, entry.source, null));
      row.append(source, target, remove);
      list.append(row);
    }
  }

  private async editGlossary(tabId: number, source: string, target: string | null) {
    await chrome.runtime.sendMessage({ type: 'EDIT_GLOSSARY_ENTRY', tabId, source, target });
    await this.loadGlossary();
  }

  private subtitleModeRunning = false;

  /** Audio (live captions from speech) or Subtitles (burned-in subtitle translation). */
  setMode(mode: 'audio' | 'subtitles') {
    const subtitles = mode === 'subtitles';
    this.elements.modeAudio.classList.toggle('active', !subtitles);
    this.elements.modeSubtitles.classList.toggle('active', subtitles);
    this.elements.audioPanel.classList.toggle('hidden', subtitles);
    this.elements.subtitlePanel.classList.toggle('hidden', !subtitles);
    chrome.storage.local?.set({ popupMode: mode }).catch(() => undefined);
  }

  async refreshSubtitleModeState() {
    let state: { mode?: string; state?: string; hasBox?: boolean } = {};
    try {
      const tab = await getTargetTab();
      if (tab?.id !== undefined) state = (await chrome.tabs.sendMessage(tab.id, { type: 'GET_SUBTITLE_MODE_STATE' })) ?? {};
    } catch {
      // page without content scripts
    }
    const stored = await chrome.storage.local?.get('popupMode').catch(() => ({}));
    this.subtitleModeRunning = state.mode === 'subtitles';
    this.setMode(this.subtitleModeRunning || (stored as any)?.popupMode === 'subtitles' ? 'subtitles' : 'audio');
    this.renderSubtitleMode(!!state.hasBox, state.state);
  }

  private renderSubtitleMode(hasBox: boolean, state?: string) {
    const running = this.subtitleModeRunning;
    this.elements.stopSubtitleMode.classList.toggle('hidden', !running);
    this.elements.startSubtitleMode.classList.toggle('hidden', running || !hasBox);
    this.elements.drawSubtitleBox.textContent = hasBox || running ? 'Redraw box' : 'Draw subtitle box';
    const status = this.elements.subtitleModeStatus;
    const text = running
      ? state === 'paused-ad'
        ? 'Paused during the ad.'
        : state === 'loading'
          ? 'Loading OCR model...'
          : 'Translating subtitles in the box.'
      : '';
    status.textContent = text;
    status.className = 'status success';
    status.classList.toggle('hidden', !text);
  }

  private async sendToTab(message: Record<string, unknown>) {
    const tab = await getTargetTab();
    if (!tab || typeof tab.id !== 'number') throw new Error('No active tab found');
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async drawSubtitleBox() {
    try {
      if (this.isActive) await this.toggleSubtitles(); // one mode at a time
      await this.sendToTab({ type: 'DRAW_SUBTITLE_BOX', lang: this.elements.subtitleLanguage.value });
      this.showStatus('Drag a box around the subtitles on the video.', 'success');
    } catch (error) {
      this.showStatus('Failed to start: ' + describeTabError(error), 'error');
    }
  }

  async startSubtitleModeWithSavedBox() {
    try {
      if (this.isActive) await this.toggleSubtitles();
      const response = await this.sendToTab({ type: 'START_SUBTITLE_MODE' });
      if (!response?.success) throw new Error(response?.error || 'Could not start');
      await this.refreshSubtitleModeState();
    } catch (error) {
      this.showStatus('Failed to start: ' + describeTabError(error), 'error');
    }
  }

  async stopSubtitleMode() {
    try {
      await this.sendToTab({ type: 'STOP_SUBTITLE_MODE' });
    } catch {
      // nothing to stop
    }
    await this.refreshSubtitleModeState();
  }

  /** Subtitles are per tab, so ask the tab rather than trusting a stored flag. */
  async refreshSubtitleState() {
    try {
      const tab = await getTargetTab();
      if (!tab || typeof tab.id !== 'number') return;
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SUBTITLE_STATE' });
      this.isActive = response?.active === true;
    } catch {
      this.isActive = false;
    }
    this.updateToggleButton();
  }

  initializeElements() {
    const found: Partial<PopupElements> = {};
    for (const id of ELEMENT_IDS) {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Popup element #${id} not found in the DOM.`);
      (found as Record<string, HTMLElement>)[id] = el;
    }
    this.elements = found as PopupElements;
  }

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

    this.elements.modeAudio.addEventListener('click', () => this.setMode('audio'));
    this.elements.modeSubtitles.addEventListener('click', () => this.setMode('subtitles'));
    this.elements.drawSubtitleBox.addEventListener('click', () => this.drawSubtitleBox());
    this.elements.startSubtitleMode.addEventListener('click', () => this.startSubtitleModeWithSavedBox());
    this.elements.stopSubtitleMode.addEventListener('click', () => this.stopSubtitleMode());

    this.elements.translationProvider.addEventListener('change', () => {
      this.updateApiKeyVisibility();
    });
    this.elements.claudeAccess.addEventListener('change', () => this.updateClaudeFields());
    for (const key of ['anthropicApiKey', 'claudeGatewayUrl', 'claudeGatewayToken'] as const) {
      this.elements[key].addEventListener('change', () => this.updateClaudeFields());
    }

    Object.keys(this.elements).forEach(key => {
      if (!NON_SETTING_ELEMENT_KEYS.includes(key)) {
        (this.elements[key as keyof PopupElements] as HTMLElement).addEventListener('change', () => {
          this.saveSettings();
        });
      }
    });
  }

  /** The last Claude failure the service worker recorded (cleared when Claude works again). */
  private async showClaudeError(): Promise<void> {
    try {
      const { claudeError } = (await chrome.storage.session.get('claudeError')) as { claudeError?: { status: number | null; message: string } };
      if (claudeError && !this.elements.claudeStatus.textContent) {
        this.elements.claudeStatus.textContent = `Claude error${claudeError.status ? ` (${claudeError.status})` : ''}: ${claudeError.message}`.slice(0, 240);
      }
    } catch {
      // no session storage (tests) or not available: nothing to show
    }
  }

  /** Key vs gateway fields, the gateway URL check, and "(needs Claude access)" on Claude modes. */
  private updateClaudeFields(): boolean {
    const gateway = this.elements.claudeAccess.value === 'gateway';
    this.elements.anthropicKeyGroup.classList.toggle('hidden', gateway);
    this.elements.claudeGatewayGroup.classList.toggle('hidden', !gateway);
    const url = this.elements.claudeGatewayUrl.value.trim();
    const urlOk = !url || validateGatewayUrl(url) !== null;
    this.elements.claudeStatus.textContent =
      gateway && !urlOk ? 'Gateway URL must start with https:// (http:// only for localhost).' : '';
    const hasClaude = gateway ? !!url && urlOk && !!this.elements.claudeGatewayToken.value : !!this.elements.anthropicApiKey.value;
    for (const option of this.elements.engineMode.options) {
      const needsClaude = option.value !== 'fast';
      option.textContent = MODE_LABELS[option.value] + (needsClaude && !hasClaude ? ' (needs Claude access)' : '');
    }
    return urlOk;
  }

  private updateApiKeyVisibility() {
    const isDeepL = this.elements.translationProvider.value === 'deepl';
    this.elements.googleApiKeyGroup.classList.toggle('hidden', isDeepL);
    this.elements.deeplApiKeyGroup.classList.toggle('hidden', !isDeepL);
  }

  async loadSettings() {
    try {
      const settings = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as ExtensionSettings;
      const secrets = await getSecrets();

      this.elements.sourceLanguage.value = settings.sourceLanguage;
      this.elements.targetLanguage.value = settings.targetLanguage;
      this.elements.subtitleStyle.value = settings.subtitleStyle;
      this.elements.fontSize.value = settings.fontSize;
      this.elements.translationProvider.value = settings.translationProvider;
      this.elements.googleTranslateApiKey.value = secrets.googleTranslateApiKey;
      this.elements.deeplApiKey.value = secrets.deeplApiKey;
      this.elements.subtitleLanguage.value = settings.subtitleLanguage;
      this.elements.engineMode.value = settings.translationEngineMode;
      this.elements.claudeModel.value = settings.claudeModel;
      this.elements.claudeAccess.value = settings.claudeAccess;
      this.elements.claudeGatewayUrl.value = settings.claudeGatewayUrl;
      this.elements.claudeGatewayAuth.value = settings.claudeGatewayAuth;
      this.elements.anthropicApiKey.value = secrets.anthropicApiKey;
      this.elements.claudeGatewayToken.value = secrets.claudeGatewayToken;
      this.updateApiKeyVisibility();
      this.updateClaudeFields();
      await this.showClaudeError();

      this.updateToggleButton();

      this.showStatus('Ready to start subtitles', 'success');
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.showStatus('Failed to load settings', 'error');
      this.setDefaultValues();
    }
  }

  private setDefaultValues() {
    this.elements.sourceLanguage.value = 'auto';
    this.elements.targetLanguage.value = 'en';
    this.elements.subtitleStyle.value = 'bottom';
    this.elements.fontSize.value = 'medium';
    this.elements.translationProvider.value = 'google';
    this.elements.googleTranslateApiKey.value = '';
    this.elements.deeplApiKey.value = '';
    this.updateApiKeyVisibility();
    this.isActive = false;
    this.updateToggleButton();
  }

  async saveSettings() {
    try {
      const gatewayUrlOk = this.updateClaudeFields();
      const settings: Record<string, string> = {
        sourceLanguage: this.elements.sourceLanguage.value,
        targetLanguage: this.elements.targetLanguage.value,
        subtitleStyle: this.elements.subtitleStyle.value,
        fontSize: this.elements.fontSize.value,
        translationProvider: this.elements.translationProvider.value,
        googleTranslateApiKey: this.elements.googleTranslateApiKey.value,
        deeplApiKey: this.elements.deeplApiKey.value,
        subtitleLanguage: this.elements.subtitleLanguage.value,
        translationEngineMode: this.elements.engineMode.value,
        claudeModel: this.elements.claudeModel.value,
        claudeAccess: this.elements.claudeAccess.value,
        claudeGatewayAuth: this.elements.claudeGatewayAuth.value,
        anthropicApiKey: this.elements.anthropicApiKey.value,
        claudeGatewayToken: this.elements.claudeGatewayToken.value
      };
      // An unacceptable gateway URL is never stored (the token must only go to a safe endpoint).
      if (gatewayUrlOk) settings.claudeGatewayUrl = validateGatewayUrl(this.elements.claudeGatewayUrl.value) ?? '';

      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: settings
      });

      this.showStatus('Settings saved', 'success');
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showStatus('Failed to save settings', 'error');
    }
  }

  async toggleSubtitles() {
    try {
      if (!this.isActive && this.subtitleModeRunning) {
        await this.stopSubtitleMode(); // one mode at a time
      }
      this.isActive = !this.isActive;
      this.updateToggleButton();

      const tab = await getTargetTab();

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id !== 'number') {
        throw new Error('Active tab does not have a valid id');
      }
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_SUBTITLES'
      });
      if (typeof response?.active === 'boolean' && response.active !== this.isActive) {
        // The content script couldn't start capture; it shows the reason on the page.
        this.isActive = response.active;
        this.updateToggleButton();
        this.showStatus('Could not start subtitles - see the message on the page', 'error');
        return;
      }

      this.showStatus(
        this.isActive ? 'Subtitles activated' : 'Subtitles deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle subtitles:', error);
      this.showStatus('Failed to toggle subtitles: ' + describeTabError(error), 'error');
      this.isActive = !this.isActive;
      this.updateToggleButton();
    }
  }

  async toggleScreenTranslation() {
    const wasScreenTranslating = this.isScreenTranslating;
    this.screenTranslateActionCount++;

    try {
      this.renderScreenTranslateState(wasScreenTranslating ? 'inactive' : 'armed');

      const tab = await getTargetTab();

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id === 'number') {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SCREEN_TRANSLATION'
        });
        if (response?.state) {
          this.renderScreenTranslateState(response.state);
        }
      } else {
        throw new Error('Active tab does not have a valid id');
      }

      this.showStatus(
        this.isScreenTranslating ? 'Screen translation activated' : 'Screen translation deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle screen translation:', error);
      this.showStatus('Failed to toggle screen translation: ' + describeTabError(error), 'error');
      this.renderScreenTranslateState(wasScreenTranslating ? 'armed' : 'inactive');
    }
  }

  async refreshScreenTranslateState() {
    const actionCountAtStart = this.screenTranslateActionCount;
    try {
      const tab = await getTargetTab();

      if (!tab || typeof tab.id !== 'number') {
        this.renderScreenTranslateState('inactive');
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_SCREEN_TRANSLATE_STATE'
      });

      if (this.screenTranslateActionCount !== actionCountAtStart) return;
      this.renderScreenTranslateState(response?.state ?? 'inactive');
    } catch (error) {
      if (this.screenTranslateActionCount !== actionCountAtStart) return;
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
    this.screenTranslateActionCount++;
    try {
      const tab = await getTargetTab();

      if (!tab || typeof tab.id !== 'number') {
        throw new Error('No active tab found');
      }

      await chrome.tabs.sendMessage(tab.id, {
        type: 'DRAW_NEW_BOX'
      });

      this.renderScreenTranslateState('armed');
    } catch (error) {
      console.error('Failed to draw new box:', error);
      this.showStatus('Failed to draw new box: ' + describeTabError(error), 'error');
    }
  }

  updateToggleButton() {
    const button = this.elements.toggleButton;

    if (this.isActive) {
      button.textContent = 'Stop Subtitles';
      button.classList.add('active');
    } else {
      button.textContent = 'Start Subtitles';
      button.classList.remove('active');
    }
  }

  updateScreenTranslateButton() {
    const button = this.elements.screenTranslateButton;

    if (this.isScreenTranslating) {
      button.textContent = 'Stop Translation';
      button.classList.add('active');
      button.style.background = '#e53e3e';
    } else {
      button.textContent = 'Screen Translate';
      button.classList.remove('active');
      button.style.background = '#38a169';
    }
  }

  showStatus(message: string, type = 'success') {
    const statusElement = this.elements.status;

    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
    statusElement.classList.remove('hidden');

    setTimeout(() => {
      statusElement.classList.add('hidden');
    }, 3000);
  }

  async checkPermissions() {
    try {
      const hasPermissions = await chrome.permissions.contains({
        permissions: ['tabCapture'],
        origins: ['<all_urls>']
      });

      if (!hasPermissions) {
        this.showStatus('Missing required permissions', 'warning');
        return false;
      }

      return true;
    } catch (error) {
      console.error('Permission check failed:', error);
      return false;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
