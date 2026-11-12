import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../helpers/extension';
import { FIXTURES } from '../helpers/paths';

interface TimelineLine { stretch: 's1' | 's2'; start: number; end: number; ko: string; en: string; terms: string[] }
const timeline = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'subtitles/_zIrbXw-SVs.timeline.json'), 'utf8')) as {
  stretches: { id: 's1' | 's2'; start: number; end: number; file: string }[];
  lines: TimelineLine[];
};

test('timeline covers both stretches without gaps or overlaps', () => {
  for (const stretch of timeline.stretches) {
    const lines = timeline.lines.filter(l => l.stretch === stretch.id);
    const length = stretch.end - stretch.start;
    expect(lines.length).toBeGreaterThanOrEqual(25);
    lines.forEach((line, i) => {
      expect(line.end).toBeGreaterThan(line.start);
      expect(line.start).toBeGreaterThanOrEqual(0);
      expect(line.end).toBeLessThanOrEqual(length + 0.05);
      expect(line.ko.trim().length).toBeGreaterThan(0);
      expect(line.en.trim().length).toBeGreaterThan(0);
      if (i > 0) expect(line.start).toBeGreaterThanOrEqual(lines[i - 1].end);
    });
  }
});

test('fixture page plays a stretch through MSE', async ({ context, fixtureURL }) => {
  const page = await context.newPage();
  await page.goto(`${fixtureURL}/video-subs.html?v=_zIrbXw-SVs&stretch=s1`);
  await page.evaluate(() => (window as any).__fixture.video.play());
  await expect.poll(() => page.evaluate(() => (window as any).__fixture.video.currentTime), { timeout: 15_000 }).toBeGreaterThan(2);
  const info = await page.evaluate(() => {
    const v = (window as any).__fixture.video as HTMLVideoElement;
    return { height: v.videoHeight, src: v.src };
  });
  expect(info.height).toBe(1080);
  expect(info.src.startsWith('blob:')).toBe(true);
});
