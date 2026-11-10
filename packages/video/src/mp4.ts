import { fault } from '../../shared/errors.js';

export interface Box {
  offset: number;
  type: string;
  start: number;
  end: number;
}
/** Internal ISO reader passed only to the optional fragmented-container entry. */
export interface FragmentInput {
  bytes: Uint8Array;
  roots: Box[];
  moov: Box[];
  trackID: number;
  boxes(start: number, end: number): Box[];
  children(box: Box): Box[];
  one(boxes: Box[], type: string): Box;
  uint(p: number, end: number): number;
  wide(p: number, end: number): number;
  version(box: Box, allowed: number[]): number;
}
export interface Sample {
  offset: number;
  size: number;
  pts: number;
  duration: number;
  key: boolean;
}
export interface Movie {
  config: VideoDecoderConfig;
  samples: Sample[];
  order: number[];
  times: number[];
  duration: number;
}
const invalid = (): never => {
  throw fault('failed', 'Invalid MP4 sample tables; provide a complete unencrypted AVC MP4');
};
const unsupported = (): never => {
  throw fault(
    'unsupported',
    'Video decoding needs nonfragmented AVC MP4 with one sample description and a rate-1 edit',
  );
};

// ISO box lengths and QuickTime sample-table layouts, written from the published format description.
export function readMP4(bytes: Uint8Array, fragments?: (input: FragmentInput) => Sample[]): Movie {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint = (p: number, end: number): number => (p < 0 || p + 4 > end ? invalid() : view.getUint32(p));
  const wide = (p: number, end: number): number => {
    const value = uint(p, end) * 4294967296 + uint(p + 4, end);
    return Number.isSafeInteger(value) ? value : invalid();
  };
  const text = (p: number): string => String.fromCharCode(...bytes.subarray(p, p + 4));
  const boxes = (start: number, end: number): Box[] => {
    const out: Box[] = [];
    for (let p = start; p < end; ) {
      if (end - p < 8) invalid();
      let size = uint(p, end),
        head = 8;
      if (size === 1) {
        size = wide(p + 8, end);
        head = 16;
      } else if (size === 0) size = end - p;
      if (size < head || size > end - p) invalid();
      out.push({ type: text(p + 4), offset: p, start: p + head, end: p + size });
      p += size;
    }
    return out;
  };
  const one = (list: Box[], type: string): Box => {
    const matches = list.filter((b) => b.type === type);
    return matches.length === 1 ? matches[0]! : invalid();
  };
  const children = (b: Box): Box[] => boxes(b.start, b.end);
  const table = (b: Box, width: number, extra = 0): number => {
    const n = uint(b.start + 4 + extra, b.end);
    if (n > Math.floor((b.end - b.start - 8 - extra) / width)) invalid();
    return n;
  };
  const version = (b: Box, allowed: number[]): number => {
    uint(b.start, b.end);
    const v = bytes[b.start]!;
    if (!allowed.includes(v)) unsupported();
    return v;
  };
  const roots = boxes(0, bytes.length);
  const moov = children(one(roots, 'moov'));
  const fragmented = roots.some((b) => b.type === 'moof') || moov.some((b) => b.type === 'mvex');
  if (fragmented && !fragments) unsupported();
  const tracks = moov.filter((b) => b.type === 'trak').map(children);
  const video = tracks.find((track) => {
    const mdia = children(one(track, 'mdia')),
      handler = one(mdia, 'hdlr');
    uint(handler.start + 8, handler.end);
    return text(handler.start + 8) === 'vide';
  });
  if (!video) return unsupported();
  const mdia = children(one(video, 'mdia')),
    mdhd = one(mdia, 'mdhd');
  const scale = uint(mdhd.start + (version(mdhd, [0, 1]) ? 20 : 12), mdhd.end);
  if (!scale) invalid();
  const stbl = children(one(children(one(mdia, 'minf')), 'stbl'));
  const stsd = one(stbl, 'stsd');
  if (uint(stsd.start + 4, stsd.end) !== 1) unsupported();
  const entries = boxes(stsd.start + 8, stsd.end);
  if (entries.length !== 1 || entries[0]!.type !== 'avc1') unsupported();
  const entry = entries[0]!;
  if (entry.end - entry.start < 78) invalid();
  // A self-contained data reference is required. External media data is not fetched.
  const reference = view.getUint16(entry.start + 6);
  const dinf = children(one(children(one(mdia, 'minf')), 'dinf'));
  const dref = one(dinf, 'dref'),
    refs = boxes(dref.start + 8, dref.end);
  if (uint(dref.start + 4, dref.end) !== refs.length) invalid();
  if (reference < 1 || reference > refs.length) invalid();
  const ref = refs[reference - 1]!;
  if (ref.type !== 'url ' || uint(ref.start, ref.end) !== 1) unsupported();
  const avcc = one(boxes(entry.start + 78, entry.end), 'avcC');
  if (avcc.end - avcc.start < 7 || bytes[avcc.start] !== 1) invalid();
  const codec =
    'avc1.' + [...bytes.subarray(avcc.start + 1, avcc.start + 4)].map((v) => v.toString(16).padStart(2, '0')).join('');
  let samples: Sample[];
  if (fragmented) {
    const tkhd = one(video, 'tkhd'),
      trackID = uint(tkhd.start + (version(tkhd, [0, 1]) ? 20 : 12), tkhd.end);
    samples = fragments!({ bytes, roots, moov, trackID, boxes, children, one, uint, wide, version });
  } else {
    const stsz = one(stbl, 'stsz'),
      constant = uint(stsz.start + 4, stsz.end),
      count = uint(stsz.start + 8, stsz.end);
    // Every nonempty sample occupies at least one byte in this in-memory file.
    if (!count || count > bytes.length || (!constant && count > (stsz.end - stsz.start - 12) / 4)) invalid();
    samples = Array.from({ length: count }, (_, i) => ({
      offset: 0,
      size: constant || uint(stsz.start + 12 + i * 4, stsz.end),
      pts: 0,
      duration: 0,
      key: true,
    }));
    const stts = one(stbl, 'stts');
    let index = 0,
      dts = 0;
    for (let j = 0, n = table(stts, 8); j < n; j++) {
      const p = stts.start + 8 + j * 8,
        run = uint(p, stts.end),
        delta = uint(p + 4, stts.end);
      if (!run || !delta || run > count - index) invalid();
      for (let k = 0; k < run; k++) {
        const sample = samples[index++]!;
        sample.pts = dts;
        sample.duration = delta;
        dts += delta;
        if (!Number.isSafeInteger(dts)) invalid();
      }
    }
    if (index !== count) invalid();
    const ctts = stbl.find((b) => b.type === 'ctts');
    if (ctts) {
      const signed = version(ctts, [0, 1]) === 1;
      index = 0;
      for (let j = 0, n = table(ctts, 8); j < n; j++) {
        const p = ctts.start + 8 + j * 8,
          run = uint(p, ctts.end),
          raw = uint(p + 4, ctts.end);
        const offset = signed ? raw | 0 : raw;
        if (!run || run > count - index) invalid();
        for (let k = 0; k < run; k++) samples[index++]!.pts += offset;
      }
      if (index !== count) invalid();
    }
    const stss = stbl.find((b) => b.type === 'stss');
    if (stss) {
      samples.forEach((s) => {
        s.key = false;
      });
      let previous = 0;
      for (let j = 0, n = table(stss, 4); j < n; j++) {
        const value = uint(stss.start + 8 + j * 4, stss.end);
        if (value <= previous || value > count) invalid();
        samples[value - 1]!.key = true;
        previous = value;
      }
    }
    if (!samples[0]!.key) unsupported();
    const offsets = stbl.filter((b) => b.type === 'stco' || b.type === 'co64');
    if (offsets.length !== 1) invalid();
    const co = offsets[0]!,
      stride = co.type === 'co64' ? 8 : 4,
      chunks = table(co, stride);
    const sc = one(stbl, 'stsc'),
      runs = table(sc, 12);
    if (!runs || !chunks) invalid();
    const chunkRuns: { first: number; size: number }[] = [];
    for (let j = 0; j < runs; j++) {
      const p = sc.start + 8 + j * 12,
        first = uint(p, sc.end),
        size = uint(p + 4, sc.end);
      if ((!j && first !== 1) || first > chunks || (j && first <= chunkRuns[j - 1]!.first) || !size) invalid();
      if (uint(p + 8, sc.end) !== 1) unsupported();
      chunkRuns.push({ first, size });
    }
    const media = roots.filter((b) => b.type === 'mdat');
    index = 0;
    for (let j = 1, run = 0; j <= chunks; j++) {
      if (run + 1 < runs && j === chunkRuns[run + 1]!.first) run++;
      let offset =
        stride === 8 ? wide(co.start + 8 + (j - 1) * stride, co.end) : uint(co.start + 8 + (j - 1) * stride, co.end);
      if (chunkRuns[run]!.size > count - index) invalid();
      for (let k = 0; k < chunkRuns[run]!.size; k++) {
        const sample = samples[index++]!;
        if (!sample.size || !media.some((b) => offset >= b.start && offset + sample.size <= b.end)) invalid();
        sample.offset = offset;
        offset += sample.size;
      }
    }
    if (index !== count) invalid();
  }
  if (!samples.length || !samples[0]!.key) unsupported();
  let mediaStart = 0,
    lead = 0,
    duration = 0,
    movieScale = 1,
    leadTicks = 0,
    mediaLength: number | undefined;
  for (const s of samples) duration = Math.max(duration, (s.pts + s.duration) / scale);
  const edts = video.find((b) => b.type === 'edts');
  if (edts) {
    const elst = one(children(edts), 'elst'),
      v = version(elst, [0, 1]),
      width = v ? 20 : 12;
    const n = table(elst, width),
      mvhd = one(moov, 'mvhd');
    movieScale = uint(mvhd.start + (version(mvhd, [0, 1]) ? 20 : 12), mvhd.end);
    if (!movieScale || n < 1 || n > 2) unsupported();
    for (let j = 0; j < n; j++) {
      const p = elst.start + 8 + j * width,
        length = v ? wide(p, elst.end) : uint(p, elst.end);
      const timeAt = p + (v ? 8 : 4);
      const empty = v
        ? uint(timeAt, elst.end) === 0xffffffff && uint(timeAt + 4, elst.end) === 0xffffffff
        : uint(timeAt, elst.end) === 0xffffffff;
      const time = empty ? -1 : v ? wide(timeAt, elst.end) : uint(timeAt, elst.end);
      if (uint(p + width - 4, elst.end) !== 65536 || (!length && !fragmented)) unsupported();
      if (empty) {
        if (j !== 0 || n !== 2) unsupported();
        leadTicks = length;
        lead = length / movieScale;
      } else {
        if (j !== n - 1) unsupported();
        mediaStart = time;
        mediaLength = length || undefined;
        if (length) duration = lead + length / movieScale;
      }
    }
  }
  const us = (value: number): number => {
    const rounded = Math.round(value * 1000000);
    return Number.isSafeInteger(rounded) ? rounded : invalid();
  };
  // Edit bounds and movie times use exact native ticks. Rounding the media PTS first can
  // move a boundary sample across an edit and double-round an edited timestamp by 1 us.
  const track = BigInt(scale),
    movie = BigInt(movieScale),
    start = BigInt(mediaStart),
    denominator = track * movie,
    limit = mediaLength === undefined ? undefined : BigInt(mediaLength) * track,
    at = (i: number): bigint => {
      if (!Number.isSafeInteger(samples[i]!.pts)) invalid();
      return (BigInt(samples[i]!.pts) - start) * movie;
    };
  const order = samples.map((_, i) => i).filter((i) => at(i) >= 0n && (limit === undefined || at(i) < limit));
  order.sort((a, b) => samples[a]!.pts - samples[b]!.pts);
  if (!order.length) invalid();
  const times = order.map((i) => {
    const value = Number(((at(i) + BigInt(leadTicks) * track) * 1000000n + denominator / 2n) / denominator);
    return Number.isSafeInteger(value) ? value / 1000000 : invalid();
  });
  for (const s of samples) {
    s.pts = us(s.pts / scale);
    s.duration = us(s.duration / scale);
  }
  // Decode timestamps must also be unique: an edit offset can separate rounded movie
  // times while the underlying WebCodecs timestamps still collide.
  if (new Set(samples.map((s) => s.pts)).size !== samples.length) unsupported();
  if (times.some((t, i) => i > 0 && t <= times[i - 1]!)) unsupported();
  return { config: { codec, description: bytes.slice(avcc.start, avcc.end) }, samples, order, times, duration };
}
