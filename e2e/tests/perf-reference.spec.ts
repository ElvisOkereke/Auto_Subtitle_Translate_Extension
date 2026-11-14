import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../helpers/extension';
import { CACHE, FIXTURES } from '../helpers/paths';
import { browserKind } from '../helpers/launch';
import { astTest } from '../helpers/bridge';
import { isSameLine as isSameLineText } from '../../src/subtitle/textSimilarity';
import { charErrorRate } from '../helpers/cer';

// Candidate reference timelines for the benchmark videos (perf project).
// Inputs: e2e/scripts/make_reference.py <id> (segments of the subtitle box at 10 fps).
// Output: e2e/fixtures/subtitles/<id>.timeline.json, which is then hand-checked
// against the contact sheets before it is committed.
test.use({ profileDir: path.join(CACHE, `profile-subtitles-${browserKind()}`) });

interface Segment { index: number; start: number; end: number; file: string; h: number }
interface BenchVideo { id: string; mode: string; lang: string; start: number; duration: number; reference?: string }

const videos: BenchVideo[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../bench/videos.json'), 'utf8')).videos;

for (const video of videos.filter(v => v.mode === 'subtitles' && v.reference && !fs.existsSync(path.join(FIXTURES, 'subtitles', v.reference)))) {
  test(`candidate reference timeline for ${video.id}`, async ({ context, fixtureURL }) => {
    const dir = path.join(CACHE, 'ocr-crops', 'ref', video.id);
    const segments: Segment[] = JSON.parse(fs.readFileSync(path.join(dir, 'segments.json'), 'utf8'));
    const offset: number = JSON.parse(fs.readFileSync(path.join(CACHE, 'videos', `${video.id}.b.json`), 'utf8')).offset;
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s1`);
    await astTest(page, 'ocr.preload', { lang: video.lang });

    const lines: { stretch: string; start: number; end: number; ko: string; h: number; segments: number[] }[] = [];
    for (const seg of segments) {
      const r = await astTest<{ text: string; confidence: number }>(page, 'ocr', { bitmapUrl: `${fixtureURL}/crops/ref/${video.id}/${seg.file}`, lang: video.lang });
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

// Timing pass for hand-corrected references: segment boundaries come from
// image differences, which miss changes over bright backgrounds. For each
// line, OCR every 10 fps frame within 1.5 s of its start and end and move the
// boundary to the first / last frame that shows that line's text.
const FPS = 10;
for (const video of videos.filter(v => v.mode === 'subtitles' && v.reference && v.id !== '_zIrbXw-SVs')) {
  const refPath = path.join(FIXTURES, 'subtitles', video.reference!);
  const ref = fs.existsSync(refPath) ? JSON.parse(fs.readFileSync(refPath, 'utf8')) : null;
  if (!ref?.corrected || ref.timingRefined === 2) continue;
  test(`refine reference timing for ${video.id}`, async ({ context, fixtureURL }) => {
    const frames = path.join(CACHE, 'ocr-crops', 'ref', video.id, 'frames');
    const count = fs.readdirSync(frames).filter(f => f.endsWith('.png')).length;
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s1`);
    await astTest(page, 'ocr.preload', { lang: video.lang });
    const cache = new Map<number, string>();
    const textAt = async (t: number) => {
      const i = Math.round(t * FPS) + 1;
      if (i < 1 || i > count) return '';
      if (!cache.has(i)) {
        const r = await astTest<{ text: string; confidence: number }>(page, 'ocr', {
          bitmapUrl: `${fixtureURL}/crops/ref/${video.id}/frames/${String(i).padStart(5, '0')}.png`,
          lang: video.lang,
        });
        cache.set(i, r.confidence >= 0.5 ? r.text.trim() : '');
      }
      return cache.get(i)!;
    };
    const shows = (text: string, ko: string) => {
      if (!text) return false;
      const { errors, length } = charErrorRate(ko, text);
      return length > 0 && errors / length <= 0.35;
    };
    const lines: { start: number; end: number; ko: string }[] = ref.lines;
    let moved = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prevEnd = i > 0 ? lines[i - 1].end : 0;
      const nextStart = i + 1 < lines.length ? lines[i + 1].start : Infinity;
      const step = 1 / FPS;
      let start: number | null = null;
      for (let t = Math.max(prevEnd, line.start - 1.5); t <= line.start + 1.0 + 1e-6; t += step) {
        if (shows(await textAt(t), line.ko)) {
          start = t;
          break;
        }
      }
      let end: number | null = null;
      // Back from just before the next line to this line's start: the last frame that still shows it.
      for (let t = Math.min(nextStart - step, line.end + 1.5); t >= (start ?? line.start) - 1e-6; t -= step) {
        if (shows(await textAt(t), line.ko)) {
          end = t + step;
          break;
        }
      }
      const newStart = Math.round((start ?? line.start) * 1000) / 1000;
      const newEnd = Math.round((end ?? line.end) * 1000) / 1000;
      if (newStart !== line.start || newEnd !== line.end) moved++;
      line.start = newStart;
      line.end = Math.max(newEnd, newStart + step);
    }
    ref.timingRefined = 2; // version of the timing pass
    if (!ref.labelledBy.includes('per-frame OCR')) ref.labelledBy += '; boundaries refined by per-frame OCR at 10 fps';
    fs.writeFileSync(refPath, JSON.stringify(ref, null, 1));
    console.log(`${video.id}: ${moved}/${lines.length} lines re-timed (${cache.size} frames read)`);
  });
}
