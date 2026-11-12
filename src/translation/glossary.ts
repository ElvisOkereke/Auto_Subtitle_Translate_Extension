// Glossary store: names and terms fixed while translating, per video and per
// topic (franchise/sport/show), so a name is translated one way throughout a
// video and the next video on the same topic starts with what was learned.
// Lives in chrome.storage.local (extension-only); the store takes the storage
// area as a parameter so it is testable and runs anywhere.
import { GLOSSARY_SOURCE_MAX, GLOSSARY_TARGET_MAX } from './claudePrompt';
import type { GlossaryEntry } from './types';

export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
}

export const MAX_GLOSSARY_ENTRIES = 200;

interface VideoMeta {
  topic: string;
  topicKey: string;
  version: number;
}

const videoKeyOf = (videoKey: string) => `glossary:video:${videoKey}`;
const topicKeyOf = (topicKey: string) => `glossary:topic:${topicKey}`;
const metaKeyOf = (videoKey: string) => `glossary:meta:${videoKey}`;

function valid(e: GlossaryEntry): boolean {
  return (
    typeof e?.source === 'string' &&
    typeof e?.target === 'string' &&
    e.source.trim().length > 0 &&
    e.target.trim().length > 0 &&
    e.source.length <= GLOSSARY_SOURCE_MAX &&
    e.target.length <= GLOSSARY_TARGET_MAX
  );
}

const clean = (e: GlossaryEntry): GlossaryEntry => (e.note ? { source: e.source.trim(), target: e.target.trim(), note: e.note } : { source: e.source.trim(), target: e.target.trim() });

/** Newest first: incoming entries go in front, replacing older ones with the same source. */
function merge(existing: GlossaryEntry[], incoming: GlossaryEntry[]): GlossaryEntry[] {
  const fresh = incoming.filter(valid).map(clean).reverse(); // last of the batch is newest
  const seen = new Set<string>();
  const out: GlossaryEntry[] = [];
  for (const e of [...fresh, ...existing]) {
    if (seen.has(e.source)) continue;
    seen.add(e.source);
    out.push(e);
  }
  return out.slice(0, MAX_GLOSSARY_ENTRIES);
}

export class GlossaryStore {
  constructor(private readonly area: StorageArea) {}

  async getVideoMeta(videoKey: string): Promise<VideoMeta | null> {
    const stored = await this.area.get(metaKeyOf(videoKey));
    return (stored[metaKeyOf(videoKey)] as VideoMeta | undefined) ?? null;
  }

  async setVideoMeta(videoKey: string, meta: { topic: string; topicKey: string }): Promise<void> {
    const current = await this.getVideoMeta(videoKey);
    await this.area.set({ [metaKeyOf(videoKey)]: { ...meta, version: current?.version ?? 0 } });
  }

  private async scopes(videoKey: string): Promise<{ meta: VideoMeta | null; video: GlossaryEntry[]; topic: GlossaryEntry[] }> {
    const meta = await this.getVideoMeta(videoKey);
    const keys = [videoKeyOf(videoKey), ...(meta?.topicKey ? [topicKeyOf(meta.topicKey)] : [])];
    const stored = await this.area.get(keys);
    return {
      meta,
      video: stored[videoKeyOf(videoKey)] ?? [],
      topic: meta?.topicKey ? (stored[topicKeyOf(meta.topicKey)] ?? []) : [],
    };
  }

  /** Topic ∪ video entries (video wins), newest first, at most 200. */
  async effective(videoKey: string): Promise<GlossaryEntry[]> {
    const { video, topic } = await this.scopes(videoKey);
    const own = new Set(video.map(e => e.source));
    return [...video, ...topic.filter(e => !own.has(e.source))].slice(0, MAX_GLOSSARY_ENTRIES);
  }

  /** Terms fixed by the translator: kept for this video and its topic. */
  async learn(videoKey: string, entries: GlossaryEntry[]): Promise<void> {
    if (!entries.some(valid)) return;
    const { meta, video, topic } = await this.scopes(videoKey);
    const items: Record<string, GlossaryEntry[]> = { [videoKeyOf(videoKey)]: merge(video, entries) };
    if (meta?.topicKey) items[topicKeyOf(meta.topicKey)] = merge(topic, entries);
    await this.area.set(items);
  }

  /** A user correction (target) or deletion (null) in both scopes; returns the new glossary version. */
  async edit(videoKey: string, source: string, target: string | null): Promise<number> {
    const { meta, video, topic } = await this.scopes(videoKey);
    const apply = (list: GlossaryEntry[]) =>
      target === null ? list.filter(e => e.source !== source) : merge(list, [{ source, target }]);
    const version = (meta?.version ?? 0) + 1;
    const items: Record<string, unknown> = {
      [videoKeyOf(videoKey)]: apply(video),
      [metaKeyOf(videoKey)]: { topic: meta?.topic ?? '', topicKey: meta?.topicKey ?? '', version },
    };
    if (meta?.topicKey) items[topicKeyOf(meta.topicKey)] = apply(topic);
    await this.area.set(items);
    return version;
  }

  async list(videoKey: string): Promise<{ topic: string | null; entries: (GlossaryEntry & { scope: 'video' | 'topic' })[]; version: number }> {
    const { meta, video, topic } = await this.scopes(videoKey);
    const own = new Set(video.map(e => e.source));
    return {
      topic: meta?.topic || null,
      version: meta?.version ?? 0,
      entries: [
        ...video.map(e => ({ ...e, scope: 'video' as const })),
        ...topic.filter(e => !own.has(e.source)).map(e => ({ ...e, scope: 'topic' as const })),
      ],
    };
  }
}
