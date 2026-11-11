// Clean room: HDF Group File Format Specification 3.0; sources in docs/clean-room.md.
import { inflateZlib } from '../../shared/inflate.js';
import { byteLimit, fileSource, readBytes, type FileInput, type FileOptions } from './file-source.js';
import { Cursor, datatype, dataspace, hdfError as bad, numeric, product, text, type HDFType } from './hdf5-binary.js';
export type { FileInput, FileOptions, FileSource } from './file-source.js';

/** Numeric samples are checked float64 values; fixed and variable UTF-8 strings remain strings. */
export type HDF5Values = Float64Array | readonly string[];
/** Zero-based file-order hyperslab, last dimension fastest. Defaults select the entire dataset. */
export interface HDF5Selection {
  readonly start?: readonly number[];
  readonly count?: readonly number[];
  readonly stride?: readonly number[];
  readonly signal?: AbortSignal;
}
/** One immutable object header and lazy accessors, owned by its open HDF5File. */
export interface HDF5Node {
  readonly path: string;
  readonly kind: 'group' | 'dataset' | 'datatype';
  readonly shape: readonly number[];
  readonly elementBytes: number;
  /** Optional names project attributes before decoding unrelated datatypes. */
  attributes(signal?: AbortSignal, names?: readonly string[]): Promise<Readonly<Record<string, HDF5Values>>>;
  /** Immediate link names. Listing a group does not read dataset payloads. */
  keys(signal?: AbortSignal): Promise<readonly string[]>;
  read(selection?: HDF5Selection): Promise<HDF5Values>;
}
/** Metadata and lazy datasets; disposal cancels pending and future range reads. */
export interface HDF5File {
  readonly superblockVersion: number;
  get(path: string, signal?: AbortSignal): Promise<HDF5Node>;
  dispose(): void;
  [Symbol.dispose](): void;
}
interface Message {
  type: number;
  data: Uint8Array;
}
interface Link {
  name: string;
  address?: number;
  target?: string;
}
interface Chunk {
  origin: number[];
  address: number;
  size: number;
  mask: number;
}
interface Layout {
  kind: number;
  address: number;
  chunks: number[];
  index: number;
  flags: number;
  size: number;
  mask: number;
  compact?: Uint8Array;
}

