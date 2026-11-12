// DeepL engine: one request per line, neighbouring lines as DeepL `context`.
import { APIError } from '../../types';
import type { TranslateBatchRequest, TranslateBatchResult, TranslationEngine } from '../types';
import { callFetch, retryRequest, toDeepLSource, toDeepLTarget, withTimeout } from './http';

const DEEPL_FREE_ENDPOINT = 'https://api-free.deepl.com/v2/translate';
const DEEPL_PRO_ENDPOINT = 'https://api.deepl.com/v2/translate';

export interface SingleLineOptions {
  previousLines?: string[];
  nextLines?: string[];
}

export class DeepLEngine implements TranslationEngine {
  readonly id = 'deepl' as const;

  constructor(private readonly cfg: { apiKey: string; endpoint?: string; fetch?: typeof fetch }) {}

  async translateBatch(req: TranslateBatchRequest): Promise<TranslateBatchResult> {
    const translations = await Promise.all(
      req.lines.map(async l => ({
        id: l.id,
        text: (await this.translateOne(l.text, req.sourceLang, req.targetLang, { previousLines: l.previous, nextLines: l.next })).text,
      }))
    );
    return { translations, glossaryUpdates: [] };
  }

  async translateOne(text: string, sourceLang: string, targetLang: string, options: SingleLineOptions = {}): Promise<{ text: string; detectedSourceLanguage?: string }> {
    const apiKey = this.cfg.apiKey;
    if (!apiKey) throw new APIError('No DeepL API key configured', 401);
    const endpoint = this.cfg.endpoint ?? (apiKey.endsWith(':fx') ? DEEPL_FREE_ENDPOINT : DEEPL_PRO_ENDPOINT);
    const body: Record<string, unknown> = { text: [text], target_lang: toDeepLTarget(targetLang) };
    if (sourceLang && sourceLang !== 'auto') body.source_lang = toDeepLSource(sourceLang);
    const context = [...(options.previousLines ?? []), ...(options.nextLines ?? [])].join('\n');
    if (context) body.context = context;

    return retryRequest(() =>
      withTimeout(async signal => {
        const response = await callFetch(this.cfg.fetch, endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          throw new APIError(`Translation request failed: ${response.status}`, response.status, await response.text());
        }
        const json = await response.json();
        const translation = json?.translations?.[0];
        if (!translation) throw new APIError('Malformed translation response', 500, json);
        return { text: translation.text, detectedSourceLanguage: translation.detected_source_language?.toLowerCase() };
      })
    );
  }
}
