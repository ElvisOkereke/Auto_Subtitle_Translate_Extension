// Extension message types
export interface ExtensionMessage {
  type: MessageType;
  [key: string]: any;
}

export type MessageType = 
  | 'START_CAPTURE'
  | 'STOP_CAPTURE'
  | 'GET_SETTINGS'
  | 'UPDATE_SETTINGS'
  | 'TRANSLATE_TEXT'
  | 'TOGGLE_SUBTITLES'
  | 'CAPTURE_STARTED'
  | 'CAPTURE_STOPPED'
  | 'DISPLAY_SUBTITLE'
  | 'UPDATE_STYLE'
  | 'TOGGLE_SCREEN_TRANSLATION'
  | 'START_ROI_SELECTION'
  | 'END_ROI_SELECTION'
  | 'TRANSLATE_SELECTED_TEXT'
  | 'SHOW_TRANSLATION_OVERLAY'
  | 'START_OFFSCREEN_CAPTURE'
  | 'STOP_OFFSCREEN_CAPTURE'
  | 'TRANSCRIPTION_RESULT'
  | 'TRANSCRIPTION_ERROR'
  | 'MODEL_LOADING_PROGRESS'
  | 'CAPTION_ERROR'
  | 'CAPTION_STATUS';

export interface StartCaptureMessage extends ExtensionMessage {
  type: 'START_CAPTURE';
}

export interface StopCaptureMessage extends ExtensionMessage {
  type: 'STOP_CAPTURE';
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

export interface CaptionErrorMessage extends ExtensionMessage {
  type: 'CAPTION_ERROR';
  message: string;
}

export interface CaptionStatusMessage extends ExtensionMessage {
  type: 'CAPTION_STATUS';
  message: string;
}

export interface UpdateStyleMessage extends ExtensionMessage {
  type: 'UPDATE_STYLE';
  style: SubtitleStyle;
}

// Screen translation message types
export interface ToggleScreenTranslationMessage extends ExtensionMessage {
  type: 'TOGGLE_SCREEN_TRANSLATION';
}

export interface StartROISelectionMessage extends ExtensionMessage {
  type: 'START_ROI_SELECTION';
}

export interface EndROISelectionMessage extends ExtensionMessage {
  type: 'END_ROI_SELECTION';
  roi: ROIData;
}

export interface TranslateSelectedTextMessage extends ExtensionMessage {
  type: 'TRANSLATE_SELECTED_TEXT';
  text: string;
  rect: DOMRect;
}

export interface ShowTranslationOverlayMessage extends ExtensionMessage {
  type: 'SHOW_TRANSLATION_OVERLAY';
  originalText: string;
  translatedText: string;
  position: { x: number; y: number };
}

export interface StartOffscreenCaptureMessage extends ExtensionMessage {
  type: 'START_OFFSCREEN_CAPTURE';
  streamId: string;
  sourceLanguage: string;
}

export interface StopOffscreenCaptureMessage extends ExtensionMessage {
  type: 'STOP_OFFSCREEN_CAPTURE';
}

export interface TranscriptionResultMessage extends ExtensionMessage {
  type: 'TRANSCRIPTION_RESULT';
  text: string;
}

export interface TranscriptionErrorMessage extends ExtensionMessage {
  type: 'TRANSCRIPTION_ERROR';
  message: string;
}

export interface ModelLoadingProgressMessage extends ExtensionMessage {
  type: 'MODEL_LOADING_PROGRESS';
  status: 'downloading' | 'cpu-fallback' | 'ready';
}

// Settings types
export interface ExtensionSettings {
  sourceLanguage: string;
  targetLanguage: string;
  subtitleStyle: SubtitlePosition;
  fontSize: FontSize;
  enabled: boolean;
  googleTranslateApiKey: string;
  translationProvider: 'google' | 'deepl';
  deeplApiKey: string;
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

// Screen translation types
export interface ROIData {
  x: number;
  y: number;
  width: number;
  height: number;
  element?: Element;
}

export interface ScreenTranslationSettings {
  enabled: boolean;
  autoDetect: boolean;
  overlayStyle: 'tooltip' | 'inline' | 'sidebar';
  triggerMethod: 'hover' | 'click' | 'selection';
}
