// TranslationService - the engine layer as the service worker uses it:
// "fast" (DeepL/Google) and "best" (Claude with video context, topic and
// glossary) tiers, Claude batching by priority, fallback to the fast engine,
// usage metering. Dependencies are injected so the rules are unit-tested.
import { ExtensionSettings } from '../types';
import { hostedServiceUrl, type Secrets } from '../settings';
import type { EndpointOverrides } from '../services/apiService';
import { PriorityRunner } from '../utils/priorityRunner';
import { ClaudeBatcher } from './claudeBatcher';
import { costUsd } from './costs';
import { ANTHROPIC_BASE_URL, validateGatewayUrl } from './claudeAccess';
import type { ClaudeConfig, ClaudeEngine } from './engines/claude';
import type { SingleLineOptions } from './engines/deepl';
import type { GlossaryStore, StorageArea } from './glossary';
import type { LineRequest, TopicResult, Usage, VideoContext } from './types';

export type Tier = 'fast' | 'best';

export interface TranslationPlan {
  fast: boolean;
  best: boolean;
}

export interface LineTranslateRequest {
  tier: Tier;
  text: string;
  sourceLang: string;
  previousLines: string[];
  nextLines: string[];
  priority: 'live' | 'readahead';
  video: VideoContext;
  /** The caller already requested the fast tier for this line: on Claude failure, don't pay for it twice. */
  noFallback?: boolean;
}

/** Last Claude failure, for the popup (null = Claude is working). */
export interface ClaudeErrorReport {
  status: number | null;
  message: string;
  at: number;
}

export interface LineTranslateResponse {
  success: boolean;
  translatedText?: string;
  quality?: 'fast' | 'better';
  engine?: 'deepl' | 'google' | 'subscription' | 'claude';
  error?: string;
  /** Shown to the user once (e.g. Claude rejected the key); the line still has a translation. */
  warning?: string;
}

export interface UsageTotals {
  lines: number;
  requests: number;
  costUsd: number;
  byModel: Record<string, Usage & { costUsd: number; requests: number; lines: number }>;
}

export interface UsageMeter {
  record(usage: Usage, lines: number): Promise<void>;
  totals(): Promise<UsageTotals>;
}

const USAGE_KEY = 'translationUsage';

/** Running totals of Claude usage and cost in a storage area (chrome.storage.local). */
export class StorageUsageMeter implements UsageMeter {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly area: StorageArea) {}

  record(usage: Usage, lines: number): Promise<void> {
    // Serialized read-modify-write: concurrent batches must not lose counts.
    this.chain = this.chain.then(async () => {
      const t = await this.totals();
      const cost = costUsd(usage);
      const m = (t.byModel[usage.model] ??= { model: usage.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0, lines: 0 });
      m.inputTokens += usage.inputTokens;
      m.outputTokens += usage.outputTokens;
      m.cacheReadTokens += usage.cacheReadTokens;
      m.cacheWriteTokens += usage.cacheWriteTokens;
      m.costUsd += cost;
      m.requests += 1;
      m.lines += lines;
      t.lines += lines;
      t.requests += 1;
      t.costUsd += cost;
      await this.area.set({ [USAGE_KEY]: t });
    });
    return this.chain;
  }

  async totals(): Promise<UsageTotals> {
    const stored = await this.area.get(USAGE_KEY);
    return stored[USAGE_KEY] ?? { lines: 0, requests: 0, costUsd: 0, byModel: {} };
  }
}

type ClaudeLike = Pick<ClaudeEngine, 'translateBatch' | 'summarizeTopic'>;
interface FastLike {
  translateOne(text: string, sourceLang: string, targetLang: string, options?: SingleLineOptions): Promise<{ text: string }>;
}

export interface TranslationServiceDeps {
  settings(): Promise<ExtensionSettings>;
  secrets(): Promise<Secrets>;
  overrides(): Promise<EndpointOverrides>;
  glossary: GlossaryStore;
  usage: UsageMeter;
  makeClaude(cfg: ClaudeConfig): ClaudeLike;
  makeFast(provider: 'deepl' | 'google' | 'subscription', apiKey: string, endpoint?: string): FastLike;
  batch?: { maxLines: number; windowMs: number };
  /** How long a line waits for the video's topic summary before going without it (ms). */
  topicWaitMs?: number;
  /** Where the last Claude error goes (the popup shows it); null clears it. */
  reportClaudeError?(error: ClaudeErrorReport | null): Promise<void>;
  clock?: () => number;
}

