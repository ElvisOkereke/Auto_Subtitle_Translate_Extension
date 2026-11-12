// Subscriber translation proxy: the extension's own engines (src/translation)
// with the service's keys, behind subscription gating, request validation,
// per-account metering and a monthly cost budget.
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { ClaudeEngine } from '../../src/translation/engines/claude';
import { DeepLEngine } from '../../src/translation/engines/deepl';
import { costUsd } from '../../src/translation/costs';
import type { ClaudeModel, GlossaryEntry, LineRequest, Usage, VideoContext } from '../../src/translation/types';
import type { AuthEnv } from './auth';
import type { ServerConfig } from './config';
import type { Account, Repo } from './db';
import { DEEPL_USD_PER_CHAR, PLANS, isPaidPlan } from './plans';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_LINES = 16;
const MAX_TEXT = 500;
const MAX_NEIGHBOURS = 4;
const MAX_GLOSSARY = 200;
const MAX_FIELD = 2000;

class BadRequest extends Error {}

const str = (v: unknown, max: number, name: string): string => {
  if (typeof v !== 'string' || v.length > max) throw new BadRequest(`${name} must be a string of at most ${max} characters`);
  return v;
};
const strList = (v: unknown, maxItems: number, maxLen: number, name: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > maxItems) throw new BadRequest(`${name} must be a list of at most ${maxItems} items`);
  return v.map((s, i) => str(s, maxLen, `${name}[${i}]`));
};
const lang = (v: unknown, name: string): string => {
  const s = str(v, 16, name);
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$|^auto$/.test(s)) throw new BadRequest(`${name} is not a language code`);
  return s;
};

function video(v: any): VideoContext {
  if (!v || typeof v !== 'object') throw new BadRequest('video is required');
  return {
    videoId: v.videoId === null || v.videoId === undefined ? null : str(v.videoId, 300, 'video.videoId'),
    url: str(v.url ?? '', MAX_FIELD, 'video.url'),
    title: str(v.title ?? '', 300, 'video.title'),
    channel: str(v.channel ?? '', 300, 'video.channel'),
    description: str(v.description ?? '', MAX_FIELD, 'video.description'),
  };
}

function lines(v: unknown): LineRequest[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_LINES) throw new BadRequest(`lines must have 1-${MAX_LINES} items`);
  return v.map((l: any, i) => ({
    id: str(l?.id, 40, `lines[${i}].id`),
    text: str(l?.text, MAX_TEXT, `lines[${i}].text`),
    previous: strList(l?.previous, MAX_NEIGHBOURS, MAX_TEXT, `lines[${i}].previous`),
    next: strList(l?.next, MAX_NEIGHBOURS, MAX_TEXT, `lines[${i}].next`),
  }));
}

function glossary(v: unknown): GlossaryEntry[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_GLOSSARY) throw new BadRequest(`glossary must have at most ${MAX_GLOSSARY} entries`);
  return v.map((g: any, i) => ({ source: str(g?.source, 40, `glossary[${i}].source`), target: str(g?.target, 80, `glossary[${i}].target`), ...(g?.note ? { note: str(g.note, 40, `glossary[${i}].note`) } : {}) }));
}

async function readBody(c: Context): Promise<any> {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new BadRequest('request too large');
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequest('body must be JSON');
  }
}

export interface ProxyDeps {
  config: ServerConfig;
  repo: Repo;
  clock: () => number;
  monthOf: (t: number) => string;
  status: (account: Account) => { active: boolean; exhausted: boolean };
  fetch?: typeof fetch;
}

