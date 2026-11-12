import { Repo } from '../db';

describe('Repo (SQLite)', () => {
  let repo: Repo;
  beforeEach(() => (repo = new Repo(':memory:')));
  afterEach(() => repo.close());

  it('accounts are created once per email (case-insensitive)', () => {
    const a = repo.upsertAccount('Fan@Example.com ');
    const b = repo.upsertAccount('fan@example.com');
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ email: 'fan@example.com', plan: 'free', subscriptionStatus: null });
    expect(repo.accountByEmail('FAN@example.com')?.id).toBe(a.id);
  });

  it('plans can be set and accounts found by Stripe customer', () => {
    const a = repo.upsertAccount('a@example.com');
    repo.setPlan(a.id, 'pro', 'active', 'cus_123');
    expect(repo.accountById(a.id)).toMatchObject({ plan: 'pro', subscriptionStatus: 'active', stripeCustomerId: 'cus_123' });
    expect(repo.accountByCustomer('cus_123')?.id).toBe(a.id);
  });

  it('usage accumulates per account and month', () => {
    const a = repo.upsertAccount('a@example.com');
    repo.addUsage(a.id, '2026-11', { costUsd: 0.5, claudeRequests: 1, fastChars: 0 });
    repo.addUsage(a.id, '2026-11', { costUsd: 0.25, claudeRequests: 0, fastChars: 120 });
    repo.addUsage(a.id, '2026-12', { costUsd: 1, claudeRequests: 1, fastChars: 0 });
    expect(repo.usageFor(a.id, '2026-11')).toEqual({ costUsd: 0.75, claudeRequests: 1, fastChars: 120 });
    expect(repo.usageFor(a.id, '2027-01')).toEqual({ costUsd: 0, claudeRequests: 0, fastChars: 0 });
  });

  it('a stripe event id is recorded once', () => {
    expect(repo.recordStripeEvent('evt_1')).toBe(true);
    expect(repo.recordStripeEvent('evt_1')).toBe(false);
  });

  it('sessions resolve to their account until revoked', () => {
    const a = repo.upsertAccount('a@example.com');
    repo.addSession('hash1', a.id);
    expect(repo.sessionAccount('hash1')?.id).toBe(a.id);
    repo.revokeSession('hash1');
    expect(repo.sessionAccount('hash1')).toBeNull();
  });
});
