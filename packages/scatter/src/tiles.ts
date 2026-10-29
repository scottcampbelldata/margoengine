/// <reference lib="esnext.disposable" preserve="true" />
// Stored instances streamed per tile (biomes decision D3): 8-byte records (u16 x and z inside the tile, palette
// index, log scale, yaw, variant) uploaded per tile and expanded on the GPU every frame by scatter's own distribute
// pass, rewritten to read records instead of a stratified grid, so culling, LOD rings, fades, wind, ground fit and
// shading are scatter's.
// GPU memory follows what is held (goal G2 of the biomes spec): the records of every held tile sit packed in one buffer
// sized from their count with headroom, and each LOD ring holds only as many instances as the held tiles within its
// distance can give, recounted every frame from the camera. A second mesh of the same objects (a tree's canopy over its
// trunk) shares the first one's records, culling and rings instead of repeating them.
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
      '@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;\n@group(0) @binding(7) var<storage,read> records:array<vec2u>;\n@group(0) @binding(8) var<storage,read> tiles:array<vec4u>;',
    )
    .replace(
      ' let slot=atomicAdd(&commands[ring].count,1u);',
      // tiles[0] = (tile count, ring capacities): a ring never writes past its buffer.
      ' let slot=atomicAdd(&commands[ring].count,1u);if(slot>=tiles[0][ring+1u]){atomicSub(&commands[ring].count,1u);return;}',
    )
    .replace(
      /let i=id\.x;if\(i>=frame\.ids\.x\|\|hash\(i\*7u\+1u\)>frame\.rules\.w\)\{return;\}[\s\S]*?let uv=[^\n]*\n/,
      // Tile t is tiles[1 + 2t] = (origin x, origin z, side as f32 bits, count) and tiles[2 + 2t].x = its first record,
      // sorted by first record: the last tile starting at or before record i holds it, if it is within its count.
      'let i=id.x;if(i>=frame.ids.x){return;}let n=tiles[0].x;if(n==0u){return;}var lo=0u;var hi=n;loop{if(lo+1u>=hi){break;}let mid=(lo+hi)>>1u;if(tiles[2u+2u*mid].x<=i){lo=mid;}else{hi=mid;}}\n let tile=tiles[1u+2u*lo];let first=tiles[2u+2u*lo].x;if(i<first||i-first>=tile.w){return;}let r=records[i];\n let world=bitcast<vec2f>(tile.xy)+vec2f(f32(r.x&0xffffu),f32(r.x>>16u))*bitcast<f32>(tile.z)/65536.0;\n',
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

/** Records the first buffer holds before it grows; a held tile's records are packed after the previous ones. */
const FIRST_CAPACITY = 1024;
/** Headroom when a buffer grows: half again the records or instances that need it, plus a little. */
const grown = (n: number) => Math.ceil(n * 1.5) + 256;

/** One held tile: its place in the packed records and its rectangle. */
interface Held {
  first: number;
  count: number;
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
  /** CPU copy of the packed records (kept for device restoration and repacking) and the held tiles by key. */
  #records = new Uint32Array(2 * FIRST_CAPACITY);
  #end = 0;
  readonly #held = new Map<string, Held>();
  /** The tile table as uploaded: header (count, three ring capacities), then two vec4u per tile. */
  #table: Uint32Array;
  /** Records the GPU buffer holds and instances each ring holds. */
  #capacity = 0;
  readonly #rings = [0, 0, 0];
  #recordBuffer?: GPUBuffer;
  #tableBuffer?: GPUBuffer;
  /** Records [from, to) to upload before the next distribute; `#all` uploads every record (after a repack or growth). */
  #from = Number.POSITIVE_INFINITY;
  #to = 0;
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
      !bounds.every(Number.isFinite) ||
      bounds[2] <= bounds[0] ||
      bounds[3] <= bounds[1]
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
      count: FIRST_CAPACITY,
      area: [bounds[2] - bounds[0], bounds[3] - bounds[1]],
      center: [(bounds[0] + bounds[2]) / 2, 0, (bounds[1] + bounds[3]) / 2],
      scale: [scale, scale],
      bounds,
    });
    this.slots = slots;
    this.slotSize = slotSize;
    this.#species = species;
    this.#drawn = drawn;
    this.#table = new Uint32Array(4 + 8 * slots);
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
   * GPU bytes this mesh holds for its objects: its records (8 per record slot) and its LOD rings (32 per instance), both
   * 0 for a mesh that shares another's.
   */
  get gpuBytes(): number {
    if (this.#leader) return 0;
    return this.#capacity * 8 + (this.#rings[0] + this.#rings[1] + this.#rings[2]) * 32 + this.#table.byteLength;
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
    if (!Array.isArray(origin) || origin.length !== 2 || !origin.every(Number.isFinite) || !(side > 0))
      throw new RangeError('ScatterTiles tile needs an [x, z] origin and a side above 0');
    if (!this.#held.has(key) && this.#held.size >= this.slots)
      throw new RangeError('ScatterTiles has no free slot; remove a tile or attach with more slots');
    const words = new Uint32Array(records.buffer, records.byteOffset, records.length >> 2);
    let n = 0;
    for (let k = 0; k < words.length; k += 2) if (this.#species < 0 || (words[k + 1] & 255) === this.#species) n++;
    if (n > this.slotSize)
      throw new RangeError('ScatterTiles tile holds more records than slotSize; attach with a larger slotSize');
    this.removeTile(key);
    // Packed after the last tile; when the end is reached, the held tiles move together first (holes left by removed
    // tiles close), and the buffer grows when they still do not leave room.
    if (this.#end + n > this.#records.length >> 1) this.#repack(n);
    const first = this.#end;
    for (let k = 0, at = 2 * first; k < words.length; k += 2) {
      if (this.#species >= 0 && (words[k + 1] & 255) !== this.#species) continue;
      this.#records[at++] = words[k];
      this.#records[at++] = words[k + 1];
    }
    this.#end += n;
    this.#held.set(key, { first, count: n, x: origin[0], z: origin[1], side });
    this.#from = Math.min(this.#from, first);
    this.#to = Math.max(this.#to, this.#end);
    this.#tableDirty = true;
  }

  /** Removes a tile; returns whether it was held. */
  removeTile(key: string): boolean {
    if (this.#leader) return this.#leader.removeTile(key);
    if (!this.#held.delete(key)) return false;
    this.#tableDirty = true;
    return true;
  }

  /** Moves the held tiles' records together and grows the CPU copy so `extra` more records fit after them. */
  #repack(extra: number): void {
    let total = extra;
    for (const h of this.#held.values()) total += h.count;
    const size = total > this.#records.length >> 1 ? grown(total) : this.#records.length >> 1,
      packed = new Uint32Array(2 * size);
    let end = 0;
    for (const h of [...this.#held.values()].sort((a, b) => a.first - b.first)) {
      packed.set(this.#records.subarray(2 * h.first, 2 * (h.first + h.count)), 2 * end);
      h.first = end;
      end += h.count;
    }
    this.#records = packed;
    this.#end = end;
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
    this.#tableBuffer = d.createBuffer({
      size: this.#table.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
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
    // Records: the buffer follows the CPU copy's size.
    const size = this.#records.length >> 1;
    if (size !== this.#capacity) {
      if (
        Math.ceil(size / 64) > d.limits.maxComputeWorkgroupsPerDimension ||
        size * 8 > d.limits.maxStorageBufferBindingSize
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
      if (this.#end)
        d.queue.writeBuffer(this.#recordBuffer!, 0, this.#records as Uint32Array<ArrayBuffer>, 0, 2 * this.#end);
      this.#all = false;
    } else if (this.#to > this.#from)
      d.queue.writeBuffer(
        this.#recordBuffer!,
        this.#from * 8,
        this.#records as Uint32Array<ArrayBuffer>,
        2 * this.#from,
        2 * (this.#to - this.#from),
      );
    this.#from = Number.POSITIVE_INFINITY;
    this.#to = 0;
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
    if (this.#tableDirty) {
      const t = this.#table,
        held = [...this.#held.values()].sort((a, b) => a.first - b.first),
        floats = new Float32Array(t.buffer);
      t.fill(0);
      t[0] = held.length;
      t[1] = this.#rings[0];
      t[2] = this.#rings[1];
      t[3] = this.#rings[2];
      held.forEach((h, k) => {
        const at = 4 + 8 * k;
        floats[at] = h.x;
        floats[at + 1] = h.z;
        floats[at + 2] = h.side;
        t[at + 3] = h.count;
        t[at + 4] = h.first;
      });
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
