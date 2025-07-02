// popup.ts - Popup interface logic

import {
  ExtensionSettings,
  SubtitlePosition,
  FontSize
} from './types';

interface PopupElements {
  toggleButton: HTMLButtonElement;
  status: HTMLDivElement;
  apiKey: HTMLInputElement;
  sourceLanguage: HTMLSelectElement;
  targetLanguage: HTMLSelectElement;
  subtitleStyle: HTMLSelectElement;
  fontSize: HTMLSelectElement;
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
    this.elements = {
      toggleButton: document.getElementById('toggleButton'),
      status: document.getElementById('status'),
      apiKey: document.getElementById('apiKey'),
      sourceLanguage: document.getElementById('sourceLanguage'),
      targetLanguage: document.getElementById('targetLanguage'),
      subtitleStyle: document.getElementById('subtitleStyle'),
      fontSize: document.getElementById('fontSize')
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
        this.elements[key].addEventListener('change', () => {
          this.saveSettings();
        });
      }
    });

    // API key input handler with debounce
    let apiKeyTimeout;
    this.elements.apiKey.addEventListener('input', () => {
      clearTimeout(apiKeyTimeout);
      apiKeyTimeout = setTimeout(() => {
        this.saveSettings();
        this.validateApiKey();
      }, 500);
    });
  }

  async loadSettings() {
    try {
      const settings = await chrome.runtime.sendMessage({
        type: 'GET_SETTINGS'
      });

      // Populate form fields
      this.elements.apiKey.value = settings.apiKey || '';
      this.elements.sourceLanguage.value = settings.sourceLanguage || 'auto';
      this.elements.targetLanguage.value = settings.targetLanguage || 'en';
      this.elements.subtitleStyle.value = settings.subtitleStyle || 'bottom';
      this.elements.fontSize.value = settings.fontSize || 'medium';
      
      this.isActive = settings.enabled || false;
      this.updateToggleButton();
      
      // Validate API key if present
      if (settings.apiKey) {
        this.validateApiKey();
      } else {
        this.showStatus('Please configure your API key', 'warning');
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.showStatus('Failed to load settings', 'error');
    }
  }

  async saveSettings() {
    try {
      const settings = {
        apiKey: this.elements.apiKey.value.trim(),
        sourceLanguage: this.elements.sourceLanguage.value,
        targetLanguage: this.elements.targetLanguage.value,
        subtitleStyle: this.elements.subtitleStyle.value,
        fontSize: this.elements.fontSize.value,
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

  async validateApiKey() {
    const apiKey = this.elements.apiKey.value.trim();
    
    if (!apiKey) {
      this.showStatus('API key is required', 'warning');
      return false;
    }

    if (apiKey.length < 10) {
      this.showStatus('API key appears to be invalid', 'warning');
      return false;
    }

    // In a real implementation, you might want to test the API key
    // with a simple API call to validate it
    this.showStatus('API key configured', 'success');
    return true;
  }

  async toggleSubtitles() {
    try {
      // Validate API key before starting
      if (!this.isActive && !await this.validateApiKey()) {
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
      await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_SUBTITLES'
      });

      // Save the new state
      await this.saveSettings();

      this.showStatus(
        this.isActive ? 'Subtitles activated' : 'Subtitles deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle subtitles:', error);
      this.showStatus('Failed to toggle subtitles: ' + error.message, 'error');
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

  showStatus(message, type = 'success') {
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