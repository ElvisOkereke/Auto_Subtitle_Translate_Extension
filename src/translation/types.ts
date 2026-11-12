// Translation engine layer: shared types. Everything in src/translation/ except
// translationService.ts is free of chrome.* and DOM APIs so it can also run in
// Node (benchmarks) and, in piece 4, on the hosted proxy.

export type ClaudeModel = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';

/** What the video is about, read from the page (title, uploader, description). */
export interface VideoContext {
  videoId: string | null;
  url: string;
  title: string;
  channel: string;
  description: string;
}

export interface GlossaryEntry {
  source: string;
  target: string;
  note?: string;
}

export interface LineRequest {
  id: string;
  text: string;
  previous: string[];
  next: string[];
}

export interface TranslateBatchRequest {
  sourceLang: string;
  targetLang: string;
  lines: LineRequest[];
  video: VideoContext;
  topic: string | null;
  glossary: GlossaryEntry[];
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TranslateBatchResult {
  translations: { id: string; text: string }[];
  glossaryUpdates: GlossaryEntry[];
  usage?: Usage;
}

export interface TopicResult {
  topic: string;
  topicKey: string;
  glossary: GlossaryEntry[];
  usage?: Usage;
}

export interface TranslationEngine {
  readonly id: 'deepl' | 'google' | 'claude';
  translateBatch(req: TranslateBatchRequest): Promise<TranslateBatchResult>;
}
