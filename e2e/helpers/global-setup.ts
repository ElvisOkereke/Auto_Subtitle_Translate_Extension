import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CACHE, DIST } from './paths';

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

// Unpacked extension IDs are derived from the load path, so we launch once to
// learn the ID. Tests need it up front for --allowlisted-extension-id, which
// lets chrome.tabCapture work without a real toolbar click.
export default async function globalSetup() {
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
