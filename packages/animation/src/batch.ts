// Batched deformation: every skinned or morphed primitive of a device lives in a few shared storage buffers, so the
// primitives of many models deform in one dispatch per pipeline (four- and eight-influence) and buffer page instead
// of one dispatch each. Readers find a primitive's vertices at `PBRPrimitive.deformedOffset` in `deformed`.
import type { PBRPrimitive } from '@margoengine/gltf-pro';
import { batchedDeformationShader } from './shader.js';

declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; COPY_DST: number; COPY_SRC: number };

/** Element sizes in bytes: an 80-byte vertex, a 48-byte morph delta, a vec4u influence word, a weight, a matrix. */
const VERTEX = 80,
  MORPH = 48,
  WORD = 16,
  WEIGHT = 4,
  MATRIX = 64,
  /** Bytes of one slot record in the shader's `slots` array (12 u32). */
  SLOT = 48,
  WORKGROUP = 64;

/** A run of elements in one pool. */
interface Range {
  offset: number;
  size: number;
}
/** Immutable data every copy of a primitive reads (bind-pose vertices, morph deltas, skin influences), held once. */
interface Block {
  range: Range;
  refs: number;
  key: string;
  owner: Map<string, Block>;
  /** The two keys above `owner` in the page's `blocks`, dropped with the last block so the page holds no dead asset. */
  asset: object;
  holder: object;
}
/** One storage buffer of a page and the ranges living in it. */
class Pool {
  buffer?: GPUBuffer;
  capacity = 0;
  top = 0;
  readonly ranges = new Set<Range>();
  constructor(
    readonly bytes: number,
    readonly usage: number,
    /** Ranges start on a multiple of this many elements. */
    readonly align = 1,
  ) {}
  get live(): number {
    let n = 0;
    for (const r of this.ranges) n += r.size;
    return n;
  }
}
/** What one deformed primitive needs; the arrays are read once, when the primitive is placed. */
export interface SlotSpec {
  primitive: PBRPrimitive;
  /** Vertices (80 bytes each). */
  count: number;
  /** Morph targets. */
  targets: number;
  /** Skin joints; 0 for a morph-only primitive. */
  joints: number;
  /** Eight influences per vertex (JOINTS_1/WEIGHTS_1) rather than four. */
  extra: boolean;
  /** Identity of the asset data the deltas and influences come from: equal keys share one copy. */
  asset: object;
  definition: object;
  skin: number | undefined;
  deltas(): Float32Array;
  influences(): Uint32Array;
}
/** A placed primitive: where its inputs and its deformed output live. */
export interface Slot {
  readonly page: Page;
  readonly primitive: PBRPrimitive;
  readonly count: number;
  readonly targets: number;
  readonly joints: number;
  readonly extra: boolean;
  readonly source: Block;
  readonly output: Range;
  readonly weights: Range;
  readonly bones: Range;
  readonly morphs?: Block;
  readonly influences?: Block;
  /** Index into the page's slot records, valid for the page's current `version`. */
  index: number;
}
/** One set of shared buffers, all within the device's storage-binding limit. */
class Page {
  readonly source = new Pool(VERTEX, GPUBufferUsage.STORAGE);
  readonly output: Pool;
  readonly morphs = new Pool(MORPH, GPUBufferUsage.STORAGE);
  readonly influences = new Pool(WORD, GPUBufferUsage.STORAGE);
  readonly weights = new Pool(WEIGHT, GPUBufferUsage.STORAGE);
  readonly bones = new Pool(MATRIX, GPUBufferUsage.STORAGE);
  readonly slots = new Set<Slot>();
  readonly blocks = new Map<object, Map<object, Map<string, Block>>>();
  /** Changes whenever a slot or buffer of the page does. */
  version = 0;
  info?: { buffer: GPUBuffer; version: number };
  constructor(alignment: number) {
    // Outputs start on a storage-binding offset, so readers can bind one primitive's vertices.
    let align = 1;
    while ((align * VERTEX) % alignment) align++;
    this.output = new Pool(VERTEX, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC, align);
  }
  get pools(): Pool[] {
    return [this.source, this.output, this.morphs, this.influences, this.weights, this.bones];
  }
}
/** A dispatch the encoder records: one per page and pipeline. */
interface Dispatch {
  pipeline: GPUComputePipeline;
  group: GPUBindGroup;
  table: GPUBuffer;
  x: number;
  y: number;
}
/** The dispatches of one set of owners, rebuilt when the set or the arena changes. */
export interface DispatchCache {
  owners: readonly object[];
  version: number;
  dispatches: Dispatch[];
}
const arenas = new WeakMap<GPUDevice, DeformArena>();
const roundUp = (value: number, align: number) => Math.ceil(value / align) * align;
type BlockKind = 's' | 'm' | 'i';
/** The key of a primitive's shared vertices (`s`), deltas (`m`) or influences (`i`) within its asset and `blockOwner`. */
const blockKey = (spec: SlotSpec, kind: BlockKind) =>
  kind + ':' + spec.count + ':' + (kind === 'i' ? (spec.skin ?? '') : '');
