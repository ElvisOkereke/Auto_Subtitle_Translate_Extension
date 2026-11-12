/** YouTube video id from a page URL (watch, youtu.be, shorts) or the fixture page's ?v=. */
export function videoIdFrom(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  const shorts = u.pathname.match(/^\/shorts\/([\w-]+)/);
  if (shorts) return shorts[1];
  return u.searchParams.get('v');
}
