import path from 'node:path';
import { test, expect } from '../helpers/extension';
import { CACHE } from '../helpers/paths';
import { browserKind } from '../helpers/launch';

// The point of the setup page: the minutes-long first-time GPU setup of the
// large speech model happens there, not when someone starts Audio mode.
// Run with installed Chrome (real WebGPU) and a wiped shader cache:
//   E2E_BROWSER=chrome E2E_CLEAR_GPU_CACHE=1 npx playwright test --project=perf perf-setup-gpu
// The profile keeps the downloaded model, so this measures setup, not download.
test.use({ profileDir: path.join(CACHE, `profile-captions-${browserKind()}`), keepWelcome: true });

test('the setup page does the first-time GPU setup; Audio mode then starts in seconds', async ({ context, extensionId, sw, configure, fixtureURL, openPopup }) => {
  test.skip(browserKind() !== 'chrome', 'needs real WebGPU (installed Chrome)');
  test.setTimeout(1_800_000);
  await configure({ speechModel: 'turbo', sourceLanguage: 'en', translationProvider: 'deepl', deeplApiKey: 'k:fx' });
  await sw.evaluate(() => chrome.storage.local.remove('setupState'));

  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/welcome.html`);
  await expect(setup.locator('#speechChoice')).toBeVisible(); // the GPU is usable
  const started = Date.now();
  await setup.click('#prepare');
  await expect(setup.locator('#speechState')).toHaveText('Ready', { timeout: 1_500_000 });
  const setupS = (Date.now() - started) / 1000;
  const note = await setup.locator('#speechNote').textContent();
  await setup.close();

  // Audio mode, as a user would start it afterwards: a new offscreen document and worker.
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/captions.html?audio=hello.wav`);
  const popup = await openPopup(page);
  await popup.click('#toggleButton');
  await expect(popup.locator('#toggleButton')).toHaveText('Stop live captions');
  await expect
    .poll(async () => ((await sw.evaluate(() => (self as any).__astAudioDiag?.())) as { model?: string } | null)?.model ?? '', { timeout: 600_000, intervals: [1000] })
    .not.toBe('');
  const diag = (await sw.evaluate(() => (self as any).__astAudioDiag?.())) as { model: string; loadMs: number; prepareMs: number | null };
  const report = { setupPageS: Math.round(setupS), setupNote: note, audioModeModel: diag.model, audioModeLoadS: Math.round(diag.loadMs / 100) / 10, audioModePrepareS: diag.prepareMs == null ? null : Math.round(diag.prepareMs / 100) / 10 };
  console.log(JSON.stringify(report, null, 1));
  expect(diag.model).toContain('webgpu');
  expect(diag.loadMs).toBeLessThan(60_000); // the first-time setup took minutes; here it must not
});
