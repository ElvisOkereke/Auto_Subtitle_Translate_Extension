import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { test } from '@playwright/test';
import { ROOT } from '../helpers/paths';

// Opt-in (E2E_JUDGE=1): Claude scores the subtitle translations produced by the
// real-DeepL quality run (live-subtitles.spec.ts) against League-aware reference
// English. Report only - engine quality is the translation-layer piece's job.
// Credentials come from the environment (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL).
test.skip(process.env.E2E_JUDGE !== '1', 'set E2E_JUDGE=1 to run the Claude judge');

interface Pair {
  ko: string;
  en: string;
  reference: string;
}

const INSTRUCTIONS =
  'Score each English subtitle translation of a Korean League of Legends stream subtitle. ' +
  'Use 2 = correct and natural (League terms right), 1 = gist right but a notable error, 0 = wrong or misleading. ' +
  'The reference is one good translation, not the only acceptable one. ' +
  'Reply with only a JSON array of integers, one per item, in order.';

test('Claude judges subtitle translation quality', async () => {
  const source = ['chrome', 'chromium']
    .map(b => path.join(ROOT, `e2e/.perf/subtitle-quality-deepl-${b}.json`))
    .find(p => fs.existsSync(p));
  test.skip(!source, 'run the live project first (npx playwright test --project=live)');
  const { pairs } = JSON.parse(fs.readFileSync(source!, 'utf8')) as { pairs: Pair[] };
  const items = pairs.map((p, i) => `${i + 1}. Korean: ${p.ko}\n   Reference: ${p.reference}\n   Candidate: ${p.en}`).join('\n');

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'low' },
    // The gateway requires an explicit cache breakpoint on long prompts.
    system: [{ type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: items, cache_control: { type: 'ephemeral' } }] }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Judge refused');
  const text = response.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
  const scores = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as number[];
  if (scores.length !== pairs.length) throw new Error(`Judge returned ${scores.length} scores for ${pairs.length} lines`);
  const report = {
    judge: 'claude-opus-5-5',
    engine: 'deepl',
    lines: pairs.length,
    translationJudgeScore: scores.reduce((a, b) => a + b, 0) / (2 * scores.length),
    perLine: pairs.map((p, i) => ({ ...p, score: scores[i] })),
  };
  console.log(`translationJudgeScore ${report.translationJudgeScore.toFixed(3)} over ${pairs.length} lines`);
  fs.writeFileSync(path.join(ROOT, 'e2e/.perf/subtitle-judge.json'), JSON.stringify(report, null, 2));
});
