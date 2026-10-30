/// <reference lib="esnext.disposable" preserve="true" />
// BiomeEditor (spec 3.3 /editor, B4): paint, erase and fill a world's user layers with brushes, group dabs into
// strokes, undo and redo with the exact previous bytes, and keep every edit as plain data so a stroke replays exactly
// (and can sync between users later). Brush maths is integer: the same edit gives the same bytes everywhere. Dirty
// rectangles cover every cell an edit can change, grown by the placement margin (K rounds of 2 x the largest species
// radius plus the widest cluster spread, research notes 2026-10-28) so later milestones stay inside them.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { clampInt, divFloor, fade, isqrt, ONE } from '@margoengine/biomes/toolkit';
import { paintReach, placementReach } from './reach.js';
import type { BiomeWorld, LayerWrite } from './world.js';

type Rect = readonly [number, number, number, number];

/** What each built-in tile layer holds, by name: for layer pickers and tooltips in editors. */
export const LAYER_ABOUT: Readonly<Record<string, string>> = Object.freeze({
  height: 'terrain height',
  slope: 'gradient magnitude (rise over run), Horn 3x3',
  aspect: 'downslope direction, clockwise from north (-Z); east (+X) is 90',
  curvature: 'general curvature of the 3x3 quadratic fit, positive on convex ground',
  tpi: 'topographic position: height minus the 49 m box mean',
  temperature: 'mean annual air temperature',
  coldest: 'mean temperature of the coldest month',
  warmest: 'mean temperature of the warmest month',
  gdd5: 'growing degree days above 5 C',
  season: 'days with a mean above 0.9 C (growing season)',
  treeline: 'Korner thermal treeline margin: trees grow where it is 0 or more',
  rainfall: 'annual rainfall with orography and rain shadow',
  alpha: 'moisture index AET / PET (Fu-Budyko)',
  moisture: 'soil moisture: moisture index plus topographic wetness and nearness to water',
  exposure: 'wind exposure (Winstral Sx), 0.5 on flat ground',
  waterDistance: 'distance to the sea or a river',
  soil: 'soil depth proxy, 0 to 2.55 m',
  biome: 'the 4 strongest biomes per cell, as indices into the world biome list (255 = none)',
  biomeWeight: 'their weights, in the same order, summing to exactly 255',
  profile: 'profile curvature (on request)',
  plan: 'plan curvature (on request)',
});

/** How a dab changes a layer: raise, lower, move toward, or keep the larger or smaller of the value and the brush. */
export type BrushMode = 'add' | 'subtract' | 'set' | 'max' | 'min';
/** Brush edge: smooth (quintic), linear or hard. */
export type BrushFalloff = 'smooth' | 'linear' | 'constant';

/** One edit as plain data; `apply` replays it exactly. Lengths in metres, strength and value 0..1. */
export interface BiomeEdit {
  readonly kind: 'paint' | 'fill';
  /** `paint/<biome>` or `mask/<name>`. */
  readonly layer: string;
  /** Dab centre [x, z] and radius (paint). */
  readonly center?: readonly [number, number];
  readonly radius?: number;
  /** Fill rectangle [minX, minZ, maxX, maxZ] (fill; default the whole world). */
  readonly rect?: Rect;
  readonly strength: number;
  readonly mode: BrushMode;
  readonly falloff: BrushFalloff;
  /** Fill only where this mask layer is set (scaled by it). */
  readonly mask?: string;
}

/** Brush settings of {@link BiomeEditor.paint}. */
export interface BrushOptions {
  /** Centre [x, z] in world metres. */
  readonly center: readonly [number, number];
  /** Radius in metres, above 0. Default 10. */
  readonly radius?: number;
  /** 0..1. Default 1. */
  readonly strength?: number;
  /** Default `'add'`. */
  readonly mode?: BrushMode;
  /** Default `'smooth'`. */
  readonly falloff?: BrushFalloff;
}

/** Fill settings of {@link BiomeEditor.fill}. */
export interface FillOptions {
  /** World rectangle; default the whole world. */
  readonly rect?: Rect;
  /** Value 0..1. Default 1. */
  readonly value?: number;
  /** Only where this user mask layer is set, scaled by it. Default none. */
  readonly mask?: string;
}

/** A step of the undo history: the rasters before and after, per `layer|x,z`. */
interface Step {
  readonly edits: BiomeEdit[];
  readonly before: Map<string, Uint8Array | undefined>;
  readonly after: Map<string, Uint8Array | undefined>;
  dirty: Rect;
}

const MODES = ['add', 'subtract', 'set', 'max', 'min'],
  FALLOFFS = ['smooth', 'linear', 'constant'];
/** Placement rounds whose conflict chains an edit can reach (spec 2.4 step 4). */
const ROUNDS = 6;

