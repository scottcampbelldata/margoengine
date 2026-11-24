/// <reference lib="esnext.disposable" preserve="true" />
// Ground that changes on screen (entry `@margoengine/terrain/ground-change`): gullies cutting back, banks retreating,
// scour holes, explosion craters with their heave and ejecta, slide scars with their runout, a flood's mud, ash fall, lava flows and burn scars, drawn as a height and
// colour change of a heightfield mesh or a clipmap `Terrain` each frame. The change is a closed form of film time (./ground-model.ts holds the
// laws and their sources), so a seek, a re-render or a frame rendered out of order shows the same ground. Each frame
// whose time moved recomputes only the vertices the events active since the last frame can touch: their heights (base
// plus the events' sum) and their normals (the base normal tilted by the change's slope), written into the mesh's own
// vertex buffer (and its CPU copy, so a device restore keeps the change), and two cover textures (mud, ash, char, lava;
// heat, wetness, fresh soil, ash whitening) that a patch of core's lit shader lays over the mesh's colour, with lava's
// glow added to its light. Shadows see the new shape: pass the `Shadows` to re-render a cached still map.
// On a clipmap `Terrain` the grid is its heightmap's texels: the changed heights are written into the heightmap itself
// (read back once for the base), so every ring, the terrain's shadow pass and its normals see them, and the covers lie
// in one three-layer texture (covers, state, and the change's float bytes for terrains whose normals come from a normal
// map) that a terrain lighting effect lays over `terrainColor`.
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type Mesh as RuntimeMesh,
} from '@margoengine/core/extension';
import type { HeightField } from '@margoengine/math';
import type { Terrain, TerrainLighting } from './index.js';
import { MargoError } from '@margoengine/math/errors';
import { holdFromWeather } from '../../shared/settings.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { noiseCode, openMeshBlock } from './mesh-patch.js';
import {
  COVER_CHANNELS,
  resolveEvent,
  sampleEvent,
  type GroundCover,
  type GroundEvent,
  type ResolvedEvent,
} from './ground-model.js';
export * from './ground-model.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
/** Terrain lighting group bindings 112 and 113, past deformation's 110 and 111 (test/bindings.test.js). */
const TERRAIN_BINDING = 112;
const terrainFragmentHead = '@fragment fn fragment(i:Output)->@location(0) vec4f {',
  terrainColorHead = 'fn terrainColor(position:vec3f,normal:vec3f)->vec3f {';

type Color = readonly [number, number, number];
/**
 * The grid the change is computed on: the heightfield mesh's (`heightfieldGeometry` options), or a terrain's heightmap
 * (left out with a `Terrain`: its `origin`, `size` and heightmap texels).
 */
export interface GroundGrid {
  /** World XZ extent, each above 0. */
  size: readonly [number, number];
  /** World XZ of the minimum corner. Default centred on the origin (`-size / 2`), as `heightfieldGeometry`. */
  origin?: readonly [number, number];
  /**
   * Cells per side, an integer 1 to 4,096 (vertices: resolution + 1 per side), or [along X, along Z]. Default 192, as
   * `heightfieldGeometry`.
   */
  resolution?: number | readonly [number, number];
}
/** How the covers look; every field is live (`setLook`, or `applyGroundChangeSettings`). Colours are linear RGB. */
export interface GroundLook {
  /** Freshly cut soil. Default [0.3, 0.21, 0.13]. */
  soil?: Color;
  /** Wet flood mud (before wet darkening). Default [0.24, 0.2, 0.15]. */
  mud?: Color;
  /** Fallen ash. Default [0.36, 0.35, 0.34]. */
  ash?: Color;
  /** Fresh char. Default [0.025, 0.022, 0.02]. */
  char?: Color;
  /** Char whitened to ash. Default [0.5, 0.49, 0.47]. */
  ashen?: Color;
  /** Cooled lava rock. Default [0.04, 0.036, 0.034]. */
  lava?: Color;
  /** Brightness of lava's glow at full heat (linear radiance over the sun's 1), 0 to 100. Default 12. */
  glow?: number;
  /** How much a cooling flow glows only in its cracks, 0 (evenly) to 1. Default 0.7. */
  cracks?: number;
  /** World size of the crust plates between the cracks, metres above 0. Default 0.8. */
  crackSize?: number;
  /** Albedo of fully wet ground (1 is no darkening), 0 to 1. Default 0.55. */
  wetDarkening?: number;
  /** Share by which wet ground is smoother, 0 to 1. Default 0.5. */
  wetGloss?: number;
  /**
   * Wetness of all cut soil, mud and ash from rain, 0 to 1, or null to follow the weather (a `WeatherDrive` writes its
   * rain here). Default null (dry until a weather drives it).
   */
  rain?: number | null;
}
/** {@link GroundChange} settings. Invalid values throw RangeError. */
export interface GroundChangeOptions extends GroundLook {
  /**
   * The grid; with a mesh it must be the one the mesh was built on. With a `Terrain` leave it out (the heightmap's
   * texels over the terrain's `origin` and `size`) or give that same grid.
   */
  grid?: GroundGrid;
  /** Events to start with. Default none. */
  events?: readonly GroundEvent[];
  /**
   * Base heights when there is no mesh: a height function, or (resolution + 1)^2 heights row by row from the minimum
   * corner (x fastest). With a mesh the base is the mesh's own vertex heights, with a `Terrain` its heightmap's (read
   * back once; give no `base`). Default 0 everywhere.
   */
  base?: HeightField | Float32Array;
  /** Film seconds to start at, 0 or more. Default 0. */
  time?: number;
  /** A clock read every frame instead of adding frame deltas (a shot's time). Default none. */
  clock?: () => number;
  /** Shadows whose cached still map re-renders when the ground moves (`Shadows` from `@margoengine/shadows`). */
  shadows?: { invalidate(): void };
}
/** A rectangle of grid vertices, inclusive. */
export interface GroundRect {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}
/**
 * What {@link GroundChange.scatterGround} returns: spread into `Scatter` options (`@margoengine/scatter`) so its plants
 * follow the changed ground.
 */
export interface GroundScatterMaps {
  /** `r32float` ground heights in metres (base plus change), one texel per grid vertex; undefined until attached. */
  readonly heightmap: () => GPUTexture | undefined;
  /** `r8unorm` share of plants kept: 1 on untouched ground, 0 under fresh soil, mud, ash, char or lava. */
  readonly densityMap: () => GPUTexture | undefined;
  /** World `[minX, minZ, maxX, maxZ]` the two maps cover (half a cell past the grid, as Scatter reads texel centres). */
  readonly bounds: readonly [number, number, number, number];
}
/** What {@link GroundChange.sample} returns. */
export interface GroundSample extends GroundCover {
  /** Ground height: the base plus the change. */
  height: number;
  /** The change from the base, metres (negative where cut). */
  change: number;
}

