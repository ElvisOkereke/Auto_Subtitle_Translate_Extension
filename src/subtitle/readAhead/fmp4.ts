// fmp4.ts - incremental demuxer for fragmented MP4 as appended to an MSE SourceBuffer
// (init segment ftyp+moov, then moof+mdat fragments). Single video track.

export interface Fmp4Init {
  timescale: number;
  /** Codec configuration box found in the sample entry ('av1C', 'avcC', 'hvcC', 'vpcC'). */
  configBox: string | null;
  /** Payload of the configuration box (WebCodecs `description` for AV1/H.264/HEVC). */
  description: Uint8Array | null;
  width: number;
  height: number;
  /** Audio tracks (WebM): WebCodecs AudioDecoder configuration; `description` is the codec private data (OpusHead). */
  audio?: { codec: string; sampleRate: number; channels: number };
}

export interface Fmp4Sample {
  /** Presentation time in seconds (decode time + SourceBuffer timestampOffset). */
  time: number;
  duration: number;
  key: boolean;
  data: Uint8Array;
}

export interface Fmp4Fragment {
  start: number;
  samples: Fmp4Sample[];
}

interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
}

const CONFIG_BOXES = ['av1C', 'avcC', 'hvcC', 'vpcC'];
/** Partial data kept between appends is capped; beyond it the stream is treated as desynced. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const VISUAL_SAMPLE_ENTRY_FIELDS = 78;
/** AudioSampleEntry: 8 bytes of SampleEntry + 20 of audio fields before its child boxes (esds). */
const AUDIO_SAMPLE_ENTRY_FIELDS = 28;

/** An MPEG-4 descriptor's variable-length size (1-4 bytes, high bit = more). */
function descriptorSize(b: Uint8Array, o: number): { size: number; next: number } {
  let size = 0;
  let i = 0;
  for (; i < 4; i++) {
    const v = b[o + i];
    size = (size << 7) | (v & 0x7f);
    if (!(v & 0x80)) break;
  }
  return { size, next: o + i + 1 };
}

/** The AudioSpecificConfig inside an esds box (ES_Descriptor > DecoderConfigDescriptor > DecoderSpecificInfo). */
function audioSpecificConfig(b: Uint8Array, esds: Box): Uint8Array | null {
  let o = esds.body + 4; // version + flags
  if (b[o] !== 0x03) return null;
  let d = descriptorSize(b, o + 1);
  o = d.next;
  const esFlags = b[o + 2];
  o += 3; // ES_ID, flags
  if (esFlags & 0x80) o += 2; // dependsOn_ES_ID
  if (esFlags & 0x40) o += 1 + b[o]; // URL
  if (esFlags & 0x20) o += 2; // OCR_ES_Id
  if (b[o] !== 0x04) return null;
  d = descriptorSize(b, o + 1);
  o = d.next + 13; // objectTypeIndication, streamType, bufferSize, maxBitrate, avgBitrate
  if (b[o] !== 0x05) return null;
  d = descriptorSize(b, o + 1);
  return d.next + d.size <= esds.end ? b.slice(d.next, d.next + d.size) : null;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function u64(b: Uint8Array, o: number): number {
  return u32(b, o) * 2 ** 32 + u32(b, o + 4);
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = u64(b, o + 8);
      header = 16;
    } else if (size === 0) {
      size = end - o; // box extends to the end
    }
    if (size < header || o + size > end) return;
    yield { type: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), start: o, end: o + size, body: o + header };
    o += size;
  }
}

function child(b: Uint8Array, parent: { body: number; end: number }, path: string[]): Box | null {
  let current: { body: number; end: number } = parent;
  let found: Box | null = null;
  for (const type of path) {
    found = null;
    for (const box of boxes(b, current.body, current.end)) {
      if (box.type === type) {
        found = box;
        break;
      }
    }
    if (!found) return null;
    current = found;
  }
  return found;
}

export class Fmp4Parser {
  /** 'audio': the stream's AAC track (YouTube's audio/mp4); every audio frame decodes on its own. */
  constructor(private readonly kind: 'video' | 'audio' = 'video') {}

  private pending = new Uint8Array(0);
  private init: Fmp4Init | null = null;

  get initInfo(): Fmp4Init | null {
    return this.init;
  }

  get pendingBytes(): number {
    return this.pending.length;
  }

  /** Forget partial data (SourceBuffer.abort()/changeType() reset the browser's parser too). */
  reset(): void {
    this.pending = new Uint8Array(0);
  }

  /** Feed appended bytes; returns a newly seen init segment and any complete fragments. */
  push(bytes: Uint8Array, timestampOffset = 0): { init?: Fmp4Init; fragments: Fmp4Fragment[] } {
    const b = new Uint8Array(this.pending.length + bytes.length);
    b.set(this.pending);
    b.set(bytes, this.pending.length);

    const fragments: Fmp4Fragment[] = [];
    let init: Fmp4Init | undefined;
    let consumed = 0;
    let moof: Box | null = null;
    for (const box of boxes(b, 0, b.length)) {
      if (box.type === 'moov') {
        init = this.parseInit(b, box);
        this.init = init;
      } else if (box.type === 'moof') {
        moof = box;
        continue; // keep until its mdat is complete
      } else if (box.type === 'mdat' && moof) {
        if (this.init) {
          const fragment = this.parseFragment(b, moof, timestampOffset);
          if (fragment) fragments.push(fragment);
        }
        moof = null;
      }
      consumed = box.end;
    }
    this.pending = b.slice(moof ? moof.start : consumed);
    if (this.pending.length > MAX_PENDING_BYTES) {
      // Corrupt or desynced input (e.g. a garbage box size): drop it rather than
      // buffering forever; parsing resumes at the next clean segment boundary.
      this.pending = new Uint8Array(0);
    }
    return { ...(init ? { init } : {}), fragments };
  }

