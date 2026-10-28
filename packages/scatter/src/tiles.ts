/// <reference lib="esnext.disposable" preserve="true" />
// Stored instances streamed per tile (biomes decision D3): 8-byte records (u16 x and z inside the tile, palette
// index, log scale, yaw, variant) uploaded per tile and expanded on the GPU every frame by scatter's own distribute
// pass, rewritten to read records instead of a stratified grid, so culling, LOD rings, fades, wind, ground fit and
// shading are scatter's.
import type { EngineKernel, Geometry } from '@margoengine/core';
import { engineRuntime, type Engine, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
// Through the package name, so the tiles entry shares the root's Scatter class with the app.
import { Scatter, scatterCullShader, type ScatterOptions } from '@margoengine/scatter';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };
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
  /** Instances each LOD ring can draw per frame, 1..1,000,000. Default 65,536. */
  readonly drawn?: number;
  /** Multiplier on every record's scale (the mesh size at scale 1). Default 1. */
  readonly scale?: number;
  /** The record palette index this mesh draws; records of other indices are skipped. Default: every record. */
  readonly species?: number;
}

/** The distribute shader that reads records: scatter's world-rectangle variant with a record prelude. */
export function tilesCullShader(capacity: number): string {
  const code = scatterCullShader({ bounds: [0, 0, 1, 1] })
    .replace(
      '@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;',
      '@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;\n@group(0) @binding(7) var<storage,read> records:array<vec2u>;\n@group(0) @binding(8) var<storage,read> tiles:array<vec4f>;\nconst CAPACITY=' +
        capacity +
        'u;',
    )
    .replace(
      ' let slot=atomicAdd(&commands[ring].count,1u);',
      ' let slot=atomicAdd(&commands[ring].count,1u);if(slot>=CAPACITY){atomicSub(&commands[ring].count,1u);return;}',
    )
    .replace(
      /let i=id\.x;if\(i>=frame\.ids\.x\|\|hash\(i\*7u\+1u\)>frame\.rules\.w\)\{return;\}[\s\S]*?let uv=[^\n]*\n/,
      // A tile slot of ids.z records: (origin x, origin z, side, count) per slot.
      'let i=id.x;if(i>=frame.ids.x){return;}let tile=tiles[i/frame.ids.z];if(f32(i%frame.ids.z)>=tile.w){return;}let r=records[i];\n let world=tile.xy+vec2f(f32(r.x&0xffffu),f32(r.x>>16u))*tile.z/65536.0;\n',
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

/**
 * Stored instances drawn through scatter: add each tile's 8-byte records as they stream in, remove tiles as they
 * leave; the GPU culls them, picks LOD rings and fades every frame. One `ScatterTiles` draws one mesh (one species).
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
  /** CPU copies (kept for device restoration): records per slot, and per slot (origin x, origin z, side, count). */
  readonly #records: Uint32Array;
  readonly #table: Float32Array;
  readonly #keys = new Map<string, number>();
  readonly #dirty = new Set<number>();
  #recordBuffer?: GPUBuffer;
  #tableBuffer?: GPUBuffer;

  constructor(geometry: Geometry | readonly [Geometry, Geometry, Geometry], input: ScatterTilesOptions) {
    const {
      bounds,
      slots = 64,
      slotSize = 4096,
      drawn = 65536,
      scale = 1,
      species = -1,
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
    super(geometry, {
      ...input,
      count: slots * slotSize,
      area: [bounds[2] - bounds[0], bounds[3] - bounds[1]],
      center: [(bounds[0] + bounds[2]) / 2, 0, (bounds[1] + bounds[3]) / 2],
      scale: [scale, scale],
      bounds,
    });
    this.slots = slots;
    this.slotSize = slotSize;
    this.#species = species;
    this.#drawn = drawn;
    this.#records = new Uint32Array(slots * slotSize * 2);
    this.#table = new Float32Array(slots * 4);
    this.meta[38] = slotSize; // ids.z: records per slot
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

  /** Instances each LOD ring can draw per frame. */
  get drawnCapacity(): number {
    return this.#drawn;
  }

  /** Tiles held now. */
  get size(): number {
    return this.#keys.size;
  }

  /**
   * Adds or replaces a tile's records: `origin` is the tile's minimum corner and `side` its size in world units, the
   * records as `@margoengine/biomes/placement` makes them (only this mesh's palette index is kept, when one is set).
   * @throws RangeError when every slot is taken (remove a tile first) or the tile holds more than `slotSize` records.
   */
  setTile(key: string, origin: readonly [number, number], side: number, records: Uint8Array): void {
    if (!(records instanceof Uint8Array) || records.length % 8)
      throw new TypeError('ScatterTiles records must be a Uint8Array of 8-byte records');
    if (!Array.isArray(origin) || origin.length !== 2 || !origin.every(Number.isFinite) || !(side > 0))
      throw new RangeError('ScatterTiles tile needs an [x, z] origin and a side above 0');
    let slot = this.#keys.get(key);
    if (slot === undefined) {
      const used = new Set(this.#keys.values());
      slot = 0;
      while (used.has(slot)) slot++;
      if (slot >= this.slots)
        throw new RangeError('ScatterTiles has no free slot; remove a tile or attach with more slots');
    }
    const words = new Uint32Array(records.buffer, records.byteOffset, records.length >> 2);
    let n = 0;
    for (let k = 0; k < words.length; k += 2) {
      if (this.#species >= 0 && (words[k + 1] & 255) !== this.#species) continue;
      if (n === this.slotSize)
        throw new RangeError('ScatterTiles tile holds more records than slotSize; attach with a larger slotSize');
      this.#records[(slot * this.slotSize + n) * 2] = words[k];
      this.#records[(slot * this.slotSize + n) * 2 + 1] = words[k + 1];
      n++;
    }
    this.#table.set([origin[0], origin[1], side, n], slot * 4);
    this.#keys.set(key, slot);
    this.#dirty.add(slot);
  }

  /** Removes a tile; returns whether it was held. */
  removeTile(key: string): boolean {
    const slot = this.#keys.get(key);
    if (slot === undefined) return false;
    this.#keys.delete(key);
    this.#table[slot * 4 + 3] = 0;
    this.#dirty.add(slot);
    return true;
  }

  protected override cullCode(): string {
    return tilesCullShader(this.#drawn);
  }

  protected override ringCapacity(): number {
    return this.#drawn;
  }

  protected override extraEntries(): { buffer: GPUBuffer }[] {
    return [{ buffer: this.#recordBuffer! }, { buffer: this.#tableBuffer! }];
  }

  override setup(engine: Engine): void {
    super.setup(engine);
    const d = engine.gpu!;
    this.#recordBuffer = d.createBuffer({
      size: this.#records.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#tableBuffer = d.createBuffer({
      size: this.#table.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    for (let s = 0; s < this.slots; s++) this.#dirty.add(s);
    this.extraChanged = true;
  }

  protected override beforeDistribute(c: TilesPassContext): void {
    if (!this.#dirty.size) return;
    for (const slot of this.#dirty) {
      const at = slot * this.slotSize * 2,
        n = this.#table[slot * 4 + 3];
      if (n)
        c.device.queue.writeBuffer(this.#recordBuffer!, at * 4, this.#records as Uint32Array<ArrayBuffer>, at, n * 2);
    }
    c.device.queue.writeBuffer(this.#tableBuffer!, 0, this.#table as Float32Array<ArrayBuffer>);
    this.#dirty.clear();
  }

  protected override release(): void {
    super.release();
    this.#recordBuffer?.destroy();
    this.#tableBuffer?.destroy();
    this.#recordBuffer = this.#tableBuffer = undefined;
  }
}
