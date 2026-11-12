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
const metaKeyOf = (videoKey: string) => `glossary:meta:${videoKey}`;
/** Distinct channels needed to agree on a model-learned term before it is shared with the whole topic. */
export const TOPIC_PROMOTION_CHANNELS = 2;
const MAX_CANDIDATES = 500;

/**
 * Topic storage key. YouTube videos (bare ids) share topics across YouTube;
 * any other site's videos (keys are site-scoped URLs) only share with that site,
 * so a page elsewhere can't push entries into, say, the League topic.
 */
function topicScope(videoKey: string, topicKey: string): string {
  if (!videoKey.includes('://')) return topicKey;
  try {
    return `${new URL(videoKey).origin}|${topicKey}`;
  } catch {
    return `${videoKey}|${topicKey}`;
  }
}
const topicKeyOf = (scope: string) => `glossary:topic:${scope}`;
const candidatesKeyOf = (scope: string) => `glossary:candidates:${scope}`;
// Glossary targets are subtitle words: links and markup are never legitimate (prompt-injection bait).
const SUSPICIOUS = /https?:\/\/|www\.|[<>]/i;

function valid(e: GlossaryEntry): boolean {
  return (
    typeof e?.source === 'string' &&
    typeof e?.target === 'string' &&
    e.source.trim().length > 0 &&
    e.target.trim().length > 0 &&
    e.source.length <= GLOSSARY_SOURCE_MAX &&
    e.target.length <= GLOSSARY_TARGET_MAX &&
    !SUSPICIOUS.test(e.source) &&
    !SUSPICIOUS.test(e.target)
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

  private async scopes(
    videoKey: string
  ): Promise<{ meta: VideoMeta | null; scope: string | null; video: GlossaryEntry[]; topic: GlossaryEntry[]; candidates: Record<string, { target: string; channels: string[] }> }> {
    const meta = await this.getVideoMeta(videoKey);
    const scope = meta?.topicKey ? topicScope(videoKey, meta.topicKey) : null;
    const keys = [videoKeyOf(videoKey), ...(scope ? [topicKeyOf(scope), candidatesKeyOf(scope)] : [])];
    const stored = await this.area.get(keys);
    return {
      meta,
      scope,
      video: stored[videoKeyOf(videoKey)] ?? [],
      topic: scope ? (stored[topicKeyOf(scope)] ?? []) : [],
      candidates: scope ? (stored[candidatesKeyOf(scope)] ?? {}) : {},
    };
  }

  /** Topic ∪ video entries (video wins), newest first, at most 200. */
  async effective(videoKey: string): Promise<GlossaryEntry[]> {
    const { video, topic } = await this.scopes(videoKey);
    const own = new Set(video.map(e => e.source));
    return [...video, ...topic.filter(e => !own.has(e.source))].slice(0, MAX_GLOSSARY_ENTRIES);
  }

  /**
   * Terms fixed by the translator: kept for this video at once; shared with the
   * topic only when TOPIC_PROMOTION_CHANNELS different channels agree on the
   * same translation, so one uploader's injected text can't rewrite a whole
   * topic. Videos with no known channel never promote.
   */
  async learn(videoKey: string, entries: GlossaryEntry[], channel = ''): Promise<void> {
    const good = entries.filter(valid).map(clean);
    if (!good.length) return;
    const { scope, video, topic, candidates } = await this.scopes(videoKey);
    const items: Record<string, unknown> = { [videoKeyOf(videoKey)]: merge(video, good) };
    if (scope) {
      const promoted: GlossaryEntry[] = [];
      const who = channel.trim().toLowerCase();
      for (const e of good) {
        const c = candidates[e.source];
        const known = c && c.target === e.target && Array.isArray(c.channels) ? c.channels : [];
        const channels = who ? [...new Set([...known, who])] : known;
        delete candidates[e.source]; // re-insert: newest last
        candidates[e.source] = { target: e.target, channels: channels.slice(-8) };
        if (channels.length >= TOPIC_PROMOTION_CHANNELS) promoted.push(e);
      }
      const sources = Object.keys(candidates);
      for (const old of sources.slice(0, Math.max(0, sources.length - MAX_CANDIDATES))) delete candidates[old];
      items[candidatesKeyOf(scope)] = candidates;
      if (promoted.length) items[topicKeyOf(scope)] = merge(topic, promoted);
    }
    await this.area.set(items);
  }

  /** A user correction (target) or deletion (null) in both scopes; returns the new glossary version. */
  async edit(videoKey: string, source: string, target: string | null): Promise<number> {
    const { meta, scope, video, topic, candidates } = await this.scopes(videoKey);
    const apply = (list: GlossaryEntry[]) =>
      target === null ? list.filter(e => e.source !== source) : merge(list, [{ source, target }]);
    const version = (meta?.version ?? 0) + 1;
    const items: Record<string, unknown> = {
      [videoKeyOf(videoKey)]: apply(video),
      [metaKeyOf(videoKey)]: { topic: meta?.topic ?? '', topicKey: meta?.topicKey ?? '', version },
    };
    if (scope) {
      items[topicKeyOf(scope)] = apply(topic); // the user's own correction: trusted, shared at once
      delete candidates[source]; // and a pending model proposal for it is dropped
      items[candidatesKeyOf(scope)] = candidates;
    }
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
