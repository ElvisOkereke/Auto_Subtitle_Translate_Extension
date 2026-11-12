// Email + one-time code sign-in and bearer sessions. Codes and tokens are only
// ever stored as SHA-256 hashes; attempts and sends are rate-limited.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { Context, MiddlewareHandler } from 'hono';
import type { Account, Repo } from './db';
import type { Mailer } from './mailer';

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
const EMAIL_LIMIT = { count: 3, windowMs: 15 * 60_000 };
/**
 * Wrong codes per (email, IP) and per IP before that IP is locked out for the
 * window. Only the guessing IP is locked: the real user, elsewhere, still signs
 * in with the right code. Total guesses per email stay bounded by the code
 * send limit (3 per 15 min) x 5 attempts per code.
 */
const FAILURE_LIMIT = { perEmailIp: 10, perIp: 30, windowMs: 60 * 60_000 };
/**
 * Failures on one email from any IPs: past this, every further wrong guess burns
 * the code, so a distributed guesser gets one try per new code (and new codes
 * are limited to 3 per 15 minutes).
 */
const EMAIL_FAILURE_SOFT_LIMIT = 10;

/** Rate-limit key for an address: IPv6 grouped by /64 (one subscriber's prefix). */
function ipKey(raw: string): string {
  const ip = raw.trim().replace(/^::ffff:/i, ''); // IPv4-mapped IPv6 = the IPv4 client
  if (isIPv4(ip) || !ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map(g => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
export const SESSION_TTL_MS = 90 * 24 * 3600_000;
const IP_LIMIT = { count: 20, windowMs: 60 * 60_000 };
// No whitespace, '@' extras or '|' (rate-limit keys use it as a separator).
const EMAIL_RE = /^[^\s@|]{1,64}@[^\s@|]{1,190}\.[^\s@|]{2,63}$/;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

export function validEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email.trim());
}

/**
 * The client's address: with `trustProxyHops` proxies in front (each appends to
 * X-Forwarded-For), the entry that many from the end; otherwise the socket.
 * Client-supplied X-Forwarded-For entries are never trusted.
 */
export function clientIp(c: Context, trustProxyHops: number): string {
  if (trustProxyHops > 0) {
    const entries = (c.req.header('x-forwarded-for') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const entry = entries[entries.length - trustProxyHops];
    if (entry) return ipKey(entry);
  }
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return socket ? ipKey(socket) : 'local';
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

  /** A new session token; null for a wrong/expired/used/exhausted code; 'locked' after too many failures. */
  verify(emailRaw: string, code: string, ip: string): string | null | 'locked' {
    const email = emailRaw.trim().toLowerCase();
    const since = this.clock() - FAILURE_LIMIT.windowMs;
    if (
      this.repo.countRateEvents(`failpair:${email}|${ip}`, since) >= FAILURE_LIMIT.perEmailIp ||
      this.repo.countRateEvents(`failip:${ip}`, since) >= FAILURE_LIMIT.perIp
    ) {
      return 'locked';
    }
    const stored = this.repo.latestCode(email);
    if (!stored || stored.used || stored.attempts >= MAX_CODE_ATTEMPTS || this.clock() > stored.expiresAt) return null;
    const expected = Buffer.from(stored.codeHash, 'hex');
    const given = Buffer.from(codeHash(email, String(code)), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      this.repo.markCodeAttempt(stored.id);
      this.repo.addRateEvent(`failpair:${email}|${ip}`, this.clock());
      this.repo.addRateEvent(`failip:${ip}`, this.clock());
      this.repo.addRateEvent(`failemail:${email}`, this.clock());
      if (this.repo.countRateEvents(`failemail:${email}`, since) > EMAIL_FAILURE_SOFT_LIMIT) this.repo.markCodeUsed(stored.id);
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
      const account = tokenHash ? this.repo.sessionAccount(tokenHash, this.clock() - SESSION_TTL_MS) : null;
      if (!account) return c.json({ error: 'unauthorized', message: 'Sign in again.' }, 401);
      c.set('account', account);
      c.set('tokenHash', tokenHash);
      await next();
    };
  }
}