/** What equal blocks have in common: bind-pose vertices are one packed array, the rest come from one definition. */
const blockOwner = (spec: SlotSpec, kind: BlockKind): object =>
  kind === 's' ? spec.primitive.vertices : spec.definition;
const same = (a: SlotSpec, b: SlotSpec, kind: BlockKind) =>
  a.asset === b.asset && blockOwner(a, kind) === blockOwner(b, kind) && blockKey(a, kind) === blockKey(b, kind);

/** Weights live in a region of at least four floats, the size of the per-primitive buffer they used to have. */
export const weightRegion = (targets: number) => Math.max(4, targets);

/** Every deformed primitive of one device, packed into pages of shared buffers. */
export class DeformArena {
  readonly pages: Page[] = [];
  version = 0;
  private pipelines: (GPUComputePipeline | undefined)[] = [];
  private readonly limit: number;
  private readonly alignment: number;
  private constructor(readonly device: GPUDevice) {
    const limits = device.limits;
    this.limit = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
    this.alignment = limits.minStorageBufferOffsetAlignment ?? 256;
  }
  static of(device: GPUDevice): DeformArena {
    let arena = arenas.get(device);
    if (!arena) arenas.set(device, (arena = new DeformArena(device)));
    return arena;
  }
  pipeline(extra: boolean): GPUComputePipeline {
    const at = +extra;
    return (this.pipelines[at] ??= this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: batchedDeformationShader(extra) }),
        entryPoint: 'main',
      },
    }));
  }
  /** Places the primitives of one owner, growing a page at most once; returns their slots in order. */
  add(specs: readonly SlotSpec[]): Slot[] {
    if (!specs.length) return [];
    const plans = new Map<Page, SlotSpec[]>(),
      fresh: Page[] = [],
      pending = new Map<Page, number[]>();
    for (const spec of specs) {
      const need = this.needs(spec);
      if (need.some((n, i) => n * [VERTEX, VERTEX, MORPH, WORD, WEIGHT, MATRIX][i] > this.limit))
        throw new RangeError(
          'Animation buffer exceeds device limit; split the mesh or reduce vertices, joints and morph targets',
        );
      let page = [...this.pages, ...fresh].find((p) => this.fits(p, pending.get(p), need));
      if (!page) fresh.push((page = new Page(this.alignment)));
      // Vertices, deltas and influences another copy already placed (or one placed earlier in this call) are shared.
      const queued = plans.get(page) ?? [];
      if (this.block(page, spec, 's') || queued.some((q) => same(q, spec, 's'))) need[0] = 0;
      if (this.block(page, spec, 'm') || queued.some((q) => same(q, spec, 'm'))) need[2] = 0;
      if (this.block(page, spec, 'i') || queued.some((q) => same(q, spec, 'i'))) need[3] = 0;
      const sum = pending.get(page) ?? [0, 0, 0, 0, 0, 0];
      need.forEach((n, i) => (sum[i] += n));
      pending.set(page, sum);
      let list = plans.get(page);
      if (!list) plans.set(page, (list = []));
      list.push(spec);
    }
    this.pages.push(...fresh);
    for (const [page, list] of plans) this.reserve(page, pending.get(page)!, list);
    const slots = specs.map((spec) => {
      const page = [...plans].find(([, list]) => list.includes(spec))![0];
      return this.place(page, spec);
    });
    // Outputs start as the bind pose, copied on the GPU: a copy of a placed primitive uploads no vertices.
    const encoder = this.device.createCommandEncoder();
    for (const slot of slots)
      encoder.copyBufferToBuffer(
        slot.page.source.buffer!,
        slot.source.range.offset * VERTEX,
        slot.page.output.buffer!,
        slot.output.offset * VERTEX,
        slot.count * VERTEX,
      );
    this.device.queue.submit([encoder.finish()]);
    this.version++;
    return slots;
  }
  /** Frees a slot; an emptied page releases its buffers at once. */
  remove(slot: Slot): void {
    const page = slot.page;
    if (!page.slots.delete(slot)) return;
    const p = slot.primitive;
    if (this.published(slot)) p.deformed = p.deformedOffset = undefined;
    page.output.ranges.delete(slot.output);
    page.weights.ranges.delete(slot.weights);
    page.bones.ranges.delete(slot.bones);
    for (const [block, pool] of [
      [slot.source, page.source],
      [slot.morphs, page.morphs],
      [slot.influences, page.influences],
    ] as const)
      if (block && --block.refs === 0) {
        pool.ranges.delete(block.range);
        block.owner.delete(block.key);
        const byOwner = page.blocks.get(block.asset)!;
        if (!block.owner.size) byOwner.delete(block.holder);
        if (!byOwner.size) page.blocks.delete(block.asset);
      }
    page.version++;
    this.version++;
    if (!page.slots.size) {
      for (const pool of page.pools) pool.buffer?.destroy();
      page.info?.buffer.destroy();
      this.pages.splice(this.pages.indexOf(page), 1);
    }
  }
  /**
   * The dispatches that deform `slots` (grouped by owner in `owners`), cached in `cache` while the owners and the
   * arena stay the same.
   */
  dispatches(owners: readonly object[], slotsOf: (owner: object) => readonly Slot[], cache: DispatchCache): Dispatch[] {
    if (
      cache.version === this.version &&
      cache.owners.length === owners.length &&
      cache.owners.every((owner, i) => owner === owners[i])
    )
      return cache.dispatches;
    const dispatches: Dispatch[] = [],
      work = new Map<Page, [number[], number[]]>();
    for (const owner of owners)
      for (const slot of slotsOf(owner)) {
        const page = slot.page;
        if (!page.slots.has(slot)) continue;
        this.records(page);
        let lists = work.get(page);
        if (!lists) work.set(page, (lists = [[], []]));
        const list = lists[+slot.extra];
        for (let first = 0; first < slot.count; first += WORKGROUP) list.push(slot.index, first);
      }
    const max = this.device.limits.maxComputeWorkgroupsPerDimension ?? 65535;
    try {
      for (const [page, lists] of work)
        for (let extra = 0; extra < 2; extra++) {
          const list = lists[extra],
            n = list.length / 2;
          if (!n) continue;
          const pipeline = this.pipeline(!!extra),
            data = new Uint32Array(list.length + 2);
          data[0] = n;
          data.set(list, 2);
          const table = this.mapped(data),
            x = Math.min(n, max);
          dispatches.push({ pipeline, table, x, y: Math.ceil(n / x), group: undefined! });
          dispatches[dispatches.length - 1].group = this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              page.source.buffer!,
              page.output.buffer!,
              page.morphs.buffer!,
              page.weights.buffer!,
              page.bones.buffer!,
              page.influences.buffer!,
              page.info!.buffer,
              table,
            ].map((buffer, binding) => ({ binding, resource: { buffer } })),
          });
        }
    } catch (error) {
      for (const d of dispatches) d.table.destroy();
      throw error;
    }
    this.retire(cache.dispatches.map((d) => d.table));
    cache.owners = owners.slice();
    cache.version = this.version;
    cache.dispatches = dispatches;
    return dispatches;
  }
  /** Destroys a cache's tables now (its owners are going away). */
  drop(cache: DispatchCache): void {
    for (const d of cache.dispatches) d.table.destroy();
    cache.dispatches = [];
    cache.owners = [];
    cache.version = -1;
  }
  private block(page: Page, spec: SlotSpec, kind: BlockKind): Block | undefined {
    return page.blocks.get(spec.asset)?.get(blockOwner(spec, kind))?.get(blockKey(spec, kind));
  }
  private needs(spec: SlotSpec): number[] {
    return [
      spec.count,
      spec.count,
      spec.count * spec.targets,
      spec.joints ? spec.count * (spec.extra ? 4 : 2) : 0,
      weightRegion(spec.targets),
      spec.joints,
    ];
  }
  private fits(page: Page, pending: number[] | undefined, need: number[]): boolean {
    return page.pools.every((pool, i) => {
      const extra = i === 1 ? pool.align * (page.slots.size + 1) : 0;
      return (pool.live + (pending?.[i] ?? 0) + need[i] + extra) * pool.bytes <= this.limit;
    });
  }
  /** Makes room for `need` more elements in each pool of `page`: compacts and grows its buffers when they are full. */
  private reserve(page: Page, need: number[], specs: readonly SlotSpec[]): void {
    const pools = page.pools,
      // Where pool i ends once the new slots and blocks follow `start`, outputs each on their alignment.
      end = (i: number, start: number) =>
        i === 1 ? specs.reduce((at, spec) => roundUp(at, pools[1].align) + spec.count, start) : start + need[i];
    if (pools.every((pool, i) => pool.buffer && end(i, pool.top) <= pool.capacity)) return;
    const encoder = pools.some((pool) => pool.ranges.size) ? this.device.createCommandEncoder() : undefined,
      retired: GPUBuffer[] = [],
      // Primitives still drawing this page's output (no other deformer took them over) follow it to the new buffer.
      published = [...page.slots].filter((slot) => this.published(slot));
    pools.forEach((pool, i) => {
      const live = [...pool.ranges].sort((a, b) => a.offset - b.offset);
      let used = 0;
      for (const r of live) used = roundUp(used, pool.align) + r.size;
      const needed = end(i, used),
        limit = Math.floor(this.limit / pool.bytes),
        capacity = Math.max(needed, Math.min(limit, pool.capacity * 2), 1),
        buffer = this.device.createBuffer({
          size: Math.max(16, capacity * pool.bytes),
          usage: pool.usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
      let top = 0;
      for (const r of live) {
        top = roundUp(top, pool.align);
        if (r.size)
          encoder!.copyBufferToBuffer(
            pool.buffer!,
            r.offset * pool.bytes,
            buffer,
            top * pool.bytes,
            r.size * pool.bytes,
          );
        r.offset = top;
        top += r.size;
      }
      if (pool.buffer) retired.push(pool.buffer);
      pool.buffer = buffer;
      pool.capacity = Math.floor(buffer.size / pool.bytes);
      pool.top = top;
    });
    if (encoder) this.device.queue.submit([encoder.finish()]);
    this.retire(retired);
    // Every slot of the page moved: point its primitive at the new buffer and offset.
    for (const slot of published) this.publish(slot);
    page.version++;
    this.version++;
  }
  private place(page: Page, spec: SlotSpec): Slot {
    const allocate = (pool: Pool, size: number): Range => {
      const offset = roundUp(pool.top, pool.align),
        range = { offset, size };
      pool.top = offset + size;
      pool.ranges.add(range);
      return range;
    };
    const shared = (pool: Pool, kind: BlockKind, size: number, data: () => ArrayBufferView): Block | undefined => {
      if (!size && kind !== 's') return undefined;
      let byOwner = page.blocks.get(spec.asset);
      if (!byOwner) page.blocks.set(spec.asset, (byOwner = new Map()));
      const owner = blockOwner(spec, kind);
      let byKey = byOwner.get(owner);
      if (!byKey) byOwner.set(owner, (byKey = new Map()));
      const key = blockKey(spec, kind);
      let block = byKey.get(key);
      if (!block) {
        block = { range: allocate(pool, size), refs: 0, key, owner: byKey, asset: spec.asset, holder: owner };
        byKey.set(key, block);
        this.write(pool, block.range, data());
      }
      block.refs++;
      return block;
    };
    const slot: Slot = {
      page,
      primitive: spec.primitive,
      count: spec.count,
      targets: spec.targets,
      joints: spec.joints,
      extra: spec.extra,
      source: shared(page.source, 's', spec.count, () => spec.primitive.vertices)!,
      output: allocate(page.output, spec.count),
      weights: allocate(page.weights, weightRegion(spec.targets)),
      bones: allocate(page.bones, spec.joints),
      morphs: shared(page.morphs, 'm', spec.count * spec.targets, spec.deltas),
      influences: shared(page.influences, 'i', spec.joints ? spec.count * (spec.extra ? 4 : 2) : 0, spec.influences),
      index: -1,
    };
    page.slots.add(slot);
    page.version++;
    this.publish(slot);
    return slot;
  }
  private published(slot: Slot): boolean {
    const p = slot.primitive;
    return p.deformed === slot.page.output.buffer && (p.deformedOffset ?? 0) === slot.output.offset * VERTEX;
  }
  private publish(slot: Slot): void {
    const p = slot.primitive;
    p.deformed = slot.page.output.buffer;
    p.deformedOffset = slot.output.offset * VERTEX;
  }
  private write(pool: Pool, range: Range, data: ArrayBufferView): void {
    if (range.size) this.device.queue.writeBuffer(pool.buffer!, range.offset * pool.bytes, data as BufferSource);
  }
  /** The page's slot records (where each slot's data is), rebuilt when the page changed. */
  private records(page: Page): void {
    if (page.info?.version === page.version) return;
    const data = new Uint32Array(Math.max(1, page.slots.size) * (SLOT / 4));
    let index = 0;
    for (const slot of page.slots) {
      slot.index = index;
      data.set(
        [
          slot.source.range.offset,
          slot.output.offset,
          slot.count,
          slot.targets,
          slot.morphs?.range.offset ?? 0,
          slot.weights.offset,
          slot.bones.offset,
          slot.joints,
          slot.influences?.range.offset ?? 0,
        ],
        index++ * (SLOT / 4),
      );
    }
    if (page.info) this.retire([page.info.buffer]);
    page.info = { buffer: this.mapped(data), version: page.version };
  }
  private mapped(data: Uint32Array): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: Math.max(16, data.byteLength),
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Uint32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }
  /**
   * Destroys buffers an open frame may still have recorded, once the work submitted so far is done (a frame encodes and
   * submits synchronously, so it has been submitted by then).
   */
  private retire(buffers: readonly GPUBuffer[]): void {
    if (!buffers.length) return;
    void this.device.queue.onSubmittedWorkDone().then(() => {
      for (const buffer of buffers) buffer.destroy();
    });
  }
}
