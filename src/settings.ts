import { ExtensionSettings } from './types';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  sourceLanguage: 'auto',
  targetLanguage: 'en',
  subtitleStyle: 'bottom',
  fontSize: 'medium',
  googleTranslateApiKey: '',
  translationProvider: 'google',
  deeplApiKey: '',
  enabled: false
};

export async function getSettings(): Promise<ExtensionSettings> {
  return (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as ExtensionSettings;
}
