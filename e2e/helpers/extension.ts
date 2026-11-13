import { test as base, expect, BrowserContext, Page, Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchExtensionBrowser } from './launch';
import { startFixtureServer, FixtureServer, TranslationCall } from './server';
import { startLocalProxy, LocalProxy } from './proxy';

export type { TranslationCall };

export interface ExtensionFixtures {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  /** Base URL of the local fixture server (pages, audio, mock APIs). */
  fixtureURL: string;
  /** Requests the extension made to the mock translation APIs during this test. */
  translationCalls: TranslationCall[];
  /** Write settings like the extension does: API keys to chrome.storage.local, the rest to sync. */
  configure: (settings: Record<string, unknown>) => Promise<void>;
  /** Open popup.html bound to the given page's tab (as if the toolbar icon was clicked there). */
  openPopup: (target: Page) => Promise<Page>;
  tabIdOf: (target: Page) => Promise<number>;
  /** The hosted proxy (server/) running locally; the extension is pointed at it. Opt-in: only started when a test uses it. */
  localProxy: LocalProxy;
}

export interface ExtensionOptions {
  /** Reuse a persistent profile dir (e.g. to keep the Whisper model cached). */
  profileDir: string | undefined;
  /** Point the extension at the mock translation APIs. Disable for live API tests. */
  mockTranslation: boolean;
  /** Extra Chromium switches. */
  extraArgs: string[];
  /** Force a headed browser (e.g. sites that stop playback in headless mode). */
  headed: boolean;
  /**
   * Keep one browser per worker across tests (tests open tabs in it) instead of
   * launching one per test. Pages marked with keepPage() survive between tests;
   * other pages are closed after each test.
   */
  reuseBrowser: boolean;
}

/** Pages that should stay open between tests when the browser is reused. */
const keptPages = new WeakSet<Page>();
export const keepPage = (page: Page) => keptPages.add(page);

const SKIP_ON_COPY = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'lockfile', 'LOCK']);

/** Best-effort copy of a browser profile (locked files are skipped). */
function copyProfile(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_ON_COPY.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    try {
      if (entry.isDirectory()) copyProfile(src, dst);
      else fs.copyFileSync(src, dst);
    } catch {
      // in use by another browser: skip
    }
  }
}

/**
 * Persistent profiles can't be shared by browsers running at the same time:
 * parallel worker N > 0 gets its own copy (made once from the base profile, so
 * downloaded models and a signed-in session carry over).
 */
function profileForWorker(profileDir: string, parallelIndex: number): string {
  if (parallelIndex === 0) return profileDir;
  const dir = `${profileDir}-w${parallelIndex}`;
  if (!fs.existsSync(dir) && fs.existsSync(profileDir)) copyProfile(profileDir, dir);
  return dir;
}

type Launched = Awaited<ReturnType<typeof launchExtensionBrowser>>;

/**
 * Waits for the extension's service worker: briefly on its own, then woken by
 * opening an extension page (the popup messages the background on load).
 */
