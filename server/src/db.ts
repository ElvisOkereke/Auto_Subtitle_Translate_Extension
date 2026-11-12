// SQLite repository (node:sqlite). Small and synchronous; the interface is what
// the rest of the server uses, so Postgres can replace it later.
import { DatabaseSync } from 'node:sqlite';
import type { Plan } from './plans';

export interface Account {
  id: number;
  email: string;
  plan: Plan;
  subscriptionStatus: string | null;
  stripeCustomerId: string | null;
  /** The one Stripe subscription this account follows (events for others are ignored). */
  stripeSubscriptionId: string | null;
  /** Start of the current billing period (ms); budgets run per period. Null = calendar month (manual plans). */
  periodStart: number | null;
}

export interface Usage {
  costUsd: number;
  claudeRequests: number;
  fastChars: number;
}

export interface LoginCode {
  id: number;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  used: boolean;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free',
    subscription_status TEXT,
    stripe_customer_id TEXT,
    created_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS accounts_customer ON accounts(stripe_customer_id)',
  `CREATE TABLE IF NOT EXISTS login_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes(email)',
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    created_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS usage (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    month TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    claude_requests INTEGER NOT NULL DEFAULT 0,
    fast_chars INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, month))`,
  'CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS rate_events (key TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS rate_events_key ON rate_events(key, at)',
];

function toAccount(row: any): Account | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    plan: row.plan,
    subscriptionStatus: row.subscription_status ?? null,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
    periodStart: row.period_start === null || row.period_start === undefined ? null : Number(row.period_start),
  };
}

export class Repo {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000'); // wait on locks (e.g. the admin CLI) instead of failing
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    for (const statement of SCHEMA) this.db.exec(statement);
    // Columns added after the first schema (existing databases get them here).
    for (const column of ['stripe_event_at INTEGER', 'stripe_subscription_id TEXT', 'period_start INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${column}`);
      } catch {
        // already there
      }
    }
  }

  /** Runs fn atomically: any throw rolls back everything it wrote. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  busyTimeoutMs(): number {
    const row: any = this.db.prepare('PRAGMA busy_timeout').get();
    return Number(row?.timeout ?? row?.busy_timeout ?? Object.values(row ?? {})[0] ?? 0);
  }

  setSubscription(accountId: number, subscriptionId: string | null, periodStart: number | null): void {
    this.db.prepare('UPDATE accounts SET stripe_subscription_id = ?, period_start = ? WHERE id = ?').run(subscriptionId, periodStart, accountId);
  }

  /** Creation time (Stripe `event.created`, seconds) of the last billing event applied to an account. */
  stripeEventAt(accountId: number): number | null {
    const row: any = this.db.prepare('SELECT stripe_event_at FROM accounts WHERE id = ?').get(accountId);
    return row?.stripe_event_at === null || row?.stripe_event_at === undefined ? null : Number(row.stripe_event_at);
  }

  setStripeEventAt(accountId: number, created: number): void {
    this.db.prepare('UPDATE accounts SET stripe_event_at = ? WHERE id = ?').run(created, accountId);
  }

  close(): void {
    this.db.close();
  }

  upsertAccount(email: string, now = Date.now()): Account {
    const e = normalizeEmail(email);
    this.db.prepare('INSERT INTO accounts (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING').run(e, now);
    return this.accountByEmail(e)!;
  }

  accountByEmail(email: string): Account | null {
    return toAccount(this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(normalizeEmail(email)));
  }

  accountById(id: number): Account | null {
    return toAccount(this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  accountByCustomer(customerId: string): Account | null {
    return toAccount(this.db.prepare('SELECT * FROM accounts WHERE stripe_customer_id = ?').get(customerId));
  }

  setPlan(id: number, plan: Plan, status: string | null, customerId?: string | null): void {
    if (customerId !== undefined) {
      this.db.prepare('UPDATE accounts SET plan = ?, subscription_status = ?, stripe_customer_id = ? WHERE id = ?').run(plan, status, customerId, id);
    } else {
      this.db.prepare('UPDATE accounts SET plan = ?, subscription_status = ? WHERE id = ?').run(plan, status, id);
    }
  }

  addCode(email: string, codeHash: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO login_codes (email, code_hash, expires_at) VALUES (?, ?, ?)').run(normalizeEmail(email), codeHash, expiresAt);
  }

  latestCode(email: string): LoginCode | null {
    const row: any = this.db.prepare('SELECT * FROM login_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(normalizeEmail(email));
    return row ? { id: Number(row.id), codeHash: row.code_hash, expiresAt: Number(row.expires_at), attempts: Number(row.attempts), used: !!row.used } : null;
  }

  markCodeAttempt(id: number): void {
    this.db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
  }

  markCodeUsed(id: number): void {
    this.db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(id);
  }

  /** Test/audit helpers: what is actually stored. */
  allCodeHashes(): string[] {
    return (this.db.prepare('SELECT code_hash FROM login_codes').all() as any[]).map(r => r.code_hash);
  }

  allSessionHashes(): string[] {
    return (this.db.prepare('SELECT token_hash FROM sessions').all() as any[]).map(r => r.token_hash);
  }

  addSession(tokenHash: string, accountId: number, now = Date.now()): void {
    this.db.prepare('INSERT INTO sessions (token_hash, account_id, created_at) VALUES (?, ?, ?)').run(tokenHash, accountId, now);
  }

  /** The account of a live session created at or after `createdAfter` (expired sessions don't count). */
  sessionAccount(tokenHash: string, createdAfter = 0): Account | null {
    return toAccount(
      this.db
        .prepare('SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.revoked = 0 AND s.created_at >= ?')
        .get(tokenHash, createdAfter)
    );
  }

  revokeAllSessions(accountId: number): void {
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE account_id = ?').run(accountId);
  }

  revokeSession(tokenHash: string): void {
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(tokenHash);
  }

  addUsage(accountId: number, month: string, u: Usage): void {
    this.db
      .prepare(
        `INSERT INTO usage (account_id, month, cost_usd, claude_requests, fast_chars) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, month) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
           claude_requests = claude_requests + excluded.claude_requests, fast_chars = fast_chars + excluded.fast_chars`
      )
      .run(accountId, month, u.costUsd, u.claudeRequests, u.fastChars);
  }

  usageFor(accountId: number, month: string): Usage {
    const row: any = this.db.prepare('SELECT * FROM usage WHERE account_id = ? AND month = ?').get(accountId, month);
    return row
      ? { costUsd: Number(row.cost_usd), claudeRequests: Number(row.claude_requests), fastChars: Number(row.fast_chars) }
      : { costUsd: 0, claudeRequests: 0, fastChars: 0 };
  }

  /** True the first time an event id is seen (webhook idempotency). */
  recordStripeEvent(id: string, now = Date.now()): boolean {
    const result = this.db.prepare('INSERT INTO stripe_events (id, at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(id, now);
    return Number(result.changes) === 1;
  }

  addRateEvent(key: string, now = Date.now()): void {
    this.db.prepare('INSERT INTO rate_events (key, at) VALUES (?, ?)').run(key, now);
  }

  countRateEvents(key: string, since: number): number {
    const row: any = this.db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND at >= ?').get(key, since);
    return Number(row.n);
  }
}