  private parseInit(b: Uint8Array, moov: Box): Fmp4Init {
    const mdhd = child(b, moov, ['trak', 'mdia', 'mdhd']);
    const timescale = mdhd ? (b[mdhd.body] === 1 ? u32(b, mdhd.body + 20) : u32(b, mdhd.body + 12)) : 1;
    const stsd = child(b, moov, ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
    let configBox: string | null = null;
    let description: Uint8Array | null = null;
    let width = 0;
    let height = 0;
    if (stsd && this.kind === 'audio') {
      const entry = boxes(b, stsd.body + 8, stsd.end).next().value as Box | undefined;
      if (entry?.type === 'mp4a') {
        const channels = (b[entry.body + 16] << 8) | b[entry.body + 17];
        const sampleRate = u32(b, entry.body + 24) >>> 16;
        const esds = child(b, { body: entry.body + AUDIO_SAMPLE_ENTRY_FIELDS, end: entry.end }, ['esds']);
        const asc = esds ? audioSpecificConfig(b, esds) : null;
        if (asc) {
          let objectType = asc[0] >> 3;
          if (objectType === 31) objectType = 32 + (((asc[0] & 0x07) << 3) | (asc[1] >> 5));
          return { timescale, configBox: 'esds', description: asc, width: 0, height: 0, audio: { codec: `mp4a.40.${objectType}`, sampleRate, channels } };
        }
      }
      return { timescale, configBox: null, description: null, width: 0, height: 0 };
    }
    if (stsd) {
      const entry = boxes(b, stsd.body + 8, stsd.end).next().value as Box | undefined;
      if (entry) {
        width = (b[entry.body + 24] << 8) | b[entry.body + 25];
        height = (b[entry.body + 26] << 8) | b[entry.body + 27];
        for (const box of boxes(b, entry.body + VISUAL_SAMPLE_ENTRY_FIELDS, entry.end)) {
          if (CONFIG_BOXES.includes(box.type)) {
            configBox = box.type;
            description = b.slice(box.body, box.end);
            break;
          }
        }
      }
    }
    return { timescale, configBox, description, width, height };
  }

  private parseFragment(b: Uint8Array, moof: Box, timestampOffset: number): Fmp4Fragment | null {
    const timescale = this.init!.timescale;
    const traf = child(b, moof, ['traf']);
    const tfhd = traf && child(b, traf, ['tfhd']);
    const trun = traf && child(b, traf, ['trun']);
    if (!traf || !tfhd || !trun) return null;
    const tfdt = child(b, traf, ['tfdt']);

    const tfFlags = u32(b, tfhd.body) & 0xffffff;
    let p = tfhd.body + 8;
    if (tfFlags & 0x1) p += 8; // explicit base_data_offset (not used by MSE streams)
    if (tfFlags & 0x2) p += 4;
    let defaultDuration = 0;
    let defaultSize = 0;
    let defaultFlags = 0;
    if (tfFlags & 0x8) {
      defaultDuration = u32(b, p);
      p += 4;
    }
    if (tfFlags & 0x10) {
      defaultSize = u32(b, p);
      p += 4;
    }
    if (tfFlags & 0x20) defaultFlags = u32(b, p);

    let decodeTime = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : 0;
    const trFlags = u32(b, trun.body) & 0xffffff;
    const count = u32(b, trun.body + 4);
    let q = trun.body + 8;
    let dataOffset = 0;
    if (trFlags & 0x1) {
      dataOffset = u32(b, q) | 0;
      q += 4;
    }
    let firstFlags: number | null = null;
    if (trFlags & 0x4) {
      firstFlags = u32(b, q);
      q += 4;
    }

    // MSE fragments use moof-relative data offsets (default-base-is-moof or no explicit base).
    let offset = moof.start + dataOffset;
    const samples: Fmp4Sample[] = [];
    for (let i = 0; i < count; i++) {
      let duration = defaultDuration;
      let size = defaultSize;
      let flags = defaultFlags;
      if (trFlags & 0x100) {
        duration = u32(b, q);
        q += 4;
      }
      if (trFlags & 0x200) {
        size = u32(b, q);
        q += 4;
      }
      if (trFlags & 0x400) {
        flags = u32(b, q);
        q += 4;
      }
      if (trFlags & 0x800) q += 4; // composition time offset (ignored: crops only need approximate order)
      if (i === 0 && firstFlags !== null) flags = firstFlags;
      if (offset + size > b.length) break;
      samples.push({
        time: decodeTime / timescale + timestampOffset,
        duration: duration / timescale,
        key: this.kind === 'audio' || (flags & 0x10000) === 0, // sample_is_non_sync_sample clear
        data: b.slice(offset, offset + size),
      });
      offset += size;
      decodeTime += duration;
    }
    return samples.length ? { start: samples[0].time, samples } : null;
  }
}
