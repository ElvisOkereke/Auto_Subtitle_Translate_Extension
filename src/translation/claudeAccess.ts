// Claude access settings helpers without the SDK (the popup imports these).

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Gateway base URL check: https on any host, http only on loopback (local
 * gateways), no embedded credentials. Returns the URL without a trailing slash,
 * or null when it isn't acceptable.
 */
export function validateGatewayUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}