const LOOK = {
  soil: [0.3, 0.21, 0.13],
  mud: [0.24, 0.2, 0.15],
  ash: [0.36, 0.35, 0.34],
  char: [0.025, 0.022, 0.02],
  ashen: [0.5, 0.49, 0.47],
  lava: [0.04, 0.036, 0.034],
  glow: 12,
  cracks: 0.7,
  crackSize: 0.8,
  wetDarkening: 0.55,
  wetGloss: 0.5,
  rain: null,
} as const;
/** The look every option takes when left out. */
export const GROUND_LOOK_DEFAULTS: Readonly<Required<GroundLook>> = LOOK as unknown as Required<GroundLook>;
const COLORS = ['soil', 'mud', 'ash', 'char', 'ashen', 'lava'] as const;
const UNITS = ['cracks', 'wetDarkening', 'wetGloss'] as const;
function checkLook(look: GroundLook): void {
  for (const k of COLORS) {
    const v = look[k];
    if (
      v !== undefined &&
      !(Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && x >= 0 && x <= 1))
    )
      throw new RangeError(`Invalid ground change ${k}; give three numbers from 0 to 1 (linear RGB).`);
  }
  for (const k of UNITS) {
    const v = look[k];
    if (v !== undefined && !(typeof v === 'number' && v >= 0 && v <= 1))
      throw new RangeError(`Invalid ground change ${k}; give a number from 0 to 1.`);
  }
  if (look.glow !== undefined && !(typeof look.glow === 'number' && look.glow >= 0 && look.glow <= 100))
    throw new RangeError('Invalid ground change glow; give a number from 0 to 100.');
  if (
    look.crackSize !== undefined &&
    !(typeof look.crackSize === 'number' && look.crackSize > 0 && look.crackSize <= 100)
  )
    throw new RangeError('Invalid ground change crackSize; give a number above 0 up to 100.');
  if (
    look.rain !== undefined &&
    look.rain !== null &&
    !(typeof look.rain === 'number' && look.rain >= 0 && look.rain <= 1)
  )
    throw new RangeError('Invalid ground change rain; give a number from 0 to 1, or null to follow the weather.');
}

let nextId = 0;
/**
 * Ground that changes over film time: events (gully, bank, scour, slide, mud, ash, lava, burn, crater) change a heightfield
 * mesh's or a clipmap terrain's heights and colours each frame, the same at any time however it is reached.
 * `GroundChange.attach(engine, mesh, options)` for a mesh made by `heightfieldGeometry` on the same grid;
 * `GroundChange.attach(engine, terrain, options)` for an attached `Terrain` (an `r32float` heightmap with COPY_SRC and
 * COPY_DST usage); `new GroundChange(options)` alone is the CPU model (`sample`, `heights`, `update`). WebGPU (and the
 * WebGL2 compatibility layer) only.
 * @throws RangeError for an option or event out of range; TypeError for a mesh that is not on the grid or a heightmap
 * of the wrong format, usage or size; MargoError `'unsupported'` on a WebGL engine, `'state'` for a terrain not yet
 * attached, `'attached'` for a target of another engine or a second attach, `'disposed'` after `dispose()`.
 */
export class GroundChange implements EnginePlugin, TerrainLighting {
  readonly name = 'ground-change:' + nextId++;
  disposed = false;
  /** Vertices along X: resolution + 1. */
  readonly side: number;
  /** Vertices along X and along Z. */
  readonly sides: readonly [number, number];
  readonly origin: readonly [number, number];
  readonly size: readonly [number, number];
  /** The look the shader reads; `rain` is written by a `WeatherDrive` while not held. Change it with `setLook`. */
  readonly look: Required<GroundLook>;
  #events: ResolvedEvent[] = [];
  #ids = new Map<number, ResolvedEvent>();
  #nextEvent = 0;
  #order = 0;
  #base: Float32Array;
  #top = 0;
  readonly #delta: Float32Array;
  readonly #cover: Uint8Array;
  readonly #heat: Uint8Array;
  #time: number;
  #shown = Number.NaN;
  #forced: GroundRect[] = [];
  /** Vertices changed on the CPU and not yet on the GPU. */
  #pending?: GroundRect;
  #listeners = new Set<(rect: GroundRect) => void>();
  #engine?: Engine;
  #mesh?: Mesh;
  #terrain?: Terrain;
  /** The terrain heightmap's texels as read back (its base), written back on dispose. */
  #raw?: Float32Array;
  #ready: Promise<void>;
  #readFailure?: unknown;
  #reading = false;
  #removeLighting?: () => void;
  #offDispose?: () => void;
  #terrainTexture?: GPUTexture;
  #terrainEntries: GPUBindGroupEntry[] = [];
  #rowScratch = new Float32Array(0);
  #shaders = new Map<string, string>();
  #scatterHeight?: GPUTexture;
  #scatterDensity?: GPUTexture;
  #scatterBytes = new Uint8Array(0);
  #plantCovers?: GPUTexture;
  #plantBytes = new Uint8Array(0);
  #map?: Int32Array;
  #normals?: Float32Array;
  #coverTexture?: GPUTexture;
  #heatTexture?: GPUTexture;
  #lookBuffer?: GPUBuffer;
  #lookData = new Float32Array(32);
  #lookDirty = true;
  #entries: GPUBindGroupEntry[] = [];
  #source = '';
  #shader = '';
  #binding = 44;
  readonly #scratch = new Float64Array(9);
  /** The mesh's vertex buffer as last written, so dispose can put the base back on the GPU however it is removed. */
  #vertex?: GPUBuffer;
  /** The geometry's bounding sphere at attach, put back on dispose. */
  #sphere?: Float32Array;

  /**
   * `target`: the heightfield mesh or attached `Terrain` to change once the plugin is used by its engine (`attach`
   * passes it).
   */
  constructor(
    readonly options: GroundChangeOptions,
    target?: Mesh | Terrain,
  ) {
    const terrain = isTerrain(target) ? target : undefined;
    let g = options?.grid;
    if (terrain) {
      const map = terrain.heightmap;
      if (terrain.disposed || !map)
        throw new MargoError('state', 'GroundChange needs an attached Terrain; attach the Terrain to its engine first');
      if (options.base !== undefined)
        throw new RangeError("A terrain's GroundChange takes its base from the heightmap; leave out base.");
      g ??= {
        size: terrain.options.size,
        origin: terrain.options.origin ?? [0, 0],
        resolution: [map.width - 1, map.height - 1],
      };
    }
    const r = g?.resolution ?? 192,
      [rx, rz] = typeof r === 'number' ? [r, r] : Array.isArray(r) && r.length === 2 ? r : [Number.NaN, Number.NaN],
      cells = (v: number) => Number.isInteger(v) && v >= 1 && v <= 4096;
    if (
      !g ||
      !Array.isArray(g.size) ||
      g.size.length !== 2 ||
      !g.size.every((v) => typeof v === 'number' && v > 0 && v <= 1e6) ||
      !cells(rx) ||
      !cells(rz) ||
      (g.origin !== undefined &&
        !(Array.isArray(g.origin) && g.origin.length === 2 && g.origin.every((v) => Number.isFinite(v))))
    )
      throw new RangeError(
        'Invalid ground change grid; give size [w, d] above 0 (up to 1e6), an integer resolution 1 to 4,096 (or one along X and one along Z) and a finite origin.',
      );
    const t = options.time ?? 0;
    if (!(typeof t === 'number' && t >= 0 && t <= 1e9))
      throw new RangeError('Invalid ground change time; give 0 to 1e9 seconds.');
    if (options.clock !== undefined && typeof options.clock !== 'function')
      throw new TypeError('Invalid ground change clock; pass a function returning film seconds.');
    if (options.shadows !== undefined && typeof options.shadows?.invalidate !== 'function')
      throw new TypeError('Invalid ground change shadows; pass a Shadows (anything with invalidate()).');
    checkLook(options);
    this.side = rx + 1;
    this.sides = [rx + 1, rz + 1];
    this.size = [g.size[0], g.size[1]];
    this.origin = [g.origin?.[0] ?? -g.size[0] / 2, g.origin?.[1] ?? -g.size[1] / 2];
    const count = this.sides[0] * this.sides[1];
    this.#delta = new Float32Array(count);
    this.#cover = new Uint8Array(count * 4);
    this.#heat = new Uint8Array(count * 4);
    this.#base = new Float32Array(count);
    const base = options.base;
    if (typeof base === 'function') {
      for (let j = 0; j < this.sides[1]; j++)
        for (let i = 0; i < this.side; i++) {
          const [x, z] = this.#world(i, j),
            h = base(x, z);
          if (!Number.isFinite(h)) throw new RangeError('Ground change base heights must be finite.');
          this.#base[j * this.side + i] = h;
        }
    } else if (base !== undefined) {
      if (!(base instanceof Float32Array) || base.length !== count || !base.every(Number.isFinite))
        throw new RangeError(`Invalid ground change base; give ${count} finite heights, or a height function.`);
      this.#base.set(base);
    }
    this.#top = this.#base.reduce((a, b) => Math.max(a, b), -Infinity);
    this.look = { ...LOOK, ...stripUndefined(options) } as Required<GroundLook>;
    if (options.rain !== undefined && options.rain !== null) holdFromWeather(this.look, 'rain');
    this.#time = t;
    if (terrain) this.#terrain = terrain;
    else this.#mesh = target as Mesh | undefined;
    // A terrain's base arrives with its read back; the CPU model and a mesh have theirs now.
    this.#ready = terrain ? new Promise<void>((resolve) => (this.#resolveReady = resolve)) : Promise.resolve();
    for (const e of options.events ?? []) this.add(e);
  }
  #resolveReady?: () => void;

