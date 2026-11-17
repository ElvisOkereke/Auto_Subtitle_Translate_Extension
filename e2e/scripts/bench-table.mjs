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
if (rows.length) {
  console.log('| run | mode | video | coverage ≥0.5 s | ready | too short | stale while paused | judge |');
  console.log('|---|---|---|---|---|---|---|---|');
  console.log(rows.join('\n'));
}

// Audio runs (audio-<run>-<mode>-<id>.json): captions / reference lines, transcript
// CER (lower is better), words covered, delay from speech end (P50 / P90), lines
// leaving before their reading time, captions shown while paused.
const secs = v => (v == null ? '–' : `${v.toFixed(1)} s`);
const audioRows = [];
for (const run of ['youtube', 'local']) {
  if (runFilter && run !== runFilter) continue;
  for (const mode of ['fast-then-best', 'best', 'fast']) {
    for (const v of videos.filter(x => x.mode === 'audio')) {
      const file = `audio-${run}-${mode}-${v.id}.json`;
      const b = read(before, file);
      const as = after.map(l => read(l, file));
      if (!b && !as.some(Boolean)) continue;
      const col = f => `${b ? f(b) : '–'} → ${as.length ? cell(as, r => (r ? f(r) : '–')) : '–'}`;
      audioRows.push(
        `| ${run} | ${mode} | ${v.id} (${v.lang}) | ${col(r => `${r.captions}/${r.referenceLines}`)} | ${col(r => pct(r.transcriptCer))} | ${col(r => pct(r.wordsCovered))} | ${col(r => pct(r.onScreenWhileTalking))} | ${col(r => secs(r.longestGapWhileTalking))} | ${col(r => `${secs(r.delayFromSpeechEndP50)} / ${secs(r.delayFromSpeechEndP90)}`)} | ${col(r => (r.startOffset?.matched ? `${secs(r.startOffset.absP50)} / ${pct(r.startOffset.within05)}` : '–'))} | ${col(r => r.timeOnScreen?.tooShort ?? '–')} | ${col(r => r.shownWhilePaused ?? '–')} |`
      );
    }
  }
}
if (audioRows.length) {
  console.log('\n| run | mode | video | captions / ref lines | transcript CER | words covered | on screen while talking | longest gap | delay P50 / P90 | start offset P50 / within 0.5 s | too short | shown while paused |');
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  console.log(audioRows.join('\n'));
}
