// THROWAWAY spike (read-ahead approach b): tap the video SourceBuffer's fMP4
// appends, demux, decode ahead of playback with WebCodecs, and record how far
// ahead decoded frames reach. Runs in the page's main world (addInitScript).
(() => {
  const stats = (window.__tap = {
    mime: null, codec: null, appends: 0, bytes: 0, samples: 0, keyframes: 0,
    decoded: 0, sampledFrames: 0, maxDecodedTime: 0, decodeMs: 0, errors: [], configured: false,
  });

  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const type = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function* boxes(b, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      let header = 8;
      if (size === 1) { size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12); header = 16; }
      if (size < 8 || o + size > end) return;
      yield { type: type(b, o + 4), start: o, end: o + size, body: o + header };
      o += size;
    }
  }
  const find = (b, s, e, path) => {
    let range = { body: s, end: e };
    for (const p of path) {
      let next = null;
      for (const box of boxes(b, range.body, range.end)) if (box.type === p) { next = box; break; }
      if (!next) return null;
      range = next;
    }
    return range;
  };

  let timescale = 1;
  let decoder = null;
  let pending = new Uint8Array(0);
  let lastSampleSlot = -1;
  let expectKey = true;

  function configure(moovBytes, s, e) {
    const mdhd = find(moovBytes, s, e, ['trak', 'mdia', 'mdhd']);
    const v = moovBytes[mdhd.body];
    timescale = v === 1 ? u32(moovBytes, mdhd.body + 20) : u32(moovBytes, mdhd.body + 12);
    const stsd = find(moovBytes, s, e, ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
    // stsd: version/flags(4) + entry_count(4), then sample entry box (av01): 8 header + 78 visual fields
    const entry = [...boxes(moovBytes, stsd.body + 8, stsd.end)][0];
    const cfg = find(moovBytes, entry.body + 78, entry.end, ['av1C']) || find(moovBytes, entry.body + 78, entry.end, ['vpcC']) || find(moovBytes, entry.body + 78, entry.end, ['avcC']);
    const description = moovBytes.slice(cfg.body, cfg.end);
    decoder = new VideoDecoder({
      output: frame => {
        stats.decoded++;
        const t = frame.timestamp / 1e6;
        stats.maxDecodedTime = Math.max(stats.maxDecodedTime, t);
        const slot = Math.floor(t * 4); // 4 box-frames per second of video
        if (slot !== lastSampleSlot) {
          lastSampleSlot = slot;
          stats.sampledFrames++;
        }
        frame.close();
      },
      error: e => stats.errors.push(String(e)),
    });
    decoder.configure({ codec: stats.codec, description, hardwareAcceleration: 'prefer-hardware' });
    stats.configured = true;
  }

  function onMedia(b, moof, mdatStart) {
    const traf = find(b, moof.body, moof.end, ['traf']);
    const tfhd = find(b, traf.body, traf.end, ['tfhd']);
    const tfdt = find(b, traf.body, traf.end, ['tfdt']);
    const trun = find(b, traf.body, traf.end, ['trun']);
    const tfFlags = u32(b, tfhd.body) & 0xffffff;
    let p = tfhd.body + 8;
    if (tfFlags & 0x1) p += 8;
    if (tfFlags & 0x2) p += 4;
    let defDur = 0, defSize = 0, defFlags = 0;
    if (tfFlags & 0x8) { defDur = u32(b, p); p += 4; }
    if (tfFlags & 0x10) { defSize = u32(b, p); p += 4; }
    if (tfFlags & 0x20) { defFlags = u32(b, p); p += 4; }
    let dts = b[tfdt.body] === 1 ? u32(b, tfdt.body + 4) * 2 ** 32 + u32(b, tfdt.body + 8) : u32(b, tfdt.body + 4);
    const trFlags = u32(b, trun.body) & 0xffffff;
    const count = u32(b, trun.body + 4);
    let q = trun.body + 8;
    let dataOffset = 0;
    if (trFlags & 0x1) { dataOffset = u32(b, q) | 0; q += 4; }
    let firstFlags = null;
    if (trFlags & 0x4) { firstFlags = u32(b, q); q += 4; }
    let off = moof.start + dataOffset;
    for (let i = 0; i < count; i++) {
      const dur = trFlags & 0x100 ? u32(b, (q += 4) - 4) : defDur;
      const size = trFlags & 0x200 ? u32(b, (q += 4) - 4) : defSize;
      let flags = trFlags & 0x400 ? u32(b, (q += 4) - 4) : defFlags;
      if (trFlags & 0x800) q += 4;
      if (i === 0 && firstFlags !== null) flags = firstFlags;
      const key = !(flags & 0x10000);
      stats.samples++;
      if (key) stats.keyframes++;
      if (expectKey && !key) { off += size; dts += dur; continue; }
      expectKey = false;
      const t0 = performance.now();
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (dts / timescale) * 1e6, duration: (dur / timescale) * 1e6, data: b.slice(off, off + size) }));
      stats.decodeMs += performance.now() - t0;
      off += size;
      dts += dur;
    }
  }

  function feed(chunk) {
    const merged = new Uint8Array(pending.length + chunk.length);
    merged.set(pending);
    merged.set(chunk, pending.length);
    let consumed = 0;
    let moof = null;
    for (const box of boxes(merged, 0, merged.length)) {
      if (box.type === 'moov') configure(merged, box.body, box.end);
      else if (box.type === 'moof') moof = box;
      else if (box.type === 'mdat' && moof && decoder) { onMedia(merged, moof, box.body); moof = null; }
      consumed = box.end;
      if (box.type === 'moof') consumed = box.start; // keep moof until its mdat arrives
    }
    pending = merged.slice(consumed);
  }

  const origAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAdd.call(this, mime);
    if (mime.startsWith('video/mp4')) {
      stats.mime = mime;
      stats.codec = (mime.match(/codecs="([^"]+)"/) || [])[1];
      const append = sb.appendBuffer.bind(sb);
      sb.appendBuffer = data => {
        stats.appends++;
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        stats.bytes += bytes.length;
        try { feed(bytes.slice()); } catch (e) { stats.errors.push(String(e)); }
        return append(data);
      };
    }
    return sb;
  };
})();
