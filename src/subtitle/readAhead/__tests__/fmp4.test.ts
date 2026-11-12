import { Fmp4Parser } from '../fmp4';

// --- tiny ISO-BMFF builder -------------------------------------------------
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const str = (s: string) => [...s].map(c => c.charCodeAt(0));
function box(type: string, ...parts: number[][]): number[] {
  const body = parts.flat();
  return [...u32(8 + body.length), ...str(type), ...body];
}
const full = (version: number, flags: number) => [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255];

function initSegment(timescale: number): Uint8Array {
  const mdhd = box('mdhd', full(0, 0), u32(0), u32(0), u32(timescale), u32(0), u16(0), u16(0));
  const visual = [...Array(6).fill(0), ...u16(1), ...Array(16).fill(0), ...u16(1920), ...u16(1080), ...Array(50).fill(0)]; // 78 bytes
  const av1C = box('av1C', [0x81, 0x08, 0x0c, 0x00]);
  const stsd = box('stsd', full(0, 0), u32(1), box('av01', visual, av1C));
  const moov = box('moov', box('trak', box('mdia', mdhd, box('minf', box('stbl', stsd)))));
  return Uint8Array.from([...box('ftyp', str('iso6'), u32(0)), ...moov]);
}

/** One fragment: samples [size, flags] with fixed duration, decode time base `baseTime` (in timescale units). */
function fragment(baseTime: number, duration: number, samples: { size: number; key: boolean }[], fill = 7): Uint8Array {
  const tfhd = box('tfhd', full(0, 0x020000 | 0x08), u32(1), u32(duration)); // default-base-is-moof + default duration
  const tfdt = box('tfdt', full(1, 0), u32(0), u32(baseTime));
  const trunFlags = 0x000001 | 0x000200 | 0x000400; // data offset, sample size, sample flags
  const entries = samples.flatMap(s => [...u32(s.size), ...u32(s.key ? 0x02000000 : 0x01010000)]);
  const trunLen = 8 + 4 + 4 + 4 + entries.length;
  const trafLen = 8 + 20 + 20 + trunLen; // tfhd (with default duration) 20, tfdt v1 20
  const moofLen = 8 + trafLen;
  const dataOffset = moofLen + 8; // first sample right after the mdat header
  const trun = box('trun', full(0, trunFlags), u32(samples.length), u32(dataOffset), entries);
  const moof = box('moof', box('traf', tfhd, tfdt, trun));
  const payload = samples.flatMap((s, i) => Array(s.size).fill(fill + i));
  return Uint8Array.from([...moof, ...box('mdat', payload)]);
}

describe('Fmp4Parser', () => {
  it('reads the init segment: timescale, codec config box and description', () => {
    const out = new Fmp4Parser().push(initSegment(16000));
    expect(out.init).toEqual({ timescale: 16000, configBox: 'av1C', description: Uint8Array.from([0x81, 0x08, 0x0c, 0x00]), width: 1920, height: 1080 });
    expect(out.fragments).toEqual([]);
  });

  it('demuxes fragment samples with times, durations, keyframe flags and bytes', () => {
    const parser = new Fmp4Parser();
    parser.push(initSegment(1000));
    const { fragments } = parser.push(fragment(5000, 40, [{ size: 3, key: true }, { size: 2, key: false }]));
    expect(fragments).toHaveLength(1);
    expect(fragments[0].start).toBe(5);
    expect(fragments[0].samples.map(s => ({ time: s.time, duration: s.duration, key: s.key, data: [...s.data] }))).toEqual([
      { time: 5, duration: 0.04, key: true, data: [7, 7, 7] },
      { time: 5.04, duration: 0.04, key: false, data: [8, 8] },
    ]);
  });

  it('reassembles boxes split across appends in arbitrary places', () => {
    const parser = new Fmp4Parser();
    const bytes = Uint8Array.from([...initSegment(1000), ...fragment(0, 40, [{ size: 4, key: true }]), ...fragment(40, 40, [{ size: 4, key: false }])]);
    const got: number[] = [];
    for (let i = 0; i < bytes.length; i += 13) {
      for (const f of parser.push(bytes.slice(i, i + 13)).fragments) got.push(...f.samples.map(s => s.time));
    }
    expect(got).toEqual([0, 0.04]);
  });

  it('applies the SourceBuffer timestampOffset to presentation times', () => {
    const parser = new Fmp4Parser();
    parser.push(initSegment(1000));
    const { fragments } = parser.push(fragment(1000, 40, [{ size: 1, key: true }]), 100);
    expect(fragments[0].start).toBe(101);
    expect(fragments[0].samples[0].time).toBe(101);
  });

  it('ignores media fragments before an init segment', () => {
    expect(new Fmp4Parser().push(fragment(0, 40, [{ size: 1, key: true }])).fragments).toEqual([]);
  });
});
