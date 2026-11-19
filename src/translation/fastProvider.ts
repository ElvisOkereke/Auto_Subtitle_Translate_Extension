// fastProvider.ts - which fast engine translates a line. Chrome's built-in
// translator is the free tier: chosen explicitly, or used whenever the chosen
// provider has no key (or the subscription has no account), so an install
// without keys still translates. Pure: shared by the translation service and
// the single-line API service.

export type FastProvider = 'deepl' | 'google' | 'subscription' | 'builtin';

export function chooseFastProvider(
  chosen: string | undefined,
  secrets: { deeplApiKey: string; googleTranslateApiKey: string; accountToken: string },
  hostedUrl: string | null
): FastProvider {
  if (chosen === 'deepl' && secrets.deeplApiKey) return 'deepl';
  if (chosen === 'google' && secrets.googleTranslateApiKey) return 'google';
  if (chosen === 'subscription' && secrets.accountToken && hostedUrl) return 'subscription';
  return 'builtin';
}

/** Our language codes as Chrome's built-in translator names them (BCP 47 short codes). */
export function builtinLanguage(code: string): string {
  if (code === 'auto') return 'auto';
  if (code === 'zh-Hans') return 'zh';
  if (code === 'zh-Hant') return 'zh-Hant';
  return code.split('-')[0];
}