/**
 * Paints a world's biome and mask layers with undo. `using editor = BiomeEditor.attach(world)`.
 * @example
 * const editor = BiomeEditor.attach(world);
 * editor.stroke(() => {
 *   editor.paint('desert', { center: [120, -40], radius: 50 });
 *   editor.paint('desert', { center: [140, -35], radius: 50 });
 * });
 * editor.undo(); // the exact bytes from before the stroke
 */
export class BiomeEditor implements Disposable {
  readonly #world: BiomeWorld;
  readonly #done: Step[] = [];
  readonly #undone: Step[] = [];
  readonly #log: BiomeEdit[] = [];
  readonly #waiting = new Set<() => void>();
  #open?: Step;
  #disposed = false;
  /** Rectangles the last step (edit, stroke, undo or redo) can have changed, in world metres. */
  dirty: readonly Rect[] = [];

  private constructor(world: BiomeWorld) {
    this.#world = world;
  }

  /** Starts editing a world. */
  static attach(world: BiomeWorld): BiomeEditor {
    if (!world || typeof world.writeLayers !== 'function')
      throw typeError('BiomeEditor.attach takes a BiomeWorld', 'biomes');
    return new BiomeEditor(world);
  }

  #live(): void {
    if (this.#disposed) throw fault('disposed', 'BiomeEditor is disposed; attach a new one', 'biomes');
  }

  /** Every edit applied so far, in order (undone steps excluded). */
  get edits(): readonly BiomeEdit[] {
    return this.#done.flatMap((s) => s.edits);
  }

  /** Whether `undo` and `redo` have a step to take. */
  get canUndo(): boolean {
    return this.#done.length > 0;
  }
  get canRedo(): boolean {
    return this.#undone.length > 0;
  }

  /**
   * Paints a dab on a layer (`'desert'` is short for `'paint/desert'`).
   * @throws RangeError for a bad layer or option; MargoError `'disposed'` after dispose.
   */
  paint(layer: string, options: BrushOptions): void {
    const o = options ?? ({} as BrushOptions);
    this.apply({
      kind: 'paint',
      layer: layer.includes('/') ? layer : `paint/${layer}`,
      center: o.center,
      radius: o.radius ?? 10,
      strength: o.strength ?? 1,
      mode: o.mode ?? 'add',
      falloff: o.falloff ?? 'smooth',
    });
  }

  /** Erases with a brush: moves the layer toward 0 (`mode: 'set'`, strength 0). */
  erase(layer: string, options: Omit<BrushOptions, 'mode' | 'strength'>): void {
    this.paint(layer, { ...options, mode: 'set', strength: 0 });
  }

  /** Sets a layer to `value` over a rectangle (default the whole world), optionally only where a mask is set. */
  fill(layer: string, options: FillOptions = {}): void {
    this.apply({
      kind: 'fill',
      layer: layer.includes('/') ? layer : `paint/${layer}`,
      rect: options.rect ?? this.#world.bounds,
      strength: options.value ?? 1,
      mode: 'set',
      falloff: 'constant',
      mask: options.mask,
    });
  }

