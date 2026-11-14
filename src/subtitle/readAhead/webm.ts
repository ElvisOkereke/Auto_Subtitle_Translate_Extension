// webm.ts - incremental demuxer for WebM (Matroska) as appended to an MSE
// SourceBuffer: what YouTube serves as VP9 for clients without AV1 decode.
// Produces the same shapes as fmp4.ts (one fragment per Cluster) so the tap
// can feed either to WebCodecs. Single video track. Data comes from the page
// (untrusted): sizes are bounded and anything malformed resets the parser.

import type { Fmp4Fragment, Fmp4Init, Fmp4Sample } from './fmp4';

export interface MediaParser {
  reset(): void;
  push(bytes: Uint8Array, timestampOffset?: number): { init?: Fmp4Init; fragments: Fmp4Fragment[] };
}

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
} as const;

/** Partial data kept between appends is capped; beyond it the stream is treated as desynced. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
/** Elements we read whole (Info, Tracks, blocks) are bounded; a larger one means garbage. */
const MAX_ELEMENT_BYTES = 16 * 1024 * 1024;
const UNKNOWN = -1;

interface Header {
  id: number;
  size: number; // UNKNOWN for unknown-size masters
  headerLength: number;
}

/** Reads an EBML element header at `o`, or null when more bytes are needed. Throws on invalid data. */
function readHeader(b: Uint8Array, o: number): Header | null {
  if (o >= b.length) return null;
  const first = b[o];
  let idLength = 1;
  while (idLength <= 4 && !(first & (0x80 >> (idLength - 1)))) idLength++;
  if (idLength > 4) throw new Error('bad element id');
  if (o + idLength >= b.length) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + b[o + i];
  const s0 = b[o + idLength];
  let sizeLength = 1;
  while (sizeLength <= 8 && !(s0 & (0x80 >> (sizeLength - 1)))) sizeLength++;
  if (sizeLength > 8) throw new Error('bad element size');
  if (o + idLength + sizeLength > b.length) return null;
  let size = s0 & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const v = b[o + idLength + i];
    if (v !== 0xff) allOnes = false;
    size = size * 256 + v;
  }
  return { id, size: allOnes ? UNKNOWN : size, headerLength: idLength + sizeLength };
}

function readUint(b: Uint8Array, start: number, end: number): number {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + b[i];
  return v;
}

/** Children of a fully buffered master element. */
function* children(b: Uint8Array, start: number, end: number): Generator<{ id: number; body: number; end: number }> {
  let o = start;
  while (o < end) {
    const h = readHeader(b, o);
    if (!h || h.size === UNKNOWN) throw new Error('bad child element');
    const body = o + h.headerLength;
    const childEnd = body + h.size;
    if (childEnd > end) throw new Error('child overruns parent');
    yield { id: h.id, body, end: childEnd };
    o = childEnd;
  }
}

/** WebCodecs codec string for a SourceBuffer codec parameter (YouTube sends `codecs="vp9"`). */
export function webCodecsVideoCodec(mimeCodec: string): string {
  const c = mimeCodec.trim();
  if (c.toLowerCase() === 'vp9') return 'vp09.00.10.08'; // profile 0, level 1.0, 8-bit (decoders accept higher levels)
  return c;
}

interface Pending {
  relative: number;
  key: boolean;
  data: Uint8Array;
  offset: number;
}

export class WebmParser implements MediaParser {
  private buf: Uint8Array = new Uint8Array(0);
  /** Bytes to skip of an element we don't need (may span appends). */
  private skip = 0;
  private timecodeScale = 1_000_000; // ns per tick (Matroska default)
  private videoTrack: number | null = null;
  private defaultDuration: number | null = null; // seconds
  private clusterTimecode: number | null = null;
  /** Remaining bytes of the current known-size Cluster (UNKNOWN when unknown-size, null when outside one). */
  private clusterRemaining: number | null = null;
  private blocks: Pending[] = [];

  reset(): void {
    this.buf = new Uint8Array(0);
    this.skip = 0;
    this.clusterTimecode = null;
    this.clusterRemaining = null;
    this.blocks = [];
  }

  push(bytes: Uint8Array, timestampOffset = 0): { init?: Fmp4Init; fragments: Fmp4Fragment[] } {
    const fragments: Fmp4Fragment[] = [];
    let init: Fmp4Init | undefined;
    const joined = new Uint8Array(this.buf.length + bytes.length);
    joined.set(this.buf, 0);
    joined.set(bytes, this.buf.length);
    let o = 0;
    try {
      // Skip the rest of an element we started skipping in an earlier append.
      const skipped = Math.min(this.skip, joined.length);
      this.skip -= skipped;
      this.consume(skipped);
      o = skipped;
      for (;;) {
        if (this.clusterRemaining === 0) this.endCluster(fragments);
        const h = readHeader(joined, o);
        if (!h) break;
        // Masters we descend into without buffering them whole.
        if (h.id === ID.Segment || h.id === ID.Cluster) {
          o += h.headerLength;
          this.consume(h.headerLength);
          if (h.id === ID.Cluster) {
            this.endCluster(fragments);
            this.clusterTimecode = null;
            this.clusterRemaining = h.size === UNKNOWN ? UNKNOWN : h.size;
          }
          continue;
        }
        // Any other top-level element after a cluster of unknown size ends it.
        if (this.clusterRemaining === UNKNOWN && ![ID.Timecode, ID.SimpleBlock, ID.BlockGroup].includes(h.id as never)) {
          this.endCluster(fragments);
        }
        if (h.size === UNKNOWN) throw new Error('unknown-size element');
        const wanted = h.id === ID.Info || h.id === ID.Tracks || h.id === ID.Timecode || h.id === ID.SimpleBlock || h.id === ID.BlockGroup;
        const total = h.headerLength + h.size;
        if (!wanted) {
          // EBML header, SeekHead, Cues, Tags, Void...: skip without buffering.
          const available = joined.length - o;
          this.consume(Math.min(total, available));
          if (total > available) {
            this.skip = total - available;
            o = joined.length;
            break;
          }
          o += total;
          continue;
        }
        if (total > MAX_ELEMENT_BYTES) throw new Error('element too large');
        if (o + total > joined.length) break; // wait for the rest
        const body = o + h.headerLength;
        const end = o + total;
        if (h.id === ID.Info) this.readInfo(joined, body, end);
        else if (h.id === ID.Tracks) init = this.readTracks(joined, body, end) ?? init;
        else if (h.id === ID.Timecode) this.clusterTimecode = readUint(joined, body, end);
        else if (h.id === ID.SimpleBlock) this.readBlock(joined, body, end, null, timestampOffset);
        else this.readBlockGroup(joined, body, end, timestampOffset);
        o = end;
        this.consume(total);
      }
      if (this.clusterRemaining === 0) this.endCluster(fragments);
      this.buf = joined.slice(o);
      if (this.buf.length > MAX_PENDING_BYTES) throw new Error('desynced');
    } catch {
      this.reset();
      return { init, fragments };
    }
    return { init, fragments };
  }

