import fs from 'node:fs';
import path from 'node:path';
import { TrackRegistry } from '../trackRegistry';

const ms = () => ({}) as object;
const frag = (start: number, bytes = 100) => ({
  start,
  samples: [{ time: start, duration: 1, key: true, data: new Uint8Array(bytes) }],
});

describe('TrackRegistry (MSE tap bookkeeping)', () => {
  it('finds the playing stream through the video element src', () => {
    const r = new TrackRegistry<object>();
    const a = ms();
    r.registerUrl('blob:a', a);
    const t = r.addTrack(a, 'av01');
    expect(r.active('blob:a')).toBeNull(); // no init segment yet
    t.init = { timescale: 1, trackId: 1, configBox: 'av1C', description: null } as any;
    expect(r.active('blob:a')).toBe(t);
    expect(r.active('blob:other')).toBeNull();
  });

  it('forgets a MediaSource and its tracks when it closes (no leak across videos)', () => {
    const r = new TrackRegistry<object>();
    for (let i = 0; i < 50; i++) {
      const m = ms();
      r.registerUrl(`blob:${i}`, m);
      r.addTrack(m, 'av01').fragments.push(frag(i) as any);
      r.closeMediaSource(m);
    }
    expect(r.trackCount).toBe(0);
    expect(r.urlCount).toBe(0);
  });

  it('drops a revoked URL unless a video is still playing it', () => {
    const r = new TrackRegistry<object>();
    const m = ms();
    r.registerUrl('blob:a', m);
    r.registerUrl('blob:b', m);
    r.revokeUrl('blob:a', true);
    r.revokeUrl('blob:b', false);
    expect(r.urlCount).toBe(1);
  });

  it('removes a track whose SourceBuffer was removed', () => {
    const r = new TrackRegistry<object>();
    const t = r.addTrack(ms(), 'av01');
    r.removeTrack(t);
    expect(r.trackCount).toBe(0);
  });

  it('releases stored video of every stream except the one playing', () => {
    const r = new TrackRegistry<object>();
    const old = r.addTrack(ms(), 'av01');
    old.fragments.push(frag(0, 1000) as any);
    old.bytes = 1000;
    const playing = r.addTrack(ms(), 'av01');
    playing.fragments.push(frag(0, 500) as any);
    playing.bytes = 500;
    r.releaseInactive(playing);
    expect(old.fragments).toEqual([]);
    expect(old.bytes).toBe(0);
    expect(playing.fragments).toHaveLength(1);
    expect(r.storedBytes).toBe(500);
  });
});

describe('manifest', () => {
  it('injects the main-world MSE tap only where read-ahead is supported (YouTube + local E2E fixture)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../manifest.json'), 'utf8'));
    const tap = manifest.content_scripts.find((c: any) => c.js.includes('mseTap.js'));
    expect(tap.world).toBe('MAIN');
    expect(tap.matches).not.toContain('<all_urls>');
    expect(tap.matches).toEqual(['*://*.youtube.com/*', 'http://127.0.0.1/*', 'http://localhost/*']);
  });
});