  /**
   * Groups the edits made inside `work` (or until the returned handle ends) into one undo step.
   * @example
   * using stroke = editor.stroke();
   * editor.paint('wetland', { center: [0, 0], radius: 20 });
   */
  stroke(work?: () => void): { end(): void; [Symbol.dispose](): void } {
    this.#live();
    if (this.#open)
      throw fault('state', 'A BiomeEditor stroke is already open; end it before starting another', 'biomes');
    const step: Step = {
      edits: [],
      before: new Map(),
      after: new Map(),
      dirty: [Infinity, Infinity, -Infinity, -Infinity],
    };
    this.#open = step;
    const end = () => {
      if (this.#open !== step) return;
      this.#open = undefined;
      if (step.edits.length) this.#commit(step);
    };
    if (work) {
      try {
        work();
      } finally {
        end();
      }
    }
    return { end, [Symbol.dispose]: end };
  }

  /**
   * Applies an edit given as data (what `edits` and `history` hold), so a stroke replays exactly.
   * @throws RangeError for a bad edit.
   */
  apply(edit: BiomeEdit): void {
    this.#live();
    const e = check(edit, this.#world);
    const step: Step = this.#open ?? newStep();
    const writes = brush(this.#world, e, step.before);
    step.edits.push(e);
    for (const w of writes) {
      step.after.set(`${w.name}|${w.x},${w.z}`, w.data);
      step.dirty = union(step.dirty, w.changed!);
    }
    this.#world.writeLayers(writes);
    this.dirty = grow(step.dirty, this.margin(), this.#world.bounds);
    if (!this.#open) this.#commit(step);
  }

  #commit(step: Step): void {
    this.#done.push(step);
    this.#undone.length = 0;
    this.dirty = grow(step.dirty, this.margin(), this.#world.bounds);
    for (const e of step.edits) this.#log.push(e);
    for (const wake of [...this.#waiting]) wake();
  }

  /** Undoes the last step: every raster it touched gets its exact previous bytes back. */
  undo(): boolean {
    this.#live();
    const step = this.#done.pop();
    if (!step) return false;
    this.#restore(step, step.before);
    this.#undone.push(step);
    return true;
  }

  /** Redoes the last undone step with its exact bytes. */
  redo(): boolean {
    this.#live();
    const step = this.#undone.pop();
    if (!step) return false;
    this.#restore(step, step.after);
    this.#done.push(step);
    return true;
  }

  #restore(step: Step, rasters: Map<string, Uint8Array | undefined>): void {
    const writes: LayerWrite[] = [];
    for (const [key, data] of rasters) {
      const [name, at] = key.split('|'),
        [x, z] = at.split(',').map(Number);
      writes.push({ name, x, z, data, changed: step.dirty });
    }
    this.#world.writeLayers(writes);
    this.dirty = grow(step.dirty, this.margin(), this.#world.bounds);
  }

  /**
   * How far beyond its brushed cells an edit can change the world, in metres: what classification reads across (one
   * cell for the blur, or the paint feather of the world's `ecotone`) plus, for placement, 6 rounds of 2 x the largest
   * species radius and the widest cluster spread.
   */
  margin(): number {
    const w = this.#world;
    return w.resolution * paintReach(w.ecotone, w.resolution) + placementReach(w.biomes, ROUNDS);
  }

  /** Every applied edit, then each new one as it is made, until the editor is disposed. */
  async *history(): AsyncIterableIterator<BiomeEdit> {
    let seen = 0;
    while (!this.#disposed) {
      while (seen < this.#log.length) yield this.#log[seen++];
      if (this.#disposed) return;
      await new Promise<void>((wake) => {
        const done = () => {
          this.#waiting.delete(done);
          wake();
        };
        this.#waiting.add(done);
      });
    }
  }

  /** Stops editing (the world keeps its layers); ends `history` iterators. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#open = undefined;
    for (const wake of [...this.#waiting]) wake();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

const newStep = (): Step => ({
  edits: [],
  before: new Map(),
  after: new Map(),
  dirty: [Infinity, Infinity, -Infinity, -Infinity],
});
const union = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const grow = (r: Rect, m: number, [x0, z0, x1, z1]: Rect): Rect[] =>
  r[0] > r[2] ? [] : [[Math.max(x0, r[0] - m), Math.max(z0, r[1] - m), Math.min(x1, r[2] + m), Math.min(z1, r[3] + m)]];

/** Validates an edit and returns a frozen copy. */
function check(edit: BiomeEdit, world: BiomeWorld): BiomeEdit {
  if (!edit || typeof edit !== 'object')
    throw typeError('A biome edit is an object such as editor.edits holds', 'biomes');
  const e = { ...edit };
  if (e.kind !== 'paint' && e.kind !== 'fill') throw rangeError("A biome edit kind is 'paint' or 'fill'", 'biomes');
  if (typeof e.layer !== 'string' || !/^(paint\/[a-z0-9][a-z0-9-]*|mask\/[\w-]+)$/.test(e.layer))
    throw rangeError('A biome edit layer is a biome id, paint/<biome> or mask/<name>', 'biomes');
  if (e.layer.startsWith('paint/') && !world.biomes.some((b) => `paint/${b.id}` === e.layer))
    throw rangeError('A biome edit layer is a biome id, paint/<biome> or mask/<name>', 'biomes');
  if (!(e.strength >= 0 && e.strength <= 1)) throw rangeError('A brush strength is 0..1', 'biomes');
  if (!MODES.includes(e.mode) || !FALLOFFS.includes(e.falloff))
    throw rangeError(
      'A brush mode is add, subtract, set, max or min and a falloff smooth, linear or constant',
      'biomes',
    );
  if (e.kind === 'paint') {
    if (
      !Array.isArray(e.center) ||
      e.center.length !== 2 ||
      !e.center.every(Number.isFinite) ||
      !(e.radius! > 0 && e.radius! <= 65536)
    )
      throw rangeError('A brush needs a finite [x, z] centre and a radius in 0..65,536 m (above 0)', 'biomes');
  } else if (!Array.isArray(e.rect) || e.rect.length !== 4 || !e.rect.every(Number.isFinite))
    throw rangeError('A fill rectangle is [minX, minZ, maxX, maxZ] in metres', 'biomes');
  if (e.mask !== undefined && !/^mask\/[\w-]+$/.test(e.mask)) throw rangeError('A fill mask is mask/<name>', 'biomes');
  return Object.freeze(e);
}

/**
 * The raster writes of one edit, integer only. Records each touched raster's previous bytes in `before` (first time
 * only, so a stroke keeps the state from before its first dab).
 */
function brush(world: BiomeWorld, e: BiomeEdit, before: Map<string, Uint8Array | undefined>): LayerWrite[] {
  const cell = Math.round(world.resolution * 1000),
    cells = Math.round(world.tileSize / world.resolution), // float division: exact
    [bx, bz] = world.bounds,
    ox = Math.round(bx * 1000),
    oz = Math.round(bz * 1000),
    gridX = cells * world.tilesX,
    gridZ = cells * world.tilesZ;
  // Brushed cell range (global cells, inclusive) and the dab in mm.
  let g0x: number, g0z: number, g1x: number, g1z: number;
  const cx = e.center ? Math.round(e.center[0] * 1000) - ox : 0,
    cz = e.center ? Math.round(e.center[1] * 1000) - oz : 0,
    r = e.radius ? Math.round(e.radius * 1000) : 0;
  if (e.kind === 'paint') {
    g0x = divFloor(cx - r, cell);
    g0z = divFloor(cz - r, cell);
    g1x = divFloor(cx + r, cell) + 1;
    g1z = divFloor(cz + r, cell) + 1;
  } else {
    const [x0, z0, x1, z1] = e.rect!;
    g0x = divFloor(Math.round(x0 * 1000) - ox + cell - 1, cell);
    g0z = divFloor(Math.round(z0 * 1000) - oz + cell - 1, cell);
    g1x = divFloor(Math.round(x1 * 1000) - ox, cell);
    g1z = divFloor(Math.round(z1 * 1000) - oz, cell);
  }
  g0x = clampInt(g0x, 0, gridX - 1);
  g0z = clampInt(g0z, 0, gridZ - 1);
  g1x = clampInt(g1x, 0, gridX - 1);
  g1z = clampInt(g1z, 0, gridZ - 1);
  if (g0x > g1x || g0z > g1z) return [];
  const target = Math.round(e.strength * 255),
    multiply = world.paint.some((p) => `paint/${p.biome}` === e.layer && p.mode === 'multiply'),
    neutral = multiply ? 255 : 0,
    writes: LayerWrite[] = [];
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  for (let tz = divFloor(g0z, cells); tz <= divFloor(g1z, cells); tz++)
    for (let tx = divFloor(g0x, cells); tx <= divFloor(g1x, cells); tx++) {
      const key = `${e.layer}|${tx},${tz}`,
        old = world.readLayer(e.layer, tx, tz),
        mask = e.mask ? world.readLayer(e.mask, tx, tz) : undefined;
      if (!before.has(key)) before.set(key, old);
      const data = old ? old.slice() : new Uint8Array(cells * cells).fill(neutral);
      let changed = false;
      for (let gz = Math.max(g0z, tz * cells); gz <= Math.min(g1z, tz * cells + cells - 1); gz++)
        for (let gx = Math.max(g0x, tx * cells); gx <= Math.min(g1x, tx * cells + cells - 1); gx++) {
          const k = (gz - tz * cells) * cells + gx - tx * cells;
          let amount = ONE; // brush weight at the cell, Q16
          if (e.kind === 'paint') {
            const dx = gx * cell - cx,
              dz = gz * cell - cz,
              d2 = dx * dx + dz * dz;
            if (d2 > r * r) continue;
            const t = Math.min(ONE, divFloor(isqrt(d2) * ONE, r));
            amount = e.falloff === 'constant' ? ONE : e.falloff === 'linear' ? ONE - t : ONE - fade(t);
          } else if (e.mask) amount = mask ? divFloor(mask[k] * ONE, 255) : 0;
          const v = data[k],
            push = Math.floor((target * amount) / ONE),
            next =
              e.mode === 'add'
                ? Math.min(255, v + push)
                : e.mode === 'subtract'
                  ? Math.max(0, v - push)
                  : e.mode === 'set'
                    ? v + Math.floor(((target - v) * amount) / ONE)
                    : e.mode === 'max'
                      ? Math.max(v, push)
                      : Math.min(v, 255 - Math.floor(((255 - target) * amount) / ONE));
          if (next !== v) {
            data[k] = next;
            changed = true;
            minX = Math.min(minX, gx);
            minZ = Math.min(minZ, gz);
            maxX = Math.max(maxX, gx);
            maxZ = Math.max(maxZ, gz);
          }
        }
      if (changed) writes.push({ name: e.layer, x: tx, z: tz, data });
    }
  // The changed cells as a world rectangle (cell corners are samples, so the rectangle spans one cell beyond).
  const rect: Rect =
    minX === Infinity
      ? [bx, bz, bx, bz]
      : [
          bx + minX * world.resolution,
          bz + minZ * world.resolution,
          bx + (maxX + 1) * world.resolution,
          bz + (maxZ + 1) * world.resolution,
        ];
  return writes.map((w) => ({ ...w, changed: rect }));
}