const TOPIC_WAIT_MS = 1500;
/** After a 429/5xx/timeout, Claude is left alone this long (fast tier carries on). */
const COOLDOWN_MS = 30_000;
const PAYMENT_COOLDOWN_MS = 10 * 60_000;
/** A failed topic summary is retried at most this often per video. */
const TOPIC_RETRY_MS = 60_000;
const MAX_TRACKED_VIDEOS = 50;

const statusOf = (error: unknown): number | null => {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : null;
};
/** Errors that won't fix themselves until the user changes the Claude settings. */
const isConfigError = (status: number | null) => status === 400 || status === 401 || status === 403 || status === 404;

interface BatchContext {
  sourceLang: string;
  targetLang: string;
  video: VideoContext;
  videoKey: string;
  claude: ClaudeLike;
}

export class TranslationService {
  /** Fast engine: at most 4 requests in flight, live lines first. */
  private readonly runner = new PriorityRunner(4);
  /** Claude has its own lanes, so slow Claude calls never delay fast translations. */
  private readonly claudeRunner = new PriorityRunner(4);
  private readonly batcher: ClaudeBatcher;
  private readonly batchContexts = new Map<string, BatchContext>();
  private readonly topics = new Map<string, Promise<void>>();
  private readonly topicFailedAt = new Map<string, number>();
  private lineSeq = 0;
  private authWarned = false;
  /** Claude is skipped until this time (transient errors)... */
  private coolUntil = 0;
  /** ...or while the settings are the ones that produced a config error (401/403/400). */
  private brokenConfig: string | null = null;

  constructor(private readonly deps: TranslationServiceDeps) {
    const { maxLines, windowMs } = deps.batch ?? { maxLines: 8, windowMs: 150 };
    this.batcher = new ClaudeBatcher({ maxLines, windowMs, run: (key, lines, priority) => this.runClaudeBatch(key, lines, priority) });
  }

  /** Claude engine config from settings, or null when Claude access isn't set up. */
  private claudeConfig(settings: ExtensionSettings, secrets: Secrets, overrides: EndpointOverrides): ClaudeConfig | null {
    if (settings.claudeAccess === 'subscription') {
      const baseURL = hostedServiceUrl(overrides.server);
      if (!secrets.accountToken || !baseURL) return null;
      return { model: settings.claudeModel, baseURL, auth: { kind: 'bearer', token: secrets.accountToken }, via: 'proxy' };
    }
    if (settings.claudeAccess === 'gateway') {
      const baseURL = validateGatewayUrl(settings.claudeGatewayUrl ?? '');
      if (!baseURL || !secrets.claudeGatewayToken) return null;
      return { model: settings.claudeModel, baseURL, auth: { kind: settings.claudeGatewayAuth === 'x-api-key' ? 'x-api-key' : 'bearer', token: secrets.claudeGatewayToken } };
    }
    if (!secrets.anthropicApiKey) return null;
    return { model: settings.claudeModel, baseURL: overrides.anthropic ?? ANTHROPIC_BASE_URL, auth: { kind: 'x-api-key', token: secrets.anthropicApiKey } };
  }

  async plan(): Promise<TranslationPlan> {
    const [settings, secrets, overrides] = await Promise.all([this.deps.settings(), this.deps.secrets(), this.deps.overrides()]);
    const hasClaude = this.claudeConfig(settings, secrets, overrides) !== null;
    const mode = settings.translationEngineMode;
    if (mode === 'fast') return { fast: true, best: false };
    // Best only needs Claude; without it, fall back to the fast engine rather than translate nothing.
    if (mode === 'best') return hasClaude ? { fast: false, best: true } : { fast: true, best: false };
    return { fast: true, best: hasClaude };
  }