async function extensionWorkerStarts(context: BrowserContext, extensionId: string): Promise<boolean> {
  const isOurs = (w: Worker) => w.url().startsWith(`chrome-extension://${extensionId}/`);
  if (context.serviceWorkers().some(isOurs)) return true;
  if (await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 5000 }).catch(() => null)) return true;
  const waking = context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 20_000 }).catch(() => null);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`).catch(() => undefined);
  const started = context.serviceWorkers().some(isOurs) || !!(await waking);
  await page.close().catch(() => undefined);
  return started;
}

export const test = base.extend<ExtensionFixtures & ExtensionOptions, { server: FixtureServer; browserPool: Map<string, Launched> }>({
  profileDir: [undefined, { option: true }],
  mockTranslation: [true, { option: true }],
  extraArgs: [[], { option: true }],
  headed: [false, { option: true }],
  reuseBrowser: [false, { option: true }],

  // Browsers kept for the whole worker (reuseBrowser), closed when the worker ends.
  browserPool: [
    async ({}, use) => {
      const pool = new Map<string, Launched>();
      await use(pool);
      for (const launched of pool.values()) await launched.close().catch(() => undefined);
    },
    { scope: 'worker' },
  ],

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

  context: async ({ extensionId, profileDir, extraArgs, headed, reuseBrowser, browserPool }, use, testInfo) => {
    const persistent = profileDir ? profileForWorker(profileDir, testInfo.parallelIndex) : undefined;
    const poolKey = persistent ?? `temp-${testInfo.parallelIndex}`;
    const reused = reuseBrowser ? browserPool.get(poolKey) : undefined;
    if (reused && reused.context.browser()?.isConnected() !== false) {
      const logs: string[] = [];
      const onConsole = (m: any) => logs.push(`[${m.page()?.url() ?? 'worker'}] ${m.type()}: ${m.text()}`);
      reused.context.on('console', onConsole);
      await use(reused.context);
      reused.context.off('console', onConsole);
      if (logs.length && testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('console.log', { body: logs.join('\n'), contentType: 'text/plain' });
        if (process.env.E2E_PRINT_LOGS) console.log(logs.join('\n'));
      }
      for (const page of reused.context.pages()) if (!keptPages.has(page)) await page.close().catch(() => undefined);
      return;
    }
    const dir = persistent ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ast-e2e-'));
    fs.mkdirSync(dir, { recursive: true });
    const launch = () =>
      launchExtensionBrowser({
        profileDir: dir,
        extensionId,
        extraArgs,
        headless: !(headed || process.env.HEADED),
      });
    let launched = await launch();
    // The installed extension's MV3 worker only starts when something wakes it,
    // and occasionally it doesn't start at all on a launch; one relaunch fixes it.
    if (!(await extensionWorkerStarts(launched.context, extensionId))) {
      await launched.close();
      launched = await launch();
      if (!(await extensionWorkerStarts(launched.context, extensionId))) {
        await launched.close();
        throw new Error('The extension service worker did not start, even after a relaunch');
      }
    }
    const context = launched.context;
    if (reuseBrowser) {
      // First test of this worker: keep the browser for the next ones (and its first
      // tab: Chrome may quit when its last window closes).
      browserPool.set(poolKey, launched);
      keptPages.add(context.pages()[0] ?? (await context.newPage()));
      const logs: string[] = [];
      const onConsole = (m: any) => logs.push(`[${m.page()?.url() ?? 'worker'}] ${m.type()}: ${m.text()}`);
      context.on('console', onConsole);
      await use(context);
      context.off('console', onConsole);
      if (logs.length && testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('console.log', { body: logs.join('\n'), contentType: 'text/plain' });
        if (process.env.E2E_PRINT_LOGS) console.log(logs.join('\n'));
      }
      for (const page of context.pages()) if (!keptPages.has(page)) await page.close().catch(() => undefined);
      return;
    }
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
    const sw = context.serviceWorkers().find(isOurs) ?? (await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 30_000 }));
    // Extension APIs are bound slightly after the worker script starts.
    await expect.poll(() => sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage)).toBe(true);
    await use(sw);
  },

  translationCalls: [
    async ({ sw, server, mockTranslation }, use) => {
      server.translationCalls.length = 0;
      server.setTranslationDelay(0);
      server.setAnthropicFailure(null);
      // Lets tests drive subtitle-mode internals through the content-script test bridge.
      await sw.evaluate(() => chrome.storage.local.set({ devExposeInternals: true }));
      // Persistent profiles keep keys and engine settings from earlier tests: start each
      // test without them so it gets exactly what it configures.
      await sw.evaluate(async () => {
        await chrome.storage.local.remove(['deeplApiKey', 'googleTranslateApiKey', 'anthropicApiKey', 'claudeGatewayToken', 'accountToken']);
        await chrome.storage.sync.remove(['translationEngineMode', 'claudeModel', 'claudeAccess', 'claudeGatewayUrl', 'claudeGatewayAuth']);
      });
      if (mockTranslation) {
        await sw.evaluate(
          base => chrome.storage.local.set({
              devEndpointOverrides: { deepl: `${base}/mock/deepl`, google: `${base}/mock/google`, anthropic: `${base}/mock/anthropic` },
            }),
          server.url
        );
      } else {
        // Persistent profiles may still hold a previous run's mock endpoints.
        await sw.evaluate(() => chrome.storage.local.remove('devEndpointOverrides'));
      }
      await use(server.translationCalls);
    },
    { auto: true },
  ],

  configure: async ({ sw }, use) => {
    await use(async settings => {
      // API keys go to storage.local like the extension stores them (settings.ts SECRET_KEYS).
      await sw.evaluate(s => {
        const secretKeys = ['deeplApiKey', 'googleTranslateApiKey', 'anthropicApiKey', 'claudeGatewayToken', 'accountToken'];
        const secrets = Object.fromEntries(Object.entries(s).filter(([k]) => secretKeys.includes(k)));
        const rest = Object.fromEntries(Object.entries(s).filter(([k]) => !secretKeys.includes(k)));
        return Promise.all([chrome.storage.local.set(secrets), chrome.storage.sync.set(rest)]);
      }, settings);
    });
  },

  // Not named `proxy`: that is a built-in Playwright option its own fixtures read,
  // which would start this server (and point the extension at it) in every test.
  localProxy: async ({ server, sw, translationCalls }, use) => {
    void translationCalls; // mock endpoints configured first
    const proxy = await startLocalProxy(server.url);
    await sw.evaluate(async url => {
      const { devEndpointOverrides = {} } = await chrome.storage.local.get('devEndpointOverrides');
      await chrome.storage.local.set({ devEndpointOverrides: { ...devEndpointOverrides, server: url } });
    }, proxy.url);
    await use(proxy);
    await proxy.close();
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
