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
}

export class ApiService {
  private async getSettings(): Promise<TranslationSettings> {
    const settings = await chrome.storage.sync.get([
      'translationProvider',
      'googleTranslateApiKey',
      'deeplApiKey'
    ]);
    return {
      translationProvider: settings.translationProvider === 'deepl' ? 'deepl' : 'google',
      googleTranslateApiKey: settings.googleTranslateApiKey || '',
      deeplApiKey: settings.deeplApiKey || ''
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
        this.executeDeepLTranslate(settings.deeplApiKey, text, sourceLanguage, targetLanguage)
      );
    }

    if (!settings.googleTranslateApiKey) {
      throw new APIError('No Google Translate API key configured', 401);
    }
    const body: Record<string, string> = { q: text, target: targetLanguage, format: 'text' };
    if (sourceLanguage && sourceLanguage !== 'auto') {
      body.source = sourceLanguage;
    }
    return this.retryRequest(() => this.executeGoogleTranslate(settings.googleTranslateApiKey, body));
  }

  private async executeGoogleTranslate(
    apiKey: string,
    body: Record<string, string>
  ): Promise<TranslationResult> {
    return this.withTimeout(async signal => {
      const response = await fetch(`${GOOGLE_TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
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
    apiKey: string,
    text: string,
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResult> {
    const endpoint = apiKey.endsWith(':fx') ? DEEPL_FREE_ENDPOINT : DEEPL_PRO_ENDPOINT;
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
        if (attempt === maxRetries) break;
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}

export const apiService = new ApiService();
