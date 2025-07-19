// config.ts - Environment configuration for API endpoints
export interface ApiConfig {
  whisperServiceUrl: string;
  healthCheckUrl: string;
  maxRetries: number;
  requestTimeout: number;
}

// Global configuration that can be set during build time
declare global {
  const WHISPER_SERVICE_URL: string | undefined;
}

// Default configuration
const DEFAULT_CONFIG = {
  whisperServiceUrl: 'http://localhost:8001',
  maxRetries: 3,
  requestTimeout: 15000
};

export const getApiConfig = async (): Promise<ApiConfig> => {
  // Priority order: user settings > build-time config > default
  let baseUrl = DEFAULT_CONFIG.whisperServiceUrl;
  
  // Check if build-time environment variable is available
  if (typeof WHISPER_SERVICE_URL !== 'undefined' && WHISPER_SERVICE_URL) {
    baseUrl = WHISPER_SERVICE_URL;
  }
  
  // User settings from storage take highest priority
  try {
    const settings = await chrome.storage.sync.get(['whisperServiceUrl']);
    if (settings.whisperServiceUrl) {
      baseUrl = settings.whisperServiceUrl;
    }
  } catch (error) {
    console.warn('Failed to get whisper service URL from storage, using default:', error);
  }
  
  return {
    whisperServiceUrl: baseUrl,
    healthCheckUrl: `${baseUrl}/health`,
    maxRetries: DEFAULT_CONFIG.maxRetries,
    requestTimeout: DEFAULT_CONFIG.requestTimeout
  };
};

// Synchronous version for cases where we can't use async
export const getApiConfigSync = (): ApiConfig => {
  let baseUrl = DEFAULT_CONFIG.whisperServiceUrl;
  
  // Check if build-time environment variable is available
  if (typeof WHISPER_SERVICE_URL !== 'undefined' && WHISPER_SERVICE_URL) {
    baseUrl = WHISPER_SERVICE_URL;
  }
  
  return {
    whisperServiceUrl: baseUrl,
    healthCheckUrl: `${baseUrl}/health`,
    maxRetries: DEFAULT_CONFIG.maxRetries,
    requestTimeout: DEFAULT_CONFIG.requestTimeout
  };
};

export const API_ENDPOINTS = {
  TRANSCRIBE: '/transcribe',
  TRANSLATE: '/translate',
  TRANSLATE_AUDIO_TO_LANGUAGE: '/translate_audio_to_language',
  TRANSLATE_TEXT: '/translate_text',
  DETECT_LANGUAGE: '/detect_language',
  HEALTH: '/health',
  LANGUAGES: '/languages'
};

export const AUDIO_CONFIG = {
  CHUNK_SIZE: 1024 * 4, // 4KB chunks for real-time processing
  SAMPLE_RATE: 16000, // 16kHz
  CHANNELS: 1, // Mono
  BITS_PER_SAMPLE: 16,
  PROCESSING_INTERVAL: 500, // Process every 0.5 seconds for real-time
  MAX_AUDIO_LENGTH: 3, // Maximum 3 seconds per chunk for real-time
  BUFFER_SIZE: 4096,
  MIN_AUDIO_DURATION: 0.5, // Minimum 0.5 seconds before processing
  SILENCE_THRESHOLD: 0.01 // Silence detection threshold
};
