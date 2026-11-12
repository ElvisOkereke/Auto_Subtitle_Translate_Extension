import { costUsd } from '../costs';

const usage = (model: string, u: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>) => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...u,
});

describe('costUsd', () => {
  it('prices Opus 5.5 at $4 in / $20 out / $0.20 cache read per MTok', () => {
    expect(costUsd(usage('claude-opus-5-5', { inputTokens: 1_000_000 }))).toBeCloseTo(4);
    expect(costUsd(usage('claude-opus-5-5', { outputTokens: 1_000_000 }))).toBeCloseTo(20);
    expect(costUsd(usage('claude-opus-5-5', { cacheReadTokens: 1_000_000 }))).toBeCloseTo(0.2);
    expect(costUsd(usage('claude-opus-5-5', { cacheWriteTokens: 1_000_000 }))).toBeCloseTo(5);
  });

  it('prices Sonnet 5.5 and Haiku 5.5', () => {
    expect(costUsd(usage('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toBeCloseTo(12);
    expect(costUsd(usage('claude-haiku-5-5', { outputTokens: 1_000_000 }))).toBeCloseTo(0.5);
  });

  it('unknown models cost 0 (not priced) rather than throwing', () => {
    expect(costUsd(usage('some-gateway-model', { inputTokens: 1000 }))).toBe(0);
  });
});