  /**
   * Attaches to a heightfield mesh (made by `heightfieldGeometry` on `options.grid`) or to a `Terrain` already attached
   * to `engine` (`grid` left out: the heightmap's texels).
   */
  static attach(engine: EngineKernel, target: Mesh | Terrain, options: GroundChangeOptions = {}): GroundChange {
    const change = new GroundChange(options, target);
    engineRuntime(engine).use(change);
    return change;
  }

  /**
   * Resolves once the base heights are known: at once for a mesh or the CPU model, after the heightmap's one read back
   * for a terrain (until then frames draw the base ground and `sample` reads a base of 0).
   */
  get ready(): Promise<void> {
    return this.#ready;
  }

  #world(i: number, j: number): [number, number] {
    return [
      this.origin[0] + (i / (this.sides[0] - 1)) * this.size[0],
      this.origin[1] + (j / (this.sides[1] - 1)) * this.size[1],
    ];
  }
  #rectOf(b: readonly [number, number, number, number]): GroundRect | undefined {
    const nx = this.sides[0] - 1,
      nz = this.sides[1] - 1,
      x0 = Math.max(0, Math.floor(((b[0] - this.origin[0]) / this.size[0]) * nx)),
      z0 = Math.max(0, Math.floor(((b[1] - this.origin[1]) / this.size[1]) * nz)),
      x1 = Math.min(nx, Math.ceil(((b[2] - this.origin[0]) / this.size[0]) * nx)),
      z1 = Math.min(nz, Math.ceil(((b[3] - this.origin[1]) / this.size[1]) * nz));
    return x0 > x1 || z0 > z1 ? undefined : { x0, z0, x1, z1 };
  }
  /** Resolves every event again against the base's highest point (a bank's reach depends on it), once it is known. */
  #resolveAgain(): void {
    this.#top = this.#base.reduce((a, b) => Math.max(a, b), -Infinity);
    const top = Number.isFinite(this.#top) ? this.#top : 0;
    for (const [id, e] of this.#ids) {
      const again = resolveEvent(e.source, e.order, top);
      this.#ids.set(id, again);
      this.#events[this.#events.indexOf(e)] = again;
    }
  }

  /** Adds an event; returns its id for `remove`. @throws RangeError or TypeError for a bad event. */
  add(event: GroundEvent): number {
    this.#live();
    const e = resolveEvent(event, this.#order++, Number.isFinite(this.#top) ? this.#top : 0),
      id = this.#nextEvent++;
    this.#ids.set(id, e);
    this.#events.push(e);
    this.#events.sort((a, b) => a.start - b.start || a.order - b.order);
    const r = this.#rectOf(e.bounds);
    if (r) this.#forced.push(r);
    return id;
  }
  /** Removes an event by id; the ground it changed goes back. Returns whether it was there. */
  remove(id: number): boolean {
    const e = this.#ids.get(id);
    if (!e) return false;
    this.#ids.delete(id);
    this.#events.splice(this.#events.indexOf(e), 1);
    const r = this.#rectOf(e.bounds);
    if (r) this.#forced.push(r);
    return true;
  }
  /** Removes every event. */
  clear(): void {
    for (const id of [...this.#ids.keys()]) this.remove(id);
  }
  /** The events, in the order they apply (by start time, then as added). */
  get events(): readonly GroundEvent[] {
    return this.#events.map((e) => e.source);
  }

  /** Film seconds the ground shows (after the next `update` or frame). */
  get time(): number {
    return this.#time;
  }
  /** Sets the film time outright, 0 to 1e9. */
  setTime(seconds: number): this {
    if (!(typeof seconds === 'number' && seconds >= 0 && seconds <= 1e9))
      throw new RangeError('Invalid ground change time; give 0 to 1e9 seconds.');
    this.#time = seconds;
    return this;
  }
  /** Moves the film time by `delta` seconds (0 or less moves nothing): the CPU part of a frame, for `seek`. */
  advanceTime(delta: number): void {
    if (delta > 0) this.#time = Math.min(this.#time + delta, 1e9);
  }
  onPreUpdate(delta: number): void {
    if (this.options.clock) this.setTime(this.options.clock());
    else this.advanceTime(delta);
  }

  /** Changes the look; a field left out keeps its value, `rain: null` hands the rain back to the weather. */
  setLook(look: GroundLook): void {
    if (typeof look !== 'object' || look === null) throw new TypeError('Ground change look must be an object');
    checkLook(look);
    for (const [k, v] of Object.entries(look)) {
      if (v === undefined || !(k in LOOK)) continue;
      (this.look as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
      if (k === 'rain') holdFromWeather(this.look, 'rain', v !== null);
    }
    this.#lookDirty = true;
  }

  /** Calls `listener` with each rectangle of grid vertices the ground changed in; returns an unsubscribe. */
  onChange(listener: (rect: GroundRect) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Brings the CPU grid to `time`: recomputes the vertices the events active between the time it last showed and now
   * can touch. Returns the rectangle it recomputed, or undefined when nothing could change. Frames call it.
   */
  update(): GroundRect | undefined {
    this.#live();
    const t = this.#time,
      prev = this.#shown,
      lo = Math.min(prev, t),
      hi = Math.max(prev, t);
    let rect: GroundRect | undefined;
    const grow = (r: GroundRect | undefined) => {
      if (!r) return;
      rect = rect
        ? {
            x0: Math.min(rect.x0, r.x0),
            z0: Math.min(rect.z0, r.z0),
            x1: Math.max(rect.x1, r.x1),
            z1: Math.max(rect.z1, r.z1),
          }
        : r;
    };
    for (const r of this.#forced) grow(r);
    this.#forced = [];
    for (const e of this.#events) {
      const changes = Number.isNaN(prev) ? e.start < t : e.start < hi && e.settle > lo && prev !== t;
      if (changes) grow(this.#rectOf(e.bounds));
    }
    this.#shown = t;
    if (!rect) return undefined;
    this.#compute(rect, t);
    const p = this.#pending;
    this.#pending = p
      ? {
          x0: Math.min(p.x0, rect.x0),
          z0: Math.min(p.z0, rect.z0),
          x1: Math.max(p.x1, rect.x1),
          z1: Math.max(p.z1, rect.z1),
        }
      : rect;
    for (const listener of this.#listeners) listener(rect);
    return rect;
  }

  #compute(r: GroundRect, t: number): void {
    const n = this.side,
      out = this.#scratch,
      x0w = this.#world(r.x0, r.z0),
      x1w = this.#world(r.x1, r.z1),
      near = this.#events.filter(
        (e) =>
          e.start < t &&
          e.bounds[0] <= x1w[0] &&
          e.bounds[2] >= x0w[0] &&
          e.bounds[1] <= x1w[1] &&
          e.bounds[3] >= x0w[1],
      );
    for (let j = r.z0; j <= r.z1; j++)
      for (let i = r.x0; i <= r.x1; i++) {
        const k = j * n + i,
          [x, z] = this.#world(i, j);
        out.fill(0);
        for (const e of near)
          if (x >= e.bounds[0] && x <= e.bounds[2] && z >= e.bounds[1] && z <= e.bounds[3])
            sampleEvent(e, x, z, t, this.#base[k], out);
        this.#delta[k] = out[0];
        const byte = (v: number) => Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
        this.#cover[k * 4] = byte(out[1]);
        this.#cover[k * 4 + 1] = byte(out[2]);
        this.#cover[k * 4 + 2] = byte(out[3]);
        this.#cover[k * 4 + 3] = byte(out[4]);
        this.#heat[k * 4] = byte(out[5]);
        this.#heat[k * 4 + 1] = byte(out[6]);
        this.#heat[k * 4 + 2] = byte(out[7]);
        this.#heat[k * 4 + 3] = byte(out[8]);
      }
  }

  /** The change from the base at each grid vertex (metres), row by row from the minimum corner, as of the last update. */
  get change(): Float32Array {
    return this.#delta;
  }
  /** The base heights (the mesh's heights at attach, or `base`). */
  get base(): Float32Array {
    return this.#base;
  }
  /** Ground heights at each grid vertex, base plus change, as of the last update (a new array). */
  get heights(): Float32Array {
    const h = new Float32Array(this.#base.length);
    for (let k = 0; k < h.length; k++) h[k] = this.#base[k] + this.#delta[k];
    return h;
  }
  /**
   * The covers at each grid vertex as of the last update: `rgba8` bytes of mud, ash, char and lava (`surface`) and of
   * heat, wetness, fresh soil and ash whitening (`state`), the textures the shader reads.
   */
  get covers(): { readonly surface: Uint8Array; readonly state: Uint8Array } {
    return { surface: this.#cover, state: this.#heat };
  }
  /** The two cover textures while attached (`rgba8unorm`, one texel per grid vertex). */
  get textures(): { readonly surface?: GPUTexture; readonly state?: GPUTexture } {
    return { surface: this.#coverTexture, state: this.#heatTexture };
  }

  /**
   * The ground at world (x, z) and film time `t` (default the current time), worked exactly from the events: the base
   * there (bilinear between grid vertices) plus every event's change, and the covers. For placing people and props.
   */
  sample(x: number, z: number, t = this.#time): GroundSample {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(t >= 0))
      throw new RangeError('Invalid ground sample; give finite x, z and t of 0 or more.');
    const nx = this.sides[0] - 1,
      nz = this.sides[1] - 1,
      fx = Math.min(Math.max(((x - this.origin[0]) / this.size[0]) * nx, 0), nx),
      fz = Math.min(Math.max(((z - this.origin[1]) / this.size[1]) * nz, 0), nz),
      i = Math.min(Math.floor(fx), nx - 1),
      j = Math.min(Math.floor(fz), nz - 1),
      tx = fx - i,
      tz = fz - j,
      at = (a: number, b: number) => this.#base[Math.min(b, nz) * this.side + Math.min(a, nx)],
      base =
        (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz,
      out = new Float64Array(9);
    for (const e of this.#events)
      if (x >= e.bounds[0] && x <= e.bounds[2] && z >= e.bounds[1] && z <= e.bounds[3])
        sampleEvent(e, x, z, t, base, out);
    const result = { height: base + out[0], change: out[0] } as GroundSample;
    COVER_CHANNELS.forEach((c, k) => (result[c] = Math.min(Math.max(out[k + 1], 0), 1)));
    return result;
  }

  #live(): void {
    if (this.disposed) throw new MargoError('disposed', 'This GroundChange was disposed; create a new one');
  }

  setup(engine: Engine): void {
    requireWebGPU(engine, 'GroundChange');
    if (this.#terrain) return this.#setupTerrain(engine);
    if (this.sides[0] !== this.sides[1])
      throw new TypeError(
        'GroundChange on a mesh needs a square grid (one resolution), as heightfieldGeometry builds.',
      );
    const mesh = this.#mesh ? meshRuntime(this.#mesh) : undefined;
    if (!mesh)
      throw new TypeError(
        'GroundChange needs a mesh; use GroundChange.attach(engine, mesh, options) or new GroundChange(options, mesh)',
      );
    mesh.check();
    if (this.disposed || (this.#engine && this.#engine !== engine) || mesh.engine !== engine)
      throw new MargoError(
        this.disposed ? 'disposed' : 'attached',
        "GroundChange's mesh belongs to another engine or it is already attached; attach one per mesh, to its engine",
      );
    const geometry = mesh.geometry,
      n = this.side;
    if (!this.#map) {
      if (!geometry || geometry.vertices.length / 6 !== n * n)
        throw new TypeError(`GroundChange needs the mesh's heightfieldGeometry on the same grid (${n * n} vertices).`);
      // Each grid vertex's index in the mesh, found from its position, so any vertex order works.
      const map = new Int32Array(n * n).fill(-1),
        v = geometry.vertices,
        tol = 1e-3;
      for (let k = 0; k < n * n; k++) {
        const fx = ((v[k * 6] - this.origin[0]) / this.size[0]) * (n - 1),
          fz = ((v[k * 6 + 2] - this.origin[1]) / this.size[1]) * (n - 1),
          i = Math.round(fx),
          j = Math.round(fz);
        if (
          Math.abs(fx - i) > tol ||
          Math.abs(fz - j) > tol ||
          i < 0 ||
          j < 0 ||
          i >= n ||
          j >= n ||
          map[j * n + i] >= 0
        )
          throw new TypeError(
            'GroundChange: the mesh is not a heightfield on this grid; build it with heightfieldGeometry on the same size, origin and resolution.',
          );
        map[j * n + i] = k;
      }
      this.#map = map;
      this.#normals = new Float32Array(n * n * 3);
      for (let g = 0; g < n * n; g++) {
        const k = map[g];
        this.#base[g] = v[k * 6 + 1];
        this.#normals.set([v[k * 6 + 3], v[k * 6 + 4], v[k * 6 + 5]], g * 3);
      }
      this.#resolveAgain();
      this.#sphere = geometry.bounds.slice();
      this.#shown = Number.NaN;
      this.#forced.push({ x0: 0, z0: 0, x1: n - 1, z1: n - 1 });
    }
    this.#engine = engine;
    const device = engine.gpu!,
      texture = () =>
        device.createTexture({
          size: [n, n],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
    if (n > device.limits.maxTextureDimension2D)
      throw new MargoError(
        'unsupported',
        'The ground change grid is larger than this device allows; use a smaller resolution',
      );
    this.#coverTexture = texture();
    this.#heatTexture = texture();
    this.#lookBuffer = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#lookDirty = true;
    this.#source = '';
    // The full cover goes up once; frames then send what changed.
    device.queue.writeTexture({ texture: this.#coverTexture }, this.#cover, { bytesPerRow: n * 4 }, [n, n]);
    device.queue.writeTexture({ texture: this.#heatTexture }, this.#heat, { bytesPerRow: n * 4 }, [n, n]);
  }

  registerPasses(graph: FrameGraph): void {
    if (this.#terrain) {
      graph.add({
        name: this.name,
        // Before the terrain's prepare (-6): the heightmap holds this frame's ground before any ring or shadow reads it.
        order: -7,
        execute: (c) => {
          if (c.backend !== 'webgpu' || this.disposed) return;
          if (this.#readFailure !== undefined) {
            const failure = this.#readFailure;
            this.#readFailure = undefined;
            throw failure;
          }
          if (!this.#raw) return;
          this.update();
          this.#uploadTerrain(c.device);
          this.#writeLook(c.device);
        },
      });
      return;
    }
    graph.add({
      name: this.name,
      order: -1,
      execute: (c) => {
        if (c.backend !== 'webgpu' || this.disposed || !this.#mesh) return;
        const mesh = meshRuntime(this.#mesh);
        this.update();
        this.#upload(c.device, mesh);
        if (this.#source !== c.shader) {
          this.#source = c.shader;
          this.#binding = 44;
          while ([0, 1, 2].some((d) => c.bindings.some((entry) => entry.binding === this.#binding + d)))
            this.#binding++;
          this.#entries = [
            { binding: this.#binding, resource: this.#coverTexture!.createView() },
            { binding: this.#binding + 1, resource: this.#heatTexture!.createView() },
            { binding: this.#binding + 2, resource: { buffer: this.#lookBuffer! } },
          ];
          this.#shader = this.#patch(c.shader, mesh.id);
        }
        this.#writeLook(c.device);
        if (this.#shader === this.#source) return;
        c.bindings.push(...this.#entries);
        c.shader = this.#shader;
      },
    });
  }

  /** Sends the changed vertices (heights and normals) and covers to the GPU. */
  #upload(device: GPUDevice, mesh: RuntimeMesh): void {
    const r = this.#pending,
      geometry = mesh.geometry;
    if (!r || !geometry || !this.#map) return;
    const buffers = this.#engine!.geometryBuffers(geometry);
    if (!buffers) return;
    this.#pending = undefined;
    this.#vertex = buffers.vertex;
    this.#uploadScatter(device, r);
    const n = this.side,
      v = geometry.vertices,
      map = this.#map,
      base = this.#base,
      d = this.#delta,
      nb = this.#normals!,
      dx = this.size[0] / (n - 1),
      dz = this.size[1] / (n - 1),
      // Normals depend on the neighbours: one vertex more on every side.
      e = {
        x0: Math.max(r.x0 - 1, 0),
        z0: Math.max(r.z0 - 1, 0),
        x1: Math.min(r.x1 + 1, n - 1),
        z1: Math.min(r.z1 + 1, n - 1),
      };
    for (let j = e.z0; j <= e.z1; j++) {
      let lo = Infinity,
        hi = -Infinity;
      for (let i = e.x0; i <= e.x1; i++) {
        const g = j * n + i,
          k = map[g],
          gx =
            (d[j * n + Math.min(i + 1, n - 1)] - d[j * n + Math.max(i - 1, 0)]) /
            (dx * (Math.min(i + 1, n - 1) - Math.max(i - 1, 0))),
          gz =
            (d[Math.min(j + 1, n - 1) * n + i] - d[Math.max(j - 1, 0) * n + i]) /
            (dz * (Math.min(j + 1, n - 1) - Math.max(j - 1, 0)));
        v[k * 6 + 1] = base[g] + d[g];
        if (gx === 0 && gz === 0) {
          v[k * 6 + 3] = nb[g * 3];
          v[k * 6 + 4] = nb[g * 3 + 1];
          v[k * 6 + 5] = nb[g * 3 + 2];
        } else {
          // The heightfield's normal (-hx, 1, -hz) with the change's slope added to the base's.
          const ny = Math.max(nb[g * 3 + 1], 1e-4),
            hx = -nb[g * 3] / ny + gx,
            hz = -nb[g * 3 + 2] / ny + gz,
            len = Math.hypot(hx, 1, hz);
          v[k * 6 + 3] = -hx / len;
          v[k * 6 + 4] = 1 / len;
          v[k * 6 + 5] = -hz / len;
        }
        lo = Math.min(lo, k);
        hi = Math.max(hi, k);
      }
      device.queue.writeBuffer(buffers.vertex, lo * 24, v, lo * 6, (hi - lo + 1) * 6);
    }
    this.#coverBounds(mesh, e);
    const width = r.x1 - r.x0 + 1,
      height = r.z1 - r.z0 + 1,
      layout = { offset: (r.z0 * n + r.x0) * 4, bytesPerRow: n * 4 };
    device.queue.writeTexture({ texture: this.#coverTexture!, origin: [r.x0, r.z0] }, this.#cover, layout, [
      width,
      height,
    ]);
    device.queue.writeTexture({ texture: this.#heatTexture!, origin: [r.x0, r.z0] }, this.#heat, layout, [
      width,
      height,
    ]);
    this.options.shadows?.invalidate();
  }

  /**
   * Grows the mesh's bounding sphere (the geometry's and the copy core culls with) over the vertices just written, so a
   * raise past the base sphere is never culled early. It only grows while attached: a sphere that covers more draws the
   * same picture; dispose puts the base sphere back.
   */
  #coverBounds(mesh: RuntimeMesh, r: GroundRect): void {
    const geometry = mesh.geometry!,
      b = geometry.bounds,
      v = geometry.vertices,
      map = this.#map!,
      n = this.side;
    let radius = b[3];
    for (let j = r.z0; j <= r.z1; j++)
      for (let i = r.x0; i <= r.x1; i++) {
        const k = map[j * n + i];
        radius = Math.max(radius, Math.hypot(v[k * 6] - b[0], v[k * 6 + 1] - b[1], v[k * 6 + 2] - b[2]));
      }
    if (radius <= b[3]) return;
    b[3] = radius;
    // Rounded up as core stores it, so the cull never drops a stored vertex.
    if (b[3] < radius) new Uint32Array(b.buffer, b.byteOffset, 4)[3]++;
    this.#engine!.store.bounds[mesh.id * 4 + 3] = b[3];
  }

  /** The terrain path's setup: checks the heightmap, reads its base back once, and adds the lighting effect. */
  #setupTerrain(engine: Engine): void {
    const terrain = this.#terrain!;
    if (this.disposed || (this.#engine && this.#engine !== engine) || terrain.disposed)
      throw new MargoError(
        this.disposed ? 'disposed' : 'attached',
        "GroundChange's terrain belongs to another engine or it is already attached; attach one per terrain, to its engine",
      );
    const device = engine.gpu!,
      [nx, nz] = this.sides,
      heightmap = terrain.heightmap;
    if (heightmap) {
      const usage = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
      if (heightmap.format !== 'r32float' || (heightmap.usage & usage) !== usage)
        throw new TypeError(
          'GroundChange on a Terrain needs an r32float heightmap with COPY_SRC and COPY_DST usage; create it so in the textures factory.',
        );
      if (heightmap.width !== nx || heightmap.height !== nz)
        throw new TypeError(
          `GroundChange: the terrain's heightmap is ${heightmap.width} x ${heightmap.height} texels, the grid ${nx} x ${nz}; leave out grid to take the heightmap's.`,
        );
    }
    if (nx > device.limits.maxTextureDimension2D || nz > device.limits.maxTextureDimension2D)
      throw new MargoError(
        'unsupported',
        'The ground change grid is larger than this device allows; use a smaller heightmap',
      );
    this.#engine = engine;
    this.#terrainTexture = device.createTexture({
      size: [nx, nz, 3],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#lookBuffer = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#lookDirty = true;
    this.#terrainEntries = [
      { binding: TERRAIN_BINDING, resource: this.#terrainTexture.createView({ dimension: '2d-array' }) },
      { binding: TERRAIN_BINDING + 1, resource: { buffer: this.#lookBuffer } },
    ];
    this.#writeLook(device);
    const bytes = new Uint8Array(this.#delta.buffer, this.#delta.byteOffset, this.#delta.byteLength);
    [this.#cover, this.#heat, bytes].forEach((data, layer) =>
      device.queue.writeTexture(
        { texture: this.#terrainTexture!, origin: [0, 0, layer] },
        data,
        { bytesPerRow: nx * 4 },
        [nx, nz],
      ),
    );
    this.#removeLighting ??= terrain.addLighting(this);
    this.#offDispose ??= terrain.onDispose(() => this.dispose());
    if (!this.#raw && !this.#reading && heightmap) this.#readBase(device, heightmap);
  }

  /** Reads the terrain's heightmap back once: its texels (written back on dispose) and the base heights in metres. */
  #readBase(device: GPUDevice, heightmap: GPUTexture): void {
    const [nx, nz] = this.sides,
      stride = Math.ceil((nx * 4) / 256) * 256,
      buffer = device.createBuffer({ size: stride * nz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: heightmap }, { buffer, bytesPerRow: stride, rowsPerImage: nz }, [nx, nz]);
    device.queue.submit([encoder.finish()]);
    this.#reading = true;
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const raw = new Float32Array(nx * nz),
          mapped = new Float32Array(buffer.getMappedRange());
        for (let j = 0; j < nz; j++) raw.set(mapped.subarray((j * stride) / 4, (j * stride) / 4 + nx), j * nx);
        buffer.destroy();
        this.#reading = false;
        if (this.disposed) return;
        const o = this.#terrain!.options,
          scale = o.heightScale ?? 100,
          offset = o.heightOffset ?? 0;
        for (let k = 0; k < raw.length; k++) this.#base[k] = raw[k] * scale + offset;
        this.#raw = raw;
        this.#resolveAgain();
        this.#shown = Number.NaN;
        this.#forced.push({ x0: 0, z0: 0, x1: nx - 1, z1: nz - 1 });
        this.#resolveReady?.();
      },
      (error: unknown) => {
        buffer.destroy();
        this.#reading = false;
        // A device lost during the read: the restore's setup reads again. Anything else surfaces at the next frame.
        if (!this.disposed && this.#engine?.gpu === device) this.#readFailure = error;
      },
    );
  }

  /** Writes the changed texels of the terrain's heightmap (base plus change, in its units) and of the cover texture. */
  #uploadTerrain(device: GPUDevice): void {
    const r = this.#pending,
      terrain = this.#terrain,
      heightmap = terrain?.heightmap,
      raw = this.#raw;
    if (!r || !terrain || !heightmap || !raw || !this.#terrainTexture) return;
    this.#pending = undefined;
    this.#uploadScatter(device, r);
    const nx = this.sides[0],
      width = r.x1 - r.x0 + 1,
      height = r.z1 - r.z0 + 1,
      scale = terrain.options.heightScale ?? 100,
      d = this.#delta;
    if (this.#rowScratch.length < width * height) this.#rowScratch = new Float32Array(width * height);
    const rows = this.#rowScratch;
    for (let j = 0; j < height; j++)
      for (let i = 0; i < width; i++) {
        const k = (r.z0 + j) * nx + r.x0 + i;
        rows[j * width + i] = d[k] === 0 ? raw[k] : raw[k] + d[k] / scale;
      }
    device.queue.writeTexture({ texture: heightmap, origin: [r.x0, r.z0] }, rows, { bytesPerRow: width * 4 }, [
      width,
      height,
    ]);
    const layout = { offset: (r.z0 * nx + r.x0) * 4, bytesPerRow: nx * 4 },
      bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    [this.#cover, this.#heat, bytes].forEach((data, layer) =>
      device.queue.writeTexture({ texture: this.#terrainTexture!, origin: [r.x0, r.z0, layer] }, data, layout, [
        width,
        height,
      ]),
    );
    terrain.invalidate();
    this.options.shadows?.invalidate();
  }

  /**
   * Maps that make a `Scatter` or `GrassScatter` (`@margoengine/scatter`) follow the changed ground: spread them into
   * its options (`{...change.scatterGround(), area, center: [cx, 0, cz]}`). Plants stand on the changed heights, rising
   * and sinking with the ground, and are kept by the density map only where the ground keeps its own cover: a gully,
   * scour or slide scar is bare, mud, ash and lava bury them and a burn scar is burned clear, in step with the covers.
   * The maps live while the change is attached (a new pair after device restoration); on a terrain await `ready` first.
   */
  scatterGround(): GroundScatterMaps {
    this.#live();
    const [nx, nz] = this.sides,
      dx = this.size[0] / (nx - 1),
      dz = this.size[1] / (nz - 1);
    return {
      heightmap: () => this.#scatterMaps()?.[0],
      densityMap: () => this.#scatterMaps()?.[1],
      bounds: [
        this.origin[0] - dx / 2,
        this.origin[1] - dz / 2,
        this.origin[0] + this.size[0] + dx / 2,
        this.origin[1] + this.size[1] + dz / 2,
      ],
    };
  }
  /** The scatter maps, made and filled whole on first use while attached. */
  #scatterMaps(): [GPUTexture, GPUTexture] | undefined {
    const device = this.#engine?.gpu;
    if (this.disposed || !device) return undefined;
    if (!this.#scatterHeight || !this.#scatterDensity) {
      const [nx, nz] = this.sides,
        usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
      this.#scatterHeight = device.createTexture({ size: [nx, nz], format: 'r32float', usage });
      this.#scatterDensity = device.createTexture({ size: [nx, nz], format: 'r8unorm', usage });
      this.#uploadScatter(device, { x0: 0, z0: 0, x1: nx - 1, z1: nz - 1 });
    }
    return [this.#scatterHeight, this.#scatterDensity];
  }
  /**
   * The covers plants that survive stand in, for `PlantStates` (`@margoengine/scatter/states`, its `ground` source):
   * an `rgba8unorm` texture of mud, ash, char and wetness at each grid vertex, over the same rectangle as
   * {@link GroundChange.scatterGround}, so a plant left standing at the edge of a burn scar is charred and scorched and
   * one at the edge of a mud cover carries the water mark. Lives while the change is attached (a new one after device
   * restoration).
   */
  plantCovers(): { covers: () => GPUTexture | undefined; bounds: readonly [number, number, number, number] } {
    const { bounds } = this.scatterGround();
    return { covers: () => this.#plantTexture(), bounds };
  }
  #plantTexture(): GPUTexture | undefined {
    const device = this.#engine?.gpu;
    if (this.disposed || !device) return undefined;
    if (!this.#plantCovers) {
      const [nx, nz] = this.sides;
      this.#plantCovers = device.createTexture({
        size: [nx, nz],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      this.#uploadCovers(device, { x0: 0, z0: 0, x1: nx - 1, z1: nz - 1 });
    }
    return this.#plantCovers;
  }
  /** Writes a rectangle of the plant covers: mud, ash, char (the surface bytes) and wetness (the state's second byte). */
  #uploadCovers(device: GPUDevice, r: GroundRect): void {
    if (!this.#plantCovers) return;
    const nx = this.sides[0],
      width = r.x1 - r.x0 + 1,
      height = r.z1 - r.z0 + 1,
      cover = this.#cover,
      state = this.#heat;
    if (this.#plantBytes.length < width * height * 4) this.#plantBytes = new Uint8Array(width * height * 4);
    const out = this.#plantBytes;
    for (let j = 0; j < height; j++)
      for (let i = 0; i < width; i++) {
        const k = ((r.z0 + j) * nx + r.x0 + i) * 4,
          at = (j * width + i) * 4;
        out[at] = cover[k];
        out[at + 1] = cover[k + 1];
        out[at + 2] = cover[k + 2];
        out[at + 3] = state[k + 1];
      }
    device.queue.writeTexture({ texture: this.#plantCovers, origin: [r.x0, r.z0] }, out, { bytesPerRow: width * 4 }, [
      width,
      height,
    ]);
  }
  /** Writes a rectangle of the scatter maps: heights (base plus change) and the share of plants kept. */
  #uploadScatter(device: GPUDevice, r: GroundRect): void {
    this.#uploadCovers(device, r);
    if (!this.#scatterHeight || !this.#scatterDensity) return;
    const nx = this.sides[0],
      width = r.x1 - r.x0 + 1,
      height = r.z1 - r.z0 + 1,
      count = width * height,
      base = this.#base,
      d = this.#delta,
      cover = this.#cover,
      state = this.#heat;
    if (this.#rowScratch.length < count) this.#rowScratch = new Float32Array(count);
    if (this.#scatterBytes.length < count) this.#scatterBytes = new Uint8Array(count);
    const rows = this.#rowScratch,
      kept = this.#scatterBytes;
    for (let j = 0; j < height; j++)
      for (let i = 0; i < width; i++) {
        const k = (r.z0 + j) * nx + r.x0 + i,
          at = j * width + i;
        rows[at] = base[k] + d[k];
        // Mud, ash, char and lava (the surface bytes) and fresh soil (the state's third byte) each clear the plants.
        kept[at] = 255 - Math.max(cover[k * 4], cover[k * 4 + 1], cover[k * 4 + 2], cover[k * 4 + 3], state[k * 4 + 2]);
      }
    device.queue.writeTexture(
      { texture: this.#scatterHeight, origin: [r.x0, r.z0] },
      rows,
      { bytesPerRow: width * 4 },
      [width, height],
    );
    device.queue.writeTexture({ texture: this.#scatterDensity, origin: [r.x0, r.z0] }, kept, { bytesPerRow: width }, [
      width,
      height,
    ]);
  }

  /** The terrain lighting effect's engine (`TerrainLighting`). */
  get owner(): Engine | undefined {
    return this.#engine;
  }
  /** The terrain lighting group entries the patched shader reads (`TerrainLighting`): the covers and the look. */
  bindings(): GPUBindGroupEntry[] {
    return this.#terrainEntries;
  }
  /**
   * The terrain's lit shader with the covers laid over `terrainColor`, wet ground glossier, lava's glow added to its
   * light and, where the normals come from a normal map, those tilted by the change's slope (`TerrainLighting`).
   */
  shader(source: string, group: number): string {
    const key = group + source,
      cached = this.#shaders.get(key);
    if (cached) return cached;
    if (source.split(terrainFragmentHead).length !== 2 || source.split(terrainColorHead).length !== 2)
      throw new MargoError(
        'unsupported',
        "GroundChange needs the terrain's lit fragment shader and its terrainColor; attach it before effects that replace them",
      );
    const s = '_' + this.name.slice(this.name.indexOf(':') + 1),
      b = TERRAIN_BINDING;
    const own = /* wgsl */ `
@group(${group}) @binding(${b}) var groundCover${s}:texture_2d_array<f32>;
@group(${group}) @binding(${b + 1}) var<uniform> groundLook${s}:array<vec4f,8>;
var<private> groundGlow${s}:vec3f;
var<private> groundGloss${s}:f32;
fn groundTexel${s}(f:vec2f,layer:i32)->vec4f {
 let n=vec2i(groundLook${s}[7].xy);let lo=min(vec2i(floor(f)),n);let hi=min(lo+1,n);let w=f-floor(f);
 return mix(mix(textureLoad(groundCover${s},lo,layer,0),textureLoad(groundCover${s},vec2i(hi.x,lo.y),layer,0),w.x),mix(textureLoad(groundCover${s},vec2i(lo.x,hi.y),layer,0),textureLoad(groundCover${s},hi,layer,0),w.x),w.y);
}
fn groundDelta${s}(c:vec2i)->f32 {
 let n=vec2i(groundLook${s}[7].xy);let u=vec4u(round(textureLoad(groundCover${s},clamp(c,vec2i(0),n),2,0)*255.0));
 return bitcast<f32>(u.x|(u.y<<8u)|(u.z<<16u)|(u.w<<24u));
}
fn groundSlope${s}(c:vec2i)->vec2f {
 let n=vec2i(groundLook${s}[7].xy);let step=frame.map.zw/vec2f(n);let lo=max(c-1,vec2i(0));let hi=min(c+1,n);
 return vec2f((groundDelta${s}(vec2i(hi.x,c.y))-groundDelta${s}(vec2i(lo.x,c.y)))/(f32(hi.x-lo.x)*step.x),(groundDelta${s}(vec2i(c.x,hi.y))-groundDelta${s}(vec2i(c.x,lo.y)))/(f32(hi.y-lo.y)*step.y));
}
fn groundShade${s}(p:vec3f,color:vec3f)->vec3f {
 let L=groundLook${s};let uv=(p.xz-frame.map.xy)/frame.map.zw;
 if(any(uv<vec2f(0))||any(uv>vec2f(1))){return color;}
 let f=uv*L[7].xy;let a=groundTexel${s}(f,0);let st=groundTexel${s}(f,1);
 var c=mix(color,L[0].rgb,st.b);
 c=mix(c,mix(L[3].rgb,L[4].rgb,st.a),a.b);
 c=mix(c,L[2].rgb,a.g);
 c=mix(c,L[1].rgb,a.r);
 c=mix(c,L[5].rgb,a.a);
 let wet=max(st.g,L[0].w*clamp(st.b+a.r+a.g,0.0,1.0));
 c*=mix(1.0,L[1].w,wet);
 groundGloss${s}=L[2].w*wet;
 // Lava glows from its core through the cracks of a closing crust (bright yellow-orange hot, deep red cooler).
 let heat=st.r*a.a;
 if(heat>0.0){
  let q=terrainNoise(p.xz/max(L[5].w,0.001)).x;let q2=terrainNoise(p.xz/max(L[5].w,0.001)*2.3+vec2f(17.0)).x;
  let crack=1.0-smoothstep(0.03,0.12,abs(q-0.5)*0.7+abs(q2-0.5)*0.3);
  let open=mix(1.0,crack,L[4].w*smoothstep(0.9,0.3,heat));
  groundGlow${s}=mix(vec3f(0.9,0.06,0.005),vec3f(1.0,0.5,0.1),heat)*heat*heat*L[3].w*open;
 }
 return c;
}
// Normals from a normal map do not see the heightmap change: tilt them by the change's slope (bilinear between texels).
fn groundTilt${s}(i:Output)->Output {
 var j=i;if(frame.offset.w<0.5){return j;}
 let uv=(i.position.xz-frame.map.xy)/frame.map.zw;if(any(uv<vec2f(0))||any(uv>vec2f(1))){return j;}
 let f=uv*groundLook${s}[7].xy;let lo=vec2i(floor(f));let w=f-floor(f);
 let g=mix(mix(groundSlope${s}(lo),groundSlope${s}(lo+vec2i(1,0)),w.x),mix(groundSlope${s}(lo+vec2i(0,1)),groundSlope${s}(lo+vec2i(1,1)),w.x),w.y);
 if(g.x==0.0&&g.y==0.0){return j;}
 let n=normalize(i.normal);let ny=max(n.y,1e-4);let h=vec2f(-n.x/ny+g.x,-n.z/ny+g.y);
 j.normal=normalize(vec3f(-h.x,1.0,-h.y));return j;
}
`;
    let code = source
      .replace(terrainColorHead, `fn terrainColorUnchanged${s}(position:vec3f,normal:vec3f)->vec3f {`)
      .replace(terrainFragmentHead, `fn groundChangeInner${s}(i:Output)->vec4f {`)
      .replace(
        'let a=i.material.x*i.material.x;',
        `let groundRough${s}=i.material.x*(1.0-groundGloss${s});let a=groundRough${s}*groundRough${s};`,
      )
      .replace(/let linear=([^;]+);/, `let linear=$1+groundGlow${s};`);
    code =
      (code.includes('fn terrainNoise(') ? '' : noiseCode) +
      own +
      code +
      `\n${terrainColorHead}return groundShade${s}(position,terrainColorUnchanged${s}(position,normal));}` +
      `\n${terrainFragmentHead}return groundChangeInner${s}(groundTilt${s}(i));}`;
    if (this.#shaders.size >= 16) this.#shaders.clear();
    this.#shaders.set(key, code);
    return code;
  }

  #writeLook(device: GPUDevice): void {
    const l = this.look,
      f = this.#lookData,
      rain = l.rain ?? 0;
    const want = [
      ...l.soil,
      rain,
      ...l.mud,
      l.wetDarkening,
      ...l.ash,
      l.wetGloss,
      ...l.char,
      l.glow,
      ...l.ashen,
      l.cracks,
      ...l.lava,
      l.crackSize,
      this.origin[0],
      this.origin[1],
      this.size[0],
      this.size[1],
      this.sides[0] - 1,
      this.sides[1] - 1,
      0,
      0,
    ];
    let same = !this.#lookDirty;
    for (let k = 0; k < 32; k++)
      if (f[k] !== Math.fround(want[k])) {
        f[k] = want[k];
        same = false;
      }
    if (same) return;
    this.#lookDirty = false;
    device.queue.writeBuffer(this.#lookBuffer!, 0, f);
  }

  /** Core's lit shader with this mesh's covers laid over its colour and lava's glow added to its light. */
  #patch(source: string, id: number): string {
    const opened = openMeshBlock(source);
    if (!opened) return source;
    let { code, at } = opened;
    const s = '_' + id,
      b = this.#binding,
      // After TerrainColors' own statement for this mesh, when it patched first, so the covers lie over its colours.
      colors = code.indexOf(`if(i.terrainId==${id + 1}.0){let s=terrainSurface`);
    if (colors >= 0) at = code.indexOf('n=s.normal;}', colors) + 'n=s.normal;}'.length;
    const own = /* wgsl */ `
@group(0) @binding(${b}) var groundSurface${s}:texture_2d<f32>;
@group(0) @binding(${b + 1}) var groundState${s}:texture_2d<f32>;
@group(0) @binding(${b + 2}) var<uniform> groundLook${s}:array<vec4f,8>;
var<private> groundGlow${s}:vec3f;
fn groundTexel${s}(t:texture_2d<f32>,f:vec2f)->vec4f {
 let n=vec2i(groundLook${s}[7].xy);let lo=vec2i(floor(f));let hi=min(lo+1,n);let w=f-floor(f);
 return mix(mix(textureLoad(t,lo,0),textureLoad(t,vec2i(hi.x,lo.y),0),w.x),mix(textureLoad(t,vec2i(lo.x,hi.y),0),textureLoad(t,hi,0),w.x),w.y);
}
fn groundShade${s}(p:vec3f,color:vec3f,rough:f32)->vec4f {
 let L=groundLook${s};let g=L[6];let uv=(p.xz-g.xy)/g.zw;
 if(any(uv<vec2f(0))||any(uv>vec2f(1))){return vec4f(color,rough);}
 let f=uv*L[7].xy;let a=groundTexel${s}(groundSurface${s},f);let st=groundTexel${s}(groundState${s},f);
 var c=mix(color,L[0].rgb,st.b);
 c=mix(c,mix(L[3].rgb,L[4].rgb,st.a),a.b);
 c=mix(c,L[2].rgb,a.g);
 c=mix(c,L[1].rgb,a.r);
 c=mix(c,L[5].rgb,a.a);
 let wet=max(st.g,L[0].w*clamp(st.b+a.r+a.g,0.0,1.0));
 c*=mix(1.0,L[1].w,wet);
 // Lava glows from its core through the cracks of a closing crust (bright yellow-orange hot, deep red cooler).
 let heat=st.r*a.a;
 if(heat>0.0){
  let q=terrainNoise(p.xz/max(L[5].w,0.001)).x;let q2=terrainNoise(p.xz/max(L[5].w,0.001)*2.3+vec2f(17.0)).x;
  let crack=1.0-smoothstep(0.03,0.12,abs(q-0.5)*0.7+abs(q2-0.5)*0.3);
  let open=mix(1.0,crack,L[4].w*smoothstep(0.9,0.3,heat));
  groundGlow${s}=mix(vec3f(0.9,0.06,0.005),vec3f(1.0,0.5,0.1),heat)*heat*heat*L[3].w*open;
 }
 return vec4f(c,rough*(1.0-L[2].w*wet));
}
`;
    code =
      (code.includes('fn terrainNoise(') ? '' : noiseCode) +
      own +
      code.slice(0, at) +
      `if(i.terrainId==${id + 1}.0){let gs=groundShade${s}(i.position,i.color,i.material.x);i.color=gs.rgb;i.material.x=gs.a;}` +
      code.slice(at);
    const lit = code.replace(/let linear=([^;]+);/, `let linear=$1+groundGlow${s};`);
    return lit === code ? code : lit;
  }

  onDeviceRestored(engine: Engine): void {
    this.#release();
    this.#engine = undefined;
    this.setup(engine);
    // The next frame writes the whole grid again, so the new vertex buffer (or heightmap) is known and the covers sent.
    this.#forced.push({ x0: 0, z0: 0, x1: this.sides[0] - 1, z1: this.sides[1] - 1 });
  }

  #release(): void {
    this.#coverTexture?.destroy();
    this.#heatTexture?.destroy();
    this.#lookBuffer?.destroy();
    this.#terrainTexture?.destroy();
    this.#scatterHeight?.destroy();
    this.#scatterDensity?.destroy();
    this.#plantCovers?.destroy();
    this.#plantCovers = undefined;
    this.#coverTexture = this.#heatTexture = this.#lookBuffer = this.#terrainTexture = undefined;
    this.#scatterHeight = this.#scatterDensity = undefined;
    this.#terrainEntries = [];
    this.#entries = [];
    this.#source = '';
    this.#vertex = undefined;
  }

  /** Detaches: the mesh gets its base heights and normals back, a terrain its heightmap. */
  dispose(): void {
    if (this.disposed) return;
    const terrain = this.#terrain,
      heightmap = terrain && !terrain.disposed ? terrain.heightmap : undefined,
      owner = this.#engine;
    if (heightmap && this.#raw && owner && !owner.disposed && owner.gpu) {
      // However it is removed, the terrain's heightmap gets its base texels back (a lost device ignores the write; the
      // terrain's own restore then recreates it from its factory).
      const [nx, nz] = this.sides;
      owner.gpu.queue.writeTexture({ texture: heightmap }, this.#raw, { bytesPerRow: nx * 4 }, [nx, nz]);
      terrain!.invalidate();
      this.options.shadows?.invalidate();
    }
    this.#removeLighting?.();
    this.#removeLighting = undefined;
    this.#offDispose?.();
    this.#offDispose = undefined;
    this.#terrain = undefined;
    this.#shaders.clear();
    const mesh = this.#mesh ? meshRuntime(this.#mesh) : undefined,
      geometry = mesh?.geometry,
      map = this.#map;
    if (geometry && map && this.#normals) {
      const v = geometry.vertices;
      for (let g = 0; g < map.length; g++) {
        const k = map[g];
        v[k * 6 + 1] = this.#base[g];
        v[k * 6 + 3] = this.#normals[g * 3];
        v[k * 6 + 4] = this.#normals[g * 3 + 1];
        v[k * 6 + 5] = this.#normals[g * 3 + 2];
      }
      // The GPU copy goes back too, however the plugin is removed (`dispose`, `engine.removePlugin`, the engine's own
      // disposal): the buffer last written is alive while the live mesh still holds this geometry. A device lost since
      // ignores the write, and the restore uploads the CPU copy just put back.
      const engine = this.#engine,
        live = engine && !engine.disposed && engine.meshes.get(mesh.id) === mesh && mesh.geometry === geometry;
      if (live && this.#vertex) engine.gpu?.queue.writeBuffer(this.#vertex, 0, v);
      if (this.#sphere) {
        geometry.bounds.set(this.#sphere);
        if (live) engine.store.bounds.set(this.#sphere, mesh.id * 4);
      }
      this.options.shadows?.invalidate();
    }
    this.disposed = true;
    this.#release();
    const engine = this.#engine;
    this.#engine = undefined;
    this.#mesh = undefined;
    this.#listeners.clear();
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
function stripUndefined(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k in LOOK) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
}
function isTerrain(target: unknown): target is Terrain {
  return typeof (target as Terrain | undefined)?.addLighting === 'function';
}
