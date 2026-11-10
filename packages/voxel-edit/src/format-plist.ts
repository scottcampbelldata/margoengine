// Internal bplist00 reader for VMAX payloads. From Jonathan Levin's format notes;
// bounded object graph, no keyed-unarchive execution. See docs/clean-room.md.
export type Plist = null | boolean | number | string | Uint8Array | Plist[] | { [key: string]: Plist };

export function parsePlist(bytes: Uint8Array): Plist {
  const fail = (): never => {
    throw new RangeError('VMAX binary plist is malformed; save the document again');
  };
  const text = new TextDecoder(),
    dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    trailer = bytes.length - 32;
  if (trailer < 8 || text.decode(bytes.subarray(0, 8)) !== 'bplist00') fail();
  const uint = (at: number, size: number, end = bytes.length): number => {
    if (![1, 2, 4, 8].includes(size) || at < 8 || at + size > end) return fail();
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + bytes[at + i];
    if (!Number.isSafeInteger(n)) fail();
    return n;
  };
  const offsetSize = bytes[trailer + 6],
    refSize = bytes[trailer + 7],
    count = uint(trailer + 8, 8),
    root = uint(trailer + 16, 8),
    offsets = uint(trailer + 24, 8);
  if (
    !count ||
    root >= count ||
    offsets < 8 ||
    offsets + count * offsetSize > trailer ||
    count > bytes.length ||
    ![1, 2, 4, 8].includes(refSize)
  )
    fail();
  const cache = new Map<number, Plist>(),
    active = new Set<number>();
  const read = (id: number, depth: number): Plist => {
    if (id >= count || depth > 64 || active.has(id)) return fail();
    if (cache.has(id)) return cache.get(id)!;
    let at = uint(offsets + id * offsetSize, offsetSize, trailer);
    if (at < 8 || at >= offsets) return fail();
    const marker = bytes[at++],
      kind = marker >>> 4,
      small = marker & 15;
    let value: Plist;
    const take = (n: number) => {
      if (at + n > offsets) fail();
      const p = at;
      at += n;
      return p;
    };
    const size = () => {
      if (small < 15) return small;
      const m = bytes[take(1)];
      if (m >>> 4 !== 1 || (m & 15) > 3) return fail();
      const n = 2 ** (m & 15);
      return uint(take(n), n, offsets);
    };
    active.add(id);
    if (kind === 0) {
      if (small === 0) value = null;
      else if (small === 8 || small === 9) value = small === 9;
      else return fail();
    } else if (kind === 1 || kind === 8) {
      const n = kind === 8 ? small + 1 : 2 ** small,
        p = take(n);
      // Only 8-byte plist integers are signed; smaller integers are unsigned.
      if (kind === 1 && n === 8 && bytes[p] & 128) {
        const v = dv.getBigInt64(p);
        value = Number(v);
        if (!Number.isSafeInteger(value)) return fail();
      } else value = uint(p, n, offsets);
    } else if (kind === 2 || kind === 3) {
      const n = kind === 3 ? 8 : 2 ** small,
        p = take(n);
      if (n !== 4 && n !== 8) return fail();
      value = n === 4 ? dv.getFloat32(p) : dv.getFloat64(p);
      if (!Number.isFinite(value)) return fail();
    } else if (kind === 4 || kind === 5 || kind === 6) {
      const n = size() * (kind === 6 ? 2 : 1),
        p = take(n),
        data = bytes.subarray(p, p + n);
      value =
        kind === 4 ? data : kind === 6 ? new TextDecoder('utf-16be', { fatal: true }).decode(data) : text.decode(data);
    } else if (kind === 10 || kind === 12 || kind === 13) {
      const n = size(),
        p = take(n * refSize * (kind === 13 ? 2 : 1));
      if (kind === 13) {
        const obj: { [key: string]: Plist } = Object.create(null);
        for (let i = 0; i < n; i++) {
          const key = read(uint(p + i * refSize, refSize, offsets), depth + 1);
          if (typeof key !== 'string') return fail();
          obj[key] = read(uint(p + (n + i) * refSize, refSize, offsets), depth + 1);
        }
        value = obj;
      } else {
        value = Array.from({ length: n }, (_, i) => read(uint(p + i * refSize, refSize, offsets), depth + 1));
      }
    } else return fail();
    active.delete(id);
    cache.set(id, value);
    return value;
  };
  return read(root, 0);
}
