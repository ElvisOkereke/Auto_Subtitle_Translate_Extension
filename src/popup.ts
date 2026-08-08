// popup.ts - Popup interface logic

import { ExtensionSettings } from './types';

interface PopupElements {
  toggleButton: HTMLButtonElement;
  screenTranslateButton: HTMLButtonElement;
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

const NON_SETTING_ELEMENT_KEYS = [
  'toggleButton',
  'screenTranslateButton',
  'status',
  'googleApiKeyGroup',
  'deeplApiKeyGroup'
];

class PopupController {
  private isActive: boolean;
  private isScreenTranslating: boolean;
  private elements: PopupElements;

  constructor() {
    this.isActive = false;
    this.isScreenTranslating = false;
    this.elements = {} as PopupElements;
    this.initializeElements();
    this.loadSettings();
    this.setupEventListeners();
  }

  initializeElements() {
    const toggleButton = document.getElementById('toggleButton') as HTMLButtonElement | null;
    const screenTranslateButton = document.getElementById('screenTranslateButton') as HTMLButtonElement | null;
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

      this.isActive = settings.enabled;
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
        deeplApiKey: this.elements.deeplApiKey.value,
        enabled: this.isActive
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

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id === 'number') {
        chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SUBTITLES'
        });
      } else {
        throw new Error('Active tab does not have a valid id');
      }

      await this.saveSettings();

      this.showStatus(
        this.isActive ? 'Subtitles activated' : 'Subtitles deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle subtitles:', error);
      const errorMsg = (error && typeof error === 'object' && 'message' in error)
        ? (error as Error).message
        : String(error);
      this.showStatus('Failed to toggle subtitles: ' + errorMsg, 'error');
      this.isActive = !this.isActive;
      this.updateToggleButton();
    }
  }

  async toggleScreenTranslation() {
    try {
      this.isScreenTranslating = !this.isScreenTranslating;
      this.updateScreenTranslateButton();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id === 'number') {
        chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SCREEN_TRANSLATION'
        });
      } else {
        throw new Error('Active tab does not have a valid id');
      }

      this.showStatus(
        this.isScreenTranslating ? 'Screen translation activated' : 'Screen translation deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle screen translation:', error);
      const errorMsg = (error && typeof error === 'object' && 'message' in error)
        ? (error as Error).message
        : String(error);
      this.showStatus('Failed to toggle screen translation: ' + errorMsg, 'error');
      this.isScreenTranslating = !this.isScreenTranslating;
      this.updateScreenTranslateButton();
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
