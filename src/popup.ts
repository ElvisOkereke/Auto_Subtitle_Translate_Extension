// popup.ts - Popup interface logic

import {
  ExtensionSettings,
  SubtitlePosition,
  FontSize
} from './types';

interface PopupElements {
  toggleButton: HTMLButtonElement;
  status: HTMLDivElement;
  sourceLanguage: HTMLSelectElement;
  targetLanguage: HTMLSelectElement;
  subtitleStyle: HTMLSelectElement;
  fontSize: HTMLSelectElement;
  whisperServiceUrl: HTMLInputElement;
}

class PopupController {
  private isActive: boolean;
  private elements: PopupElements;

  constructor() {
    this.isActive = false;
    this.elements = {} as PopupElements;
    this.initializeElements();
    this.loadSettings();
    this.setupEventListeners();
  }

  initializeElements() {
    const toggleButton = document.getElementById('toggleButton') as HTMLButtonElement | null;
    const status = document.getElementById('status') as HTMLDivElement | null;
    const sourceLanguage = document.getElementById('sourceLanguage') as HTMLSelectElement | null;
    const targetLanguage = document.getElementById('targetLanguage') as HTMLSelectElement | null;
    const subtitleStyle = document.getElementById('subtitleStyle') as HTMLSelectElement | null;
    const fontSize = document.getElementById('fontSize') as HTMLSelectElement | null;
    const whisperServiceUrl = document.getElementById('whisperServiceUrl') as HTMLInputElement | null;

    if (
      !toggleButton ||
      !status ||
      !sourceLanguage ||
      !targetLanguage ||
      !subtitleStyle ||
      !fontSize ||
      !whisperServiceUrl
    ) {
      throw new Error('One or more popup elements not found in the DOM.');
    }

    this.elements = {
      toggleButton,
      status,
      sourceLanguage,
      targetLanguage,
      subtitleStyle,
      fontSize,
      whisperServiceUrl
    };
  }

  setupEventListeners() {
    // Toggle button
    this.elements.toggleButton.addEventListener('click', () => {
      this.toggleSubtitles();
    });

    // Settings change handlers
    Object.keys(this.elements).forEach(key => {
      if (key !== 'toggleButton' && key !== 'status') {
        (this.elements[key as keyof PopupElements] as HTMLElement).addEventListener('change', () => {
          this.saveSettings();
        });
      }
    });
  }

  async loadSettings() {
    try {
      // Get settings directly from storage with defaults
      const defaultSettings = {
        sourceLanguage: 'auto',
        targetLanguage: 'en',
        subtitleStyle: 'bottom',
        fontSize: 'medium',
        whisperServiceUrl: 'http://localhost:8001',
        enabled: false
      };
      
      const settings = await chrome.storage.sync.get(defaultSettings);

      // Populate form fields
      this.elements.sourceLanguage.value = settings.sourceLanguage;
      this.elements.targetLanguage.value = settings.targetLanguage;
      this.elements.subtitleStyle.value = settings.subtitleStyle;
      this.elements.fontSize.value = settings.fontSize;
      this.elements.whisperServiceUrl.value = settings.whisperServiceUrl;
      
      this.isActive = settings.enabled;
      this.updateToggleButton();
      
      // Validate connection on load
      this.validateConnection();
      
      this.showStatus('Ready to start subtitles', 'success');
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.showStatus('Failed to load settings', 'error');
      // Set default values on error
      this.setDefaultValues();
    }
  }

  private setDefaultValues() {
    this.elements.sourceLanguage.value = 'auto';
    this.elements.targetLanguage.value = 'en';
    this.elements.subtitleStyle.value = 'bottom';
    this.elements.fontSize.value = 'medium';
    this.elements.whisperServiceUrl.value = 'http://localhost:8001';
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
        whisperServiceUrl: this.elements.whisperServiceUrl.value,
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

  async validateConnection() {
    // Check if the whisper-service is running
    try {
      const settings = await chrome.storage.sync.get(['whisperServiceUrl']);
      const serviceUrl = settings.whisperServiceUrl || 'http://localhost:8001';
      
      const response = await fetch(`${serviceUrl}/health`);
      if (response.ok) {
        const healthData = await response.json();
        this.showStatus(`Whisper service connected (${healthData.model})`, 'success');
        return true;
      } else {
        this.showStatus('Whisper service not responding', 'warning');
        return false;
      }
    } catch (error) {
      this.showStatus('Cannot connect to whisper service', 'warning');
      return false;
    }
  }

  async toggleSubtitles() {
    try {
      // Validate connection before starting
      if (!this.isActive && !await this.validateConnection()) {
        return;
      }

      this.isActive = !this.isActive;
      this.updateToggleButton();
      
      // Get current active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab) {
        throw new Error('No active tab found');
      }

      // Send message to content script
      if (typeof tab.id === 'number') {
        chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SUBTITLES'
        });
      } else {
        throw new Error('Active tab does not have a valid id');
      }

      // Save the new state
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
      // Revert state on error
      this.isActive = !this.isActive;
      this.updateToggleButton();
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

  showStatus(message: string, type = 'success') {
    const statusElement = this.elements.status;
    
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
    statusElement.classList.remove('hidden');
    
    // Auto-hide status after 3 seconds
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

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});