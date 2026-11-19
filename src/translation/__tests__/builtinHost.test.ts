import { createBuiltinHost } from '../builtinHost';

function fakeChrome(opts: { packs?: Record<string, string>; detector?: string; detected?: string } = {}) {
  const created: string[] = [];
  const Translator = {
    availability: jest.fn(async ({ sourceLanguage, targetLanguage }: any) => opts.packs?.[`${sourceLanguage}>${targetLanguage}`] ?? 'downloadable'),
    create: jest.fn(async ({ sourceLanguage, targetLanguage }: any) => {
      created.push(`${sourceLanguage}>${targetLanguage}`);
      return { translate: async (t: string) => `${sourceLanguage}>${targetLanguage}: ${t}` };
    }),
  };
  const LanguageDetector = {
    availability: jest.fn(async () => opts.detector ?? 'available'),
    create: jest.fn(async () => ({ detect: async () => [{ detectedLanguage: opts.detected ?? 'ko', confidence: 0.98 }] })),
  };
  return { g: { Translator, LanguageDetector } as any, created, Translator };
}

describe('built-in translator host (offscreen document)', () => {
  it('translates with a downloaded pack, creating one translator per language pair', async () => {
    const { g, created } = fakeChrome({ packs: { 'ko>en': 'available' } });
    const host = createBuiltinHost(g);
    expect(await host({ text: '안녕', source: 'ko', target: 'en' })).toEqual({ text: 'ko>en: 안녕' });
    await host({ text: '하나 더', source: 'ko', target: 'en' });
    expect(created).toEqual(['ko>en']);
  });

  it('no pack downloaded yet: says so instead of trying (a download needs a click)', async () => {
    const { g, Translator } = fakeChrome();
    expect(await createBuiltinHost(g)({ text: '안녕', source: 'ko', target: 'en' })).toEqual({ error: 'needs-download' });
    expect(Translator.create).not.toHaveBeenCalled();
  });

  it('a browser with the API but no language packs (Opera GX, Edge, Brave)', async () => {
    const { g } = fakeChrome({ packs: { 'ko>en': 'unavailable' } });
    expect(await createBuiltinHost(g)({ text: '안녕', source: 'ko', target: 'en' })).toEqual({ error: 'unavailable' });
  });

  it('a browser without the API at all', async () => {
    expect(await createBuiltinHost({} as any)({ text: '안녕', source: 'ko', target: 'en' })).toEqual({ error: 'unavailable' });
  });

  it('"Detect automatically": the language detector picks the source language', async () => {
    const { g } = fakeChrome({ packs: { 'ja>en': 'available' }, detected: 'ja' });
    expect(await createBuiltinHost(g)({ text: 'こんにちは', source: 'auto', target: 'en' })).toEqual({ text: 'ja>en: こんにちは' });
  });

  it('detected language is already the target language: the text as it is', async () => {
    const { g } = fakeChrome({ detected: 'en' });
    expect(await createBuiltinHost(g)({ text: 'hello', source: 'auto', target: 'en' })).toEqual({ text: 'hello' });
  });

  it('detector never downloaded: needs the setup page too', async () => {
    const { g } = fakeChrome({ detector: 'downloadable' });
    expect(await createBuiltinHost(g)({ text: '안녕', source: 'auto', target: 'en' })).toEqual({ error: 'needs-download' });
  });

  it('test stub (dev flag): a recognisable fake translation', async () => {
    expect(await createBuiltinHost({} as any, { stub: true })({ text: '안녕', source: 'ko', target: 'en' })).toEqual({ text: '[built-in] 안녕' });
  });
});
