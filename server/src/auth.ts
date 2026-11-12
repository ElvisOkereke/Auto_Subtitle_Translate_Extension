// Email + one-time code sign-in and bearer sessions. Codes and tokens are only
// ever stored as SHA-256 hashes; attempts and sends are rate-limited.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { Account, Repo } from './db';
import type { Mailer } from './mailer';

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
const EMAIL_LIMIT = { count: 3, windowMs: 15 * 60_000 };
const IP_LIMIT = { count: 20, windowMs: 60 * 60_000 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

export function validEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email.trim());
}

export function clientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';
}

export type AuthEnv = { Variables: { account: Account; tokenHash: string } };

export class Auth {
  constructor(
    private readonly repo: Repo,
    private readonly mailer: Mailer,
    private readonly clock: () => number
  ) {}

  /** Sends a code; 'rate_limited' when the email or IP asked too often. */
  async start(emailRaw: string, ip: string): Promise<'sent' | 'rate_limited'> {
    const email = emailRaw.trim().toLowerCase();
    const now = this.clock();
    if (this.repo.countRateEvents(`code:${email}`, now - EMAIL_LIMIT.windowMs) >= EMAIL_LIMIT.count) return 'rate_limited';
    if (this.repo.countRateEvents(`ip:${ip}`, now - IP_LIMIT.windowMs) >= IP_LIMIT.count) return 'rate_limited';
    this.repo.addRateEvent(`code:${email}`, now);
    this.repo.addRateEvent(`ip:${ip}`, now);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.repo.addCode(email, codeHash(email, code), now + CODE_TTL_MS);
    await this.mailer.send(
      email,
      `Your sign-in code: ${code}`,
      `Your Auto Subtitle Translator sign-in code is ${code}.\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`
    );
    return 'sent';
  }

  /** Returns a new session token, or null for a wrong/expired/used/exhausted code. */
  verify(emailRaw: string, code: string): string | null {
    const email = emailRaw.trim().toLowerCase();
    const stored = this.repo.latestCode(email);
    if (!stored || stored.used || stored.attempts >= MAX_CODE_ATTEMPTS || this.clock() > stored.expiresAt) return null;
    const expected = Buffer.from(stored.codeHash, 'hex');
    const given = Buffer.from(codeHash(email, String(code)), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      this.repo.markCodeAttempt(stored.id);
      return null;
    }
    this.repo.markCodeUsed(stored.id);
    const account = this.repo.upsertAccount(email, this.clock());
    const token = randomBytes(32).toString('base64url');
    this.repo.addSession(sha256(token), account.id, this.clock());
    return token;
  }

  /** Bearer-token middleware: sets c.var.account, or answers 401. */
  requireAccount(): MiddlewareHandler<AuthEnv> {
    return async (c, next) => {
      const header = c.req.header('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const tokenHash = token ? sha256(token) : '';
      const account = tokenHash ? this.repo.sessionAccount(tokenHash) : null;
      if (!account) return c.json({ error: 'unauthorized', message: 'Sign in again.' }, 401);
      c.set('account', account);
      c.set('tokenHash', tokenHash);
      await next();
    };
  }
}
