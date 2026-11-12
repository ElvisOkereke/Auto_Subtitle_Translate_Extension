// What the video is about, read from the page: the translator's context
// (title, uploader/site, description). YouTube's watch page first, then
// generic document metadata.
import type { VideoContext } from '../translation/types';
import { videoIdFrom } from './videoId';

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 1000;

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const meta = (doc: Document, selector: string) => doc.querySelector<HTMLMetaElement>(selector)?.content?.trim() ?? '';

function isYouTube(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

export function readVideoContext(doc: Document, url: string): VideoContext {
  let title = '';
  let channel = '';
  let description = '';
  if (isYouTube(url)) {
    title = text(doc.querySelector('ytd-watch-metadata h1')) || doc.title.replace(/\s*-\s*YouTube$/, '');
    channel = text(doc.querySelector('#owner #channel-name a, ytd-channel-name a')) || (doc.querySelector('[itemprop="author"] [itemprop="name"]')?.getAttribute('content') ?? '');
    description = text(doc.querySelector('#description-inline-expander')) || meta(doc, 'meta[name="description"]');
  }
  title ||= doc.title.trim();
  channel ||= meta(doc, 'meta[property="og:site_name"]');
  description ||= meta(doc, 'meta[name="description"]') || meta(doc, 'meta[property="og:description"]');
  return {
    videoId: videoIdFrom(url),
    url,
    title: title.slice(0, TITLE_MAX),
    channel: channel.slice(0, TITLE_MAX),
    description: description.slice(0, DESCRIPTION_MAX),
  };
}
