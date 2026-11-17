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
  'You compare subtitles. KOREAN lists the original-language lines of a video (its burned-in subtitles, or its own captions) with when they were on screen. ENGLISH lists ' +
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

export interface SubtitleLocation {
  /** Burned-in dialogue subtitles were seen. */
  present: boolean;
  /** Where they appear (normalized to the video frame, generous enough for two lines), when present. */
  box: { x: number; y: number; w: number; h: number } | null;
  /** Their language (Subtitles mode's setting): ko, ja, zh-Hans, zh-Hant, es, fr, de, pt, ru; null if none. */
  language: string | null;
  /** The language spoken, as far as the frames tell (Audio mode's source language). */
  note: string;
}

const LOCATE_INSTRUCTIONS =
  'You look at frames from one YouTube video, as a viewer deciding where its burned-in subtitles are. Burned-in subtitles are ' +
  'dialogue or narration text drawn into the picture (usually centred near the bottom), changing as people speak. They are NOT ' +
  'game UI, scoreboards, chat, usernames, logos, titles, watermarks, captions of products, or YouTube\'s own caption track. ' +
  'Reply with only JSON: {"present": true|false, "box": {"x": 0.2, "y": 0.75, "w": 0.6, "h": 0.14} or null, "language": "ko"|"ja"|"zh-Hans"|"zh-Hant"|"es"|"fr"|"de"|"pt"|"ru"|null, "note": "..."}. ' +
  'box is normalized to the frame (x,y = top-left), generous enough to hold two lines of those subtitles wherever they appear across the frames, ' +
  'but not covering unrelated UI. note: one short sentence on what you saw.';

/** Where a video's burned-in subtitles are, judged from a few frames (what a person does before drawing the box). */
export async function locateSubtitles(frames: string[]): Promise<SubtitleLocation> {
  const content: any[] = [];
  frames.forEach((f, i) => {
    content.push({ type: 'text', text: `Frame ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f } });
  });
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1000,
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: LOCATE_INSTRUCTIONS }],
    messages: [{ role: 'user', content }],
  } as any);
  const text = textOf(response);
  const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const b = j.box;
  const box = j.present && b && [b.x, b.y, b.w, b.h].every((v: unknown) => typeof v === 'number') ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
  return { present: !!j.present && !!box, box, language: j.language ?? null, note: String(j.note ?? '') };
}
