// builtinHost.ts - runs Chrome's built-in Translator in an extension page (the
// offscreen document): the API isn't available in the service worker. One
// translator per language pair; "Detect automatically" uses the built-in
// Language Detector. Packs are never downloaded here: a download needs a click,
// which only the setup page has, so a missing pack is reported instead.
import type { BuiltinHost, BuiltinReply } from './engines/builtin';

interface ChromeAi {
  Translator?: {
    availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
    create(o: { sourceLanguage: string; targetLanguage: string }): Promise<{ translate(text: string): Promise<string> }>;
  };
  LanguageDetector?: {
    availability(): Promise<string>;
    create(): Promise<{ detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]> }>;
  };
}

export function createBuiltinHost(g: ChromeAi = globalThis as unknown as ChromeAi, opts: { stub?: boolean } = {}): BuiltinHost {
  const translators = new Map<string, Promise<{ translate(text: string): Promise<string> }>>();
  let detector: ReturnType<NonNullable<ChromeAi['LanguageDetector']>['create']> | null = null;

  const detect = async (text: string): Promise<string | BuiltinReply> => {
    if (!g.LanguageDetector) return { error: 'unavailable' };
    if (!detector) {
      const availability = await g.LanguageDetector.availability();
      if (availability === 'unavailable') return { error: 'unavailable' };
      if (availability !== 'available') return { error: 'needs-download' };
      detector = g.LanguageDetector.create();
    }
    const [best] = await (await detector).detect(text);
    return best?.detectedLanguage ?? 'und';
  };

  return async ({ text, source, target }) => {
    if (opts.stub) return { text: `[built-in] ${text}` };
    if (!g.Translator) return { error: 'unavailable' };
    try {
      let from = source;
      if (from === 'auto') {
        const found = await detect(text);
        if (typeof found !== 'string') return found;
        from = found;
      }
      if (from === 'und' || from.split('-')[0] === target.split('-')[0]) return { text };
      const pair = `${from}>${target}`;
      let translator = translators.get(pair);
      if (!translator) {
        const availability = await g.Translator.availability({ sourceLanguage: from, targetLanguage: target });
        if (availability === 'unavailable') return { error: 'unavailable' };
        if (availability !== 'available') return { error: 'needs-download' };
        translator = g.Translator.create({ sourceLanguage: from, targetLanguage: target });
        translators.set(pair, translator);
        translator.catch(() => translators.delete(pair));
      }
      return { text: await (await translator).translate(text) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}
