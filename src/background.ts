// background.ts - Service Worker for managing extension lifecycle

import {
  ExtensionMessage,
  ExtensionSettings,
  CaptureResponse,
  SpeechToTextResponse,
  TranslationResponse,
  APIResponse,
  AudioCaptureError,
  APIError
} from './types';

class SubtitleService {
  private activeStreams: Map<number, MediaStream>;

  constructor() {
    this.activeStreams = new Map();
    this.setupEventListeners();
    this.initializeSettings();
  }

  private setupEventListeners(): void {
    // Handle extension installation
    chrome.runtime.onInstalled.addListener(this.handleInstalled.bind(this));
    
    // Handle messages from content scripts and popup
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
    
    // Handle tab updates
    chrome.tabs.onUpdated.addListener(this.handleTabUpdate.bind(this));
    
    // Handle tab removal
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
  }

  private async initializeSettings(): Promise<void> {
    const defaultSettings: Partial<ExtensionSettings> = {
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      apiKey: '',
      subtitleStyle: 'bottom',
      fontSize: 'medium',
      enabled: true
    };
    
    const settings = await chrome.storage.sync.get(defaultSettings);
    await chrome.storage.sync.set(settings);
  }

  private handleInstalled(details: chrome.runtime.InstalledDetails): void {
    if (details.reason === 'install') {
      chrome.tabs.create({
        url: chrome.runtime.getURL('welcome.html')
      });
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
        
        case 'PROCESS_AUDIO':
          return await this.processAudioChunk(message.audioData, sender.tab?.id!);
        
        case 'GET_SETTINGS':
          return await chrome.storage.sync.get();
        
        case 'UPDATE_SETTINGS':
          return await chrome.storage.sync.set(message.settings);
        
        case 'TRANSLATE_TEXT':
          return await this.translateText(message.text, message.targetLang);
        
        default:
          console.warn('Unknown message type:', message.type);
          return { success: false, error: 'Unknown message type' };
      }
    } catch (error) {
      console.error('Error handling message:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  private async startAudioCapture(tabId: number): Promise<CaptureResponse> {
    try {
      // Check if already capturing for this tab
      if (this.activeStreams.has(tabId)) {
        return { success: false, error: 'Already capturing audio for this tab' };
      }

      // Request tab capture
      const stream = await new Promise<MediaStream>((resolve, reject) => {
        chrome.tabCapture.capture({
          audio: true,
          video: false
        }, (stream: MediaStream | null) => {
          if (chrome.runtime.lastError) {
            reject(new AudioCaptureError(chrome.runtime.lastError.message!));
          } else if (stream) {
            resolve(stream);
          } else {
            reject(new AudioCaptureError('No stream received'));
          }
        });
      });

      this.activeStreams.set(tabId, stream);
      
      // Notify content script that capture started
      await chrome.tabs.sendMessage(tabId, {
        type: 'CAPTURE_STARTED',
        streamId: stream.id
      });

      return { success: true, streamId: stream.id };
    } catch (error) {
      console.error('Failed to start audio capture:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  async stopAudioCapture(tabId: number) {
    const stream = this.activeStreams.get(tabId);
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      this.activeStreams.delete(tabId);
      
      // Notify content script
      await chrome.tabs.sendMessage(tabId, {
        type: 'CAPTURE_STOPPED'
      });
    }
    return { success: true };
  }

  async processAudioChunk(audioData: any, tabId: number) {
    try {
      const settings = await chrome.storage.sync.get(['apiKey', 'sourceLanguage']);
      
      if (!settings.apiKey) {
        throw new Error('API key not configured');
      }

      // Convert audio data to appropriate format for speech recognition
      const transcript = await this.speechToText(audioData, settings);
      
      if (transcript && transcript.trim()) {
        // Send transcript to content script for display
        await chrome.tabs.sendMessage(tabId, {
          type: 'DISPLAY_SUBTITLE',
          text: transcript,
          language: settings.sourceLanguage
        });

        return { success: true, transcript };
      }
      
      return { success: true, transcript: null };
    } catch (error) {
      console.error('Error processing audio:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  async speechToText(audioData: any, settings: any) {
    // Placeholder for speech recognition API call
    // In production, this would call Google Speech-to-Text or similar
    try {
      const response = await fetch('https://your-backend-api.com/speech-to-text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          audio: audioData,
          language: settings.sourceLanguage
        })
      });

      const result = await response.json();
      return result.transcript;
    } catch (error) {
      console.error('Speech recognition failed:', error);
      return null;
    }
  }

  async translateText(text: string, targetLang: string) {
    try {
      const settings = await chrome.storage.sync.get(['apiKey']);
      
      if (!settings.apiKey) {
        throw new Error('API key not configured');
      }

      // Placeholder for translation API call
      const response = await fetch('https://your-backend-api.com/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          text: text,
          targetLanguage: targetLang
        })
      });

      const result = await response.json();
      return { success: true, translatedText: result.translation };
    } catch (error) {
      console.error('Translation failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  handleTabUpdate(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) {
    // Clean up if tab is navigating away
    if (changeInfo.status === 'loading' && this.activeStreams.has(tabId)) {
      this.stopAudioCapture(tabId);
    }
  }

  handleTabRemoved(tabId: number) {
    // Clean up stream when tab is closed
    if (this.activeStreams.has(tabId)) {
      this.stopAudioCapture(tabId);
    }
  }
}

// Initialize the service
const subtitleService = new SubtitleService();