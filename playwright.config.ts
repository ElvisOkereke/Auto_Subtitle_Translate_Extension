import { defineConfig } from '@playwright/test';

// The extension is loaded from dist/, so `npm run build` must run first
// (`npm run test:e2e` does this). Each test gets a fresh Chromium profile.
export default defineConfig({
  testDir: './e2e/tests',
  outputDir: './e2e/.results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  globalSetup: './e2e/helpers/global-setup.ts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'ui', testIgnore: /captions|perf|spike|live|judge|domain-bench|subtitle-(ocr|mode|readahead|claude|real)|youtube/ },
    // Speech tests share one persistent profile so the Whisper model is only
    // downloaded once; Chromium locks a profile dir, so they run serially.
    { name: 'captions', testMatch: /captions/, workers: 1, timeout: 600_000 },
    // Subtitle mode with real OCR: persistent profile keeps the OCR models cached.
    { name: 'subtitles', testMatch: /subtitle-(ocr|mode|readahead|claude)/, workers: 1, timeout: 600_000 },
    { name: 'perf', testMatch: /perf|spike/, workers: 1, timeout: 1_800_000 },
    { name: 'live', testMatch: /live/, workers: 1, timeout: 600_000 },
    // Real YouTube (installed Chrome only, opt-in): npm run e2e:youtube
    { name: 'youtube', testMatch: /youtube-real/, workers: 1, timeout: 900_000 },
    // Claude-as-judge translation scoring (opt-in, Fuelix/Anthropic credentials): E2E_JUDGE=1
    { name: 'judge', testMatch: /judge|domain-bench/, workers: 1, timeout: 900_000 },
  ],
});
