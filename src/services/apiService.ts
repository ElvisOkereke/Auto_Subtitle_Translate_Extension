// apiService.ts - Client for the Google Cloud Translation API and the DeepL API
import { APIError } from '../types';

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const DEEPL_FREE_ENDPOINT = 'https://api-free.deepl.com/v2/translate';
const DEEPL_PRO_ENDPOINT = 'https://api.deepl.com/v2/translate';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
}

// DeepL requires a regional variant for some target languages that Google
// treats as a single generic code.
const DEEPL_TARGET_OVERRIDES: Record<string, string> = {
  en: 'EN-US',
  pt: 'PT-PT'
};

function toDeepLTarget(code: string): string {
  return DEEPL_TARGET_OVERRIDES[code.toLowerCase()] || code.toUpperCase();
}

function toDeepLSource(code: string): string {
  return code.toUpperCase();
}

interface TranslationSettings {
  translationProvider: 'google' | 'deepl';
  googleTranslateApiKey: string;
  deeplApiKey: string;
  endpoints: { google: string; deeplFree: string; deeplPro: string };
}

/**
 * Dev/test hook: `chrome.storage.local.devEndpointOverrides` can point the
 * providers at a local mock server. Only loopback http URLs are honoured, so
 * this can never redirect API keys to a remote host.
 */
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

async function getEndpointOverrides(): Promise<Partial<Record<'google' | 'deepl', string>>> {
  try {
    const { devEndpointOverrides } = (await chrome.storage.local?.get('devEndpointOverrides')) ?? {};
    const result: Partial<Record<'google' | 'deepl', string>> = {};
    for (const key of ['google', 'deepl'] as const) {
      const url = devEndpointOverrides?.[key];
      if (typeof url === 'string' && LOOPBACK_URL.test(url)) result[key] = url;
    }
    return result;
  } catch {
    return {};
  }
}

// Client errors (bad key, quota, bad request) won't succeed on retry; only
// network failures, timeouts, rate limits and server errors are retried.
function isRetryable(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status === undefined) return true;
  const status = error.status;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export class ApiService {
  private async getSettings(): Promise<TranslationSettings> {
    const [settings, overrides] = await Promise.all([
      chrome.storage.sync.get(['translationProvider', 'googleTranslateApiKey', 'deeplApiKey']),
      getEndpointOverrides()
    ]);
    return {
      translationProvider: settings.translationProvider === 'deepl' ? 'deepl' : 'google',
      googleTranslateApiKey: settings.googleTranslateApiKey || '',
      deeplApiKey: settings.deeplApiKey || '',
      endpoints: {
        google: overrides.google ?? GOOGLE_TRANSLATE_ENDPOINT,
        deeplFree: overrides.deepl ?? DEEPL_FREE_ENDPOINT,
        deeplPro: overrides.deepl ?? DEEPL_PRO_ENDPOINT
      }
    };
  }

  async translateText(
    text: string,
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResult> {
    const settings = await this.getSettings();

    if (settings.translationProvider === 'deepl') {
      if (!settings.deeplApiKey) {
        throw new APIError('No DeepL API key configured', 401);
      }
      return this.retryRequest(() =>
        this.executeDeepLTranslate(settings, text, sourceLanguage, targetLanguage)
      );
    }

    if (!settings.googleTranslateApiKey) {
      throw new APIError('No Google Translate API key configured', 401);
    }
    const body: Record<string, string> = { q: text, target: targetLanguage, format: 'text' };
    if (sourceLanguage && sourceLanguage !== 'auto') {
      body.source = sourceLanguage;
    }
    return this.retryRequest(() => this.executeGoogleTranslate(settings, body));
  }

  private async executeGoogleTranslate(
    settings: TranslationSettings,
    body: Record<string, string>
  ): Promise<TranslationResult> {
    const apiKey = settings.googleTranslateApiKey;
    return this.withTimeout(async signal => {
      const response = await fetch(`${settings.endpoints.google}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new APIError(`Translation request failed: ${response.status}`, response.status, errorText);
      }

      const json = await response.json();
      const translation = json?.data?.translations?.[0];
      if (!translation) {
        throw new APIError('Malformed translation response', 500, json);
      }

      return {
        translatedText: translation.translatedText,
        detectedSourceLanguage: translation.detectedSourceLanguage
      };
    });
  }

  private async executeDeepLTranslate(
    settings: TranslationSettings,
    text: string,
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResult> {
    const apiKey = settings.deeplApiKey;
    const endpoint = apiKey.endsWith(':fx') ? settings.endpoints.deeplFree : settings.endpoints.deeplPro;
    const body: Record<string, unknown> = { text: [text], target_lang: toDeepLTarget(targetLanguage) };
    if (sourceLanguage && sourceLanguage !== 'auto') {
      body.source_lang = toDeepLSource(sourceLanguage);
    }

    return this.withTimeout(async signal => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `DeepL-Auth-Key ${apiKey}`
        },
        body: JSON.stringify(body),
        signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new APIError(`Translation request failed: ${response.status}`, response.status, errorText);
      }

      const json = await response.json();
      const translation = json?.translations?.[0];
      if (!translation) {
        throw new APIError('Malformed translation response', 500, json);
      }

      return {
        translatedText: translation.text,
        detectedSourceLanguage: translation.detected_source_language?.toLowerCase()
      };
    });
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fn(controller.signal);
    } catch (error) {
      if (error instanceof APIError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new APIError('Translation request timeout', 408);
      }
      throw new APIError('Network error', 0, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async retryRequest<T>(requestFn: () => Promise<T>, maxRetries = MAX_RETRIES): Promise<T> {
    let lastError!: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error as Error;
        if (attempt === maxRetries || !isRetryable(error)) break;
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}

export const apiService = new ApiService();
