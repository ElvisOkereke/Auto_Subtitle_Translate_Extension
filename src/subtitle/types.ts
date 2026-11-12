// Shared types for subtitle mode (burned-in subtitle OCR + translation).

export type SubtitleLanguage = 'ko' | 'ja' | 'zh-Hans' | 'zh-Hant' | 'es' | 'fr' | 'de' | 'pt' | 'ru';

/** A rectangle as fractions (0..1) of the video's rendered content rect. */
export interface NormalizedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrResult {
  text: string;
  confidence: number;
  ms: number;
  tier: 'fast' | 'accurate';
  /** Execution provider that produced the result ('webgpu' | 'wasm'). */
  device?: string;
}
