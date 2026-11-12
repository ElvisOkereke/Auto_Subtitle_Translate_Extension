import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { test, expect } from '@playwright/test';
import { FIXTURES, ROOT } from '../helpers/paths';
import { readEnv } from '../helpers/env';
import { ClaudeEngine } from '../../src/translation/engines/claude';
import { DeepLEngine } from '../../src/translation/engines/deepl';
import { costUsd } from '../../src/translation/costs';
import type { GlossaryEntry, LineRequest, Usage, VideoContext } from '../../src/translation/types';

// Opt-in (E2E_JUDGE=1): does context-aware Claude beat DeepL beyond League?
// Real subtitle lines from three non-gaming videos (e2e/fixtures/domains,
// fetched by e2e/scripts/fetch_domain_lines.py) are translated by DeepL (with
// neighbouring lines) and by Claude through the extension's own engine code
// (video context + topic + glossary learned along the way), then a blind,
// reference-free pairwise judge picks the better English subtitle per line.
// Runs in Node: the engine layer is browser-independent (piece 4's proxy reuses it).
test.skip(process.env.E2E_JUDGE !== '1', 'set E2E_JUDGE=1 to run the cross-domain benchmark');

const DOMAINS = ['football-es', 'anime-ja', 'drama-ko'];
const MODEL = 'claude-opus-5-5' as const;
const BATCH = 8;

interface Fixture {
  name: string;
  url: string;
  title: string;
  channel: string;
  description: string;
  sourceLang: string;
  subtitles: string;
  lines: string[];
}

/** Deterministic A/B order per line. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const lineRequests = (lines: string[], from: number, to: number): LineRequest[] =>
  lines.slice(from, to).map((text, k) => {
    const i = from + k;
    return { id: `L${i}`, text, previous: lines.slice(Math.max(0, i - 2), i), next: lines.slice(i + 1, i + 3) };
  });

test('context-aware Claude beats DeepL in every domain', async () => {
  test.setTimeout(900_000);
  const deeplKey = readEnv('DEEPL_API_KEY');
  test.skip(!deeplKey, 'DEEPL_API_KEY not set in .env');
  test.skip(!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY, 'no Anthropic credentials');
  const auth = process.env.ANTHROPIC_AUTH_TOKEN
    ? { kind: 'bearer' as const, token: process.env.ANTHROPIC_AUTH_TOKEN }
    : { kind: 'x-api-key' as const, token: process.env.ANTHROPIC_API_KEY! };
  const baseURL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const claude = new ClaudeEngine({ model: MODEL, baseURL, auth });
  const deepl = new DeepLEngine({ apiKey: deeplKey! });
  const judge = new Anthropic({ baseURL, ...(auth.kind === 'bearer' ? { authToken: auth.token, apiKey: null } : { apiKey: auth.token }) });

  const report: Record<string, unknown> = { judge: MODEL, model: MODEL, domains: {} };
  const usages: Usage[] = [];
  for (const name of DOMAINS) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'domains', `${name}.json`), 'utf8')) as Fixture;
    const video: VideoContext = { videoId: new URL(fx.url).searchParams.get('v'), url: fx.url, title: fx.title, channel: fx.channel, description: fx.description };
    const all = lineRequests(fx.lines, 0, fx.lines.length);

    const deeplOut = await deepl.translateBatch({ sourceLang: fx.sourceLang, targetLang: 'en', lines: all, video, topic: null, glossary: [] });

    const topic = await claude.summarizeTopic(video, fx.lines.slice(0, 10), fx.sourceLang, 'en');
    if (topic.usage) usages.push(topic.usage);
    let glossary: GlossaryEntry[] = topic.glossary;
    const claudeText = new Map<string, string>();
    for (let i = 0; i < fx.lines.length; i += BATCH) {
      const out = await claude.translateBatch({ sourceLang: fx.sourceLang, targetLang: 'en', lines: lineRequests(fx.lines, i, i + BATCH), video, topic: topic.topic, glossary });
      if (out.usage) usages.push(out.usage);
      for (const t of out.translations) claudeText.set(t.id, t.text);
      const learned = new Map(glossary.map(g => [g.source, g]));
      for (const g of out.glossaryUpdates) learned.set(g.source, g);
      glossary = [...learned.values()];
    }

    // Blind pairwise judging, A/B order randomized per line.
    const random = rng(DOMAINS.indexOf(name) + 7);
    const items = all.map((l, i) => {
      const c = claudeText.get(l.id) ?? '';
      const d = deeplOut.translations.find(t => t.id === l.id)?.text ?? '';
      const claudeIsA = random() < 0.5;
      return { i, source: l.text, before: l.previous.join(' / '), a: claudeIsA ? c : d, b: claudeIsA ? d : c, claudeIsA };
    });
    const prompt = items
      .map(it => `${it.i + 1}. Source: ${it.source}${it.before ? `\n   (previous lines: ${it.before})` : ''}\n   A: ${it.a}\n   B: ${it.b}`)
      .join('\n');
    const response = await judge.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: [
        {
          type: 'text',
          text:
            `You compare two English subtitle translations of each line of a video titled "${fx.title}" (channel: ${fx.channel}). ` +
            'For each line pick the one that is more accurate and natural as a subtitle for this video (names, terms and tone right). ' +
            'Reply with only a JSON array with one entry per line, in order: "A", "B", or "tie".',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] }],
    });
    const text = response.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
    const verdicts = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as string[];
    expect(verdicts).toHaveLength(items.length);
    let wins = 0;
    let ties = 0;
    items.forEach((it, k) => {
      const v = String(verdicts[k]).toUpperCase();
      if (v === 'TIE') ties++;
      else if ((v === 'A') === it.claudeIsA) wins++;
    });
    const winRate = (wins + ties / 2) / items.length;
    (report.domains as Record<string, unknown>)[name] = {
      subtitles: fx.subtitles,
      lines: items.length,
      claudeWins: wins,
      ties,
      deeplWins: items.length - wins - ties,
      claudeWinRate: winRate,
      topic: topic.topic,
      glossary,
      examples: items.slice(0, 6).map(it => ({ source: it.source, claude: claudeText.get(`L${it.i}`), deepl: it.claudeIsA ? it.b : it.a })),
    };
    console.log(`${name}: Claude ${wins} / ties ${ties} / DeepL ${items.length - wins - ties} -> win rate ${winRate.toFixed(2)}`);
  }
  const totalLines = DOMAINS.length * 35;
  report.claudeCostUsd = usages.reduce((n, u) => n + costUsd(u), 0);
  report.claudeCostPerLineUsd = (report.claudeCostUsd as number) / totalLines;
  fs.mkdirSync(path.join(ROOT, 'e2e/.perf'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'e2e/.perf/domain-bench.json'), JSON.stringify(report, null, 2));
  for (const name of DOMAINS) {
    expect((report.domains as Record<string, { claudeWinRate: number }>)[name].claudeWinRate).toBeGreaterThan(0.5);
  }
});
