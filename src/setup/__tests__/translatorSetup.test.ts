import { startTranslatorDownloads, translatorPlan, translatorStatus } from '../translatorSetup';

function fake(states: Record<string, string> = {}, detector = 'downloadable') {
  const created: string[] = [];
  const g = {
    Translator: {
      availability: jest.fn(async ({ sourceLanguage, targetLanguage }: any) => states[`${sourceLanguage}>${targetLanguage}`] ?? 'downloadable'),
      create: jest.fn(async ({ sourceLanguage, targetLanguage, monitor }: any) => {
        const listeners: ((e: { loaded: number }) => void)[] = [];
        monitor?.({ addEventListener: (_: string, fn: (e: { loaded: number }) => void) => listeners.push(fn) });
        listeners.forEach(fn => fn({ loaded: 1 }));
        created.push(`${sourceLanguage}>${targetLanguage}`);
        return {};
      }),
    },
    LanguageDetector: {
      availability: jest.fn(async () => detector),
      create: jest.fn(async () => {
        created.push('detector');
        return {};
      }),
    },
  };
  return { g: g as any, created };
}

describe('translatorPlan (which language packs the free translator needs)', () => {
  it('the subtitle language and the spoken language into the target language', () => {
    expect(translatorPlan('ko', 'ja', 'en')).toEqual({ pairs: [{ source: 'ko', target: 'en' }, { source: 'ja', target: 'en' }], detector: false });
  });
  it('"Detect automatically" adds the language detector; same languages are not doubled; nothing into itself', () => {
    expect(translatorPlan('ko', 'auto', 'en')).toEqual({ pairs: [{ source: 'ko', target: 'en' }], detector: true });
    expect(translatorPlan('ko', 'ko', 'en').pairs).toHaveLength(1);
    expect(translatorPlan('zh-Hans', 'en', 'en')).toEqual({ pairs: [{ source: 'zh', target: 'en' }], detector: false });
  });
});

describe('translatorStatus', () => {
  const plan = translatorPlan('ko', 'auto', 'en');

  it('a browser without the built-in translator, or without its language packs (Opera GX)', async () => {
    expect(await translatorStatus({} as any, plan)).toBe('unsupported');
    expect(await translatorStatus(fake({ 'ko>en': 'unavailable' }).g, plan)).toBe('unsupported');
  });

  it('what is left to download, or ready', async () => {
    expect(await translatorStatus(fake().g, plan)).toEqual({ pairs: [{ source: 'ko', target: 'en' }], detector: true });
    expect(await translatorStatus(fake({ 'ko>en': 'available' }, 'available').g, plan)).toBe('ready');
  });
});

describe('startTranslatorDownloads', () => {
  it('starts every download at once (a click only counts for a moment) and reports progress', async () => {
    const { g, created } = fake();
    const progress: number[] = [];
    const job = startTranslatorDownloads(g, { pairs: [{ source: 'ko', target: 'en' }, { source: 'ja', target: 'en' }], detector: true }, p => progress.push(p));
    // Every create() was called synchronously, before the first await.
    expect(g.Translator.create).toHaveBeenCalledTimes(2);
    expect(g.LanguageDetector.create).toHaveBeenCalledTimes(1);
    await job;
    expect(created.sort()).toEqual(['detector', 'ja>en', 'ko>en']);
    expect(progress[progress.length - 1]).toBe(100);
  });
});
