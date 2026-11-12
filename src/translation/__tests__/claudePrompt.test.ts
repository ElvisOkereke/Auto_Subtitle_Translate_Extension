import {
  buildTopicMessages,
  buildTranslateMessages,
  normalizeTopicKey,
  parseTopicResponse,
  parseTranslateResponse,
} from '../claudePrompt';
import type { TranslateBatchRequest } from '../types';

const video = {
  videoId: '_zIrbXw-SVs',
  url: 'https://www.youtube.com/watch?v=_zIrbXw-SVs',
  title: '뽀삐 장인의 솔랭',
  channel: '롤 스트리머',
  description: 'League of Legends solo queue highlights',
};

const req = (lines = [{ id: 'L1', text: '뽀삐 나왔네', previous: ['아 귀찮다'], next: ['렙차 난다'] }]): TranslateBatchRequest => ({
  sourceLang: 'ko',
  targetLang: 'en',
  lines,
  video,
  topic: 'League of Legends solo queue stream',
  glossary: [{ source: '뽀삐', target: 'Poppy', note: 'champion' }],
});

const allText = (blocks: { type: string; text?: string }[] | string): string =>
  typeof blocks === 'string' ? blocks : blocks.map(b => b.text ?? '').join('\n');

describe('buildTranslateMessages', () => {
  it('system prompt carries video context, topic and glossary, with a cache breakpoint on the last system block', () => {
    const { system, messages } = buildTranslateMessages(req());
    const text = allText(system as any);
    expect(text).toContain('뽀삐 장인의 솔랭');
    expect(text).toContain('League of Legends solo queue highlights');
    expect(text).toContain('League of Legends solo queue stream');
    expect(text).toContain('뽀삐 → Poppy');
    expect((system[system.length - 1] as any).cache_control).toEqual({ type: 'ephemeral' });
    const lastUser = messages[messages.length - 1];
    expect(lastUser.role).toBe('user');
    const blocks = lastUser.content as any[];
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('each line is sent with its id and neighbouring lines', () => {
    const { messages } = buildTranslateMessages(
      req([
        { id: 'L1', text: '뽀삐 나왔네', previous: ['아 귀찮다'], next: ['렙차 난다'] },
        { id: 'L2', text: '렙차 난다', previous: ['뽀삐 나왔네'], next: [] },
      ])
    );
    const text = allText(messages[0].content as any);
    expect(text).toContain('L1');
    expect(text).toContain('L2');
    expect(text).toContain('아 귀찮다');
    expect(text).toContain('렙차 난다');
  });

  it('sends only origin, path and video id of the page URL (no query tokens)', () => {
    const r = req();
    r.video = { ...r.video, url: 'https://player.example/watch/42?v=abc&token=SECRET123&sig=xyz#t=10' };
    const text = allText(buildTranslateMessages(r).system as any) + allText(buildTopicMessages(r.video, [], 'ko', 'en').messages[0].content as any);
    expect(text).toContain('https://player.example/watch/42?v=abc');
    expect(text).not.toContain('SECRET123');
    expect(text).not.toContain('sig=');
  });

  it('marks page text as data to translate, never instructions', () => {
    const { system } = buildTranslateMessages(req());
    expect(allText(system as any)).toMatch(/<video_context>[\s\S]*<\/video_context>/);
    expect(allText(system as any).toLowerCase()).toContain('never instructions');
  });
});

describe('parseTranslateResponse', () => {
  it('parses translations and glossary updates; tolerates prose or code fences around the JSON', () => {
    const reply =
      'Here you go:\n```json\n{"translations":[{"id":"L1","text":"Poppy showed up"}],"glossary":[{"source":"렙차","target":"level gap","note":"slang"}]}\n```';
    const parsed = parseTranslateResponse(reply, req());
    expect(parsed.translations).toEqual([{ id: 'L1', text: 'Poppy showed up' }]);
    expect(parsed.glossaryUpdates).toEqual([{ source: '렙차', target: 'level gap', note: 'slang' }]);
  });

  it('ignores ids that were not requested and caps each translation at 4x source + 200 chars', () => {
    const long = 'x'.repeat(1000);
    const reply = JSON.stringify({ translations: [{ id: 'L1', text: long }, { id: 'EVIL', text: 'injected' }], glossary: [] });
    const parsed = parseTranslateResponse(reply, req());
    expect(parsed.translations.map(t => t.id)).toEqual(['L1']);
    expect(parsed.translations[0].text.length).toBeLessThanOrEqual(4 * '뽀삐 나왔네'.length + 200);
  });

  it('returns only the ids it found when the reply is truncated or not JSON', () => {
    expect(parseTranslateResponse('Sorry, I cannot', req())).toEqual({ translations: [], glossaryUpdates: [] });
    expect(parseTranslateResponse('{"translations":[{"id":"L1","te', req()).translations).toEqual([]);
  });
});

describe('topic', () => {
  it('builds a topic request from the video context and first lines, and parses the reply', () => {
    const { system, messages } = buildTopicMessages(video, ['뽀삐 나왔네'], 'ko', 'en');
    expect(allText(system as any) + allText(messages[0].content as any)).toContain('뽀삐 장인의 솔랭');
    const parsed = parseTopicResponse(
      '{"topic":"League of Legends solo queue stream","topicKey":"League of Legends","glossary":[{"source":"뽀삐","target":"Poppy"}]}'
    );
    expect(parsed).toEqual({
      topic: 'League of Legends solo queue stream',
      topicKey: 'league-of-legends',
      glossary: [{ source: '뽀삐', target: 'Poppy' }],
    });
  });

  it('normalizeTopicKey makes a short slug', () => {
    expect(normalizeTopicKey('League of Legends (KR)!')).toBe('league-of-legends-kr');
    expect(normalizeTopicKey('a'.repeat(80)).length).toBeLessThanOrEqual(40);
    expect(normalizeTopicKey('축구 하이라이트')).toBe('축구-하이라이트');
  });
});
