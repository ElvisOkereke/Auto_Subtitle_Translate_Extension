import { test as base, expect, BrowserContext, Page, Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchExtensionBrowser } from './launch';
import { startFixtureServer, FixtureServer, TranslationCall } from './server';

export type { TranslationCall };

export interface ExtensionFixtures {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  /** Base URL of the local fixture server (pages, audio, mock APIs). */
  fixtureURL: string;
  /** Requests the extension made to the mock translation APIs during this test. */
  translationCalls: TranslationCall[];
  /** Write settings straight into chrome.storage.sync. */
  configure: (settings: Record<string, unknown>) => Promise<void>;
  /** Open popup.html bound to the given page's tab (as if the toolbar icon was clicked there). */
  openPopup: (target: Page) => Promise<Page>;
  tabIdOf: (target: Page) => Promise<number>;
}

export interface ExtensionOptions {
  /** Reuse a persistent profile dir (e.g. to keep the Whisper model cached). */
  profileDir: string | undefined;
  /** Point the extension at the mock translation APIs. Disable for live API tests. */
  mockTranslation: boolean;
  /** Extra Chromium switches. */
  extraArgs: string[];
}

export const test = base.extend<ExtensionFixtures & ExtensionOptions, { server: FixtureServer }>({
  profileDir: [undefined, { option: true }],
  mockTranslation: [true, { option: true }],
  extraArgs: [[], { option: true }],

  server: [
    async ({}, use) => {
      const server = await startFixtureServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  fixtureURL: async ({ server }, use) => {
    await use(server.url);
  },

  extensionId: async ({}, use) => {
    const id = process.env.AST_EXTENSION_ID;
    if (!id) throw new Error('AST_EXTENSION_ID not set - globalSetup did not run');
    await use(id);
  },

  context: async ({ extensionId, profileDir, extraArgs }, use, testInfo) => {
    const dir = profileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ast-e2e-'));
    fs.mkdirSync(dir, { recursive: true });
    const launched = await launchExtensionBrowser({
      profileDir: dir,
      extensionId,
      extraArgs,
      headless: !process.env.HEADED,
    });
    const context = launched.context;
    // Collect console output from every page so failures come with logs attached.
    const logs: string[] = [];
    const stamp = () => new Date().toISOString().slice(17, 23);
    context.on('console', m => logs.push(`${stamp()} [${m.page()?.url() ?? 'worker'}] ${m.type()}: ${m.text()}`));
    context.on('weberror', e => logs.push(`${stamp()} [pageerror] ${e.error().stack ?? e.error().message}`));
    await use(context);
    if (logs.length && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('console.log', { body: logs.join('\n'), contentType: 'text/plain' });
      if (process.env.E2E_PRINT_LOGS) console.log(logs.join('\n'));
    }
    await launched.close();
    if (!profileDir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  },

  sw: async ({ context, extensionId }, use) => {
    const isOurs = (w: Worker) => w.url().startsWith(`chrome-extension://${extensionId}/`);
    const sw = context.serviceWorkers().find(isOurs) ?? (await context.waitForEvent('serviceworker', { predicate: isOurs }));
    // Extension APIs are bound slightly after the worker script starts.
    await expect.poll(() => sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage)).toBe(true);
    await use(sw);
  },

  translationCalls: [
    async ({ sw, server, mockTranslation }, use) => {
      server.translationCalls.length = 0;
      server.setTranslationDelay(0);
      // Lets tests drive subtitle-mode internals through the content-script test bridge.
      await sw.evaluate(() => chrome.storage.local.set({ devExposeInternals: true }));
      if (mockTranslation) {
        await sw.evaluate(
          base => chrome.storage.local.set({ devEndpointOverrides: { deepl: `${base}/mock/deepl`, google: `${base}/mock/google` } }),
          server.url
        );
      }
      await use(server.translationCalls);
    },
    { auto: true },
  ],

  configure: async ({ sw }, use) => {
    await use(async settings => {
      await sw.evaluate(s => chrome.storage.sync.set(s), settings);
    });
  },

  tabIdOf: async ({ sw }, use) => {
    await use(async target => {
      const url = target.url();
      const id = await sw.evaluate(
        async u => (await chrome.tabs.query({})).find(t => t.url === u)?.id ?? null,
        url
      );
      if (id === null) throw new Error(`No tab found for ${url}`);
      return id;
    });
  },

  openPopup: async ({ context, extensionId, tabIdOf }, use) => {
    await use(async target => {
      const tabId = await tabIdOf(target);
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 380, height: 640 });
      await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
      return popup;
    });
  },
});

export { expect };
