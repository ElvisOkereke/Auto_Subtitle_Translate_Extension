// screenJudge.ts - Claude reads what was on screen. Stage 1 (vision): for each
// sampled moment, the burned-in subtitle from the bare video frame and the
// extension's translated subtitle from the screenshot of what the viewer saw.
// Stage 2 (text): which Korean line each English line translates, and whether
// the translation is acceptable. Scoring is deterministic (screenMetrics.ts).
// Uses the Anthropic credentials in the environment (authorized for testing).
import Anthropic from '@anthropic-ai/sdk';
import type { Alignment, FrameSample, Line } from './screenMetrics';

const MODEL = process.env.SCREEN_JUDGE_MODEL || 'claude-opus-5-5';
const BATCH = 8;

export interface CapturedSample {
  t: number;
  /** JPEG (base64) of the player as the viewer saw it. */
  screen: string;
  /** JPEG (base64) of the bare video frame's lower part (no overlay): the burned-in subtitle. */
  frame: string;
}

const READ_INSTRUCTIONS =
  'You read subtitles from frames of a YouTube video (Korean speech, Korean subtitles burned into the picture). ' +
  'Each moment comes as two images: FRAME is the bare video picture (lower part) and SCREEN is what the viewer saw, ' +
  'which may include an English subtitle added by a browser extension: white text on a dark translucent box drawn over the video. ' +
  'For each moment report: "burned": the burned-in Korean subtitle text in FRAME exactly as written (the dialogue subtitle, ' +
  'not game UI, player names, scores, chat, logos or titles), or null if none; "overlay": the English extension subtitle ' +
  'text visible in SCREEN exactly as written, or null if none is visible. If the extension shows two lines, join them with " / ". ' +
  'Reply with only a JSON array: [{"i": 1, "burned": ..., "overlay": ...}, ...], one entry per moment, in order.';

const ALIGN_INSTRUCTIONS =
  'You compare subtitles. KOREAN lists the burned-in subtitle lines of a video with when they were on screen. ENGLISH lists ' +
  'the lines a translation extension showed, with when. For each English line, give the index of the Korean line it translates ' +
  '(if it covers several, the first one), or null if it translates none of them; and "ok": true if it is an acceptable translation ' +
  'of that line (meaning right; wording may differ; small slips in names are fine), false otherwise. ' +
  'Reply with only a JSON array: [{"o": 0, "k": 3, "ok": true}, ...], one entry per English line, in order.';

function client(): Anthropic {
  return new Anthropic();
}

function textOf(response: any): string {
  return response.content.flatMap((b: any) => (b.type === 'text' ? [b.text] : [])).join('');
}

function jsonArray<T>(text: string): T[] {
  return JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as T[];
}

/** Stage 1: what was on screen at each moment. */
export async function readFrames(samples: CapturedSample[], onBatch?: (done: number) => void): Promise<FrameSample[]> {
  const out: FrameSample[] = [];
  for (let i = 0; i < samples.length; i += BATCH) {
    const batch = samples.slice(i, i + BATCH);
    const content: any[] = [];
    batch.forEach((s, j) => {
      content.push({ type: 'text', text: `Moment ${j + 1} (video time ${s.t.toFixed(1)} s). FRAME:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.frame } });
      content.push({ type: 'text', text: 'SCREEN:' });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.screen } });
    });
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: READ_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    } as any);
    const rows = jsonArray<{ i: number; burned: string | null; overlay: string | null }>(textOf(response));
    batch.forEach((s, j) => {
      const row = rows.find(r => r.i === j + 1) ?? rows[j];
      out.push({ t: s.t, burned: row?.burned?.trim() || null, overlay: row?.overlay?.trim() || null });
    });
    onBatch?.(out.length);
  }
  return out;
}

/** Stage 2: which Korean line each English line translates. */
export async function alignLines(korean: Line[], overlay: Line[]): Promise<Alignment[]> {
  if (!overlay.length) return [];
  const list = (lines: Line[]) => lines.map((l, i) => `${i}. [${l.from.toFixed(1)}-${l.to.toFixed(1)} s] ${l.text}`).join('\n');
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: ALIGN_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: `KOREAN:\n${list(korean)}\n\nENGLISH:\n${list(overlay)}` }] }],
  } as any);
  const rows = jsonArray<{ o: number; k: number | null; ok: boolean }>(textOf(response));
  return rows.map(r => ({ overlayIndex: r.o, koreanIndex: typeof r.k === 'number' ? r.k : null, correct: !!r.ok }));
}
