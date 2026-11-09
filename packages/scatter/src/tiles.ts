/// <reference lib="esnext.disposable" preserve="true" />
// Stored instances streamed per tile (biomes decision D3): 8-byte records (u16 x and z inside the tile, palette
// index, log scale, yaw, variant) uploaded per tile and expanded on the GPU every frame by scatter's own distribute
// pass, rewritten to read records instead of a stratified grid, so culling, LOD rings, fades, wind, ground fit and
// shading are scatter's.
// GPU memory follows what is held (goal G2 of the biomes spec): records live in pages of 64 taken from a free list (a
// tile wastes less than one page, adding or removing a tile moves nothing else, and streaming never repacks), the pool
// grows with headroom only when every page is taken, and each LOD ring holds only as many instances as the held tiles
// within its distance can give, recounted every frame from the camera. A second mesh of the same objects (a tree's
// canopy over its trunk) shares the first one's records, culling and rings instead of repeating them.
import type { EngineKernel, Geometry } from '@margoengine/core';
import { engineRuntime, type Engine, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
// Through the package name, so the tiles entry shares the root's Scatter class with the app.
import { Scatter, scatterCullShader, type ScatterOptions } from '@margoengine/scatter';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; COPY_SRC: number; INDIRECT: number };
type TilesPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Settings of {@link ScatterTiles}. Every option of `Scatter` that describes one look applies (material, lod, wind...). */
export interface ScatterTilesOptions
  extends Omit<
    ScatterOptions,
    'count' | 'area' | 'center' | 'density' | 'densityMap' | 'follow' | 'exclusions' | 'scale'
  > {
  /** World rectangle `[minX, minZ, maxX, maxZ]` the heightmap covers (and the tiles lie in). */
  readonly bounds: readonly [number, number, number, number];
  /** Tiles held at once, 1..4,096. Default 64. */
  readonly slots?: number;
  /** Records one tile may hold for this mesh, 1..65,536. Default 4,096. */
  readonly slotSize?: number;
  /** Most instances one LOD ring may draw per frame, 1..1,000,000 (rings are sized from the held tiles up to it). Default
   * 1,000,000. */
  readonly drawn?: number;
  /** Multiplier on every record's scale (the mesh size at scale 1). Default 1. */
  readonly scale?: number;
  /** The record palette index this mesh draws; records of other indices are skipped. Default: every record. */
  readonly species?: number;
  /**
   * Another `ScatterTiles` whose objects this mesh also draws (a tree's canopy over its trunk): it shares that one's
   * records, culling and LOD rings, and its own `setTile` and `removeTile` go to it. Default none.
   */
  readonly share?: ScatterTiles;
}

