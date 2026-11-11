import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DIST } from './paths';

// Unpacked extension IDs are derived from the load path, so we launch once to
// learn the ID. Tests need it up front for --allowlisted-extension-id, which
// lets chrome.tabCapture work without a real toolbar click.
export default async function globalSetup() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('dist/ is missing - run `npm run build` first (npm run test:e2e does this).');
  }
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
