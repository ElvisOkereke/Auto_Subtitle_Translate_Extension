import { chromium, BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { DIST } from './paths';

export interface LaunchOptions {
  profileDir: string;
  extensionId: string;
  extraArgs?: string[];
  headless?: boolean;
}

export interface LaunchedBrowser {
  context: BrowserContext;
  close: () => Promise<void>;
}

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function browserKind(): 'chromium' | 'chrome' {
  return process.env.E2E_BROWSER === 'chrome' ? 'chrome' : 'chromium';
}

function baseArgs(o: LaunchOptions): string[] {
  return [
    // Lets chrome.tabCapture work without a real toolbar click.
    `--allowlisted-extension-id=${o.extensionId}`,
    '--autoplay-policy=no-user-gesture-required',
    ...(o.extraArgs ?? []),
  ];
}

/**
 * Launches a browser with the extension from dist/ loaded.
 *
 * - chromium (default): Playwright's bundled Chromium via --load-extension.
 * - chrome (E2E_BROWSER=chrome): the installed Google Chrome. Branded Chrome
 *   ignores --load-extension, so we start it ourselves with a debugging port
 *   and load the extension through CDP `Extensions.loadUnpacked`. This is the
 *   browser users actually run, and (unlike Playwright's Chromium build on
 *   Windows) it ships the D3D12 shader compiler WebGPU needs.
 */
export async function launchExtensionBrowser(o: LaunchOptions): Promise<LaunchedBrowser> {
  if (browserKind() === 'chromium') {
    const context = await chromium.launchPersistentContext(o.profileDir, {
      channel: 'chromium',
      headless: o.headless ?? true,
      viewport: { width: 1280, height: 800 },
      // Playwright mutes headless browsers by default; a muted tab captures as silence.
      ignoreDefaultArgs: ['--mute-audio'],
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, ...baseArgs(o)],
    });
    return { context, close: () => context.close() };
  }

  const exe = process.env.CHROME_PATH ?? CHROME_PATHS.find(p => fs.existsSync(p));
  if (!exe) throw new Error('Google Chrome not found; set CHROME_PATH');
  fs.rmSync(`${o.profileDir}/DevToolsActivePort`, { force: true });
  // Branded Chrome keeps the extension's previous service-worker registration
  // and script in a persistent profile even when loadUnpacked installs a newer
  // build (and a version bump doesn't help here). Drop the registrations; the
  // Cache API data next to them (downloaded models) is kept.
  for (const dir of ['Database', 'ScriptCache']) {
    fs.rmSync(`${o.profileDir}/Default/Service Worker/${dir}`, { recursive: true, force: true });
  }
  const proc = spawn(
    exe,
    [
      ...(o.headless ?? true ? ['--headless=new'] : []),
      `--user-data-dir=${o.profileDir}`,
      '--remote-debugging-port=0',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      ...baseArgs(o),
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let port: string | undefined;
  for (let i = 0; i < 150 && !port; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      port = fs.readFileSync(`${o.profileDir}/DevToolsActivePort`, 'utf8').split('\n')[0];
    } catch {
      // not written yet
    }
  }
  if (!port) {
    proc.kill();
    throw new Error('Chrome did not expose a debugging port');
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const cdp = await browser.newBrowserCDPSession();
  const { id } = (await cdp.send('Extensions.loadUnpacked' as any, { path: DIST } as any)) as { id: string };
  if (id !== o.extensionId) {
    console.warn(`Extension loaded as ${id}, expected ${o.extensionId}; tabCapture allowlist may not apply`);
  }
  const context = browser.contexts()[0];
  // Same viewport as the Chromium launch (a headless Chrome window minus its UI is smaller).
  await context.pages()[0]?.setViewportSize({ width: 1280, height: 800 });
  context.on('page', page => {
    if (!page.url().includes('popup.html')) page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  });
  return {
    context,
    close: async () => {
      await browser.close().catch(() => undefined);
      proc.kill();
      await new Promise(r => proc.once('exit', r)).catch(() => undefined);
    },
  };
}