/** The distribute shader that reads records: scatter's world-rectangle variant with a record prelude. */
export function tilesCullShader(): string {
  const code = scatterCullShader({ bounds: [0, 0, 1, 1] })
    .replace(
      '@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;',
      '@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;\n@group(0) @binding(7) var<storage,read> records:array<vec2u>;\n@group(0) @binding(8) var<storage,read> pages:array<vec4u>;',
    )
    // A ring keeps at most its buffer's instances: the ordered cull's compaction stops there (./order.ts).
    .replace(
      /let i=id\.x;if\(i>=frame\.ids\.x\|\|hash\(i\*7u\+1u\)>frame\.rules\.w\)\{return;\}[\s\S]*?let uv=[^\n]*\n/,
      // Page p (records 64 p .. 64 p + 63) is pages[1 + p] = (its tile's origin x and z and side as f32 bits, records used).
      'let i=id.x;if(i>=frame.ids.x){return;}let page=pages[1u+(i>>6u)];if((i&63u)>=page.w){return;}let r=records[i];\n let world=bitcast<vec2f>(page.xy)+vec2f(f32(r.x&0xffffu),f32(r.x>>16u))*bitcast<f32>(page.z)/65536.0;\n',
    )
    .replace('let world=vec2f((uv.x-0.5)*frame.area.x+frame.area.z,(uv.y-0.5)*frame.area.y+frame.area.w);', '')
    .replace(
      'let scale=mix(frame.scale.x,frame.scale.y,hash(i*7u+4u));',
      'let scale=frame.scale.x*exp2((f32((r.y>>8u)&255u)-128.0)/32.0);',
    )
    .replace('(uv.x-0.5)*frame.area.x+frame.area.z', 'world.x')
    .replace('(uv.y-0.5)*frame.area.y+frame.area.w', 'world.y')
    .replace('let angle=hash(i*7u+5u)*6.2831853;', 'let angle=f32((r.y>>16u)&255u)*0.024543693;');
  // The rewrite must leave no grid term; the package test pins the result, this catches a changed base shader.
  if (/hash\(i\*7u|uv\./.test(code))
    throw new MargoError(
      'failed',
      'The scatter tiles shader kept a grid term; update tilesCullShader to the distribute shader',
    );
  return code;
}

/** Records per page, and the pages the pool starts with. */
const PAGE = 64,
  FIRST_PAGES = 16;
const normal = (n: number) => Number.isFinite(n) && Number.isFinite(Math.fround(n)) && (n === 0 || Math.abs(Math.fround(n)) >= 2 ** -126);
/** Headroom when a buffer grows: half again the records or instances that need it, plus a little. */
const grown = (n: number) => Math.ceil(n * 1.5) + 256;

/** One held tile: its pages and its rectangle. */
interface Held {
  readonly pages: number[];
  readonly count: number;
  readonly x: number;
  readonly z: number;
  readonly side: number;
}

/**
 * Stored instances drawn through scatter: add each tile's 8-byte records as they stream in, remove tiles as they
 * leave; the GPU culls them, picks LOD rings and fades every frame. One `ScatterTiles` draws one mesh (one species);
 * a second mesh of the same objects takes `share`. GPU memory: 8 bytes per held record and 32 per instance a ring can
 * draw, both sized from what is held (with headroom), so a sparse species costs little.
 * `using tiles = ScatterTiles.attach(engine, geometry, options)` frees it at the end of a block.
 * @example
 * const trees = ScatterTiles.attach(engine, [near, middle, far], { bounds: [-2048, -2048, 2048, 2048], heightmap });
 * trees.setTile('3,4', [-1280, -1024], 256, records);
 */
export class ScatterTiles extends Scatter {
  readonly slots: number;
  readonly slotSize: number;
  readonly #species: number;
  readonly #drawn: number;
  readonly #leader?: ScatterTiles;
  readonly #followers: ScatterTiles[] = [];
  /** CPU copies (kept for device restoration): the records by page, and the page table, header first. */
  #records = new Uint32Array(2 * PAGE * FIRST_PAGES);
  #table = new Uint32Array(4 * (1 + FIRST_PAGES));
  /** Free pages (taken from the end), the held tiles by key, and pages written since the last upload. */
  #free: number[] = Array.from({ length: FIRST_PAGES }, (_, p) => FIRST_PAGES - 1 - p);
  readonly #held = new Map<string, Held>();
  readonly #written = new Set<number>();
  /** Records the GPU buffer holds and instances each ring holds. */
  #capacity = 0;
  readonly #rings = [0, 0, 0];
  #recordBuffer?: GPUBuffer;
  #tableBuffer?: GPUBuffer;
  /** Every page uploads on the next frame (after growth or device restoration). */
  #all = true;
  #tableDirty = true;

  constructor(geometry: Geometry | readonly [Geometry, Geometry, Geometry], input: ScatterTilesOptions) {
    const {
      bounds,
      slots = 64,
      slotSize = 4096,
      drawn = 1000000,
      scale = 1,
      species = -1,
      share,
    } = input ?? ({} as ScatterTilesOptions);
    if (
      !Array.isArray(bounds) ||
      bounds.length !== 4 ||
      !Array.from(bounds).every(normal) ||
      !normal(Math.fround(bounds[2]) - Math.fround(bounds[0])) ||
      !normal(Math.fround(bounds[3]) - Math.fround(bounds[1])) ||
      Math.fround(bounds[2]) <= Math.fround(bounds[0]) ||
      Math.fround(bounds[3]) <= Math.fround(bounds[1])
    )
      throw new RangeError(
        'ScatterTiles needs bounds: the world rectangle [minX, minZ, maxX, maxZ] its heightmap covers',
      );
    if (
      !Number.isInteger(slots) ||
      slots < 1 ||
      slots > 4096 ||
      !Number.isInteger(slotSize) ||
      slotSize < 1 ||
      slotSize > 65536 ||
      !Number.isInteger(drawn) ||
      drawn < 1 ||
      drawn > 1000000 ||
      !(scale > 0 && scale <= 100) ||
      !Number.isInteger(species) ||
      species < -1 ||
      species > 255 ||
      slots * slotSize > 16777216
    )
      throw new RangeError(
        'ScatterTiles needs integer slots 1..4,096, slotSize 1..65,536 (at most 16,777,216 records), drawn 1..1,000,000, scale 0..100 and species -1..255',
      );
    if (share !== undefined && (!(share instanceof ScatterTiles) || share.#leader))
      throw new TypeError('ScatterTiles share must be another ScatterTiles that does not share one itself');
    super(geometry, {
      ...input,
      count: PAGE * FIRST_PAGES,
      area: [bounds[2] - bounds[0], bounds[3] - bounds[1]],
      center: [(bounds[0] + bounds[2]) / 2, 0, (bounds[1] + bounds[3]) / 2],
      scale: [scale, scale],
      bounds,
    });
    this.slots = slots;
    this.slotSize = slotSize;
    this.#species = species;
    this.#drawn = drawn;
    if (share) {
      this.#leader = share;
      share.#followers.push(this);
      // The shared culling keeps whatever either mesh shows: the larger bounding radius.
      share.values[35] = Math.max(share.values[35], this.values[35]);
    }
  }

  static override attach(
    engine: EngineKernel,
    geometry: Geometry | readonly [Geometry, Geometry, Geometry],
    options: ScatterTilesOptions | ScatterOptions = {},
  ): ScatterTiles {
    // Typed wide to keep Scatter.attach's signature; the constructor checks the tiles options (bounds first).
    const tiles = new ScatterTiles(geometry, options as ScatterTilesOptions);
    engineRuntime(engine).use(tiles);
    return tiles;
  }

  /** Most instances each LOD ring may draw per frame. */
  get drawnCapacity(): number {
    return this.#drawn;
  }

  /** Tiles held now. */
  get size(): number {
    return (this.#leader ?? this).#held.size;
  }

  /**
   * GPU bytes this mesh holds for its objects: its records (8 per record slot), its LOD rings (32 per instance) and,
   * from its first frame, its ordered cull (about 58 per record slot: the culled instance, ring flags and slots); all
   * 0 for a mesh that shares another's.
   */
  get gpuBytes(): number {
    if (this.#leader) return 0;
    const rings = this.#rings[0] + this.#rings[1] + this.#rings[2];
    return this.#capacity * 8 + rings * 32 + this.#table.byteLength + (this.ordered?.bytes ?? 0);
  }

  /**
   * Adds or replaces a tile's records: `origin` is the tile's minimum corner and `side` its size in world units, the
   * records as `@margoengine/biomes/placement` makes them (only this mesh's palette index is kept, when one is set).
   * @throws RangeError when every slot is taken (remove a tile first) or the tile holds more than `slotSize` records.
   */
  setTile(key: string, origin: readonly [number, number], side: number, records: Uint8Array): void {
    if (this.#leader) return this.#leader.setTile(key, origin, side, records);
    if (!(records instanceof Uint8Array) || records.length % 8)
      throw new TypeError('ScatterTiles records must be a Uint8Array of 8-byte records');
    if (
      !Array.isArray(origin) || origin.length !== 2 || !Array.from(origin).every(normal) ||
      !normal(side) || !(side > 0) || !Number.isFinite(Math.fround(Math.fround(side) * 65535)) ||
      !normal(Math.fround(origin[0]) + Math.fround(side)) || !normal(Math.fround(origin[1]) + Math.fround(side))
    )
      throw new RangeError('ScatterTiles tile needs finite f32 [x, z] and a positive normal f32 side whose packed-coordinate products fit f32');
    if (!this.#held.has(key) && this.#held.size >= this.slots)
      throw new RangeError('ScatterTiles has no free slot; remove a tile or attach with more slots');
    // A Uint8Array may start on any byte. Copy only an unaligned view before reading its packed words.
    const aligned = records.byteOffset % 4 ? records.slice() : records;
    const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length >> 2);
    let n = 0;
    for (let k = 0; k < words.length; k += 2) if (this.#species < 0 || (words[k + 1] & 255) === this.#species) n++;
    if (n > this.slotSize)
      throw new RangeError('ScatterTiles tile holds more records than slotSize; attach with a larger slotSize');
    this.removeTile(key);
    // Whole pages from the free list; the pool grows (with headroom) only when they run out.
    const need = Math.ceil(n / PAGE),
      pages: number[] = [];
    if (need > this.#free.length) this.#grow(need - this.#free.length);
    for (let q = 0; q < need; q++) pages.push(this.#free.pop()!);
    const table = this.#table,
      floats = new Float32Array(table.buffer);
    let at = 0;
    for (let k = 0; k < words.length; k += 2) {
      if (this.#species >= 0 && (words[k + 1] & 255) !== this.#species) continue;
      const slot = pages[at >> 6] * PAGE + (at & 63);
      this.#records[2 * slot] = words[k];
      this.#records[2 * slot + 1] = words[k + 1];
      at++;
    }
    pages.forEach((p, q) => {
      const e = 4 * (1 + p);
      floats[e] = origin[0];
      floats[e + 1] = origin[1];
      floats[e + 2] = side;
      table[e + 3] = Math.min(PAGE, n - q * PAGE);
      this.#written.add(p);
    });
    this.#held.set(key, { pages, count: n, x: origin[0], z: origin[1], side });
    this.#tableDirty = true;
  }

  /** Removes a tile; returns whether it was held. */
  removeTile(key: string): boolean {
    if (this.#leader) return this.#leader.removeTile(key);
    const held = this.#held.get(key);
    if (!held) return false;
    this.#held.delete(key);
    // Its pages go back to the free list, marked empty for the shader.
    for (const p of held.pages) {
      this.#table[4 * (1 + p) + 3] = 0;
      this.#free.push(p);
    }
    this.#tableDirty = true;
    return true;
  }

  /** Grows the page pool by at least `extra` pages (with headroom); every page uploads again on the next frame. */
  #grow(extra: number): void {
    const before = this.#records.length / (2 * PAGE),
      after = Math.ceil(grown((before + extra) * PAGE) / PAGE),
      records = new Uint32Array(2 * PAGE * after),
      table = new Uint32Array(4 * (1 + after));
    records.set(this.#records);
    table.set(this.#table);
    this.#records = records;
    this.#table = table;
    for (let p = after - 1; p >= before; p--) this.#free.push(p);
    this.#all = true;
    this.#tableDirty = true;
  }

  protected override cullCode(): string {
    return tilesCullShader();
  }

  protected override ringCapacity(): number {
    // Made at setup with room for one; each ring is sized from the held tiles before its first draw.
    return 1;
  }

  protected override dispatched(): number {
    return this.#capacity;
  }

  protected override extraEntries(): { buffer: GPUBuffer }[] {
    return [{ buffer: this.#recordBuffer! }, { buffer: this.#tableBuffer! }];
  }

  override setup(engine: Engine): void {
    super.setup(engine);
    this.#rings.fill(1);
    if (this.#leader) return;
    const d = engine.gpu!,
      // The same draw commands as scatter's, readable too: the ring counts are copied to the sharing meshes.
      commands = new Uint32Array(15);
    for (let i = 0; i < 3; i++) commands[i * 5] = this.geometries[i].indices.length;
    this.commands!.destroy();
    this.commands = d.createBuffer({
      size: 60,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    d.queue.writeBuffer(this.commands, 0, commands);
    this.#capacity = 0;
    this.#all = true;
    this.#tableDirty = true;
  }

  /**
   * Instances each ring can be asked for at this camera: a ring takes instances closer than its outer distance (plus
   * half the fade), and every instance of a tile is at least the tile's nearest distance away.
   */
  #ringNeeds(eye: ArrayLike<number>, out: number[]): void {
    const lod = this.values,
      fade = lod[31] * 0.5;
    out.fill(0);
    for (const h of this.#held.values()) {
      const dx = Math.max(0, h.x - eye[0], eye[0] - h.x - h.side),
        dz = Math.max(0, h.z - eye[2], eye[2] - h.z - h.side),
        d = Math.hypot(dx, dz);
      for (let ring = 0; ring < 3; ring++) if (d < lod[32 + ring] + fade) out[ring] += h.count;
    }
  }

  readonly #needs = [0, 0, 0];

  protected override beforeDistribute(c: TilesPassContext): void {
    if (this.#leader) {
      // The leader's rings are this mesh's rings.
      if (this.instances[0] !== this.#leader.instances[0]) this.#link();
      return;
    }
    const d = c.device;
    // Records: the buffer follows the page pool's size.
    const size = this.#records.length >> 1;
    if (size !== this.#capacity) {
      if (
        Math.ceil(size / 64) > d.limits.maxComputeWorkgroupsPerDimension ||
        size * 32 > d.limits.maxStorageBufferBindingSize
      )
        throw new RangeError('ScatterTiles holds more records than the GPU can cull; hold fewer or smaller tiles');
      this.#recordBuffer?.destroy();
      this.#recordBuffer = d.createBuffer({ size: size * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.#capacity = size;
      this.meta[36] = size; // ids.x: threads of the distribute pass
      this.#all = true;
      this.extraChanged = true;
    }
    if (this.#all) {
      d.queue.writeBuffer(this.#recordBuffer!, 0, this.#records as Uint32Array<ArrayBuffer>);
      this.#all = false;
    } else if (this.#written.size) {
      // One upload per run of neighbouring pages (a new tile's pages usually are one run).
      const pages = [...this.#written].sort((a, b) => a - b);
      for (let i = 0; i < pages.length; ) {
        let j = i + 1;
        while (j < pages.length && pages[j] === pages[j - 1] + 1) j++;
        d.queue.writeBuffer(
          this.#recordBuffer!,
          pages[i] * PAGE * 8,
          this.#records as Uint32Array<ArrayBuffer>,
          2 * PAGE * pages[i],
          2 * PAGE * (j - i),
        );
        i = j;
      }
    }
    this.#written.clear();
    const tableBytes = this.#table.byteLength;
    // Rings: grown (with headroom) as soon as the held tiles near the camera can fill one, shrunk when a ring uses
    // under a quarter of its buffer, never past `drawn`.
    this.#ringNeeds(c.camera.position, this.#needs);
    let resized = false;
    for (let ring = 0; ring < 3; ring++) {
      const need = Math.min(this.#drawn, this.#needs[ring]),
        have = this.#rings[ring];
      if (need > have || (have > 1024 && need * 4 < have)) {
        const next = Math.max(1, Math.min(this.#drawn, grown(need)));
        this.instances[ring].destroy();
        this.instances[ring] = d.createBuffer({ size: next * 32, usage: GPUBufferUsage.STORAGE });
        this.#rings[ring] = next;
        resized = true;
        this.#tableDirty = true;
      }
    }
    if (resized) {
      this.instancesChanged();
      for (const f of this.#followers) f.#link();
    }
    if (this.#tableDirty || tableBytes !== this.#tableBuffer?.size) {
      const t = this.#table;
      t[1] = this.#rings[0];
      t[2] = this.#rings[1];
      t[3] = this.#rings[2];
      if (tableBytes !== this.#tableBuffer?.size) {
        this.#tableBuffer?.destroy();
        this.#tableBuffer = d.createBuffer({
          size: tableBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.extraChanged = true;
      }
      d.queue.writeBuffer(this.#tableBuffer!, 0, t as Uint32Array<ArrayBuffer>);
      this.#tableDirty = false;
    }
  }

  /** A sharing mesh draws the leader's rings: its own one-instance buffers go, the bind groups are made again. */
  #link(): void {
    const leader = this.#leader!;
    if (this.#owned) for (const b of this.instances) b.destroy();
    this.#owned = false;
    this.instances = [...leader.instances];
    this.instancesChanged();
  }

  /** Whether `instances` are this mesh's own buffers (a sharing mesh's become the leader's). */
  #owned = true;

  protected override cull(c: TilesPassContext, terrain: GPUTexture): void {
    if (this.#leader) return; // the leader fills the rings and the counts
    super.cull(c, terrain);
    // A sharing mesh draws the same instances: copy the three ring counts into its own draw commands.
    for (const f of this.#followers)
      for (let i = 0; i < 3; i++) c.encoder.copyBufferToBuffer(this.commands!, i * 20 + 4, f.commands!, i * 20 + 4, 4);
  }

  protected override release(): void {
    if (!this.#owned) this.instances = [];
    this.#owned = true;
    super.release();
    this.#recordBuffer?.destroy();
    this.#tableBuffer?.destroy();
    this.#recordBuffer = this.#tableBuffer = undefined;
    this.#capacity = 0;
    this.#rings.fill(0);
    if (this.#leader) return;
    // Sharing meshes that point at these buffers link again on their next frame.
    for (const f of this.#followers)
      if (!f.#owned) {
        f.instances = [];
        f.#owned = true;
      }
  }

  override dispose(): void {
    if (this.#leader) {
      const list = this.#leader.#followers,
        at = list.indexOf(this);
      if (at >= 0) list.splice(at, 1);
    }
    super.dispose();
  }
}
