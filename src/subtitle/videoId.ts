const isYouTubeHost = (host: string) => host === 'youtube.com' || host.endsWith('.youtube.com');

/**
 * Key for a video's saved box and subtitle timeline.
 * YouTube (watch, youtu.be, shorts): the bare video id, shared across YouTube's hosts.
 * Any other site with ?v=: scoped to that page (origin + path), so a site can't
 * read or poison what was saved for a YouTube video by reusing its id.
 */
export function videoIdFrom(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  const v = u.searchParams.get('v');
  if (isYouTubeHost(u.hostname)) {
    const shorts = u.pathname.match(/^\/shorts\/([\w-]+)/);
    return shorts ? shorts[1] : v;
  }
  return v ? `${u.origin}${u.pathname}?v=${encodeURIComponent(v)}` : null;
}
