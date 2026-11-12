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
  it('a learned term reaches the topic only once a second channel agrees (one uploader cannot poison a topic)', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('vidA', { topic: 'LoL stream', topicKey: 'league-of-legends' });
    await store.learn('vidA', [{ source: '뽀삐', target: 'Poppy' }, { source: '갱', target: 'buy now' }], 'chanA');
    expect(await store.effective('vidA')).toEqual([{ source: '갱', target: 'buy now' }, { source: '뽀삐', target: 'Poppy' }]); // own video: kept
    await store.setVideoMeta('vidB', { topic: 'Another LoL stream', topicKey: 'league-of-legends' });
    expect(await store.effective('vidB')).toEqual([]); // not shared yet
    await store.learn('vidB', [{ source: '뽀삐', target: 'Poppy' }], 'chanB'); // a second channel agrees
    await store.setVideoMeta('vidC', { topic: 'LoL', topicKey: 'league-of-legends' });
    expect(await store.effective('vidC')).toEqual([{ source: '뽀삐', target: 'Poppy' }]);
    await store.learn('vidA', [{ source: '뽀삐', target: 'Poppy' }], 'chanA'); // repeating doesn't change anything
    expect((await store.effective('vidC')).map(e => e.source)).toEqual(['뽀삐']);
    expect(await store.effective('vidD')).toEqual([]); // no topic yet
  });

  it('two videos from the same channel, or videos with no known channel, are not enough', async () => {
    const store = new GlossaryStore(memoryArea());
    for (const [vid, chan] of [['v1', 'spam'], ['v2', 'spam'], ['v3', ''], ['v4', '']]) {
      await store.setVideoMeta(vid, { topic: 'LoL', topicKey: 'lol' });
      await store.learn(vid, [{ source: '갱', target: 'buy now' }], chan);
    }
    await store.setVideoMeta('fresh', { topic: 'LoL', topicKey: 'lol' });
    expect(await store.effective('fresh')).toEqual([]);
  });

  it('a user correction clears a pending candidate so it cannot be promoted later', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('v1', { topic: 'LoL', topicKey: 'lol' });
    await store.learn('v1', [{ source: '갱', target: 'buy now' }], 'chanA');
    await store.edit('v1', '갱', null); // user deletes it
    await store.setVideoMeta('v2', { topic: 'LoL', topicKey: 'lol' });
    await store.learn('v2', [{ source: '갱', target: 'buy now' }], 'chanB');
    await store.setVideoMeta('fresh', { topic: 'LoL', topicKey: 'lol' });
    expect(await store.effective('fresh')).toEqual([]);
  });

  it('a user correction applies to the topic immediately', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('vidA', { topic: 'LoL', topicKey: 'lol' });
    await store.edit('vidA', '렙차', 'level gap');
    await store.setVideoMeta('vidB', { topic: 'LoL', topicKey: 'lol' });
    expect(await store.effective('vidB')).toEqual([{ source: '렙차', target: 'level gap' }]);
  });

  it('topics of non-YouTube sites are kept per site', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('https://evil.example/watch?v=1', { topic: 'LoL', topicKey: 'lol' });
    await store.edit('https://evil.example/watch?v=1', '뽀삐', 'Poppy (sponsored)');
    await store.setVideoMeta('ytVideo', { topic: 'LoL', topicKey: 'lol' });
    expect(await store.effective('ytVideo')).toEqual([]);
    await store.setVideoMeta('https://evil.example/watch?v=2', { topic: 'LoL', topicKey: 'lol' });
    expect(await store.effective('https://evil.example/watch?v=2')).toEqual([{ source: '뽀삐', target: 'Poppy (sponsored)' }]);
  });

  it('entries whose target contains a link or markup are rejected', async () => {
    const store = new GlossaryStore(memoryArea());
    await store.setVideoMeta('v', { topic: 't', topicKey: 'k' });
    await store.learn('v', [
      { source: 'a', target: 'visit https://x.example' },
      { source: 'b', target: 'www.x.example' },
      { source: 'c', target: '<b>bold</b>' },
      { source: 'd', target: 'fine' },
    ]);
    expect(await store.effective('v')).toEqual([{ source: 'd', target: 'fine' }]);
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
    await store.edit('a', '뽀삐', 'Poppy'); // user correction: in the topic at once
    await store.setVideoMeta('b', { topic: 'LoL stream 2', topicKey: 'lol' });
    await store.edit('b', '갱', 'gank');
    const listed = await store.list('b');
    expect(listed.topic).toBe('LoL stream 2');
    expect(listed.entries).toEqual([
      { source: '갱', target: 'gank', scope: 'video' },
      { source: '뽀삐', target: 'Poppy', scope: 'topic' },
    ]);
  });
});
