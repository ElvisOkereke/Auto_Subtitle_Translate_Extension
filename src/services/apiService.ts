// apiService.ts - single-line translation with the configured fast engine
// (DeepL or Google). Used by Screen Translate and as the fast tier; the HTTP
// details live in src/translation/engines/.
import { DEFAULT_SERVER_URL, getSecrets } from '../settings';
import { ProxyClient, proxyFast } from '../translation/engines/proxy';
import { DeepLEngine } from '../translation/engines/deepl';
import { GoogleEngine } from '../translation/engines/google';

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
}

export interface TranslateOptions {
  /** Neighbouring subtitle lines; DeepL receives them as `context` (not translated, not billed). */
  previousLines?: string[];
  nextLines?: string[];
}

export type EndpointOverrides = Partial<Record<'google' | 'deepl' | 'anthropic' | 'server', string>>;

/**
 * Dev/test hook: `chrome.storage.local.devEndpointOverrides` can point the
 * providers at a local mock server. Only loopback http URLs are honoured, so
 * this can never redirect API keys to a remote host.
 */
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

export async function getEndpointOverrides(): Promise<EndpointOverrides> {
  try {
    const { devEndpointOverrides } = (await chrome.storage.local?.get('devEndpointOverrides')) ?? {};
    const result: EndpointOverrides = {};
    for (const key of ['google', 'deepl', 'anthropic', 'server'] as const) {
      const url = devEndpointOverrides?.[key];
      if (typeof url === 'string' && LOOPBACK_URL.test(url)) result[key] = url;
    }
    return result;
  } catch {
    return {};
  }
}

/** The configured fast engine with keys and dev endpoint overrides applied. */
type FastEngine = Pick<DeepLEngine, 'translateOne'>;

export async function fastEngine(): Promise<FastEngine> {
  const [settings, secrets, overrides] = await Promise.all([
    chrome.storage.sync.get(['translationProvider']),
    getSecrets(),
    getEndpointOverrides(),
  ]);
  if (settings.translationProvider === 'subscription') {
    return proxyFast(new ProxyClient({ baseURL: overrides.server ?? DEFAULT_SERVER_URL, token: secrets.accountToken }));
  }
  return settings.translationProvider === 'deepl'
    ? new DeepLEngine({ apiKey: secrets.deeplApiKey, endpoint: overrides.deepl })
    : new GoogleEngine({ apiKey: secrets.googleTranslateApiKey, endpoint: overrides.google });
}

export class ApiService {
  async translateText(text: string, sourceLanguage: string, targetLanguage: string, options: TranslateOptions = {}): Promise<TranslationResult> {
    const engine = await fastEngine();
    const result = await engine.translateOne(text, sourceLanguage, targetLanguage, options);
    return { translatedText: result.text, detectedSourceLanguage: result.detectedSourceLanguage };
  }
}

export const apiService = new ApiService();
