import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../helpers/extension';
import { CACHE, FIXTURES } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { astTest } from '../helpers/bridge';
import { isSameLine as isSameLineText } from '../../src/subtitle/textSimilarity';

// Candidate reference timelines for the benchmark videos (perf project).
// Inputs: e2e/scripts/make_reference.py <id> (segments of the subtitle box at 10 fps).
// Output: e2e/fixtures/subtitles/<id>.timeline.json, which is then hand-checked
// against the contact sheets before it is committed.
test.use({ profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });

interface Segment { index: number; start: number; end: number; file: string; h: number }
interface BenchVideo { id: string; mode: string; start: number; duration: number; reference?: string }

const videos: BenchVideo[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../bench/videos.json'), 'utf8')).videos;

for (const video of videos.filter(v => v.mode === 'subtitles' && v.reference && !fs.existsSync(path.join(FIXTURES, 'subtitles', v.reference)))) {
  test(`candidate reference timeline for ${video.id}`, async ({ context, fixtureURL }) => {
    const dir = path.join(CACHE, 'ocr-crops', 'ref', video.id);
    const segments: Segment[] = JSON.parse(fs.readFileSync(path.join(dir, 'segments.json'), 'utf8'));
    const offset: number = JSON.parse(fs.readFileSync(path.join(CACHE, 'videos', `${video.id}.b.json`), 'utf8')).offset;
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s1`);
    await astTest(page, 'ocr.preload', { lang: 'ko' });

    const lines: { stretch: string; start: number; end: number; ko: string; h: number; segments: number[] }[] = [];
    for (const seg of segments) {
      const r = await astTest<{ text: string; confidence: number }>(page, 'ocr', { bitmapUrl: `${fixtureURL}/crops/ref/${video.id}/${seg.file}`, lang: 'ko' });
      const text = r.confidence >= 0.5 ? r.text.trim() : '';
      if (!text) continue;
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.end - seg.start) < 0.11 && isSameLineText(last.ko, text)) {
        last.end = seg.end;
        last.segments.push(seg.index);
        if (text.length > last.ko.length) last.ko = text; // keep the most complete read
      } else {
        lines.push({ stretch: 'b', start: seg.start, end: seg.end, ko: text, h: seg.h, segments: [seg.index] });
      }
    }
    const out = {
      video: video.id,
      labelledBy: 'extension OCR at 10 fps, hand-checked',
      note: `Times are relative to the benchmark cut ${video.id}.b.webm, which starts at ${offset} s of the video.`,
      stretches: [{ id: 'b', start: offset, end: offset + video.duration + 10, file: `${video.id}.b.webm` }],
      lines,
    };
    fs.writeFileSync(path.join(FIXTURES, 'subtitles', video.reference!), JSON.stringify(out, null, 1));
    console.log(`${video.id}: ${lines.length} candidate lines`);
    expect(lines.length).toBeGreaterThanOrEqual(10);
  });
}
