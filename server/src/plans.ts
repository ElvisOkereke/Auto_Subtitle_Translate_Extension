// Subscription plans. Prices and budgets come from docs/pricing.md (measured
// costs): the budget is what one subscriber's translation may cost per month.
import type { ClaudeModel } from '../../src/translation/types';

export type Plan = 'free' | 'standard' | 'pro';
export type PaidPlan = Exclude<Plan, 'free'>;

export const PLANS: Record<PaidPlan, { priceUsd: number; budgetUsd: number; bestModel: ClaudeModel; models: ClaudeModel[] }> = {
  standard: { priceUsd: 9.99, budgetUsd: 6, bestModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-haiku-5-5'] },
  pro: { priceUsd: 24.99, budgetUsd: 17, bestModel: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
};

/** DeepL API Pro: $25 per million characters. */
export const DEEPL_USD_PER_CHAR = 25 / 1_000_000;
/** The popup warns from this share of the budget. */
export const BUDGET_WARN_SHARE = 0.8;

export const isPaidPlan = (plan: string): plan is PaidPlan => plan === 'standard' || plan === 'pro';
export const isActive = (status: string | null | undefined) => status === 'active' || status === 'trialing';
