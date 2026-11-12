import { ExtensionSettings } from './types';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  sourceLanguage: 'auto',
  targetLanguage: 'en',
  subtitleStyle: 'bottom',
  fontSize: 'medium',
  translationProvider: 'google',
  subtitleLanguage: 'ko',
  enabled: false,
  translationEngineMode: 'fast-then-best',
  claudeModel: 'claude-opus-5-5',
  claudeAccess: 'key',
  claudeGatewayUrl: '',
  claudeGatewayAuth: 'bearer'
};

/**
 * API keys and tokens. They live only in chrome.storage.local: storage.sync
 * would upload them to Google's sync servers, and a key must only ever go to
 * its own provider.
 */
export const SECRET_KEYS = ['deeplApiKey', 'googleTranslateApiKey', 'anthropicApiKey', 'claudeGatewayToken'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
export type Secrets = Record<SecretKey, string>;

const isSecret = (key: string): key is SecretKey => (SECRET_KEYS as readonly string[]).includes(key);

export async function getSettings(): Promise<ExtensionSettings> {
  return (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as ExtensionSettings;
}

export async function getSecrets(): Promise<Secrets> {
  const stored = await chrome.storage.local.get([...SECRET_KEYS]);
  return Object.fromEntries(SECRET_KEYS.map(k => [k, typeof stored[k] === 'string' ? stored[k] : ''])) as Secrets;
}

export async function setSecrets(secrets: Partial<Secrets>): Promise<void> {
  await chrome.storage.local.set(secrets);
}

/** Writes a settings object, routing secrets to local storage and everything else to sync. */
export async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  const secrets: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) (isSecret(key) ? secrets : rest)[key] = value;
  if (Object.keys(secrets).length) await chrome.storage.local.set(secrets);
  if (Object.keys(rest).length) await chrome.storage.sync.set(rest);
}

/** One-time move of keys saved by older versions from storage.sync to storage.local. */
export async function migrateSecretsFromSync(): Promise<void> {
  const inSync = await chrome.storage.sync.get([...SECRET_KEYS]);
  const found = Object.keys(inSync).filter(isSecret);
  if (!found.length) return;
  const inLocal = await chrome.storage.local.get(found);
  const toMove = Object.fromEntries(found.filter(k => !(k in inLocal) && inSync[k]).map(k => [k, inSync[k]]));
  if (Object.keys(toMove).length) await chrome.storage.local.set(toMove);
  await chrome.storage.sync.remove(found);
}