export function mountTranslate(app: Hono<AuthEnv>, requireAccount: MiddlewareHandler<AuthEnv>, deps: ProxyDeps): void {
  const { config, repo } = deps;

  const claudeFor = (account: Account, requested: unknown): ClaudeEngine => {
    const plan = isPaidPlan(account.plan) ? PLANS[account.plan] : PLANS.standard;
    const model = plan.models.includes(requested as ClaudeModel) ? (requested as ClaudeModel) : plan.bestModel;
    const auth = config.anthropic.authToken
      ? { kind: 'bearer' as const, token: config.anthropic.authToken }
      : { kind: 'x-api-key' as const, token: config.anthropic.apiKey ?? '' };
    return new ClaudeEngine({ model, baseURL: config.anthropic.baseURL, auth, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  };
  const deepl = () => new DeepLEngine({ apiKey: config.deepl.apiKey, endpoint: config.deepl.endpoint, ...(deps.fetch ? { fetch: deps.fetch } : {}) });

  const meterClaude = (account: Account, usage: Usage | undefined) => {
    if (usage) repo.addUsage(account.id, deps.monthOf(deps.clock()), { costUsd: costUsd(usage), claudeRequests: 1, fastChars: 0 });
  };

  /** Subscription + budget gate, then the handler; validation and upstream errors map to 400/502. */
  const guarded = (handler: (c: Context<AuthEnv>, account: Account, body: any) => Promise<Response>) => async (c: Context<AuthEnv>) => {
    const account = c.get('account');
    const status = deps.status(account);
    if (!status.active) return c.json({ error: 'not_subscribed', message: 'Subscribe to use the hosted translation.' }, 402);
    if (status.exhausted) return c.json({ error: 'budget_exhausted', message: "This month's translation allowance is used up." }, 402);
    try {
      return await handler(c, account, await readBody(c));
    } catch (error) {
      if (error instanceof BadRequest) return c.json({ error: 'bad_request', message: error.message }, 400);
      const upstreamStatus = (error as { status?: number })?.status;
      console.warn('Upstream translation failed:', upstreamStatus ?? '', error instanceof Error ? error.message : error);
      return c.json({ error: 'upstream', message: 'Translation service error, try again.', upstreamStatus: upstreamStatus ?? null }, 502);
    }
  };

  app.post(
    '/v1/translate/fast',
    requireAccount,
    guarded(async (c, account, body) => {
      const text = str(body?.text, MAX_TEXT, 'text');
      const result = await deepl().translateOne(text, lang(body?.sourceLang, 'sourceLang'), lang(body?.targetLang, 'targetLang'), {
        previousLines: strList(body?.previousLines, MAX_NEIGHBOURS, MAX_TEXT, 'previousLines'),
        nextLines: strList(body?.nextLines, MAX_NEIGHBOURS, MAX_TEXT, 'nextLines'),
      });
      // DeepL bills the translated text only (context is free).
      repo.addUsage(account.id, deps.monthOf(deps.clock()), { costUsd: text.length * DEEPL_USD_PER_CHAR, claudeRequests: 0, fastChars: text.length });
      return c.json({ text: result.text });
    })
  );

  app.post(
    '/v1/translate/batch',
    requireAccount,
    guarded(async (c, account, body) => {
      const req = {
        sourceLang: lang(body?.sourceLang, 'sourceLang'),
        targetLang: lang(body?.targetLang, 'targetLang'),
        lines: lines(body?.lines),
        video: video(body?.video),
        topic: body?.topic === null || body?.topic === undefined ? null : str(body.topic, 300, 'topic'),
        glossary: glossary(body?.glossary),
      };
      const result = await claudeFor(account, body?.model).translateBatch(req);
      meterClaude(account, result.usage);
      return c.json({ translations: result.translations, glossaryUpdates: result.glossaryUpdates });
    })
  );

  app.post(
    '/v1/translate/topic',
    requireAccount,
    guarded(async (c, account, body) => {
      const result = await claudeFor(account, body?.model).summarizeTopic(
        video(body?.video),
        strList(body?.firstLines, MAX_LINES, MAX_TEXT, 'firstLines'),
        lang(body?.sourceLang, 'sourceLang'),
        lang(body?.targetLang, 'targetLang')
      );
      meterClaude(account, result.usage);
      return c.json({ topic: result.topic, topicKey: result.topicKey, glossary: result.glossary });
    })
  );
}
