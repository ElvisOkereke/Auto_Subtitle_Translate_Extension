// TranslationService - the engine layer as the service worker uses it:
// "fast" (DeepL/Google) and "best" (Claude with video context, topic and
// glossary) tiers, Claude batching by priority, fallback to the fast engine,
// usage metering. Dependencies are injected so the rules are unit-tested.
import { APIError, ExtensionSettings } from '../types';
import type { Secrets } from '../settings';
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
}

export interface LineTranslateResponse {
  success: boolean;
  translatedText?: string;
  quality?: 'fast' | 'better';
  engine?: 'deepl' | 'google' | 'claude';
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
  makeFast(provider: 'deepl' | 'google', apiKey: string, endpoint?: string): FastLike;
  batch?: { maxLines: number; windowMs: number };
  /** At most 4 requests in flight; live lines first. */
  runner?: PriorityRunner;
}

interface BatchContext {
  sourceLang: string;
  targetLang: string;
  video: VideoContext;
  videoKey: string;
  claude: ClaudeLike;
}

export class TranslationService {
  private readonly runner: PriorityRunner;
  private readonly batcher: ClaudeBatcher;
  private readonly batchContexts = new Map<string, BatchContext>();
  private readonly topics = new Map<string, Promise<void>>();
  private lineSeq = 0;
  private authWarned = false;

  constructor(private readonly deps: TranslationServiceDeps) {
    this.runner = deps.runner ?? new PriorityRunner(4);
    const { maxLines, windowMs } = deps.batch ?? { maxLines: 8, windowMs: 150 };
    this.batcher = new ClaudeBatcher({ maxLines, windowMs, run: (key, lines, priority) => this.runClaudeBatch(key, lines, priority) });
  }

  /** Claude engine config from settings, or null when Claude access isn't set up. */
  private claudeConfig(settings: ExtensionSettings, secrets: Secrets, overrides: EndpointOverrides): ClaudeConfig | null {
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
    if (mode === 'best') return { fast: false, best: hasClaude };
    return { fast: true, best: hasClaude };
  }

  async translateLine(req: LineTranslateRequest): Promise<LineTranslateResponse> {
    const [settings, secrets, overrides] = await Promise.all([this.deps.settings(), this.deps.secrets(), this.deps.overrides()]);
    const targetLang = settings.targetLanguage;
    if (req.sourceLang.split('-')[0] === targetLang.split('-')[0]) {
      return { success: true, translatedText: req.text, quality: 'fast' };
    }
    const provider = settings.translationProvider === 'deepl' ? 'deepl' : 'google';
    const fastKey = provider === 'deepl' ? secrets.deeplApiKey : secrets.googleTranslateApiKey;
    const fast = async (): Promise<LineTranslateResponse> => {
      const engine = this.deps.makeFast(provider, fastKey, overrides[provider]);
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
    let warning: string | undefined;
    let claudeError = 'Claude access is not configured';
    if (cfg) {
      try {
        const text = await this.translateWithClaude(req, targetLang, cfg);
        if (text) return { success: true, translatedText: text, quality: 'better', engine: 'claude' };
        claudeError = 'Claude returned no translation for this line';
      } catch (error) {
        claudeError = `Claude: ${errorMessage(error)}`;
        if (error instanceof APIError ? error.status === 401 : (error as { status?: number })?.status === 401) {
          if (!this.authWarned) warning = 'Claude rejected the API key or token (401) - check the Claude settings.';
          this.authWarned = true;
        }
      }
    }
    if (!fastKey) return { success: false, error: claudeError, ...(warning ? { warning } : {}) };
    try {
      return { ...(await fast()), ...(warning ? { warning } : {}) };
    } catch (error) {
      return { success: false, error: `${claudeError}; ${errorMessage(error)}` };
    }
  }

  private async translateWithClaude(req: LineTranslateRequest, targetLang: string, cfg: ClaudeConfig): Promise<string | null> {
    const claude = this.deps.makeClaude(cfg);
    const videoKey = req.video.videoId ?? req.video.url;
    await this.ensureTopic(videoKey, req, targetLang, claude);
    const key = JSON.stringify([videoKey, req.sourceLang, targetLang, cfg.model, cfg.baseURL]);
    this.batchContexts.set(key, { sourceLang: req.sourceLang, targetLang, video: req.video, videoKey, claude });
    const line: LineRequest = { id: `L${++this.lineSeq}`, text: req.text, previous: req.previousLines, next: req.nextLines };
    return this.batcher.add(key, line, req.priority);
  }

  /** Once per video: what it is about + a starting glossary (failures don't block translation). */
  private ensureTopic(videoKey: string, req: LineTranslateRequest, targetLang: string, claude: ClaudeLike): Promise<void> {
    let pending = this.topics.get(videoKey);
    if (!pending) {
      pending = (async () => {
        if (await this.deps.glossary.getVideoMeta(videoKey)) return;
        let topic: TopicResult;
        try {
          topic = await this.runner.run(
            () => claude.summarizeTopic(req.video, [...req.previousLines, req.text, ...req.nextLines], req.sourceLang, targetLang),
            req.priority
          );
        } catch (error) {
          console.warn('Topic summary failed:', error);
          this.topics.delete(videoKey); // try again with a later line
          return;
        }
        await this.deps.glossary.setVideoMeta(videoKey, { topic: topic.topic, topicKey: topic.topicKey });
        await this.deps.glossary.learn(videoKey, topic.glossary);
        if (topic.usage) await this.deps.usage.record(topic.usage, 0);
      })();
      this.topics.set(videoKey, pending);
    }
    return pending;
  }

  private async runClaudeBatch(key: string, lines: LineRequest[], priority: 'live' | 'readahead'): Promise<Map<string, string>> {
    const ctx = this.batchContexts.get(key)!;
    const [meta, glossary] = await Promise.all([this.deps.glossary.getVideoMeta(ctx.videoKey), this.deps.glossary.effective(ctx.videoKey)]);
    const result = await this.runner.run(
      () => ctx.claude.translateBatch({ sourceLang: ctx.sourceLang, targetLang: ctx.targetLang, lines, video: ctx.video, topic: meta?.topic || null, glossary }),
      priority
    );
    await this.deps.glossary.learn(ctx.videoKey, result.glossaryUpdates);
    if (result.usage) await this.deps.usage.record(result.usage, result.translations.length);
    return new Map(result.translations.map(t => [t.id, t.text]));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
