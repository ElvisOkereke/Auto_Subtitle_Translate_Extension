import { GlossaryStore, StorageArea } from '../glossary';

function memoryArea(): StorageArea & { data: Record<string, any> } {
  const data: Record<string, any> = {};
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
  };
}

describe('GlossaryStore', () => {
  it('learned terms are shared with the next video on the same topic', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('vidA', { topic: 'LoL stream', topicKey: 'league-of-legends' });
    await store.learn('vidA', [{ source: '뽀삐', target: 'Poppy' }]);
    await store.setVideoMeta('vidB', { topic: 'Another LoL stream', topicKey: 'league-of-legends' });
    expect(await store.effective('vidB')).toEqual([{ source: '뽀삐', target: 'Poppy' }]);
    expect(await store.effective('vidC')).toEqual([]); // no topic yet
  });

  it('video entries win over topic entries; newest wins on conflicting targets', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('vidA', { topic: 't', topicKey: 'lol' });
    await store.learn('vidA', [{ source: '갱', target: 'gang' }]);
    await store.learn('vidA', [{ source: '갱', target: 'gank' }]);
    expect(await store.effective('vidA')).toEqual([{ source: '갱', target: 'gank' }]);

    await store.setVideoMeta('vidB', { topic: 't', topicKey: 'lol' });
    await store.edit('vidB', '갱', 'gank (jungle)');
    const b = await store.effective('vidB');
    expect(b.find(e => e.source === '갱')!.target).toBe('gank (jungle)');
  });

  it('entries are bounded (source ≤ 40, target ≤ 80 chars; oversized dropped) and at most 200 are returned', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('v', { topic: 't', topicKey: 'k' });
    await store.learn('v', [
      { source: 'x'.repeat(41), target: 'too long source' },
      { source: 'ok', target: 'y'.repeat(81) },
      { source: '', target: 'empty' },
    ]);
    expect(await store.effective('v')).toEqual([]);
    await store.learn(
      'v',
      Array.from({ length: 300 }, (_, i) => ({ source: `term${i}`, target: `T${i}` }))
    );
    const effective = await store.effective('v');
    expect(effective).toHaveLength(200);
    expect(effective[0]).toEqual({ source: 'term299', target: 'T299' }); // newest first
  });

  it('edit() bumps the version; edit(target=null) deletes from both scopes', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('v', { topic: 'LoL', topicKey: 'lol' });
    await store.learn('v', [{ source: '렙차', target: 'level gap' }]);
    const v0 = (await store.list('v')).version;
    const v1 = await store.edit('v', '렙차', 'level difference');
    expect(v1).toBe(v0 + 1);
    const v2 = await store.edit('v', '렙차', null);
    expect(v2).toBe(v1 + 1);
    expect(await store.effective('v')).toEqual([]);
    await store.setVideoMeta('w', { topic: 'LoL', topicKey: 'lol' });
    expect(await store.effective('w')).toEqual([]);
  });

  it('list() reports the topic and each entry with its scope', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('a', { topic: 'LoL stream', topicKey: 'lol' });
    await store.learn('a', [{ source: '뽀삐', target: 'Poppy', note: 'champion' }]);
    await store.setVideoMeta('b', { topic: 'LoL stream 2', topicKey: 'lol' });
    await store.edit('b', '갱', 'gank');
    const listed = await store.list('b');
    expect(listed.topic).toBe('LoL stream 2');
    expect(listed.entries).toEqual([
      { source: '갱', target: 'gank', scope: 'video' },
      { source: '뽀삐', target: 'Poppy', note: 'champion', scope: 'topic' },
    ]);
  });
});
