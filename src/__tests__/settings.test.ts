import { getSecrets, getSettings, migrateSecretsFromSync, saveSettings, SECRET_KEYS, setSecrets } from '../settings';

/** In-memory chrome.storage.{sync,local}. */
function fakeArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys == null) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? data[k] : d]));
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, items);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

let sync: ReturnType<typeof fakeArea>;
let local: ReturnType<typeof fakeArea>;
beforeEach(() => {
  sync = fakeArea();
  local = fakeArea();
  (globalThis as any).chrome = { storage: { sync, local } };
});

describe('secrets live only in chrome.storage.local', () => {
  it('migrateSecretsFromSync moves keys from sync to local and deletes them from sync', async () => {
    sync.data.deeplApiKey = 'k:fx';
    sync.data.googleTranslateApiKey = 'g';
    sync.data.targetLanguage = 'en';
    await migrateSecretsFromSync();
    expect(local.data).toMatchObject({ deeplApiKey: 'k:fx', googleTranslateApiKey: 'g' });
    expect(Object.keys(sync.data)).toEqual(['targetLanguage']);
  });

  it('migration never overwrites a key already in local', async () => {
    sync.data.deeplApiKey = 'old';
    local.data.deeplApiKey = 'new';
    await migrateSecretsFromSync();
    expect(local.data.deeplApiKey).toBe('new');
    expect(sync.data.deeplApiKey).toBeUndefined();
  });

  it('getSettings() contains no secret keys and getSecrets() reads local only', async () => {
    sync.data.deeplApiKey = 'leaked-in-sync';
    local.data.anthropicApiKey = 'sk-ant';
    const settings = await getSettings();
    for (const key of SECRET_KEYS) expect(settings).not.toHaveProperty(key);
    const secrets = await getSecrets();
    expect(secrets.anthropicApiKey).toBe('sk-ant');
    expect(secrets.deeplApiKey).toBe('');
  });

  it('saveSettings() splits secrets to local and the rest to sync', async () => {
    await saveSettings({ deeplApiKey: 'k:fx', claudeGatewayToken: 't', targetLanguage: 'fr' });
    expect(local.data).toEqual({ deeplApiKey: 'k:fx', claudeGatewayToken: 't' });
    expect(sync.data).toEqual({ targetLanguage: 'fr' });
    await setSecrets({ anthropicApiKey: 'sk' });
    expect(local.data.anthropicApiKey).toBe('sk');
  });

  it('defaults include the new engine settings', async () => {
    const settings = await getSettings();
    expect(settings).toMatchObject({
      translationEngineMode: 'fast-then-best',
      claudeModel: 'claude-opus-5-5',
      claudeAccess: 'key',
      claudeGatewayUrl: '',
      claudeGatewayAuth: 'bearer',
    });
  });
});
