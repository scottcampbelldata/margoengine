// Network and decode half of @margoengine/gltf-pro/progressive. Runs in dist/workers/progressive.js, or on the main
// thread where Worker is unavailable. HTTP range requests fetch each primitive's accessor bytes in the priority order
// the main thread sends; a server without range support streams the whole file and primitives decode as their bytes
// arrive. Geometry first, then images, then the remaining bytes, so the final buffers equal a plain download.
import { GLTFAsset, assetLimit, componentSizes, components, embedded, entry, overBudget } from './asset.js';
import { decodeExtras, packPrimitive, primitiveDefs } from './pack.js';
import type { GLTFDocument } from './asset.js';

export type StreamError = { name: string; message: string };
export type StreamMessage =
  | { type: 'doc'; doc: GLTFDocument }
  | { type: 'geometry'; key: number; vertices?: Float32Array; indices?: Uint32Array; error?: StreamError }
  | { type: 'image'; index: number; image?: ImageBitmap }
  | { type: 'bytes'; loaded: number; total: number }
  | { type: 'done'; buffers: Uint8Array[]; accessors: [number, Float32Array][] }
  | { type: 'error'; error: StreamError };

interface Source {
  url: URL;
  data?: Uint8Array;
  got: number[];
  asked: number[];
  ranged?: boolean;
  probing?: boolean;
  size?: number;
}
type Range = [source: number, lo: number, hi: number];
// Requests cover whole 256 KB blocks (about one round trip of data on a 50 Mbit/s link), so an assembly of many small
// parts costs file/256 KB requests at most rather than one per part.
const BATCH = 1 << 20,
  BLOCK = 256 << 10,
  PARALLEL = 4;

// Sorted disjoint intervals, flat [lo, hi, lo, hi, ...].
function add(list: number[], lo: number, hi: number): void {
  const out: number[] = [];
  let placed = false;
  for (let i = 0; i < list.length; i += 2) {
    const a = list[i],
      b = list[i + 1];
    if (b < lo) out.push(a, b);
    else if (a > hi) {
      if (!placed) {
        out.push(lo, hi);
        placed = true;
      }
      out.push(a, b);
    } else {
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
  }
  if (!placed) out.push(lo, hi);
  list.length = 0;
  for (const v of out) list.push(v);
}
function gaps(list: number[], lo: number, hi: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < list.length && lo < hi; i += 2) {
    if (list[i + 1] <= lo) continue;
    if (list[i] >= hi) break;
    if (list[i] > lo) out.push([lo, list[i]]);
    lo = Math.max(lo, list[i + 1]);
  }
  if (lo < hi) out.push([lo, hi]);
  return out;
}
const covered = (list: number[], lo: number, hi: number) => !gaps(list, lo, hi).length;
const error = (e: any): StreamError => ({
  name: e?.name ?? 'Error',
  message: e instanceof Error ? e.message : String(e),
});

