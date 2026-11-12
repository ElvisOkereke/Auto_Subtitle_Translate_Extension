// popup.ts - Popup interface logic

import { ExtensionSettings } from './types';

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
  'deeplApiKeyGroup'
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

  private updateApiKeyVisibility() {
    const isDeepL = this.elements.translationProvider.value === 'deepl';
    this.elements.googleApiKeyGroup.classList.toggle('hidden', isDeepL);
    this.elements.deeplApiKeyGroup.classList.toggle('hidden', !isDeepL);
  }

  async loadSettings() {
    try {
      const defaultSettings: ExtensionSettings = {
        sourceLanguage: 'auto',
        targetLanguage: 'en',
        subtitleStyle: 'bottom',
        fontSize: 'medium',
        googleTranslateApiKey: '',
        translationProvider: 'google',
        deeplApiKey: '',
        enabled: false
      };

      const settings = await chrome.storage.sync.get(defaultSettings);

      this.elements.sourceLanguage.value = settings.sourceLanguage;
      this.elements.targetLanguage.value = settings.targetLanguage;
      this.elements.subtitleStyle.value = settings.subtitleStyle;
      this.elements.fontSize.value = settings.fontSize;
      this.elements.translationProvider.value = settings.translationProvider;
      this.elements.googleTranslateApiKey.value = settings.googleTranslateApiKey;
      this.elements.deeplApiKey.value = settings.deeplApiKey;
      this.updateApiKeyVisibility();

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
      const settings = {
        sourceLanguage: this.elements.sourceLanguage.value,
        targetLanguage: this.elements.targetLanguage.value,
        subtitleStyle: this.elements.subtitleStyle.value,
        fontSize: this.elements.fontSize.value,
        translationProvider: this.elements.translationProvider.value,
        googleTranslateApiKey: this.elements.googleTranslateApiKey.value,
        deeplApiKey: this.elements.deeplApiKey.value
      };

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
