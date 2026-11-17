// Recomputes the audio metrics of saved benchmark reports from the captions they
// recorded (reports keep every caption), so a metric fix doesn't need a re-run.
// Usage: npm run bench:rescore -- <label> [<label>...]
import fs from 'node:fs';
import path from 'node:path';
import { benchVideos, referenceLines } from '../bench/videos';
import { captionStartOffsets, speechCovered, wordsCovered } from '../bench/metrics';

const root = path.join(__dirname, '..', '.perf', 'youtube-bench');
for (const label of process.argv.slice(2)) {
  const dir = path.join(root, label);
  for (const file of fs.readdirSync(dir).filter(f => f.startsWith('audio-') && f.endsWith('.json'))) {
    const p = path.join(dir, file);
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    const video = benchVideos.find(v => v.id === r.id);
    if (!video || !Array.isArray(r.records)) {
      console.log(`${label}/${file}: no records, skipped`);
      continue;
    }
    const window: [number, number] = [video.start, video.start + Math.min(video.duration, r.played)];
    const ref = referenceLines(video).filter(l => l.start >= window[0] && l.end <= window[1]);
    const captions = r.records.map((c: any) => ({ ...c, pausedAtShow: false, wallShownAt: 0, wallHiddenAt: null }));
    r.wordsCovered = wordsCovered(ref, captions);
    r.onScreenWhileTalking = speechCovered(ref, captions, window).share;
    r.longestGapWhileTalking = speechCovered(ref, captions, window).longestGap;
    r.startOffset = captionStartOffsets(ref, captions);
    fs.writeFileSync(p, JSON.stringify(r, null, 2));
    console.log(`${label}/${file}: words ${(r.wordsCovered * 100).toFixed(0)}%`);
  }
}
