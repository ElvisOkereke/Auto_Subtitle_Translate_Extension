// Markdown comparison table of benchmark runs (e2e/.perf/youtube-bench/<label>/).
// Usage: node e2e/scripts/bench-table.mjs <before-label> <after-label> [<after-label-2>] [--run youtube|local-mp4|local-webm]
// One row per run/mode/video: coverage (lines on screen >= 0.5 s), ready before
// shown, lines leaving before their reading time, stale lines while paused, judge.
// With two "after" labels (two live samples) both are shown.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const runFilter = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;
const labels = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--run');
const [before, ...after] = labels;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.perf', 'youtube-bench');
const videos = JSON.parse(fs.readFileSync(path.join(root, '..', '..', 'bench', 'videos.json'), 'utf8')).videos;
const read = (label, file) => {
  const p = path.join(root, label, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
const cov = r => (r ? `${r.coverage.long.matched}/${r.coverage.long.lines}` : '–');
const pct = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
const cell = (rs, f) => rs.map(f).join(' · ');

const rows = [];
for (const run of ['youtube', 'local-mp4', 'local-webm']) {
  if (runFilter && run !== runFilter) continue;
  for (const mode of ['fast-then-best', 'best']) {
    for (const v of videos) {
      const file = `${run}-${mode}-${v.id}.json`;
      const b = read(before, file);
      const as = after.map(l => read(l, file));
      if (!as.some(Boolean)) continue;
      rows.push(
        `| ${run} | ${mode} | ${v.id} (${v.lang}) | ${cov(b)} → ${cell(as, cov)} | ${pct(b?.readyBeforeShown)} → ${cell(as, r => pct(r?.readyBeforeShown))} | ${b?.timeOnScreen.tooShort ?? '–'} → ${cell(as, r => r?.timeOnScreen.tooShort ?? '–')} | ${cell(as, r => r?.staleWhilePaused ?? '–')} | ${cell(as, r => (r?.judgeScore == null ? '–' : r.judgeScore.toFixed(2)))} |`
      );
    }
  }
}
console.log('| run | mode | video | coverage ≥0.5 s | ready | too short | stale while paused | judge |');
console.log('|---|---|---|---|---|---|---|---|');
console.log(rows.join('\n'));
