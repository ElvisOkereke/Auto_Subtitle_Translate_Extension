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
import { apiService, WhisperResponse } from './services/apiService';
import { AudioProcessor, AudioChunkBuffer } from './utils/audioProcessor';
import { AUDIO_CONFIG } from './config';

interface ActiveSession {
  stream: MediaStream;
  audioProcessor: AudioProcessor;
  audioBuffer: AudioChunkBuffer;
  isProcessing: boolean;
  lastProcessedTime: number;
}

class SubtitleService {
  private activeSessions: Map<number, ActiveSession>;
  private processingQueue: Map<number, Promise<void>>;

  constructor() {
    this.activeSessions = new Map();
    this.processingQueue = new Map();
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
    const defaultSettings = {
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      subtitleStyle: 'bottom',
      fontSize: 'medium',
      whisperServiceUrl: 'http://localhost:8001',
      enabled: false
    };
    
    // Check if settings exist, if not, set defaults
    const existingSettings = await chrome.storage.sync.get(Object.keys(defaultSettings));
    const settingsToSet = { ...defaultSettings, ...existingSettings };
    
    // Only set if there are missing keys
    const missingKeys = Object.keys(defaultSettings).filter(key => !(key in existingSettings));
    if (missingKeys.length > 0) {
      await chrome.storage.sync.set(settingsToSet);
    }
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
          const defaultSettings = {
            sourceLanguage: 'auto',
            targetLanguage: 'en',
            subtitleStyle: 'bottom',
            fontSize: 'medium',
            whisperServiceUrl: 'http://localhost:8001',
            enabled: false
          };
          return await chrome.storage.sync.get(defaultSettings);
        
        case 'UPDATE_SETTINGS':
          return await chrome.storage.sync.set(message.settings);
        
        case 'TRANSLATE_TEXT':
          return await this.translateText(message.text, message.targetLang);
        
        case 'TOGGLE_SCREEN_TRANSLATION':
          // Screen translation is handled entirely in content script
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

  private async startAudioCapture(tabId: number): Promise<CaptureResponse> {
    try {
      // Check if already capturing for this tab
      if (this.activeSessions.has(tabId)) {
        return { success: false, error: 'Already capturing audio for this tab' };
      }

      // Verify whisper-service is available
      try {
        await apiService.healthCheck();
      } catch (error) {
        return { success: false, error: 'Cannot connect to whisper-service. Please ensure it is running.' };
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

      // Create audio processing session
      const audioProcessor = new AudioProcessor();
      const audioBuffer = new AudioChunkBuffer(5); // Keep last 5 chunks
      
      const session: ActiveSession = {
        stream,
        audioProcessor,
        audioBuffer,
        isProcessing: false,
        lastProcessedTime: Date.now()
      };

      this.activeSessions.set(tabId, session);
      
      // Start real-time audio processing
      await this.startRealTimeProcessing(tabId, session);
      
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

  private async startRealTimeProcessing(tabId: number, session: ActiveSession): Promise<void> {
    try {
      await session.audioProcessor.startProcessing(session.stream, async (audioChunk: Blob) => {
        await this.handleAudioChunk(audioChunk, tabId, session);
      });
    } catch (error) {
      console.error('Failed to start real-time processing:', error);
      this.stopAudioCapture(tabId);
    }
  }

  private async handleAudioChunk(audioChunk: Blob, tabId: number, session: ActiveSession): Promise<void> {
    if (session.isProcessing) {
      return; // Skip if already processing
    }

    const now = Date.now();
    if (now - session.lastProcessedTime < AUDIO_CONFIG.PROCESSING_INTERVAL) {
      return; // Too soon since last processing
    }

    session.isProcessing = true;
    session.lastProcessedTime = now;

    try {
      // Add to buffer for potential future use
      session.audioBuffer.addChunk(audioChunk);

      // Check if audio contains speech
      const hasSpeech = await session.audioProcessor.detectSpeech(audioChunk);
      if (!hasSpeech) {
        return;
      }

      // Process audio chunk
      await this.processAudioChunkRealTime(audioChunk, tabId);
    } catch (error) {
      console.error('Error processing audio chunk:', error);
    } finally {
      session.isProcessing = false;
    }
  }

  private async processAudioChunkRealTime(audioChunk: Blob, tabId: number): Promise<void> {
    try {
      const settings = await chrome.storage.sync.get(['sourceLanguage', 'targetLanguage']);
      const sourceLanguage = settings.sourceLanguage || 'auto';
      const targetLanguage = settings.targetLanguage || 'en';

      let result: WhisperResponse;

      // Use appropriate API based on language settings
      if (sourceLanguage === targetLanguage || targetLanguage === 'auto') {
        // Just transcribe
        result = await apiService.transcribeAudio(audioChunk, sourceLanguage);
      } else {
        // Transcribe and translate
        result = await apiService.translateAudioToLanguage(audioChunk, targetLanguage, sourceLanguage);
      }

      if (result.text && result.text.trim()) {
        // Send to content script for display
        await chrome.tabs.sendMessage(tabId, {
          type: 'DISPLAY_SUBTITLE',
          text: result.text,
          language: result.detected_language || sourceLanguage
        });
      }
    } catch (error) {
      console.error('Real-time processing failed:', error);
      // Don't display error to user for real-time processing failures
    }
  }

  async stopAudioCapture(tabId: number) {
    const session = this.activeSessions.get(tabId);
    if (session) {
      // Stop audio processing
      session.audioProcessor.cleanup();
      
      // Stop media stream
      session.stream.getTracks().forEach(track => track.stop());
      
      // Clean up
      this.activeSessions.delete(tabId);
      
      // Cancel any ongoing processing
      if (this.processingQueue.has(tabId)) {
        this.processingQueue.delete(tabId);
      }
      
      // Notify content script
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'CAPTURE_STOPPED'
        });
      } catch (error) {
        // Tab might be closed, ignore error
      }
    }
    return { success: true };
  }

  async processAudioChunk(audioData: any, tabId: number) {
    try {
      const settings = await chrome.storage.sync.get(['sourceLanguage']);
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
      const settings = await chrome.storage.sync.get(['sourceLanguage']);
      const sourceLanguage = settings.sourceLanguage || 'auto';
      
      const result = await apiService.translateText(text, sourceLanguage, targetLang);
      return { success: true, translatedText: result.translated_text };
    } catch (error) {
      console.error('Translation failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  handleTabUpdate(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) {
    // Clean up if tab is navigating away
    if (changeInfo.status === 'loading' && this.activeSessions.has(tabId)) {
      this.stopAudioCapture(tabId);
    }
  }

  handleTabRemoved(tabId: number) {
    // Clean up stream when tab is closed
    if (this.activeSessions.has(tabId)) {
      this.stopAudioCapture(tabId);
    }
  }
}

// Initialize the service
const subtitleService = new SubtitleService();