// apiService.ts - single-line translation with the configured fast engine
// (DeepL or Google). Used by Screen Translate and as the fast tier; the HTTP
// details live in src/translation/engines/.
import { getSecrets, hostedServiceUrl } from '../settings';
import { ProxyClient, proxyFast } from '../translation/engines/proxy';
import { DeepLEngine } from '../translation/engines/deepl';
import { GoogleEngine } from '../translation/engines/google';
import { BuiltinEngine, type BuiltinHost } from '../translation/engines/builtin';
import { chooseFastProvider } from '../translation/fastProvider';
import { APIError } from '../types';

/** How the built-in translator is reached (the background wires the offscreen document in). */
let builtinHost: BuiltinHost | null = null;
export function setBuiltinHost(host: BuiltinHost | null): void {
  builtinHost = host;
}

/** The free tier, or a 401 like a missing key when nothing can reach it. */
export function builtinEngine(): BuiltinEngine {
  return new BuiltinEngine(builtinHost ?? (async () => Promise.reject(new APIError('No translation is set up: add a DeepL or Google key in Settings.', 401))));
}

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
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

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
  const hosted = hostedServiceUrl(overrides.server);
  // No key for the chosen provider: Chrome's built-in translator (the free tier).
  const provider = chooseFastProvider(settings.translationProvider ?? 'google', secrets, hosted); // unset: the old default
  if (provider === 'subscription') return proxyFast(new ProxyClient({ baseURL: hosted!, token: secrets.accountToken }));
  if (provider === 'deepl') return new DeepLEngine({ apiKey: secrets.deeplApiKey, endpoint: overrides.deepl });
  if (provider === 'google') return new GoogleEngine({ apiKey: secrets.googleTranslateApiKey, endpoint: overrides.google });
  return builtinEngine();
}

export class ApiService {
  async translateText(text: string, sourceLanguage: string, targetLanguage: string, options: TranslateOptions = {}): Promise<TranslationResult> {
    const engine = await fastEngine();
    const result = await engine.translateOne(text, sourceLanguage, targetLanguage, options);
    return { translatedText: result.text, detectedSourceLanguage: result.detectedSourceLanguage };
  }
}

export const apiService = new ApiService();
