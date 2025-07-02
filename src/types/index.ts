// Extension message types
export interface ExtensionMessage {
  type: MessageType;
  [key: string]: any;
}

export type MessageType = 
  | 'START_CAPTURE'
  | 'STOP_CAPTURE'
  | 'PROCESS_AUDIO'
  | 'GET_SETTINGS'
  | 'UPDATE_SETTINGS'
  | 'TRANSLATE_TEXT'
  | 'TOGGLE_SUBTITLES'
  | 'CAPTURE_STARTED'
  | 'CAPTURE_STOPPED'
  | 'DISPLAY_SUBTITLE'
  | 'UPDATE_STYLE';

export interface StartCaptureMessage extends ExtensionMessage {
  type: 'START_CAPTURE';
}

export interface StopCaptureMessage extends ExtensionMessage {
  type: 'STOP_CAPTURE';
}

export interface ProcessAudioMessage extends ExtensionMessage {
  type: 'PROCESS_AUDIO';
  audioData: ArrayBuffer | string;
}

export interface GetSettingsMessage extends ExtensionMessage {
  type: 'GET_SETTINGS';
}

export interface UpdateSettingsMessage extends ExtensionMessage {
  type: 'UPDATE_SETTINGS';
  settings: ExtensionSettings;
}

export interface TranslateTextMessage extends ExtensionMessage {
  type: 'TRANSLATE_TEXT';
  text: string;
  targetLang: string;
}

export interface ToggleSubtitlesMessage extends ExtensionMessage {
  type: 'TOGGLE_SUBTITLES';
}

export interface CaptureStartedMessage extends ExtensionMessage {
  type: 'CAPTURE_STARTED';
  streamId: string;
}

export interface CaptureStoppedMessage extends ExtensionMessage {
  type: 'CAPTURE_STOPPED';
}

export interface DisplaySubtitleMessage extends ExtensionMessage {
  type: 'DISPLAY_SUBTITLE';
  text: string;
  language: string;
}

export interface UpdateStyleMessage extends ExtensionMessage {
  type: 'UPDATE_STYLE';
  style: SubtitleStyle;
}

// Settings types
export interface ExtensionSettings {
  sourceLanguage: string;
  targetLanguage: string;
  apiKey: string;
  subtitleStyle: SubtitlePosition;
  fontSize: FontSize;
  enabled: boolean;
}

export type SubtitlePosition = 'top' | 'center' | 'bottom';
export type FontSize = 'small' | 'medium' | 'large' | 'x-large';

export interface SubtitleStyle {
  position?: SubtitlePosition;
  fontSize?: FontSize;
  [key: string]: any;
}

// API response types
export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SpeechToTextResponse {
  transcript: string;
  confidence?: number;
  language?: string;
}

export interface TranslationResponse {
  translatedText: string;
  sourceLanguage?: string;
  targetLanguage: string;
  confidence?: number;
}

export interface CaptureResponse {
  success: boolean;
  streamId?: string;
  error?: string;
}

// Audio processing types
export interface AudioChunk {
  data: ArrayBuffer;
  timestamp: number;
  sampleRate: number;
}

export interface SubtitleEntry {
  id: string;
  text: string;
  translatedText?: string;
  timestamp: number;
  duration: number;
  language: string;
}

// DOM element types
export interface SubtitleElement extends HTMLDivElement {
  subtitleId?: string;
}

// Chrome extension types augmentation
declare global {
  namespace chrome.runtime {
    interface ExtensionMessageEvent {
      message: ExtensionMessage;
      sender: chrome.runtime.MessageSender;
      sendResponse: (response?: any) => void;
    }
  }
}

// Error types
export class ExtensionError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'ExtensionError';
  }
}

export class APIError extends ExtensionError {
  constructor(message: string, public status?: number, details?: any) {
    super(message, 'API_ERROR', details);
    this.name = 'APIError';
  }
}

export class AudioCaptureError extends ExtensionError {
  constructor(message: string, details?: any) {
    super(message, 'AUDIO_CAPTURE_ERROR', details);
    this.name = 'AudioCaptureError';
  }
}

// Utility types
export type PromiseResolver<T> = (value: T | PromiseLike<T>) => void;
export type PromiseRejecter = (reason?: any) => void;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: PromiseResolver<T>;
  reject: PromiseRejecter;
}

// Language codes
export type LanguageCode = 
  | 'auto'
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'it'
  | 'pt'
  | 'ja'
  | 'ko'
  | 'zh'
  | 'ar'
  | 'hi'
  | 'ru';

export interface LanguageOption {
  code: LanguageCode;
  name: string;
  nativeName?: string;
}
