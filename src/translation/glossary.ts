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
  remove?(keys: string | string[]): Promise<void>;
}

export const MAX_GLOSSARY_ENTRIES = 200;
/** Videos whose glossary is kept (least recently used are pruned; topics stay). */
export const MAX_STORED_VIDEOS = 300;

interface VideoMeta {
  topic: string;
  topicKey: string;
  version: number;
}

/** Stored entry: `by: 'user'` marks the user's own corrections; `deleted` is a user deletion (tombstone). */
interface StoredEntry extends GlossaryEntry {
  by?: 'user';
  deleted?: true;
}

const videoKeyOf = (videoKey: string) => `glossary:video:${videoKey}`;
const metaKeyOf = (videoKey: string) => `glossary:meta:${videoKey}`;
const RECENT_KEY = 'glossary:recentVideos';
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

const clean = (e: GlossaryEntry): GlossaryEntry =>
  e.note ? { source: e.source.trim(), target: e.target.trim(), note: e.note } : { source: e.source.trim(), target: e.target.trim() };

/** What translation and the popup see: live entries without the bookkeeping fields. */
const visible = (list: StoredEntry[]): GlossaryEntry[] =>
  list.filter(e => !e.deleted).map(e => (e.note ? { source: e.source, target: e.target, note: e.note } : { source: e.source, target: e.target }));

const userOwned = (list: StoredEntry[]) => new Set(list.filter(e => e.by === 'user').map(e => e.source));

/** Newest first: incoming entries go in front, replacing older ones with the same source. */
function merge(existing: StoredEntry[], incoming: StoredEntry[]): StoredEntry[] {
  const fresh = [...incoming].reverse(); // last of the batch is newest
  const seen = new Set<string>();
  const out: StoredEntry[] = [];
  for (const e of [...fresh, ...existing]) {
    if (seen.has(e.source)) continue;
    seen.add(e.source);
    out.push(e);
  }
  // User entries (incl. deletions) are kept ahead of the cap; model entries fill the rest.
  const user = out.filter(e => e.by === 'user');
  const model = out.filter(e => e.by !== 'user');
  return [...user, ...model.slice(0, Math.max(0, MAX_GLOSSARY_ENTRIES - user.length))].sort((a, b) => out.indexOf(a) - out.indexOf(b));
}

export class GlossaryStore {
  /** All writes run one after another: concurrent batches and user edits must not overwrite each other. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly maxVideos: number;

  constructor(
    private readonly area: StorageArea,
    opts: { maxVideos?: number } = {}
  ) {
    this.maxVideos = opts.maxVideos ?? MAX_STORED_VIDEOS;
  }

  private write<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async getVideoMeta(videoKey: string): Promise<VideoMeta | null> {
    const stored = await this.area.get(metaKeyOf(videoKey));
    return (stored[metaKeyOf(videoKey)] as VideoMeta | undefined) ?? null;
  }

  setVideoMeta(videoKey: string, meta: { topic: string; topicKey: string }): Promise<void> {
    return this.write(async () => {
      const current = await this.getVideoMeta(videoKey);
      await this.area.set({ [metaKeyOf(videoKey)]: { ...meta, version: current?.version ?? 0 } });
      await this.touch(videoKey);
    });
  }

  /** Marks a video as recently used and prunes the least recently used beyond the cap. */
  private async touch(videoKey: string): Promise<void> {
    const stored = await this.area.get(RECENT_KEY);
    const recent: string[] = (Array.isArray(stored[RECENT_KEY]) ? stored[RECENT_KEY] : []).filter((k: string) => k !== videoKey);
    recent.push(videoKey);
    const evicted = recent.splice(0, Math.max(0, recent.length - this.maxVideos));
    await this.area.set({ [RECENT_KEY]: recent });
    if (evicted.length && this.area.remove) await this.area.remove(evicted.flatMap(k => [videoKeyOf(k), metaKeyOf(k)]));
  }

  private async scopes(videoKey: string): Promise<{
    meta: VideoMeta | null;
    scope: string | null;
    video: StoredEntry[];
    topic: StoredEntry[];
    candidates: Record<string, { target: string; channels: string[] }>;
  }> {
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

  /** Topic ∪ video entries (video wins, user deletions hide topic entries), newest first, at most 200. */
  async effective(videoKey: string): Promise<GlossaryEntry[]> {
    const { video, topic } = await this.scopes(videoKey);
    const own = new Set(video.map(e => e.source));
    return [...visible(video), ...visible(topic.filter(e => !own.has(e.source)))].slice(0, MAX_GLOSSARY_ENTRIES);
  }

  /**
   * Terms fixed by the translator: kept for this video at once; shared with the
   * topic only when TOPIC_PROMOTION_CHANNELS different channels agree on the
   * same translation, so one uploader's injected text can't rewrite a whole
   * topic. Videos with no known channel never promote. Terms the user corrected
   * or deleted are never overridden.
   */
  learn(videoKey: string, entries: GlossaryEntry[], channel = ''): Promise<void> {
    return this.write(async () => {
      const proposed = entries.filter(valid).map(clean);
      if (!proposed.length) return;
      const { scope, video, topic, candidates } = await this.scopes(videoKey);
      const userVideo = userOwned(video);
      const userTopic = userOwned(topic);
      const forVideo = proposed.filter(e => !userVideo.has(e.source));
      const items: Record<string, unknown> = {};
      if (forVideo.length) items[videoKeyOf(videoKey)] = merge(video, forVideo);
      if (scope) {
        const promoted: GlossaryEntry[] = [];
        const who = channel.trim().toLowerCase();
        for (const e of proposed.filter(e => !userTopic.has(e.source) && !userVideo.has(e.source))) {
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
      if (Object.keys(items).length) await this.area.set(items);
      await this.touch(videoKey);
    });
  }

  /** A user correction (target) or deletion (null) in both scopes; returns the new glossary version. */
  edit(videoKey: string, source: string, target: string | null): Promise<number> {
    return this.write(async () => {
      const { meta, scope, video, topic, candidates } = await this.scopes(videoKey);
      const entry: StoredEntry =
        target === null ? { source, target: '', by: 'user', deleted: true } : { source, target: target.trim(), by: 'user' };
      if (target !== null && !valid(entry)) return meta?.version ?? 0; // rejected (too long, link, markup)
      const version = (meta?.version ?? 0) + 1;
      const items: Record<string, unknown> = {
        [videoKeyOf(videoKey)]: merge(video, [entry]),
        [metaKeyOf(videoKey)]: { topic: meta?.topic ?? '', topicKey: meta?.topicKey ?? '', version },
      };
      if (scope) {
        items[topicKeyOf(scope)] = merge(topic, [entry]); // the user's own correction: trusted, shared at once
        delete candidates[source]; // and a pending model proposal for it is dropped
        items[candidatesKeyOf(scope)] = candidates;
      }
      await this.area.set(items);
      await this.touch(videoKey);
      return version;
    });
  }

  async list(videoKey: string): Promise<{ topic: string | null; entries: (GlossaryEntry & { scope: 'video' | 'topic' })[]; version: number }> {
    const { meta, video, topic } = await this.scopes(videoKey);
    const own = new Set(video.map(e => e.source));
    return {
      topic: meta?.topic || null,
      version: meta?.version ?? 0,
      entries: [
        ...visible(video).map(e => ({ ...e, scope: 'video' as const })),
        ...visible(topic.filter(e => !own.has(e.source))).map(e => ({ ...e, scope: 'topic' as const })),
      ],
    };
  }
}
