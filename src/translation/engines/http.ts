// Shared HTTP helpers for the DeepL/Google engines: timeout, retry with
// exponential backoff, language-code mapping. No chrome.* (runs in Node too).
import { APIError } from '../../types';

export const REQUEST_TIMEOUT_MS = 15000;
export const MAX_RETRIES = 3;

// Client errors (bad key, quota, bad request) won't succeed on retry; only
// network failures, timeouts, rate limits and server errors are retried.
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status === undefined) return true;
  const status = error.status;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

export async function retryRequest<T>(requestFn: () => Promise<T>, maxRetries = MAX_RETRIES): Promise<T> {
  let lastError!: Error;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error as Error;
      if (attempt === maxRetries || !isRetryable(error)) break;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
  throw lastError;
}

// DeepL requires a regional variant for some target languages that Google
// treats as a single generic code.
const DEEPL_TARGET_OVERRIDES: Record<string, string> = { en: 'EN-US', pt: 'PT-PT' };
export const toDeepLTarget = (code: string) => DEEPL_TARGET_OVERRIDES[code.toLowerCase()] || code.toUpperCase();
// DeepL source languages have no script variants (zh-Hans/zh-Hant are target-only).
export const toDeepLSource = (code: string) => code.split('-')[0].toUpperCase();

// Subtitle languages use script-qualified Chinese codes; providers name them differently.
const GOOGLE_CODES: Record<string, string> = { 'zh-hans': 'zh-CN', 'zh-hant': 'zh-TW' };
export const toGoogleCode = (code: string) => GOOGLE_CODES[code.toLowerCase()] || code;

/** Call fetch without binding it to an object (Chrome throws "Illegal invocation" otherwise). */
export const callFetch = (f: typeof fetch | undefined, input: string, init: RequestInit) => (f ?? fetch)(input, init);

/** Maps with at most `limit` calls in flight, keeping the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Per-line engines translate batches with this many requests in flight. */
export const BATCH_CONCURRENCY = 4;
