// USD per million tokens (Claude API pricing, 2026-11).
import type { ClaudeModel, Usage } from './types';

export const PRICES: Record<ClaudeModel, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Cost of one request; models not in the table (e.g. a gateway alias) are reported as 0. */
export function costUsd(u: Usage): number {
  const price = PRICES[u.model as ClaudeModel];
  if (!price) return 0;
  return (
    (u.inputTokens * price.input + u.outputTokens * price.output + u.cacheReadTokens * price.cacheRead + u.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}