/** Opens superblocks 0..3, with bounded metadata and no eager dataset reads. */
export async function openHDF5(input: FileInput, options: FileOptions = {}): Promise<HDF5File> {
  const max = byteLimit(options.maxBytes),
    source = fileSource(input, max),
    life = new AbortController();
  const alive = (signal?: AbortSignal) =>
    AbortSignal.any([life.signal, ...(options.signal ? [options.signal] : []), ...(signal ? [signal] : [])]);
  const read = async (offset: number, length: number, signal?: AbortSignal) => {
    const b = await readBytes(source, offset, length, max, alive(signal));
    if (b.length !== length) bad('file ends before the declared byte range');
    return b;
  };
  let sb = 0,
    prefix = await read(0, 32);
  const magic = [137, 72, 68, 70, 13, 10, 26, 10];
  while (!magic.every((v, i) => prefix[i] === v)) {
    sb = sb ? sb * 2 : 512;
    if (sb > max) bad('no HDF5 signature in the bounded user block');
    prefix = await read(sb, 32);
  }
  const version = prefix[8];
  let ow: number, lw: number, root: number;
  if (version <= 1) {
    ow = prefix[13];
    lw = prefix[14];
    if (![2, 4, 8].includes(ow) || ![2, 4, 8].includes(lw)) bad('invalid address widths');
    const c = new Cursor(await read(sb, (version ? 28 : 24) + ow * 6 + 24));
    c.at = version ? 28 : 24;
    c.take(ow * 4 + ow);
    root = c.uint(ow);
  } else if (version <= 3) {
    ow = prefix[9];
    lw = prefix[10];
    if (![2, 4, 8].includes(ow) || ![2, 4, 8].includes(lw)) bad('invalid address widths');
    const c = new Cursor(await read(sb, 12 + 4 * ow + 4));
    c.at = 12 + 3 * ow;
    root = c.uint(ow);
  } else bad('unknown superblock version');
  const addr = (c: Cursor) => {
    const n = c.uint(ow, true);
    return n < 0 ? -1 : sb + n;
  };
  root += sb;
  const headers = new Map<number, readonly Message[]>();
  async function messages(address: number, signal?: AbortSignal): Promise<readonly Message[]> {
    alive(signal).throwIfAborted();
    const cached = headers.get(address);
    if (cached) return cached;
    const first = new Cursor(await read(address, 32, signal)),
      modern = text(first.bytes.subarray(0, 4)) === 'OHDR';
    let flags = 0,
      start: number,
      length: number;
    if (modern) {
      first.at = 4;
      if (first.uint() !== 2) bad('unknown object header version');
      flags = first.uint();
      if (flags & 32) first.take(16);
      if (flags & 16) first.take(4);
      length = first.uint(2 ** (flags & 3));
      start = address + first.at;
    } else {
      if (first.uint() !== 1) bad('unknown object header version');
      first.at = 8;
      length = first.uint(4);
      start = address + 16;
    }
    const out: Message[] = [],
      queue = [{ start, length, continuation: false }],
      seen = new Set<number>();
    let bytes = 0;
    for (const item of queue) {
      bytes += item.length;
      if (seen.has(item.start) || bytes > max) bad('cyclic or oversized object header');
      seen.add(item.start);
      const c = new Cursor(await read(item.start, item.length, signal));
      if (modern && item.continuation) c.signature('OCHK');
      const stop = c.bytes.length - (modern && item.continuation ? 4 : 0),
        head = modern ? (flags & 4 ? 6 : 4) : 8;
      while (c.at + head <= stop) {
        const type = c.uint(modern ? 1 : 2),
          size = c.uint(2),
          f = c.uint();
        c.take(modern ? (flags & 4 ? 2 : 0) : 3);
        const data = c.take(size);
        if (f & 2) bad('shared object messages are not supported');
        if (type === 16) {
          const next = new Cursor(data);
          queue.push({ start: addr(next), length: next.uint(lw), continuation: true });
        } else if (type) out.push({ type, data });
      }
    }
    headers.set(address, out);
    return out;
  }
  const linksCache = new Map<number, readonly Link[]>();
  function link(data: Uint8Array): Link {
    const c = new Cursor(data);
    if (c.uint() !== 1) bad('unknown link version');
    const f = c.uint(),
      type = f & 8 ? c.uint() : 0;
    if (f & 4) c.take(8);
    if (f & 16) c.take(1);
    const name = text(c.take(c.uint(2 ** (f & 3))));
    if (!name || name.includes('/')) bad('invalid link name');
    if (!type) return { name, address: addr(c) };
    if (type === 1) return { name, target: text(c.take(c.uint(2))) };
    bad(`external or user link type ${type} requires an explicit resolver`);
  }
  async function btree1(
    address: number,
    keySize: number,
    visit: (key: Uint8Array, address: number) => Promise<void>,
    signal?: AbortSignal,
  ) {
    const seen = new Set<number>();
    async function walk(at: number, depth: number) {
      if (depth > 64 || seen.has(at)) bad('cyclic B-tree');
      seen.add(at);
      const head = new Cursor(await read(at, 8 + 2 * ow, signal));
      head.signature('TREE');
      head.uint();
      const level = head.uint(),
        n = head.uint(2);
      const c = new Cursor(await read(at + 8 + 2 * ow, n * (keySize + ow) + keySize, signal));
      for (let i = 0; i < n; i++) {
        const key = c.take(keySize),
          child = addr(c);
        if (level) await walk(child, depth + 1);
        else await visit(key, child);
      }
    }
    if (address >= 0) await walk(address, 0);
  }
  async function links(address: number, signal?: AbortSignal): Promise<readonly Link[]> {
    alive(signal).throwIfAborted();
    const cached = linksCache.get(address);
    if (cached) return cached;
    const out: Link[] = [];
    for (const m of await messages(address, signal)) {
      if (m.type === 6) out.push(link(m.data));
      if (m.type === 2) {
        const c = new Cursor(m.data);
        c.uint();
        const flags = c.uint();
        if (flags & 1) c.take(8);
        const heap = addr(c),
          tree = addr(c);
        if (heap >= 0) {
          for (const record of await btree2(tree, signal))
            out.push(link(await heapObject(heap, record.subarray(4), signal)));
        }
      }
      if (m.type === 17) {
        const c = new Cursor(m.data),
          tree = addr(c),
          heap = addr(c),
          h = new Cursor(await read(heap, 8 + lw * 2 + ow, signal));
        h.signature('HEAP');
        h.take(4);
        const size = h.uint(lw);
        h.take(lw);
        const data = await read(addr(h), size, signal);
        await btree1(
          tree,
          lw,
          async (_, child) => {
            const h = new Cursor(await read(child, 8, signal));
            h.signature('SNOD');
            h.take(2);
            const n = h.uint(2);
            const entries = new Cursor(await read(child + 8, n * (ow * 2 + 24), signal));
            for (let i = 0; i < n; i++) {
              const offset = entries.uint(ow),
                target = addr(entries),
                cache = entries.uint(4);
              entries.take(4);
              const scratch = new Cursor(entries.take(16));
              if (offset >= data.length) bad('name outside local heap');
              const name = text(data.subarray(offset));
              out.push(
                cache === 2 ? { name, target: text(data.subarray(scratch.uint(4))) } : { name, address: target },
              );
            }
          },
          signal,
        );
      }
    }
    if (new Set(out.map((x) => x.name)).size !== out.length) bad('duplicate group links');
    linksCache.set(address, out);
    return out;
  }
  async function btree2(address: number, signal?: AbortSignal): Promise<Uint8Array[]> {
    const h = new Cursor(await read(address, 22 + ow + lw, signal));
    h.signature('BTHD');
    h.take(2);
    const nodeSize = h.uint(4),
      recordSize = h.uint(2),
      depth = h.uint(2);
    h.take(2);
    const root = addr(h),
      nroot = h.uint(2);
    h.uint(lw);
    if (!recordSize || depth > 64) bad('invalid v2 B-tree geometry');
    const widths: number[] = [],
      totals: number[] = [],
      capacities: number[] = [];
    const width = (n: number) => Math.max(1, Math.ceil(Math.log2(n + 1) / 8));
    capacities[0] = Math.floor((nodeSize - 10) / recordSize);
    totals[0] = capacities[0];
    widths[0] = width(capacities[0]);
    for (let d = 1; d <= depth; d++) {
      const pointer = ow + widths[d - 1] + (d > 1 ? width(totals[d - 1]) : 0);
      capacities[d] = Math.floor((nodeSize - 10 - pointer) / (recordSize + pointer));
      totals[d] = capacities[d] + (capacities[d] + 1) * totals[d - 1];
      widths[d] = width(capacities[d]);
    }
    const result: Uint8Array[] = [],
      seen = new Set<number>();
    async function walk(at: number, count: number, d: number) {
      if (seen.has(at) || count > capacities[d]) bad('invalid v2 B-tree node');
      seen.add(at);
      const ptrSize = d ? ow + widths[d - 1] + (d > 1 ? width(totals[d - 1]) : 0) : 0;
      const c = new Cursor(await read(at, 6 + count * recordSize + (d ? count + 1 : 0) * ptrSize + 4, signal));
      c.signature(d ? 'BTIN' : 'BTLF');
      c.take(2);
      for (let i = 0; i < count; i++) result.push(c.take(recordSize));
      if (d)
        for (let i = 0; i <= count; i++) {
          const child = addr(c),
            n = c.uint(widths[d - 1]);
          if (d > 1) c.take(width(totals[d - 1]));
          await walk(child, n, d - 1);
        }
      if (result.length * recordSize > max) bad('v2 B-tree exceeds maxBytes');
    }
    if (root >= 0) await walk(root, nroot, depth);
    return result;
  }
  async function heapObject(address: number, id: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    const h = new Cursor(await read(address, 128 + ow * 3, signal));
    h.signature('FRHP');
    h.uint();
    const idSize = h.uint(2),
      filters = h.uint(2),
      flags = h.uint(),
      maxManaged = h.uint(4);
    h.take(lw + ow + lw + ow + 8 * lw);
    const width = h.uint(2),
      start = h.uint(lw),
      maxDirect = h.uint(lw),
      bits = h.uint(2);
    h.uint(2);
    const root = addr(h),
      rows = h.uint(2),
      offWidth = Math.ceil(bits / 8);
    if (filters || !width || id.length < idSize) bad('invalid or filtered fractal heap');
    if (id[0] >> 4 === 2) return id.subarray(1, 2 + (id[0] & 15));
    if (id[0] >> 4 !== 0) bad('huge heap object requires an external object reader');
    const c = new Cursor(id);
    c.uint();
    const offset = c.uint(offWidth),
      length = c.uint(idSize - offWidth - 1);
    if (length > maxManaged || length > max) bad('heap object exceeds bound');
    async function locate(at: number, nrows: number, base: number, depth: number): Promise<Uint8Array> {
      if (depth > 64) bad('fractal heap nesting exceeds bound');
      if (!nrows) {
        const c = new Cursor(await read(at, 5 + ow + offWidth + (flags & 2 ? 4 : 0), signal));
        c.signature('FHDB');
        c.uint();
        addr(c);
        const blockOffset = c.uint(offWidth);
        if (offset < blockOffset) bad('invalid heap offset');
        return read(at + offset - blockOffset, length, signal);
      }
      const c = new Cursor(await read(at, 5 + ow + offWidth + width * nrows * ow + 4, signal));
      c.signature('FHIB');
      c.uint();
      addr(c);
      c.uint(offWidth);
      let pos = base;
      for (let r = 0; r < nrows; r++) {
        const size = start * 2 ** Math.max(0, r - 1);
        for (let j = 0; j < width; j++, pos += size) {
          const child = addr(c);
          if (offset >= pos && offset < pos + size) {
            if (child < 0 || offset + length > pos + size) bad('unallocated heap object');
            return locate(child, size <= maxDirect ? 0 : Math.log2(size / start) + 1, pos, depth + 1);
          }
        }
      }
      return bad('heap offset outside doubling table');
    }
    return locate(root, rows, 0, 0);
  }
  function layout(b: Uint8Array): Layout {
    const c = new Cursor(b),
      v = c.uint();
    let kind: number,
      address = -1,
      chunks: number[] = [],
      index = 0,
      flags = 0,
      size = 0,
      mask = 0,
      compact: Uint8Array | undefined;
    if (v < 3) {
      const rank = c.uint();
      kind = c.uint();
      c.take(5);
      if (kind) address = addr(c);
      chunks = Array.from({ length: rank }, () => c.uint(4));
      if (!kind) compact = c.take(c.uint(4));
      if (kind === 2) chunks.pop();
    } else {
      kind = c.uint();
      if (!kind) compact = c.take(c.uint(2));
      else if (kind === 1) {
        address = addr(c);
        size = c.uint(lw);
      } else if (kind === 2) {
        if (v === 3) {
          const n = c.uint();
          address = addr(c);
          chunks = Array.from({ length: n }, () => c.uint(4));
          chunks.pop();
        } else if (v === 4 || v === 5) {
          flags = c.uint();
          const n = c.uint(),
            w = c.uint();
          chunks = Array.from({ length: n }, () => c.uint(w));
          chunks.pop();
          index = c.uint();
          if (index === 1 && flags & 2) {
            size = c.uint(lw);
            mask = c.uint(4);
          }
          if (index === 3) c.take(1);
          if (index === 4) c.take(5);
          if (index === 5) c.take(6);
          address = addr(c);
        } else bad('unknown layout version');
      } else bad('virtual layouts require source mappings');
    }
    return { kind, address, chunks, index, flags, size, mask, compact };
  }
  function filters(b?: Uint8Array): number[] {
    if (!b) return [];
    const c = new Cursor(b),
      v = c.uint(),
      n = c.uint(),
      out: number[] = [];
    if (n > 32 || (v !== 1 && v !== 2)) bad('invalid filter pipeline');
    if (v === 1) c.take(6);
    for (let i = 0; i < n; i++) {
      const id = c.uint(2),
        len = v === 1 || id >= 256 ? c.uint(2) : 0;
      c.uint(2);
      const values = c.uint(2);
      c.take(len);
      c.take(values * 4);
      if (v === 1 && values % 2) c.take(4);
      out.push(id);
    }
    return out;
  }
  async function values(b: Uint8Array, type: HDFType, signal?: AbortSignal): Promise<HDF5Values> {
    if (type.kind === 3)
      return Array.from({ length: b.length / type.size }, (_, i) =>
        text(b.subarray(i * type.size, (i + 1) * type.size)),
      );
    if (type.kind !== 9 || !type.string) return numeric(b, type);
    const out: string[] = [],
      c = new Cursor(b);
    while (c.at < b.length) {
      const n = c.uint(4),
        address = addr(c),
        id = c.uint(4);
      if (!n) {
        out.push('');
        continue;
      }
      const h = new Cursor(await read(address, 8 + lw, signal));
      h.signature('GCOL');
      h.take(4);
      const data = new Cursor(await read(address + 8 + lw, h.uint(lw) - 8 - lw, signal));
      let found = false;
      while (data.at + 8 + lw <= data.bytes.length) {
        const key = data.uint(2);
        data.take(6);
        const size = data.uint(lw),
          bytes = data.take(Math.ceil(size / 8) * 8);
        if (key === id) {
          out.push(text(bytes.subarray(0, n)));
          found = true;
          break;
        }
        if (!key) break;
      }
      if (!found) bad('variable string heap object is missing');
    }
    return out;
  }
  async function attributes(ms: readonly Message[], signal?: AbortSignal, names?: readonly string[]) {
    alive(signal).throwIfAborted();
    const out: Record<string, HDF5Values> = Object.create(null);
    // Compact attributes are messages 12; dense ones (more than 8 on an object) are attribute messages stored in a
    // fractal heap, found through the name index (v2 B-tree, type 8 records) of the attribute info message 21.
    const stored = ms.filter((x) => x.type === 12).map((x) => x.data);
    for (const m of ms.filter((x) => x.type === 21)) {
      const c = new Cursor(m.data);
      if (c.uint() !== 0) bad('unknown attribute info version');
      const flags = c.uint();
      if (flags & 1) c.take(2);
      const heap = addr(c),
        names = addr(c);
      if (heap < 0 || names < 0) continue;
      // A type 8 record is the heap ID, a message flags byte, a creation order (4) and a name hash (4).
      for (const record of await btree2(names, signal)) {
        if (record.length <= 9) bad('invalid dense attribute record');
        if (record[record.length - 9] & 2) bad('shared attribute metadata');
        stored.push(await heapObject(heap, record.subarray(0, record.length - 9), signal));
      }
    }
    for (const bytes of stored) {
      const c = new Cursor(bytes),
        version = c.uint(),
        flags = c.uint(),
        n = c.uint(2),
        nt = c.uint(2),
        ns = c.uint(2);
      if (version > 1 && flags) bad('shared attribute metadata');
      if (version === 3) c.uint();
      const padded = (size: number) => (version === 1 ? Math.ceil(size / 8) * 8 : size);
      const name = text(c.take(padded(n)));
      if (names && !names.includes(name)) continue;
      const t = datatype(c.take(padded(nt))),
        shape = dataspace(c.take(padded(ns)), lw);
      out[name] = await values(c.take(product(shape) * t.size), t, signal);
    }
    return out;
  }
  async function node(address: number, path: string, signal?: AbortSignal): Promise<HDF5Node> {
    const ms = await messages(address, signal),
      data = (t: number) => ms.find((m) => m.type === t)?.data,
      typeBytes = data(3),
      type = typeBytes ? datatype(typeBytes) : undefined,
      space = data(1),
      shape = space ? dataspace(space, lw) : [],
      kind = space ? 'dataset' : type ? 'datatype' : 'group';
    return {
      path,
      kind,
      shape,
      elementBytes: type?.size ?? 0,
      attributes: (s, names) => attributes(ms, s, names),
      keys: async (s) => (await links(address, s)).map((l) => l.name),
      async read(selection = {}) {
        alive(selection.signal).throwIfAborted();
        if (kind !== 'dataset' || !type) bad('read requires a dataset');
        const l = layout(data(8) ?? bad('dataset has no layout')),
          rank = shape.length,
          start = selection.start ?? shape.map(() => 0),
          stride = selection.stride ?? shape.map(() => 1),
          count = selection.count ?? shape.map((n, d) => Math.max(0, Math.ceil((n - start[d]) / stride[d])));
        if (
          [start, count, stride].some((a) => a.length !== rank) ||
          shape.some(
            (n, d) =>
              !Number.isSafeInteger(start[d]) ||
              start[d] < 0 ||
              !Number.isSafeInteger(count[d]) ||
              count[d] < 0 ||
              !Number.isSafeInteger(stride[d]) ||
              stride[d] < 1 ||
              (count[d] && start[d] + (count[d] - 1) * stride[d] >= n),
          )
        )
          bad('invalid hyperslab');
        const total = product(count),
          bytes = total * type.size;
        if (bytes > max || total * 8 > max) bad('hyperslab exceeds maxBytes');
        const out = new Uint8Array(bytes),
          fill = data(5) ?? data(4);
        if (fill) {
          const c = new Cursor(fill);
          let size = 0;
          if (data(5)) {
            const v = c.uint();
            if (v < 3) {
              c.take(2);
              if (c.uint()) size = c.uint(4);
            } else if (c.uint() & 32) size = c.uint(4);
          } else size = c.uint(4);
          if (size) {
            const f = c.take(size);
            if (size !== type.size) bad('fill value width differs');
            for (let i = 0; i < total; i++) out.set(f, i * type.size);
          }
        }
        if (!total || (l.address < 0 && l.kind !== 0)) return values(out, type, selection.signal);
        const fp = filters(data(11)),
          chunks: Chunk[] = [];
        if (l.kind !== 2) {
          // Runs along the fastest axis preserve random-access laziness for small slabs.
          const rows = rank ? total / count[rank - 1] : 1,
            width = rank ? count[rank - 1] : 1;
          for (let r = 0; r < rows; r++) {
            let q = r,
              offset = 0,
              mul = 1;
            for (let d = rank - 1; d >= 0; d--) {
              const i = d === rank - 1 ? 0 : q % count[d];
              if (d !== rank - 1) q = Math.floor(q / count[d]);
              offset += (start[d] + i * stride[d]) * mul;
              mul *= shape[d];
            }
            const step = rank ? stride[rank - 1] : 1,
              n = ((width - 1) * step + 1) * type.size;
            const b = l.compact
              ? l.compact.subarray(offset * type.size, offset * type.size + n)
              : await read(l.address + offset * type.size, n, selection.signal);
            if (b.length !== n) bad('compact data ends early');
            for (let i = 0; i < width; i++)
              out.set(b.subarray(i * step * type.size, (i * step + 1) * type.size), (r * width + i) * type.size);
          }
        } else {
          const cs = l.chunks,
            rawSize = product(cs) * type.size;
          if (cs.length !== rank || cs.some((n) => n < 1) || rawSize > max) bad('invalid chunk shape');
          const intersects = (o: number[]) =>
            o.every((v, d) => v <= start[d] + (count[d] - 1) * stride[d] && v + cs[d] > start[d]);
          if (!l.index)
            await btree1(
              l.address,
              8 + (rank + 1) * 8,
              async (key, address) => {
                const c = new Cursor(key),
                  size = c.uint(4),
                  mask = c.uint(4),
                  origin = Array.from({ length: rank }, () => c.uint(8));
                if (intersects(origin)) chunks.push({ origin, address, size, mask });
              },
              selection.signal,
            );
          else if (l.index === 1)
            chunks.push({ origin: shape.map(() => 0), address: l.address, size: l.size || rawSize, mask: l.mask });
          else if (l.index === 2) {
            // Implicit index: chunk i sits at address + i * rawSize. Visit only the chunks holding a selected value,
            // per axis (at most count[d] of them), never every chunk of the shape (KB0535b).
            const dims = shape.map((n, d) => Math.ceil(n / cs[d])),
              signal = alive(selection.signal),
              axes = cs.map((n, d) => {
                const out: number[] = [];
                if (!count[d]) return out;
                const last = Math.floor((start[d] + (count[d] - 1) * stride[d]) / n);
                for (let k = Math.floor(start[d] / n); k <= last; k++) {
                  const j = Math.max(0, Math.ceil((k * n - start[d]) / stride[d]));
                  if (j < count[d] && start[d] + j * stride[d] < (k + 1) * n) out.push(k);
                }
                return out;
              });
            const at = axes.map(() => 0);
            for (let visited = 0; axes.every((a) => a.length); visited++) {
              if (!(visited & 4095)) signal.throwIfAborted();
              let i = 0;
              const origin = at.map((p, d) => {
                i = i * dims[d] + axes[d][p];
                return axes[d][p] * cs[d];
              });
              chunks.push({ origin, address: l.address + i * rawSize, size: rawSize, mask: 0 });
              let d = rank - 1;
              while (d >= 0 && ++at[d] === axes[d].length) at[d--] = 0;
              if (d < 0) break;
            }
          } else if (l.index === 3) {
            const h = new Cursor(await read(l.address, 12 + lw + ow, selection.signal));
            h.signature('FAHD');
            h.uint();
            const client = h.uint(),
              entrySize = h.uint(),
              pageBits = h.uint(),
              n = h.uint(lw),
              address = addr(h);
            const dims = shape.map((n, d) => Math.ceil(n / cs[d]));
            const add = (b: Uint8Array, i: number) => {
              const e = new Cursor(b),
                address = addr(e),
                size = client ? e.uint(entrySize - ow - 4) : rawSize,
                mask = client ? e.uint(4) : 0;
              let q = i;
              const origin = dims.map(() => 0);
              for (let d = rank - 1; d >= 0; d--) {
                origin[d] = (q % dims[d]) * cs[d];
                q = Math.floor(q / dims[d]);
              }
              if (address >= 0 && intersects(origin)) chunks.push({ origin, address, size, mask });
            };
            const pageSize = 2 ** pageBits,
              pages = Math.ceil(n / pageSize),
              bitmapSize = n > pageSize ? Math.ceil(pages / 8) : 0;
            const c = new Cursor(await read(address, 6 + ow + (bitmapSize || n * entrySize) + 4, selection.signal));
            c.signature('FADB');
            c.take(2 + ow);
            if (!bitmapSize) for (let i = 0; i < n; i++) add(c.take(entrySize), i);
            else {
              const bitmap = c.take(bitmapSize),
                base = address + c.at + 4;
              for (let p = 0; p < pages; p++) {
                if (!(bitmap[p >> 3] & (128 >> (p & 7)))) continue;
                const count = Math.min(pageSize, n - p * pageSize),
                  data = new Cursor(
                    await read(base + p * (pageSize * entrySize + 4), count * entrySize + 4, selection.signal),
                  );
                for (let i = 0; i < count; i++) add(data.take(entrySize), p * pageSize + i);
              }
            }
          } else if (l.index === 4) {
            const h = new Cursor(await read(l.address, 12 + 6 * lw + ow + 4, selection.signal));
            h.signature('EAHD');
            h.uint();
            const client = h.uint(),
              entrySize = h.uint(),
              bits = h.uint(),
              inline = h.uint(),
              minElements = h.uint(),
              minPointers = h.uint(),
              pageBits = h.uint();
            h.take(4 * lw);
            const used = h.uint(lw);
            h.uint(lw);
            const indexAddress = addr(h),
              offsetWidth = Math.ceil(bits / 8),
              directRows = 2 * Math.log2(minPointers);
            if (!Number.isInteger(directRows) || !minElements || bits > 53) bad('invalid extensible array geometry');
            const nDirect = 2 * (minPointers - 1),
              nSecondary = bits - Math.log2(minElements) + 1 - directRows;
            const c = new Cursor(
              await read(indexAddress, 6 + ow + inline * entrySize + (nDirect + nSecondary) * ow + 4, selection.signal),
            );
            c.signature('EAIB');
            c.take(2 + ow);
            const dims = shape.map((n, d) => Math.ceil(n / cs[d])),
              spaceCursor = new Cursor(space!);
            const sv = spaceCursor.uint();
            spaceCursor.uint();
            const sf = spaceCursor.uint();
            spaceCursor.at = (sv === 1 ? 8 : 4) + rank * lw;
            let unlimited = 0;
            if (sf & 1) for (let d = 0; d < rank; d++) if (spaceCursor.uint(lw, true) < 0) unlimited = d;
            const order = [unlimited, ...shape.map((_, d) => d).filter((d) => d !== unlimited)];
            const add = (b: Uint8Array, index: number) => {
              const e = new Cursor(b),
                address = addr(e),
                size = client ? e.uint(entrySize - ow - 4) : rawSize,
                mask = client ? e.uint(4) : 0;
              let q = index;
              const origin = dims.map(() => 0);
              for (let k = rank - 1; k >= 0; k--) {
                const d = order[k];
                origin[d] = (q % dims[d]) * cs[d];
                q = Math.floor(q / dims[d]);
              }
              if (index < used && address >= 0 && intersects(origin)) chunks.push({ origin, address, size, mask });
            };
            for (let i = 0; i < inline; i++) add(c.take(entrySize), i);
            const direct = Array.from({ length: nDirect }, () => addr(c)),
              secondary = Array.from({ length: nSecondary }, () => addr(c));
            let offset = inline,
              directIndex = 0;
            for (let r = 0; offset < used; r++) {
              const blocks = 2 ** Math.floor(r / 2),
                elements = minElements * 2 ** Math.ceil(r / 2);
              let blockAddresses: number[], bitmap: Uint8Array | undefined;
              const pages = elements > 2 ** pageBits ? elements / 2 ** pageBits : 0;
              if (r < directRows) blockAddresses = direct.slice(directIndex, (directIndex += blocks));
              else {
                const address = secondary[r - directRows];
                if (address < 0) {
                  offset += blocks * elements;
                  continue;
                }
                const bitmapSize = pages ? blocks * Math.ceil(pages / 8) : 0;
                const s = new Cursor(
                  await read(address, 6 + ow + offsetWidth + bitmapSize + blocks * ow + 4, selection.signal),
                );
                s.signature('EASB');
                s.take(2 + ow + offsetWidth);
                bitmap = s.take(bitmapSize);
                blockAddresses = Array.from({ length: blocks }, () => addr(s));
              }
              for (let j = 0; j < blocks; j++, offset += elements) {
                const address = blockAddresses[j];
                if (address < 0 || offset >= used) continue;
                if (!pages) {
                  const d = new Cursor(
                    await read(address, 6 + ow + offsetWidth + elements * entrySize + 4, selection.signal),
                  );
                  d.signature('EADB');
                  d.take(2 + ow + offsetWidth);
                  for (let i = 0; i < elements; i++) add(d.take(entrySize), offset + i);
                } else
                  for (let p = 0; p < pages; p++) {
                    const bit = j * Math.ceil(pages / 8) * 8 + p;
                    if (!bitmap || !(bitmap[bit >> 3] & (128 >> (bit & 7)))) continue;
                    const n = 2 ** pageBits,
                      d = new Cursor(
                        await read(
                          address + 6 + ow + offsetWidth + p * (n * entrySize + 4),
                          n * entrySize + 4,
                          selection.signal,
                        ),
                      );
                    for (let i = 0; i < n; i++) add(d.take(entrySize), offset + p * n + i);
                  }
              }
            }
          } else if (l.index === 5) {
            for (const record of await btree2(l.address, selection.signal)) {
              const c = new Cursor(record),
                address = addr(c),
                size = fp.length ? c.uint(record.length - ow - 4 - rank * 8) : rawSize,
                mask = fp.length ? c.uint(4) : 0,
                origin = Array.from({ length: rank }, (_, d) => c.uint(8) * cs[d]);
              if (intersects(origin)) chunks.push({ origin, address, size, mask });
            }
          } else bad('unknown chunk index');
          for (const chunk of chunks) {
            let b = await read(chunk.address, chunk.size, selection.signal);
            for (let f = fp.length - 1; f >= 0; f--) {
              if (chunk.mask & (2 ** f)) continue;
              if (fp[f] === 1) b = inflateZlib(b, { limit: rawSize });
              else if (fp[f] === 2) {
                const unshuffled = new Uint8Array(b.length),
                  n = Math.floor(b.length / type.size);
                for (let j = 0; j < type.size; j++)
                  for (let i = 0; i < n; i++) unshuffled[i * type.size + j] = b[j * n + i];
                unshuffled.set(b.subarray(n * type.size), n * type.size);
                b = unshuffled;
              } else bad(`unsupported applied filter ${fp[f]}`);
            }
            if (b.length !== rawSize) bad('decoded chunk size differs from shape');
            const lo = cs.map((_, d) => Math.max(0, Math.ceil((chunk.origin[d] - start[d]) / stride[d]))),
              hi = cs.map((n, d) => Math.min(count[d], Math.ceil((chunk.origin[d] + n - start[d]) / stride[d]))),
              extent = hi.map((n, d) => Math.max(0, n - lo[d]));
            for (let i = 0; i < product(extent); i++) {
              let q = i,
                dst = 0,
                src = 0,
                dm = 1,
                sm = 1;
              for (let d = rank - 1; d >= 0; d--) {
                const j = lo[d] + (q % extent[d]);
                q = Math.floor(q / extent[d]);
                dst += j * dm;
                src += (start[d] + j * stride[d] - chunk.origin[d]) * sm;
                dm *= count[d];
                sm *= cs[d];
              }
              out.set(b.subarray(src * type.size, (src + 1) * type.size), dst * type.size);
            }
          }
        }
        return values(out, type, selection.signal);
      },
    };
  }
  const dispose = () => {
    life.abort();
    headers.clear();
    linksCache.clear();
  };
  return {
    superblockVersion: version,
    dispose,
    [Symbol.dispose]: dispose,
    async get(path, signal) {
      let current = root,
        parts = path.split('/').filter((x) => x && x !== '.'),
        resolved: string[] = [],
        hops = 0;
      while (parts.length) {
        if (++hops > 128) bad('cyclic soft link');
        const name = parts.shift()!;
        if (name === '..') bad('parent path segments are not supported');
        const l = (await links(current, signal)).find((l) => l.name === name);
        if (!l) bad(`object ${path} does not exist`);
        if (l.target !== undefined) {
          const target = l.target.startsWith('/') ? l.target : [...resolved, l.target].join('/');
          parts = [...target.split('/').filter(Boolean), ...parts];
          resolved = [];
          current = root;
        } else {
          current = l.address!;
          resolved.push(name);
        }
      }
      return node(current, '/' + resolved.join('/'), signal);
    },
  };
}
