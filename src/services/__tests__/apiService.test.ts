import { ApiService } from '../apiService';
import { APIError } from '../../types';

describe('ApiService.translateText', () => {
  let apiService: ApiService;

  beforeEach(() => {
    apiService = new ApiService();
    (globalThis as any).chrome = {
      storage: {
        sync: {
          get: jest.fn().mockResolvedValue({ googleTranslateApiKey: 'test-key' })
        }
      }
    };
    (globalThis as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('returns the translated text on a successful request', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { translations: [{ translatedText: 'Hola', detectedSourceLanguage: 'en' }] }
      })
    });

    const result = await apiService.translateText('Hello', 'en', 'es');

    expect(result).toEqual({ translatedText: 'Hola', detectedSourceLanguage: 'en' });
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('translation.googleapis.com');
    expect(url).toContain('key=test-key');
    expect(JSON.parse(init.body)).toEqual({ q: 'Hello', target: 'es', format: 'text', source: 'en' });
  });

  it('omits the source field when sourceLanguage is "auto"', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { translations: [{ translatedText: 'Hola' }] } })
    });

    await apiService.translateText('Hello', 'auto', 'es');

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ q: 'Hello', target: 'es', format: 'text' });
  });

  it('retries on failure with exponential backoff, then succeeds', async () => {
    jest.useFakeTimers();
    const fetchMock = globalThis.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { translations: [{ translatedText: 'Hola' }] } })
      });

    const resultPromise = apiService.translateText('Hello', 'en', 'es');
    await jest.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.translatedText).toBe('Hola');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws an APIError after exhausting retries', async () => {
    jest.useFakeTimers();
    const fetchMock = globalThis.fetch as jest.Mock;
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });

    const resultPromise = apiService.translateText('Hello', 'en', 'es');
    resultPromise.catch(() => {});
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(4000);

    await expect(resultPromise).rejects.toThrow(APIError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
  });

  it('throws an APIError without calling fetch when no API key is configured', async () => {
    (globalThis as any).chrome.storage.sync.get = jest.fn().mockResolvedValue({});

    await expect(apiService.translateText('Hello', 'en', 'es')).rejects.toThrow(APIError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('ApiService.translateText via DeepL', () => {
  let apiService: ApiService;

  function mockStorage(overrides: Record<string, unknown>) {
    (globalThis as any).chrome = {
      storage: {
        sync: {
          get: jest.fn().mockResolvedValue({ translationProvider: 'deepl', ...overrides })
        }
      }
    };
  }

  beforeEach(() => {
    apiService = new ApiService();
    (globalThis as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('uses the free-tier endpoint and DeepL auth header for a key ending in :fx', async () => {
    mockStorage({ deeplApiKey: 'abc123:fx' });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ translations: [{ text: 'Hola', detected_source_language: 'EN' }] })
    });

    const result = await apiService.translateText('Hello', 'en', 'es');

    expect(result).toEqual({ translatedText: 'Hola', detectedSourceLanguage: 'en' });
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api-free.deepl.com/v2/translate');
    expect(init.headers.Authorization).toBe('DeepL-Auth-Key abc123:fx');
    expect(JSON.parse(init.body)).toEqual({ text: ['Hello'], target_lang: 'ES', source_lang: 'EN' });
  });

  it('uses the pro-tier endpoint for a key without the :fx suffix', async () => {
    mockStorage({ deeplApiKey: 'abc123' });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ translations: [{ text: 'Hola' }] })
    });

    await apiService.translateText('Hello', 'en', 'es');

    const [url] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.deepl.com/v2/translate');
  });

  it('maps en/pt target languages to their DeepL regional variants', async () => {
    mockStorage({ deeplApiKey: 'abc123:fx' });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ translations: [{ text: 'Hi' }] })
    });

    await apiService.translateText('Ola', 'pt', 'en');

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ text: ['Ola'], target_lang: 'EN-US', source_lang: 'PT' });
  });

  it('omits source_lang when sourceLanguage is "auto"', async () => {
    mockStorage({ deeplApiKey: 'abc123:fx' });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ translations: [{ text: 'Hola' }] })
    });

    await apiService.translateText('Hello', 'auto', 'es');

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ text: ['Hello'], target_lang: 'ES' });
  });

  it('retries on failure with exponential backoff, then succeeds', async () => {
    jest.useFakeTimers();
    mockStorage({ deeplApiKey: 'abc123:fx' });
    const fetchMock = globalThis.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ translations: [{ text: 'Hola' }] }) });

    const resultPromise = apiService.translateText('Hello', 'en', 'es');
    await jest.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.translatedText).toBe('Hola');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws an APIError without calling fetch when no DeepL API key is configured', async () => {
    mockStorage({ deeplApiKey: '' });

    await expect(apiService.translateText('Hello', 'en', 'es')).rejects.toThrow(APIError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
