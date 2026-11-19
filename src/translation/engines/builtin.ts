// Built-in engine: Chrome's on-device Translator API (free, nothing leaves the
// computer). The API only exists in pages, not in the service worker, so the
// translation runs in the offscreen document; `host` carries a line there.
import { APIError } from '../../types';
import { builtinLanguage } from '../fastProvider';

export interface BuiltinRequest {
  text: string;
  /** BCP 47 short code, or 'auto' (Chrome's language detector picks it). */
  source: string;
  target: string;
}

/** 'unavailable': this browser has no language packs (not Google Chrome); 'needs-download': the pack was never downloaded. */
export type BuiltinReply = { text: string; error?: undefined } | { text?: undefined; error: 'unavailable' | 'needs-download' | string };

export type BuiltinHost = (req: BuiltinRequest) => Promise<BuiltinReply>;

export class BuiltinEngine {
  readonly id = 'builtin' as const;

  constructor(private readonly host: BuiltinHost) {}

  async translateOne(text: string, sourceLang: string, targetLang: string): Promise<{ text: string }> {
    const reply = await this.host({ text, source: builtinLanguage(sourceLang), target: builtinLanguage(targetLang) });
    if (reply.text !== undefined) return { text: reply.text };
    if (reply.error === 'unavailable') {
      // 401 like a missing key: the existing "no translation set up" warnings apply.
      throw new APIError('Free translation needs Google Chrome. In this browser, add a DeepL or Google key, or subscribe, in Settings.', 401);
    }
    if (reply.error === 'needs-download') {
      throw new APIError('The free translator needs this language downloaded once: open Settings > Troubleshooting > Setup and tips.', 428);
    }
    throw new APIError(`Built-in translator: ${reply.error}`, 500);
  }
}