export class GLTFStream {
  private order?: number[];
  private readonly sources: Source[] = [];
  private map: { source: number; offset: number }[] = [];
  private needs: Range[][] = [];
  private asset?: GLTFAsset;
  private readonly posted = new Set<number>();
  private waiters: (() => void)[] = [];
  private failure: unknown;
  private inflight = 0;
  /** Requested bytes not yet received: new batches wait until under BATCH, so bandwidth goes to the first keys. */
  private pending = 0;
  private loaded = 0;
  private reported = 0;
  private base: URL;
  /** `limit`: maxDownloadBytes, already validated by the caller; `maxNodes`: the load's maxNodes. */
  constructor(
    private readonly url: URL,
    private readonly post: (message: StreamMessage) => void,
    private readonly signal: AbortSignal,
    private readonly limit = assetLimit,
    private readonly maxNodes?: number,
  ) {
    this.base = url;
    signal.addEventListener('abort', () => this.notify(), { once: true });
  }
  /** Primitive keys still wanted, most important first (the main thread re-sends this as the camera moves). */
  setOrder(order: number[]): void {
    this.order = order;
    this.notify();
  }
  private notify(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }
  private async next(): Promise<void> {
    await new Promise<void>((wake) => this.waiters.push(wake));
    this.signal.throwIfAborted();
    if (this.failure) throw this.failure;
  }
  async run(): Promise<void> {
    try {
      const doc = await this.head();
      this.post({ type: 'doc', doc });
      this.buffers(doc);
      while (!this.order) await this.next();
      await this.geometry(doc);
      await this.images(doc);
      // The rest (skins, animations, unused data) so the buffers end up whole; near gaps go in one request.
      for (const [i, s] of this.sources.entries())
        if (s.ranged !== false) {
          const rest = gaps(s.asked, 0, s.data!.length);
          for (let j = 0; j < rest.length; ) {
            const lo = rest[j][0];
            let hi = rest[j++][1];
            while (j < rest.length && rest[j][0] - hi <= BLOCK) hi = rest[j++][1];
            this.request(i, lo, hi);
          }
        }
      while (this.inflight || this.sources.some((s) => !covered(s.got, 0, s.data?.length ?? 0))) await this.next();
      this.bytes(true);
      this.post({ type: 'done', buffers: this.asset!.buffers as Uint8Array[], accessors: decodeExtras(this.asset!) });
    } catch (e) {
      if (!this.signal.aborted) this.post({ type: 'error', error: error(e) });
    }
  }
  private bytes(force = false): void {
    const now = Date.now();
    if (!force && now - this.reported < 100) return;
    this.reported = now;
    this.post({ type: 'bytes', loaded: this.loaded, total: this.sources.reduce((sum, s) => sum + (s.size ?? 0), 0) });
  }
  private fetch(source: Source, headers?: Record<string, string>): Promise<Response> {
    if (!['http:', 'https:'].includes(source.url.protocol)) throw new TypeError('glTF URL must use HTTP(S)');
    return fetch(source.url, { signal: this.signal, headers }).then((r) => {
      if (!r.ok) throw new Error(`glTF download request failed: HTTP ${r.status}`);
      return r;
    });
  }
  private allocate(source: Source, size: number): void {
    if (
      !Number.isSafeInteger(size) ||
      size > this.limit - this.sources.reduce((sum, s) => sum + (s.data?.length ?? 0), 0)
    )
      throw overBudget('glTF exceeds download budget', this.limit);
    source.data = new Uint8Array(size);
    source.size ??= size;
  }
  // Writes a response body at `at` (bounded to the source), marking each chunk as it lands.
  private async read(source: Source, response: Response, at: number, request = { left: 0 }): Promise<void> {
    const reader = response.body!.getReader(),
      stop = () => reader.cancel().catch(() => {});
    this.signal.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        this.signal.throwIfAborted();
        if (done) break;
        const room = source.data!.length - at,
          chunk = value.length > room ? value.subarray(0, room) : value;
        source.data!.set(chunk, at);
        add(source.got, at, at + chunk.length);
        this.loaded += chunk.length;
        at += chunk.length;
        const part = Math.min(chunk.length, request.left);
        request.left -= part;
        this.pending -= part;
        this.bytes();
        this.notify();
        if (at >= source.data!.length) {
          stop();
          break;
        }
      }
    } finally {
      this.signal.removeEventListener('abort', stop);
    }
  }
  private async head(): Promise<GLTFDocument> {
    const s: Source = { url: this.url, got: [], asked: [] };
    this.sources.push(s);
    const response = await this.fetch(s, { Range: 'bytes=0-65535' }),
      range = /^bytes 0-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (response.url) s.url = this.base = new URL(response.url);
    s.ranged = response.status === 206 && !!range;
    const reader = response.body!.getReader(),
      parts: Uint8Array[] = [];
    let length = 0;
    // The first 12 bytes tell a GLB (its length) from JSON.
    while (length < 12) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      length += value.length;
    }
    const first = new Uint8Array(length);
    parts.reduce((at, p) => (first.set(p, at), at + p.length), 0);
    const view = new DataView(first.buffer);
    if (length < 12 || view.getUint32(0, true) !== 0x46546c67) {
      // .gltf: JSON plus external or embedded buffers; the whole JSON is needed (the rest of a ranged reply follows).
      for (let r; !(r = await reader.read()).done; ) parts.push(r.value);
      if (s.ranged && +range![1] > (length = parts.reduce((n, p) => n + p.length, 0)))
        parts.push(new Uint8Array(await (await this.fetch(s, { Range: `bytes=${length}-` })).arrayBuffer()));
      const text = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      parts.reduce((at, p) => (text.set(p, at), at + p.length), 0);
      this.loaded += text.length;
      if (text.length > this.limit) throw overBudget('glTF JSON exceeds byte budget', this.limit);
      this.sources.length = 0;
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(text));
    }
    const total = view.getUint32(8, true);
    if (view.getUint32(4, true) !== 2 || total < 20 || (range && +range[1] !== total))
      throw new TypeError('Invalid GLB header');
    this.allocate(s, total);
    s.data!.set(first.subarray(0, total));
    add(s.got, 0, Math.min(length, total));
    this.loaded += length;
    let at = length;
    const body = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          this.signal.throwIfAborted();
          if (done) break;
          const chunk = value.subarray(0, Math.max(0, total - at));
          s.data!.set(chunk, at);
          add(s.got, at, at + chunk.length);
          this.loaded += chunk.length;
          at += chunk.length;
          this.bytes();
          this.notify();
        }
        if (!s.ranged && at < total) throw new RangeError('Truncated GLB');
      } catch (e) {
        this.failure ??= e;
        this.notify();
      }
    })();
    add(s.asked, 0, s.ranged ? Math.min(65536, total) : total);
    if (s.ranged) await body;
    // Header, JSON chunk and BIN chunk header.
    const json = () => new DataView(s.data!.buffer).getUint32(12, true),
      need = () => Math.min(total, 28 + json());
    while (!covered(s.got, 0, 20)) await this.next();
    if (json() % 4 || 20 + json() > total || new DataView(s.data!.buffer).getUint32(16, true) !== 0x4e4f534a)
      throw new TypeError('Invalid GLB chunk');
    if (s.ranged) for (const [a, b] of gaps(s.got, 0, need())) this.request(0, a, b);
    while (!covered(s.got, 0, need())) await this.next();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(s.data!.subarray(20, 20 + json())));
  }
  // Maps each glTF buffer onto a source: the GLB's BIN chunk, an external file (range-probed on first use) or a data URI.
  private buffers(doc: GLTFDocument): void {
    const glb = this.sources[0],
      external = new Map<string, number>();
    let binStart = 0,
      binLength = 0;
    if (glb) {
      const d = glb.data!,
        v = new DataView(d.buffer),
        at = 20 + v.getUint32(12, true);
      if (at + 8 <= d.length && covered(glb.got, at, at + 8) && v.getUint32(at + 4, true) === 0x004e4942) {
        binStart = at + 8;
        binLength = Math.min(v.getUint32(at, true), d.length - binStart);
      }
    }
    const views = (doc.buffers ?? []).map((def: any, i: number) => {
      if (def?.uri === undefined) {
        if (i === 0 && glb && binLength) {
          this.map.push({ source: 0, offset: binStart });
          return glb.data!.subarray(binStart, binStart + binLength);
        }
        this.map.push({ source: -1, offset: 0 });
        return new Uint8Array();
      }
      if (typeof def.uri === 'string' && def.uri.startsWith('data:')) {
        this.map.push({ source: -1, offset: 0 });
        const b = embedded(def.uri, this.limit);
        this.loaded += b.length;
        return b;
      }
      const url = new URL(def.uri, this.base).href;
      let k = external.get(url);
      if (k === undefined) {
        k = this.sources.length;
        external.set(url, k);
        const s: Source = { url: new URL(url), got: [], asked: [] };
        this.sources.push(s);
        this.allocate(s, Number.isSafeInteger(def.byteLength) && def.byteLength > 0 ? def.byteLength : 0);
      }
      this.map.push({ source: k, offset: 0 });
      return this.sources[k].data!;
    });
    // Same validation (and the same errors) as a plain load: required extensions, buffer sizes, the byte budget.
    this.asset = new GLTFAsset(doc, views, undefined, {}, this.limit, this.maxNodes);
    this.needs = primitiveDefs(doc).map((p) => {
      const out: Range[] = [],
        a = p?.attributes ?? {};
      try {
        for (const id of [a.POSITION, a.NORMAL, a.TANGENT, a.TEXCOORD_0, a.TEXCOORD_1, a.COLOR_0, p.indices])
          if (id !== undefined) this.ranges(doc, id, out);
      } catch {
        for (const [i, b] of this.map.entries())
          if (b.source >= 0) out.push([b.source, b.offset, b.offset + this.asset!.buffers[i].length]);
      }
      return out;
    });
  }
  // Byte ranges (in source coordinates) an accessor reads, exactly as GLTFAsset.accessor reads them.
  private ranges(doc: GLTFDocument, id: number, out: Range[]): void {
    const a = entry(doc.accessors, id, 'accessor'),
      size = componentSizes[a.componentType],
      width = components[a.type],
      count = a.count;
    const span = (view: number, offset: number, length: number) => {
      const v = entry(doc.bufferViews, view, 'bufferView'),
        b = this.map[v.buffer],
        lo = (v.byteOffset ?? 0) + offset,
        end = (v.byteOffset ?? 0) + v.byteLength;
      if (!b || !Number.isSafeInteger(lo) || !Number.isSafeInteger(end) || !(length > 0)) throw new TypeError('range');
      if (b.source >= 0) out.push([b.source, b.offset + lo, b.offset + Math.min(lo + length, end)]);
    };
    if (a.bufferView !== undefined)
      span(
        a.bufferView,
        a.byteOffset ?? 0,
        (count - 1) * (entry(doc.bufferViews, a.bufferView, 'bufferView').byteStride ?? size * width) + size * width,
      );
    if (a.sparse) {
      const n = a.sparse.count;
      span(
        a.sparse.indices.bufferView,
        a.sparse.indices.byteOffset ?? 0,
        n * componentSizes[a.sparse.indices.componentType],
      );
      span(a.sparse.values.bufferView, a.sparse.values.byteOffset ?? 0, n * size * width);
    }
  }
  private request(k: number, lo: number, hi: number): void {
    const s = this.sources[k],
      request = { left: hi - lo };
    add(s.asked, lo, hi);
    this.inflight++;
    this.pending += hi - lo;
    if (s.ranged === undefined) s.probing = true;
    (async () => {
      const response = await this.fetch(s, { Range: `bytes=${lo}-${hi - 1}` }),
        range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (response.status === 206 && range && +range[1] === lo) {
        if (s.ranged === undefined && +range[2] < s.data!.length) throw new RangeError('Truncated glTF buffer');
        s.ranged = true;
        await this.read(s, response, lo, request);
      } else {
        // No range support: this reply is the whole file; take it from the start.
        s.ranged = false;
        add(s.asked, 0, s.data!.length);
        await this.read(s, response, 0, request);
        if (!covered(s.got, 0, s.data!.length)) throw new RangeError('Truncated glTF buffer');
      }
    })()
      .catch((e) => {
        this.failure ??= e;
      })
      .finally(() => {
        this.inflight--;
        this.pending -= request.left;
        s.probing = false;
        this.notify();
      });
  }
  private ready(key: number): boolean {
    return this.needs[key].every(([k, lo, hi]) => covered(this.sources[k].got, lo, hi));
  }
  private async geometry(doc: GLTFDocument): Promise<void> {
    const defs = primitiveDefs(doc);
    for (;;) {
      if (this.failure) throw this.failure;
      const order = this.order!.filter((k) => !this.posted.has(k));
      // Decode what has arrived, most important first.
      for (const key of order)
        if (this.ready(key)) {
          this.posted.add(key);
          try {
            const { vertices, indices } = packPrimitive(this.asset!, defs[key]);
            this.post({ type: 'geometry', key, vertices, indices });
          } catch (e) {
            this.post({ type: 'geometry', key, error: error(e) });
          }
        }
      if (this.order!.every((k) => this.posted.has(k))) return;
      // Ask for the next keys' missing blocks, about BATCH bytes at a time, merging adjacent blocks into one request.
      let budget = BATCH;
      const wanted: Range[] = [];
      for (const key of order) {
        if (this.inflight >= PARALLEL || budget <= 0 || this.pending >= BATCH) break;
        for (const [k, lo, hi] of this.needs[key]) {
          const s = this.sources[k];
          if (s.ranged === false || s.probing) continue;
          for (const [a, b] of gaps(
            s.asked,
            lo - (lo % BLOCK),
            Math.min(s.data!.length, Math.ceil(hi / BLOCK) * BLOCK),
          )) {
            wanted.push([k, a, b]);
            add(s.asked, a, b);
            budget -= b - a;
            if (s.ranged === undefined) {
              s.probing = true;
              break;
            } // one request until a new source's range support is known
          }
        }
      }
      wanted.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      for (let i = 0; i < wanted.length; ) {
        let [k, lo, hi] = wanted[i++];
        while (i < wanted.length && wanted[i][0] === k && wanted[i][1] <= hi) hi = Math.max(hi, wanted[i++][2]);
        this.request(k, lo, hi);
      }
      if (!wanted.length) await this.next();
    }
  }
  private async images(doc: GLTFDocument): Promise<void> {
    // Images used by the most important primitives first, then the rest.
    const defs = primitiveDefs(doc),
      first: number[] = [],
      images = doc.images ?? [],
      material = (p: any) => doc.materials?.[p?.material];
    const textures = (m: any) =>
      JSON.stringify(m ?? {})
        .match(/"index":\d+/g)
        ?.map((t) => +t.slice(8)) ?? [];
    for (const key of this.order!)
      for (const t of textures(material(defs[key]))) {
        const def = doc.textures?.[t];
        for (const s of [def?.source, ...Object.values(def?.extensions ?? {}).map((e: any) => e?.source)])
          if (Number.isInteger(s) && !first.includes(s)) first.push(s);
      }
    const queue = [
      ...first,
      ...images.map((_: unknown, i: number) => i).filter((i: number) => !first.includes(i)),
    ].filter((i) => i < images.length);
    let decoded = 0;
    const one = async (index: number) => {
      const def = images[index],
        ktx2 = def.mimeType === 'image/ktx2' || /\.ktx2$/i.test(def.uri ?? '');
      if (ktx2) {
        this.post({ type: 'image', index });
        return;
      }
      let data: Uint8Array;
      if (def.bufferView !== undefined) {
        const v = entry(doc.bufferViews, def.bufferView, 'bufferView'),
          b = this.map[v.buffer];
        if (b?.source >= 0) {
          const s = this.sources[b.source],
            lo = b.offset + (v.byteOffset ?? 0),
            hi = lo + v.byteLength;
          if (s.ranged) {
            const missing = gaps(s.asked, lo, hi);
            for (const [a, c] of missing) this.request(b.source, a, c);
          }
          while (!covered(s.got, lo, Math.min(hi, s.data!.length))) {
            if (s.ranged === undefined && !s.probing) this.request(b.source, lo, hi);
            await this.next();
          }
        }
        data = this.asset!.view(def.bufferView);
      } else if (typeof def.uri === 'string' && def.uri.startsWith('data:')) data = embedded(def.uri, this.limit);
      else if (typeof def.uri === 'string') {
        const r = await this.fetch({ url: new URL(def.uri, this.base), got: [], asked: [] });
        data = new Uint8Array(await r.arrayBuffer());
        this.loaded += data.length;
        if (this.loaded > this.limit) throw overBudget('glTF exceeds download budget', this.limit);
      } else throw new TypeError('Invalid glTF image');
      const image = await createImageBitmap(new Blob([new Uint8Array(data)], { type: def.mimeType }), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      decoded += image.width * image.height * 4;
      if (image.width * image.height > 16_777_216) {
        image.close?.();
        throw new RangeError('glTF images exceed decoded size limit');
      }
      if (decoded > this.limit * 4) {
        image.close?.();
        throw overBudget('glTF images exceed decoded size limit', this.limit * 4);
      }
      this.post({ type: 'image', index, image });
    };
    const workers = Array.from({ length: PARALLEL }, async () => {
      for (let i; (i = queue.shift()) !== undefined; ) await one(i);
    });
    await Promise.all(workers);
  }
}
