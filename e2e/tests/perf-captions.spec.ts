import fs from 'node:fs';
import path from 'node:path';
import { test } from '../helpers/extension';
import { CACHE, FIXTURES } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { benchVideos } from '../bench/videos';

// Saves YouTube captions (json3) for audio benchmark videos through the signed-in
// test browser, for when yt-dlp is rate-limited (HTTP 429). Then run
// e2e/scripts/fetch_caption_reference.py <id> <lang> to build the reference.
test.use({ profileDir: path.join(CACHE, 'profile-youtube'), headed: true });
test.skip(browserKind() !== 'chrome', 'needs installed Chrome (E2E_BROWSER=chrome)');

for (const video of benchVideos.filter(v => v.mode === 'audio' && !fs.existsSync(path.join(FIXTURES, 'subtitles', `${v.id}.captions.json`)))) {
  test(`save captions for ${video.id}`, async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${video.id}`);
    await page.waitForSelector('video', { timeout: 30_000 });
    const saved = await page.evaluate(async lang => {
      const tracks: any[] = (window as any).ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      const ofLang = tracks.filter(t => (t.languageCode ?? '').split('-')[0] === lang);
      const track = ofLang.find(t => t.kind !== 'asr') ?? ofLang.find(t => t.kind === 'asr');
      if (!track) return null;
      const res = await fetch(`${track.baseUrl}&fmt=json3`, { credentials: 'include' });
      return { kind: track.kind === 'asr' ? 'auto' : 'manual', json3: await res.json() };
    }, video.lang);
    if (!saved) throw new Error(`${video.id}: no ${video.lang} caption track`);
    fs.mkdirSync(path.join(CACHE, 'captions'), { recursive: true });
    fs.writeFileSync(path.join(CACHE, 'captions', `${video.id}.json`), JSON.stringify(saved));
    console.log(`${video.id}: ${saved.kind} captions, ${saved.json3.events?.length ?? 0} events`);
  });
}
