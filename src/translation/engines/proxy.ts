// Hosted proxy client (subscription): the same engine interfaces as the BYOK
// engines, served by the project's server with the user's account token only.
// No chrome.* here (unit-tested in Node; used by the service worker).
import type { ClaudeModel, GlossaryEntry, TopicResult, TranslateBatchRequest, TranslateBatchResult, VideoContext } from '../types';
import type { SingleLineOptions } from './deepl';

// The server's request limits (server/src/translate.ts); requests are trimmed to
// them here so a long line never turns into a 400.
const LIMITS = { text: 500, neighbours: 4, lines: 16, glossary: 200, title: 300, field: 2000, topic: 300 };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function trimVideo(v: VideoContext): VideoContext {
  return {
    videoId: v.videoId === null ? null : clip(v.videoId, LIMITS.title),
    url: clip(v.url, LIMITS.field),
    title: clip(v.title, LIMITS.title),
    channel: clip(v.channel, LIMITS.title),
    description: clip(v.description, LIMITS.field),
  };
}

function trimBatch(req: TranslateBatchRequest): TranslateBatchRequest {
  return {
    ...req,
    lines: req.lines.slice(0, LIMITS.lines).map(l => ({
      id: l.id,
      text: clip(l.text, LIMITS.text),
      previous: l.previous.slice(-LIMITS.neighbours).map(t => clip(t, LIMITS.text)),
      next: l.next.slice(0, LIMITS.neighbours).map(t => clip(t, LIMITS.text)),
    })),
    video: trimVideo(req.video),
    topic: req.topic === null ? null : clip(req.topic, LIMITS.topic),
    glossary: req.glossary
      .slice(0, LIMITS.glossary)
      .map(g => ({ source: clip(g.source, 40), target: clip(g.target, 80), ...(g.note ? { note: clip(g.note, 40) } : {}) })),
  };
}

/** Splits text into pieces of at most `max` characters, at sentence or word boundaries where possible. */
export function splitText(text: string, max = LIMITS.text): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('\n'));
    const at = cut > max / 2 ? cut + 1 : window.lastIndexOf(' ') > max / 2 ? window.lastIndexOf(' ') : max;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

export interface AccountStatus {
  email: string;
  plan: 'free' | 'standard' | 'pro';
  status: string | null;
  active: boolean;
  month: string;
  usageUsd: number;
  budgetUsd: number;
  warn: boolean;
  exhausted: boolean;
}

export class ProxyClient {
  private readonly baseURL: string;

  constructor(private readonly cfg: { baseURL: string; token?: string; fetch?: typeof fetch }) {
    this.baseURL = cfg.baseURL.replace(/\/+$/, '');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(`${this.baseURL}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw new ProxyError(`Can't reach the translation service (${error instanceof Error ? error.message : String(error)})`, 0, 'network');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProxyError(json?.message ?? `Translation service error (${res.status})`, res.status, json?.error ?? 'error');
    return json as T;
  }

  start(email: string): Promise<{ ok: true }> {
    return this.request('POST', '/v1/auth/start', { email });
  }

  async verify(email: string, code: string): Promise<string> {
    return (await this.request<{ token: string }>('POST', '/v1/auth/verify', { email, code })).token;
  }

  async signout(): Promise<void> {
    await this.request('POST', '/v1/auth/signout', {});
  }

  me(): Promise<AccountStatus> {
    return this.request('GET', '/v1/me');
  }

  async checkout(plan: 'standard' | 'pro'): Promise<string> {
    return (await this.request<{ url: string }>('POST', '/v1/billing/checkout', { plan })).url;
  }

  async portal(): Promise<string> {
    return (await this.request<{ url: string }>('POST', '/v1/billing/portal', {})).url;
  }

  translateBatch(req: TranslateBatchRequest, model: ClaudeModel): Promise<TranslateBatchResult> {
    return this.request('POST', '/v1/translate/batch', { ...trimBatch(req), model });
  }

  summarizeTopic(video: VideoContext, firstLines: string[], sourceLang: string, targetLang: string, model: ClaudeModel): Promise<TopicResult> {
    const lines = firstLines.slice(0, LIMITS.lines).map(t => clip(t, LIMITS.text));
    return this.request('POST', '/v1/translate/topic', { video: trimVideo(video), firstLines: lines, sourceLang, targetLang, model });
  }

  async translateOne(text: string, sourceLang: string, targetLang: string, options: SingleLineOptions = {}): Promise<{ text: string }> {
    const previousLines = (options.previousLines ?? []).slice(-LIMITS.neighbours).map(t => clip(t, LIMITS.text));
    const nextLines = (options.nextLines ?? []).slice(0, LIMITS.neighbours).map(t => clip(t, LIMITS.text));
    const pieces = splitText(text);
    const out: string[] = [];
    for (const piece of pieces) {
      out.push((await this.request<{ text: string }>('POST', '/v1/translate/fast', { text: piece, sourceLang, targetLang, previousLines, nextLines })).text);
    }
    return { text: out.join(' ') };
  }
}

/** Claude tier through the proxy (same shape the TranslationService uses for BYOK Claude). */
export function proxyClaude(client: ProxyClient, model: ClaudeModel) {
  return {
    translateBatch: (req: TranslateBatchRequest) => client.translateBatch(req, model),
    summarizeTopic: (video: VideoContext, firstLines: string[], sourceLang: string, targetLang: string) =>
      client.summarizeTopic(video, firstLines, sourceLang, targetLang, model),
  };
}

/** Fast tier through the proxy. */
export function proxyFast(client: ProxyClient) {
  return { translateOne: (text: string, sourceLang: string, targetLang: string, options?: SingleLineOptions) => client.translateOne(text, sourceLang, targetLang, options) };
}

export type { GlossaryEntry };
