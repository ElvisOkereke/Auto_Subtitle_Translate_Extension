import { builtinLanguage, chooseFastProvider } from '../fastProvider';
import { BuiltinEngine } from '../engines/builtin';
import { APIError } from '../../types';

describe('chooseFastProvider (which fast engine translates)', () => {
  const keys = { deeplApiKey: '', googleTranslateApiKey: '', accountToken: '' };

  it('uses the chosen provider when it has a key', () => {
    expect(chooseFastProvider('deepl', { ...keys, deeplApiKey: 'k:fx' }, null)).toBe('deepl');
    expect(chooseFastProvider('google', { ...keys, googleTranslateApiKey: 'g' }, null)).toBe('google');
    expect(chooseFastProvider('subscription', { ...keys, accountToken: 't' }, 'https://api.example.com')).toBe('subscription');
  });

  it('the built-in translator when chosen, or when the chosen provider has no key', () => {
    expect(chooseFastProvider('builtin', { ...keys, deeplApiKey: 'k:fx' }, null)).toBe('builtin');
    expect(chooseFastProvider('deepl', keys, null)).toBe('builtin');
    expect(chooseFastProvider('google', keys, null)).toBe('builtin');
    expect(chooseFastProvider('subscription', keys, 'https://api.example.com')).toBe('builtin'); // signed out
    expect(chooseFastProvider('subscription', { ...keys, accountToken: 't' }, null)).toBe('builtin'); // no hosted service in this build
  });
});

describe('builtinLanguage (our language codes in Chrome built-in translator terms)', () => {
  it('maps script variants and keeps plain codes', () => {
    expect(builtinLanguage('zh-Hans')).toBe('zh');
    expect(builtinLanguage('zh-Hant')).toBe('zh-Hant');
    expect(builtinLanguage('zh')).toBe('zh');
    expect(builtinLanguage('ko')).toBe('ko');
    expect(builtinLanguage('pt-BR')).toBe('pt');
    expect(builtinLanguage('auto')).toBe('auto');
  });
});

describe('BuiltinEngine (translates through the offscreen host)', () => {
  it('sends the line with mapped languages and returns the translation', async () => {
    const host = jest.fn(async () => ({ text: 'Our team comp is weak to Poppy' }));
    const result = await new BuiltinEngine(host).translateOne('조합이 뽀삐한테 취약', 'ko', 'en');
    expect(host).toHaveBeenCalledWith({ text: '조합이 뽀삐한테 취약', source: 'ko', target: 'en' });
    expect(result.text).toBe('Our team comp is weak to Poppy');
  });

  it('this browser has no built-in translator: a 401 like a missing key, saying what to do', async () => {
    const engine = new BuiltinEngine(async () => ({ error: 'unavailable' as const }));
    const error = await engine.translateOne('안녕', 'ko', 'en').catch(e => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(401);
    expect(error.message).toMatch(/Google Chrome/);
  });

  it('a language pack that was never downloaded: points to the setup page', async () => {
    const engine = new BuiltinEngine(async () => ({ error: 'needs-download' as const }));
    const error = await engine.translateOne('안녕', 'ko', 'en').catch(e => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(428);
    expect(error.message).toMatch(/Setup and tips/);
  });
});
