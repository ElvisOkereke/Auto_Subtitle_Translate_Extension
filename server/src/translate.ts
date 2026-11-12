// Subscriber translation proxy: the extension's own engines (src/translation)
// with the service's keys, behind subscription gating, request validation,
// per-account metering and a monthly cost budget.
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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
/**
 * Requests one account may have in flight, per tier (bounds how far concurrent
 * requests can overshoot the budget). Matches the extension: 4 Claude lanes,
 * 4 fast lanes plus Screen Translate.
 */
export const MAX_IN_FLIGHT = { claude: 4, fast: 6 } as const;
/** Server-side Claude timeout: long Opus replies take longer than the extension's BYOK default. */
const SERVER_CLAUDE_TIMEOUT_MS = 60_000;
/** Rough tokens per character of a JSON request (for charging failed calls). */
const TOKENS_PER_CHAR = 1 / 3;

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
  periodOf: (account: Account, now: number) => string;
  status: (account: Account) => { active: boolean; exhausted: boolean };
  fetch?: typeof fetch;
}

export function mountTranslate(app: Hono<AuthEnv>, requireAccount: MiddlewareHandler<AuthEnv>, deps: ProxyDeps): void {
  const { config, repo } = deps;
  const inFlight = new Map<string, number>();
  // Reject oversized bodies while reading them, not after buffering.
  const limitBody = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: c => c.json({ error: 'bad_request', message: 'request too large' }, 413) });

  const modelFor = (account: Account, requested: unknown): ClaudeModel => {
    const plan = isPaidPlan(account.plan) ? PLANS[account.plan] : PLANS.standard;
    return plan.models.includes(requested as ClaudeModel) ? (requested as ClaudeModel) : plan.bestModel;
  };
  const claudeFor = (account: Account, requested: unknown): ClaudeEngine => {
    const model = modelFor(account, requested);
    const auth = config.anthropic.authToken
      ? { kind: 'bearer' as const, token: config.anthropic.authToken }
      : { kind: 'x-api-key' as const, token: config.anthropic.apiKey ?? '' };
    return new ClaudeEngine({ model, baseURL: config.anthropic.baseURL, auth, timeoutMs: SERVER_CLAUDE_TIMEOUT_MS, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  };
  const deepl = () => new DeepLEngine({ apiKey: config.deepl.apiKey, endpoint: config.deepl.endpoint, ...(deps.fetch ? { fetch: deps.fetch } : {}) });

  const record = (account: Account, costUsdValue: number, claudeRequests: number, fastChars: number) => {
    try {
      repo.addUsage(account.id, deps.periodOf(account, deps.clock()), { costUsd: costUsdValue, claudeRequests, fastChars });
    } catch (error) {
      console.error('Usage not recorded:', (error as Error).message);
    }
  };
  const meterClaude = (account: Account, usage: Usage | undefined) => {
    if (usage) record(account, costUsd(usage), 1, 0);
  };
  /** A Claude call that failed may still have been billed: charge an estimate of its input. */
  const chargeFailedClaude = (account: Account, model: ClaudeModel, body: unknown) => {
    const inputTokens = Math.ceil(JSON.stringify(body ?? '').length * TOKENS_PER_CHAR);
    record(account, costUsd({ model, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 1, 0);
  };

  /** Subscription + budget gate, then the handler; validation and upstream errors map to 400/502. */
  const guarded = (tier: 'claude' | 'fast', handler: (c: Context<AuthEnv>, account: Account, body: any) => Promise<Response>) => async (c: Context<AuthEnv>) => {
    const account = c.get('account');
    const status = deps.status(account);
    if (!status.active) return c.json({ error: 'not_subscribed', message: 'Subscribe to use the hosted translation.' }, 402);
    if (status.exhausted) return c.json({ error: 'budget_exhausted', message: "This month's translation allowance is used up." }, 402);
    const lane = `${account.id}:${tier}`;
    const running = inFlight.get(lane) ?? 0;
    if (running >= MAX_IN_FLIGHT[tier]) return c.json({ error: 'rate_limited', message: 'Too many translations at once.' }, 429);
    inFlight.set(lane, running + 1);
    try {
      return await handler(c, account, await readBody(c));
    } catch (error) {
      if (error instanceof BadRequest) return c.json({ error: 'bad_request', message: error.message }, 400);
      const upstreamStatus = (error as { status?: number })?.status;
      console.warn('Upstream translation failed:', upstreamStatus ?? '', error instanceof Error ? error.message : error);
      return c.json({ error: 'upstream', message: 'Translation service error, try again.', upstreamStatus: upstreamStatus ?? null }, 502);
    } finally {
      const left = (inFlight.get(lane) ?? 1) - 1;
      if (left > 0) inFlight.set(lane, left);
      else inFlight.delete(lane);
    }
  };

  app.post(
    '/v1/translate/fast',
    limitBody,
    requireAccount,
    guarded('fast', async (c, account, body) => {
      const text = str(body?.text, MAX_TEXT, 'text');
      const result = await deepl().translateOne(text, lang(body?.sourceLang, 'sourceLang'), lang(body?.targetLang, 'targetLang'), {
        previousLines: strList(body?.previousLines, MAX_NEIGHBOURS, MAX_TEXT, 'previousLines'),
        nextLines: strList(body?.nextLines, MAX_NEIGHBOURS, MAX_TEXT, 'nextLines'),
      });
      // DeepL bills the translated text only (context is free).
      record(account, text.length * DEEPL_USD_PER_CHAR, 0, text.length);
      return c.json({ text: result.text });
    })
  );

  app.post(
    '/v1/translate/batch',
    limitBody,
    requireAccount,
    guarded('claude', async (c, account, body) => {
      const req = {
        sourceLang: lang(body?.sourceLang, 'sourceLang'),
        targetLang: lang(body?.targetLang, 'targetLang'),
        lines: lines(body?.lines),
        video: video(body?.video),
        topic: body?.topic === null || body?.topic === undefined ? null : str(body.topic, 300, 'topic'),
        glossary: glossary(body?.glossary),
      };
      const result = await claudeFor(account, body?.model)
        .translateBatch(req)
        .catch(error => {
          chargeFailedClaude(account, modelFor(account, body?.model), req);
          throw error;
        });
      meterClaude(account, result.usage);
      return c.json({ translations: result.translations, glossaryUpdates: result.glossaryUpdates });
    })
  );

  app.post(
    '/v1/translate/topic',
    limitBody,
    requireAccount,
    guarded('claude', async (c, account, body) => {
      const args = [video(body?.video), strList(body?.firstLines, MAX_LINES, MAX_TEXT, 'firstLines'), lang(body?.sourceLang, 'sourceLang'), lang(body?.targetLang, 'targetLang')] as const;
      const result = await claudeFor(account, body?.model)
        .summarizeTopic(...args)
        .catch(error => {
          chargeFailedClaude(account, modelFor(account, body?.model), args);
          throw error;
        });
      meterClaude(account, result.usage);
      return c.json({ topic: result.topic, topicKey: result.topicKey, glossary: result.glossary });
    })
  );
}