  /** Counts bytes consumed inside a known-size cluster. */
  private consume(n: number): void {
    if (this.clusterRemaining !== null && this.clusterRemaining !== UNKNOWN) {
      this.clusterRemaining = Math.max(0, this.clusterRemaining - n);
    }
  }

  private readInfo(b: Uint8Array, start: number, end: number): void {
    for (const c of children(b, start, end)) if (c.id === ID.TimecodeScale) this.timecodeScale = readUint(b, c.body, c.end) || 1_000_000;
  }

  private readTracks(b: Uint8Array, start: number, end: number): Fmp4Init | undefined {
    for (const entry of children(b, start, end)) {
      if (entry.id !== ID.TrackEntry) continue;
      let number = 0;
      let type = 0;
      let codecId = '';
      let codecPrivate: Uint8Array | null = null;
      let width = 0;
      let height = 0;
      let defaultDuration = 0;
      for (const c of children(b, entry.body, entry.end)) {
        if (c.id === ID.TrackNumber) number = readUint(b, c.body, c.end);
        else if (c.id === ID.TrackType) type = readUint(b, c.body, c.end);
        else if (c.id === ID.CodecID) codecId = String.fromCharCode(...b.subarray(c.body, c.end));
        else if (c.id === ID.CodecPrivate) codecPrivate = b.slice(c.body, c.end);
        else if (c.id === ID.DefaultDuration) defaultDuration = readUint(b, c.body, c.end);
        else if (c.id === ID.Video) {
          for (const v of children(b, c.body, c.end)) {
            if (v.id === ID.PixelWidth) width = readUint(b, v.body, v.end);
            else if (v.id === ID.PixelHeight) height = readUint(b, v.body, v.end);
          }
        }
      }
      if (type !== 1) continue; // video only
      this.videoTrack = number;
      this.defaultDuration = defaultDuration ? defaultDuration / 1e9 : null;
      const av1 = codecId === 'V_AV1' && codecPrivate;
      return { timescale: 1e9 / this.timecodeScale, configBox: av1 ? 'av1C' : null, description: av1 ? codecPrivate : null, width, height };
    }
    return undefined;
  }

  private readBlockGroup(b: Uint8Array, start: number, end: number, offset: number): void {
    let block: { body: number; end: number } | null = null;
    let referenced = false;
    for (const c of children(b, start, end)) {
      if (c.id === ID.Block) block = c;
      else if (c.id === ID.ReferenceBlock) referenced = true;
    }
    if (block) this.readBlock(b, block.body, block.end, !referenced, offset);
  }

  /** `key`: null for SimpleBlock (flag in the header), else from the BlockGroup. */
  private readBlock(b: Uint8Array, start: number, end: number, key: boolean | null, offset: number): void {
    if (this.clusterTimecode === null) return;
    // The track number is a variable-length integer coded like an element size.
    const first = b[start];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || start + len + 3 > end) throw new Error('bad block');
    let track = first & (0xff >> len);
    for (let i = 1; i < len; i++) track = track * 256 + b[start + i];
    if (track !== this.videoTrack) return;
    const p = start + len;
    const relative = ((b[p] << 8) | b[p + 1]) << 16 >> 16; // int16
    const flags = b[p + 2];
    if (flags & 0x06) return; // laced blocks: not used for video
    this.blocks.push({
      relative: this.clusterTimecode + relative,
      key: key ?? !!(flags & 0x80),
      data: b.slice(p + 3, end),
      offset,
    });
  }

  private endCluster(out: Fmp4Fragment[]): void {
    this.clusterRemaining = null;
    if (!this.blocks.length) return;
    const scale = this.timecodeScale / 1e9;
    const blocks = [...this.blocks].sort((a, b) => a.relative - b.relative);
    this.blocks = [];
    const samples: Fmp4Sample[] = blocks.map((blk, i) => {
      const next = blocks[i + 1];
      const prev = blocks[i - 1];
      const duration = next
        ? (next.relative - blk.relative) * scale
        : this.defaultDuration ?? (prev ? (blk.relative - prev.relative) * scale : 1 / 30);
      return { time: blk.relative * scale + blk.offset, duration, key: blk.key, data: blk.data };
    });
    out.push({ start: samples[0].time, samples });
  }
}
