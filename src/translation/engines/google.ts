// Google Cloud Translation engine (v2): one request per line (no context support).
import { APIError } from '../../types';
import type { TranslateBatchRequest, TranslateBatchResult, TranslationEngine } from '../types';
import { callFetch, retryRequest, toGoogleCode, withTimeout } from './http';

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

export class GoogleEngine implements TranslationEngine {
  readonly id = 'google' as const;

  constructor(private readonly cfg: { apiKey: string; endpoint?: string; fetch?: typeof fetch }) {}

  async translateBatch(req: TranslateBatchRequest): Promise<TranslateBatchResult> {
    const translations = await Promise.all(
      req.lines.map(async l => ({ id: l.id, text: (await this.translateOne(l.text, req.sourceLang, req.targetLang)).text }))
    );
    return { translations, glossaryUpdates: [] };
  }

  async translateOne(text: string, sourceLang: string, targetLang: string): Promise<{ text: string; detectedSourceLanguage?: string }> {
    const apiKey = this.cfg.apiKey;
    if (!apiKey) throw new APIError('No Google Translate API key configured', 401);
    const body: Record<string, string> = { q: text, target: toGoogleCode(targetLang), format: 'text' };
    if (sourceLang && sourceLang !== 'auto') body.source = toGoogleCode(sourceLang);
    const endpoint = this.cfg.endpoint ?? GOOGLE_TRANSLATE_ENDPOINT;

    return retryRequest(() =>
      withTimeout(async signal => {
        const response = await callFetch(this.cfg.fetch, `${endpoint}?key=${encodeURIComponent(apiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          throw new APIError(`Translation request failed: ${response.status}`, response.status, await response.text());
        }
        const json = await response.json();
        const translation = json?.data?.translations?.[0];
        if (!translation) throw new APIError('Malformed translation response', 500, json);
        return { text: translation.translatedText, detectedSourceLanguage: translation.detectedSourceLanguage };
      })
    );
  }
}