  async translateLine(req: LineTranslateRequest): Promise<LineTranslateResponse> {
    const [settings, secrets, overrides] = await Promise.all([this.deps.settings(), this.deps.secrets(), this.deps.overrides()]);
    const targetLang = settings.targetLanguage;
    if (req.sourceLang.split('-')[0] === targetLang.split('-')[0]) {
      return { success: true, translatedText: req.text, quality: 'fast' };
    }
    const provider = settings.translationProvider === 'deepl' || settings.translationProvider === 'subscription' ? settings.translationProvider : 'google';
    const hosted = hostedServiceUrl(overrides.server);
    const fastKey = provider === 'deepl' ? secrets.deeplApiKey : provider === 'subscription' ? (hosted ? secrets.accountToken : '') : secrets.googleTranslateApiKey;
    const fastEndpoint = provider === 'subscription' ? (hosted ?? undefined) : overrides[provider];
    const fast = async (): Promise<LineTranslateResponse> => {
      const engine = this.deps.makeFast(provider, fastKey, fastEndpoint);
      const result = await this.runner.run(
        () => engine.translateOne(req.text, req.sourceLang, targetLang, { previousLines: req.previousLines, nextLines: req.nextLines }),
        req.priority
      );
      return { success: true, translatedText: result.text, quality: 'fast', engine: provider };
    };

    if (req.tier === 'fast') {
      try {
        return await fast();
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    }

    const cfg = this.claudeConfig(settings, secrets, overrides);
    const cfgSignature = cfg ? JSON.stringify([cfg.baseURL, cfg.model, cfg.auth]) : null;
    if (this.brokenConfig !== null && this.brokenConfig !== cfgSignature) {
      this.brokenConfig = null; // settings changed: try Claude again
      this.authWarned = false;
    }
    let warning: string | undefined;
    let claudeError = 'Claude access is not configured';
    const now = this.now();
    if (cfg && this.brokenConfig === cfgSignature) {
      claudeError = 'Claude rejected the current settings - check the Claude key or gateway in the popup';
    } else if (cfg && now < this.coolUntil) {
      claudeError = 'Claude is cooling down after an error';
    } else if (cfg) {
      try {
        const text = await this.translateWithClaude(req, targetLang, cfg);
        if (text) {
          void this.report(null);
          return { success: true, translatedText: text, quality: 'better', engine: 'claude' };
        }
        claudeError = 'Claude returned no translation for this line';
      } catch (error) {
        const status = statusOf(error);
        const code = (error as { code?: unknown })?.code;
        claudeError = `Claude: ${errorMessage(error)}`;
        // The hosted service's bad_request (a request it won't take) and rate_limited
        // (too many at once) are about one request, not the settings: no lockout.
        if (code === 'bad_request' || code === 'rate_limited') {
          // fall back for this line only
        } else if (isConfigError(status)) this.brokenConfig = cfgSignature;
        // 402 from the hosted service: not subscribed / allowance used up - check again in a while.
        else this.coolUntil = this.now() + (status === 402 ? PAYMENT_COOLDOWN_MS : COOLDOWN_MS);
        void this.report({ status, message: errorMessage(error), at: this.now() });
        if (status === 401 || status === 403) {
          if (!this.authWarned) warning = 'Claude rejected the API key or token - check the Claude settings.';
          this.authWarned = true;
        }
      }
    }
    if (!fastKey || req.noFallback) return { success: false, error: claudeError, ...(warning ? { warning } : {}) };
    try {
      return { ...(await fast()), ...(warning ? { warning } : {}) };
    } catch (error) {
      return { success: false, error: `${claudeError}; ${errorMessage(error)}` };
    }
  }

  /** Subtitle mode started: summarise the video's topic from the page now, before the first line. */
  async prepare(video: VideoContext, sourceLang: string): Promise<void> {
    const [settings, secrets, overrides] = await Promise.all([this.deps.settings(), this.deps.secrets(), this.deps.overrides()]);
    const cfg = this.claudeConfig(settings, secrets, overrides);
    if (!cfg || settings.translationEngineMode === 'fast') return;
    const req: LineTranslateRequest = { tier: 'best', text: '', sourceLang, previousLines: [], nextLines: [], priority: 'readahead', video };
    await this.ensureTopic(video.videoId ?? video.url, req, settings.targetLanguage, this.deps.makeClaude(cfg));
  }

  private now(): number {
    return this.deps.clock ? this.deps.clock() : Date.now();
  }

  private errorReported = false;

  private async report(error: ClaudeErrorReport | null): Promise<void> {
    if (!error && !this.errorReported) return; // nothing to clear (no storage write per line)
    this.errorReported = !!error;
    try {
      await this.deps.reportClaudeError?.(error);
    } catch {
      // reporting is best-effort
    }
  }

  private async translateWithClaude(req: LineTranslateRequest, targetLang: string, cfg: ClaudeConfig): Promise<string | null> {
    const claude = this.deps.makeClaude(cfg);
    const videoKey = req.video.videoId ?? req.video.url;
    // The topic (and its starting glossary) improves every batch, but the first
    // lines must not wait seconds for it: give it a short head start only.
    await Promise.race([this.ensureTopic(videoKey, req, targetLang, claude), new Promise(r => setTimeout(r, this.deps.topicWaitMs ?? TOPIC_WAIT_MS))]);
    const key = JSON.stringify([videoKey, req.sourceLang, targetLang, cfg.model, cfg.baseURL]);
    this.batchContexts.delete(key); // re-insert: most recent last
    this.batchContexts.set(key, { sourceLang: req.sourceLang, targetLang, video: req.video, videoKey, claude });
    trimOldest(this.batchContexts, MAX_TRACKED_VIDEOS);
    const line = (): LineRequest => ({ id: `L${++this.lineSeq}`, text: req.text, previous: req.previousLines, next: req.nextLines });
    // Models occasionally skip a line in a batch: ask once more for it alone.
    return (await this.batcher.add(key, line(), req.priority)) ?? this.batcher.add(key, line(), 'live');
  }

  /** Once per video: what it is about + a starting glossary (failures don't block translation). */
  private ensureTopic(videoKey: string, req: LineTranslateRequest, targetLang: string, claude: ClaudeLike): Promise<void> {
    let pending = this.topics.get(videoKey);
    if (!pending) {
      const failedAt = this.topicFailedAt.get(videoKey);
      if (failedAt !== undefined && this.now() - failedAt < TOPIC_RETRY_MS) return Promise.resolve();
      pending = (async () => {
        try {
          if (await this.deps.glossary.getVideoMeta(videoKey)) return;
        } catch {
          // storage trouble: summarise anyway
        }
        let topic: TopicResult;
        try {
          topic = await this.claudeRunner.run(
            () => claude.summarizeTopic(req.video, [...req.previousLines, req.text, ...req.nextLines].filter(Boolean), req.sourceLang, targetLang),
            req.priority
          );
        } catch (error) {
          console.warn('Topic summary failed:', error);
          this.topics.delete(videoKey);
          this.topicFailedAt.set(videoKey, this.now()); // retried after TOPIC_RETRY_MS, not on every line
          trimOldest(this.topicFailedAt, MAX_TRACKED_VIDEOS);
          return;
        }
        // Best-effort persistence: a full storage must not break translation.
        await bestEffort(async () => {
          await this.deps.glossary.setVideoMeta(videoKey, { topic: topic.topic, topicKey: topic.topicKey });
          await this.deps.glossary.learn(videoKey, topic.glossary, req.video.channel);
        });
        if (topic.usage) await bestEffort(() => this.deps.usage.record(topic.usage!, 0));
      })();
      this.topics.set(videoKey, pending);
      trimOldest(this.topics, MAX_TRACKED_VIDEOS);
    }
    return pending;
  }

  private async runClaudeBatch(key: string, lines: LineRequest[], priority: 'live' | 'readahead'): Promise<Map<string, string>> {
    const ctx = this.batchContexts.get(key)!;
    const [meta, glossary] = await Promise.all([
      this.deps.glossary.getVideoMeta(ctx.videoKey).catch(() => null),
      this.deps.glossary.effective(ctx.videoKey).catch(() => []),
    ]);
    const result = await this.claudeRunner.run(
      () => ctx.claude.translateBatch({ sourceLang: ctx.sourceLang, targetLang: ctx.targetLang, lines, video: ctx.video, topic: meta?.topic || null, glossary }),
      priority
    );
    // The translations are paid for: storage trouble while recording must not lose them.
    await bestEffort(() => this.deps.glossary.learn(ctx.videoKey, result.glossaryUpdates, ctx.video.channel));
    if (result.usage) await bestEffort(() => this.deps.usage.record(result.usage!, result.translations.length));
    return new Map(result.translations.map(t => [t.id, t.text]));
  }
}

async function bestEffort(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.warn('Translation bookkeeping failed:', error);
  }
}

/** Keeps a Map to its `max` most recently inserted entries. */
function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
