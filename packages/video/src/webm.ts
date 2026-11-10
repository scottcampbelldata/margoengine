import { fault } from '../../shared/errors.js';
import type { Movie, Sample } from './mp4.js';

interface Element {
  id: number;
  start: number;
  end: number;
}
const invalid = (): never => {
  throw fault('failed', 'Invalid WebM container; provide a complete unencrypted WebM file');
};
const unsupported = (): never => {
  throw fault('unsupported', 'Unsupported WebM track or timing; use unencrypted VP8, VP9 or AV1 with timestamps');
};

/** Package-local EBML reader written from RFC 8794, RFC 9559 and WebM's container guidelines. */
export function readWebM(bytes: Uint8Array): Movie {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vint = (
    p: number,
    end: number,
    id = false,
  ): { value: number; next: number; unknown: boolean; width: number } => {
    if (p >= end || !bytes[p]) invalid();
    const width = Math.clz32(bytes[p]!) - 23;
    if (width > (id ? 4 : 8) || p + width > end) invalid();
    let n = BigInt(id ? bytes[p]! : bytes[p]! & (255 >>> width));
    for (let i = 1; i < width; i++) n = n * 256n + BigInt(bytes[p + i]!);
    const unknown = !id && n === (1n << BigInt(7 * width)) - 1n;
    if (!unknown && n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return { value: Number(n), next: p + width, unknown, width };
  };
  const at = (p: number, end: number): Element & { unknown: boolean } => {
    const id = vint(p, end, true),
      size = vint(id.next, end);
    if (!size.unknown && size.value > end - size.next) invalid();
    return { id: id.value, start: size.next, end: size.unknown ? end : size.next + size.value, unknown: size.unknown };
  };
  const level1 = new Set([
    0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367,
  ]);
  const elements = (start: number, end: number): Element[] => {
    const out: Element[] = [];
    for (let p = start; p < end; ) {
      const e = at(p, end);
      if (e.unknown && e.id !== 0x18538067 && e.id !== 0x1f43b675) invalid();
      if (e.unknown && e.id === 0x1f43b675) {
        let q = e.start;
        while (q < end) {
          const child = at(q, end);
          if (level1.has(child.id)) break;
          if (child.unknown) invalid();
          q = child.end;
        }
        e.end = q;
      }
      out.push(e);
      p = e.end;
    }
    return out;
  };
  const kids = (e: Element): Element[] => elements(e.start, e.end);
  const one = (list: Element[], id: number): Element => {
    const found = list.filter((e) => e.id === id);
    return found.length === 1 ? found[0]! : invalid();
  };
  const uint = (e: Element): number => {
    if (e.end - e.start > 8 || e.end === e.start) invalid();
    let n = 0n;
    for (let p = e.start; p < e.end; p++) n = n * 256n + BigInt(bytes[p]!);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : invalid();
  };
  const number = (e: Element): number => {
    const n =
      e.end - e.start === 4 ? view.getFloat32(e.start) : e.end - e.start === 8 ? view.getFloat64(e.start) : invalid();
    return Number.isFinite(n) ? n : invalid();
  };
  const text = (e: Element): string => new TextDecoder().decode(bytes.subarray(e.start, e.end));
  const value = (list: Element[], id: number, fallback: number): number => {
    const e = list.find((e) => e.id === id);
    return e ? uint(e) : fallback;
  };
  const roots = elements(0, bytes.length),
    header = kids(one(roots, 0x1a45dfa3));
  if (text(one(header, 0x4282)) !== 'webm') unsupported();
  const segment = kids(one(roots, 0x18538067)),
    info = kids(one(segment, 0x1549a966)),
    scale = value(info, 0x2ad7b1, 1000000);
  if (!scale) invalid();
  const tracks = kids(one(segment, 0x1654ae6b))
      .filter((e) => e.id === 0xae)
      .map(kids),
    track = tracks.find((t) => value(t, 0x83, 0) === 1);
  if (!track) return unsupported();
  if (track.some((e) => e.id === 0x6d80)) unsupported(); // ContentEncodings includes encryption and header transforms.
  const id = uint(one(track, 0xd7)),
    codecID = text(one(track, 0x86)),
    video = kids(one(track, 0xe0)),
    width = uint(one(video, 0xb0)),
    height = uint(one(video, 0xba)),
    defaultDuration = value(track, 0x23e383, 0),
    trackScale = track.find((e) => e.id === 0x23314f),
    timeScale = trackScale ? number(trackScale) : 1,
    codecPrivate = track.find((e) => e.id === 0x63a2);
  if (!id || !width || !height || !(timeScale > 0)) invalid();
  let codec: string;
  if (codecID === 'V_VP8') codec = 'vp8';
  else if (codecID === 'V_VP9') {
    const fields = new Map<number, number>();
    if (codecPrivate)
      for (let p = codecPrivate.start; p < codecPrivate.end; ) {
        if (p + 2 > codecPrivate.end) invalid();
        const id = bytes[p++]!,
          n = bytes[p++]!;
        if (p + n > codecPrivate.end) invalid();
        if (n === 1) fields.set(id, bytes[p]!);
        p += n;
      }
    const colour = video.find((e) => e.id === 0x55b0),
      bits = colour ? value(kids(colour), 0x55b2, 8) : 8;
    codec =
      'vp09.' +
      [fields.get(1) ?? 0, fields.get(2) ?? 10, fields.get(3) ?? bits].map((n) => String(n).padStart(2, '0')).join('.');
  } else if (codecID === 'V_AV1') {
    if (!codecPrivate || codecPrivate.end - codecPrivate.start < 4) return invalid();
    const p = codecPrivate.start,
      profile = bytes[p + 1]! >>> 5,
      level = bytes[p + 1]! & 31,
      tier = bytes[p + 2]! & 128 ? 'H' : 'M',
      depth = bytes[p + 2]! & 64 ? (bytes[p + 2]! & 32 ? 12 : 10) : 8;
    if (bytes[p] !== 0x81) invalid();
    codec = `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`;
  } else return unsupported();
  const records: { sample: Sample; ns: number; duration: number; visible: boolean }[] = [];
  const block = (e: Element, clock: number, key?: boolean, duration?: number): void => {
    const trackNumber = vint(e.start, e.end);
    if (trackNumber.unknown || trackNumber.next + 3 > e.end) invalid();
    if (trackNumber.value !== id) return;
    let p = trackNumber.next;
    const timestamp = view.getInt16(p);
    p += 2;
    const flags = bytes[p++]!,
      lacing = (flags >>> 1) & 3;
    const count = lacing ? bytes[p++]! + 1 : 1,
      sizes: number[] = [];
    if (p > e.end) invalid();
    if (lacing === 1) {
      for (let i = 0; i < count - 1; i++) {
        let size = 0,
          n: number;
        do {
          if (p >= e.end) invalid();
          n = bytes[p++]!;
          size += n;
        } while (n === 255);
        sizes.push(size);
      }
    } else if (lacing === 2) {
      const size = (e.end - p) / count;
      if (!Number.isInteger(size)) invalid();
      for (let i = 0; i < count - 1; i++) sizes.push(size);
    } else if (lacing === 3) {
      if (count > 1) {
        const first = vint(p, e.end);
        if (first.unknown) invalid();
        sizes.push(first.value);
        p = first.next;
      }
      for (let i = 1; i < count - 1; i++) {
        const delta = vint(p, e.end);
        if (delta.unknown) invalid();
        p = delta.next;
        sizes.push(sizes[i - 1]! + delta.value - (2 ** (7 * delta.width - 1) - 1));
      }
    }
    sizes.push(e.end - p - sizes.reduce((a, b) => a + b, 0));
    // An explicit BlockDuration (whole block, all laced frames) overrides the track's DefaultDuration (RFC 9559).
    const step = duration ? (duration * scale * timeScale) / count : defaultDuration;
    if (count > 1 && !step) unsupported();
    for (let i = 0; i < count; i++) {
      const size = sizes[i]!,
        ns = (clock + timestamp) * scale * timeScale + i * step;
      if (!Number.isSafeInteger(size) || size < 1 || p + size > e.end || !Number.isFinite(ns)) invalid();
      records.push({
        sample: { offset: p, size, pts: 0, duration: 0, key: key ?? !!(flags & 128) },
        ns,
        duration: step,
        visible: !(flags & 8),
      });
      p += size;
    }
  };
  for (const cluster of segment.filter((e) => e.id === 0x1f43b675)) {
    const parts = kids(cluster),
      clock = uint(one(parts, 0xe7));
    for (const e of parts) {
      if (e.id === 0xa3) block(e, clock);
      else if (e.id === 0xa0) {
        const group = kids(e);
        if (group.some((e) => e.id === 0xa4)) unsupported();
        block(one(group, 0xa1), clock, !group.some((e) => e.id === 0xfb), value(group, 0x9b, 0) || undefined);
      }
    }
  }
  if (!records.length || !records[0]!.sample.key) unsupported();
  const us = (ns: number): number => {
    const n = Math.round(ns / 1000);
    return Number.isSafeInteger(n) ? n : invalid();
  };
  const declared = info.find((e) => e.id === 0x4489),
    declaredNS = declared ? number(declared) * scale : 0;
  const sorted = records.map((_, i) => i).sort((a, b) => records[a]!.ns - records[b]!.ns);
  let nextNS = declaredNS,
    groupEnd = sorted.length,
    duration = declaredNS / 1e9;
  while (groupEnd > 0) {
    const ns = records[sorted[groupEnd - 1]!]!.ns;
    let first = groupEnd - 1;
    while (first > 0 && records[sorted[first - 1]!]!.ns === ns) first--;
    for (let i = first; i < groupEnd; i++) {
      const record = records[sorted[i]!]!;
      record.sample.pts = us(ns);
      record.sample.duration = us(record.duration || Math.max(0, nextNS - ns));
      duration = Math.max(duration, (record.sample.pts + record.sample.duration) / 1000000);
    }
    nextNS = ns;
    groupEnd = first;
  }
  const samples = records.map((r) => r.sample),
    order = sorted.filter((i) => records[i]!.visible),
    times = order.map((i) => samples[i]!.pts / 1000000);
  if (!order.length || times.some((t, i) => i > 0 && t <= times[i - 1]!)) unsupported();
  return { config: { codec, codedWidth: width, codedHeight: height }, samples, order, times, duration };
}
