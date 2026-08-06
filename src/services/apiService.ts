// apiService.ts - Client for the Google Cloud Translation API
import { APIError } from '../types';

const TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
}

export class ApiService {
  private async getApiKey(): Promise<string> {
    const { googleTranslateApiKey } = await chrome.storage.sync.get(['googleTranslateApiKey']);
    if (!googleTranslateApiKey) {
      throw new APIError('No Google Translate API key configured', 401);
    }
    return googleTranslateApiKey;
  }

  async translateText(
    text: string,
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResult> {
    const apiKey = await this.getApiKey();
    const body: Record<string, string> = { q: text, target: targetLanguage, format: 'text' };
    if (sourceLanguage && sourceLanguage !== 'auto') {
      body.source = sourceLanguage;
    }

    return this.retryRequest(() => this.executeTranslate(apiKey, body));
  }

  private async executeTranslate(
    apiKey: string,
    body: Record<string, string>
  ): Promise<TranslationResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
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
