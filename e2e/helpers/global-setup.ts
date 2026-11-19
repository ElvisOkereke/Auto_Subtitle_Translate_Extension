import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CACHE, DIST, DIST_SOURCE } from './paths';

/**
 * Persistent test profiles keep running the cached service-worker script of an
 * unpacked extension until its version changes, even after dist/ is rebuilt
 * (and chrome.runtime.reload() can leave a command-line extension disabled).
 * Give every test run a new, increasing 4-part version so each launch picks up
 * the current build. Only dist/ (a build artifact) is touched.
 */
function bumpDistVersion(): void {
  const manifestPath = path.join(DIST, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const counterFile = path.join(CACHE, 'e2e-run-counter.txt');
  fs.mkdirSync(CACHE, { recursive: true });
  const run = ((fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) % 65000) + 1;
  fs.writeFileSync(counterFile, String(run));
  const base = String(manifest.version).split('.').slice(0, 3).join('.');
  manifest.version = `${base}.${run}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Temp folders tests create (browser profiles, Playwright traces, server test
 * databases) are removed when a test ends, but not when a run is killed. They
 * add up to gigabytes on the system drive: remove ours that are over 2 hours old
 * (younger ones may belong to a run in progress).
 */
const TEMP_PREFIXES = ['ast-e2e-', 'ast-id-', 'ast-proxy-', 'ast-life-', 'playwright-artifacts-', 'playwright-tracing-'];
export function sweepStaleTemp(dir = os.tmpdir(), maxAgeMs = 2 * 3600_000, now = Date.now()): number {
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!TEMP_PREFIXES.some(p => name.startsWith(p))) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs < maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed++;
    } catch {
      // in use or already gone
    }
  }
  return removed;
}

// Unpacked extension IDs are derived from the load path, so we launch once to
// learn the ID. Tests need it up front for --allowlisted-extension-id, which
// lets chrome.tabCapture work without a real toolbar click.
export default async function globalSetup() {
  sweepStaleTemp();
  if (DIST_SOURCE) {
    if (!fs.existsSync(path.join(DIST_SOURCE, 'manifest.json'))) throw new Error(`E2E_DIST has no manifest.json: ${DIST_SOURCE}`);
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.cpSync(DIST_SOURCE, DIST, { recursive: true });
  }
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('dist/ is missing - run `npm run build` first (npm run test:e2e does this).');
  }
  bumpDistVersion();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-id-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  process.env.AST_EXTENSION_ID = new URL(sw.url()).host;
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
