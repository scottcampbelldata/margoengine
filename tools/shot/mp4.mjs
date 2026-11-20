// Reads what the master encode's checks need from an MP4 file's boxes (ISO/IEC 14496-12, the ISO base media file
// format; ISO/IEC 14496-15 for avc1): the order of the top-level boxes (moov before mdat for a file that plays while it
// downloads) and the video sample entry's `colr` box (nclx: primaries, transfer, matrix, full range; ISO/IEC 23091-2
// code points, 1 = BT.709).

/** The boxes of `bytes` from `start` to `end`: [{type, start, size, header}], one level. */
export function boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    out = [];
  for (let at = start; at + 8 <= end; ) {
    let size = view.getUint32(at),
      header = 8;
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw new RangeError(`box ${type} at ${at} runs past its parent`);
    out.push({ type, start: at, size, header });
    at += size;
  }
  return out;
}

/** The first box of a path of types (`['moov', 'trak', ...]`), or null. */
export function findBox(bytes, path, start = 0, end = bytes.length) {
  let range = [start, end],
    found = null;
  for (const type of path) {
    found = boxes(bytes, ...range).find((box) => box.type === type) ?? null;
    if (!found) return null;
    range = [found.start + found.header, found.start + found.size];
  }
  return found;
}

/**
 * What the checks read from an MP4: `order` (top-level box types), `faststart` (moov before mdat) and, per video
 * track, the avc1 sample entry's size and `colr` box: {type, primaries, transfer, matrix, fullRange}, or null.
 */
export function readMp4(bytes) {
  const top = boxes(bytes),
    order = top.map((box) => box.type),
    moov = top.find((box) => box.type === 'moov');
  const tracks = [];
  if (moov)
    for (const trak of boxes(bytes, moov.start + moov.header, moov.start + moov.size).filter((box) => box.type === 'trak')) {
      const stsd = findBox(bytes, ['mdia', 'minf', 'stbl', 'stsd'], trak.start + trak.header, trak.start + trak.size);
      if (!stsd) continue;
      // stsd: version and flags (4 bytes), entry count (4), then the sample entries.
      for (const entry of boxes(bytes, stsd.start + stsd.header + 8, stsd.start + stsd.size)) {
        if (!['avc1', 'avc3'].includes(entry.type)) continue;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          // A visual sample entry: 8 bytes of SampleEntry, then 70 bytes of VisualSampleEntry before its boxes.
          body = entry.start + entry.header,
          width = view.getUint16(body + 24),
          height = view.getUint16(body + 26);
        let colr = null;
        for (const child of boxes(bytes, body + 78, entry.start + entry.size)) {
          if (child.type !== 'colr') continue;
          const at = child.start + child.header,
            kind = String.fromCharCode(...bytes.subarray(at, at + 4));
          colr =
            kind === 'nclx'
              ? { type: kind, primaries: view.getUint16(at + 4), transfer: view.getUint16(at + 6), matrix: view.getUint16(at + 8), fullRange: (bytes[at + 10] & 0x80) !== 0 }
              : { type: kind };
        }
        tracks.push({ codec: entry.type, width, height, colr });
      }
    }
  return { order, faststart: order.indexOf('moov') >= 0 && order.indexOf('moov') < order.indexOf('mdat'), tracks };
}
