// Claude engine: context-aware batch translation and topic summaries through
// the Anthropic Messages API - directly (API key) or via an Anthropic-compatible
// gateway (base URL + token). The user's own credentials (BYOK); the browser
// access flag is required because the extension calls the API from the browser.
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { buildTopicMessages, buildTranslateMessages, parseTopicResponse, parseTranslateResponse } from '../claudePrompt';
import type { ClaudeModel, TopicResult, TranslateBatchRequest, TranslateBatchResult, TranslationEngine, Usage, VideoContext } from '../types';

export { ANTHROPIC_BASE_URL, validateGatewayUrl } from '../claudeAccess';
const MAX_TOKENS = 2000;

export interface ClaudeConfig {
  model: ClaudeModel;
  baseURL: string;
  auth: { kind: 'x-api-key' | 'bearer'; token: string };
  fetch?: typeof fetch;
  /** Per-attempt request timeout (default 20 s; the SDK's own default is 10 minutes). */
  timeoutMs?: number;
}

const TIMEOUT_MS = 20_000;

export class ClaudeEngine implements TranslationEngine {
  readonly id = 'claude' as const;
  private readonly client: Anthropic;

  constructor(private readonly cfg: ClaudeConfig) {
    const bearer = cfg.auth.kind === 'bearer';
    this.client = new Anthropic({
      baseURL: cfg.baseURL,
      apiKey: bearer ? null : cfg.auth.token,
      authToken: bearer ? cfg.auth.token : null,
      // SDK 1.x sends an API key as "Authorization: Bearer"; gateways configured
      // for x-api-key expect exactly that header, so set it explicitly.
      ...(bearer ? {} : { defaultHeaders: { 'x-api-key': cfg.auth.token, authorization: null } }),
      dangerouslyAllowBrowser: true,
      // A hung Claude must not hold lines (or the request lanes) for minutes: the fast tier covers.
      maxRetries: 1,
      timeout: cfg.timeoutMs ?? TIMEOUT_MS,
      ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    });
  }

  get model(): ClaudeModel {
    return this.cfg.model;
  }

  async translateBatch(req: TranslateBatchRequest): Promise<TranslateBatchResult> {
    const { text, usage } = await this.complete(buildTranslateMessages(req));
    return { ...parseTranslateResponse(text, req), usage };
  }

  async summarizeTopic(video: VideoContext, firstLines: string[], sourceLang: string, targetLang: string): Promise<TopicResult> {
    const { text, usage } = await this.complete(buildTopicMessages(video, firstLines, sourceLang, targetLang));
    return { ...parseTopicResponse(text), usage };
  }

  private async complete(prompt: { system: TextBlockParam[]; messages: MessageParam[] }): Promise<{ text: string; usage: Usage }> {
    const response = await this.client.messages.create({
      model: this.cfg.model,
      max_tokens: MAX_TOKENS,
      system: prompt.system,
      messages: prompt.messages,
      output_config: { effort: 'low' },
    });
    const text = response.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
    const u = response.usage;
    return {
      text,
      usage: {
        model: this.cfg.model,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
