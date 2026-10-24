/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math';
import { snapshotPaintScene } from './paint-snapshot.js';
import type { PaintHit, PaintOptions, PaintPatch, PaintAtlas, PaintScene, PaintStroke } from './paint-types.js';
import { paintIslandIndex, type PaintIslandIndex, type PaintRGBA, type PaintWriteObserver } from './paint-common.js';
import { applyPreparedPaintAtlas, applyPreparedPaintSurface } from './paint.js';

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Stroke = {
  handle: PaintStroke;
  originals: Map<number, PaintRGBA>;
  pending: Bounds | null;
  ever: Bounds | null;
};
type Prepared = { scene: PaintScene & { texture: PaintAtlas }; index: PaintIslandIndex };

function prepare(input: PaintScene): Prepared {
  const scene = snapshotPaintScene(input);
  return { scene, index: paintIslandIndex(scene) };
}

function include(bounds: Bounds | null, x: number, y: number): Bounds {
  if (!bounds) return { minX: x, minY: y, maxX: x, maxY: y };
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  return bounds;
}

/**
 * A paint session for one scene, with one undoable stroke at a time.
 * The constructor copies the scene's geometry and RGBA bytes once, so each dab is cheap. `begin` opens a stroke,
 * `surface` and `atlas` paint dabs, `flush` returns the rectangle changed since the last flush, and `commit` or
 * `cancel` closes the stroke. `replace` loads a new scene. The revision goes up on each commit that changed pixels
 * and on each replace; `begin` and `commit` must name the current revision.
 * @throws TypeError or RangeError for a bad scene or dab; MargoError `state` for a stale revision or stroke handle,
 * and `disposed` after {@link MeshPaintSession.dispose}.
 */
export class MeshPaintSession {
  #prepared: Prepared | null;
  #revision = 1;
  #sequence = 0;
  #active: Stroke | null = null;
  readonly #observe: PaintWriteObserver = (index, original) => {
    const current = this.#active!;
    if (!current.originals.has(index)) current.originals.set(index, original);
    const width = this.#prepared!.scene.texture.width,
      x = index % width,
      y = Math.floor(index / width);
    current.pending = include(current.pending, x, y);
    current.ever = include(current.ever, x, y);
  };

  /** Snapshot `scene`; later edits to the input never reach the session. */
  constructor(scene: PaintScene) {
    this.#prepared = prepare(scene);
  }

  /** Whether {@link MeshPaintSession.dispose} has released the snapshot. */
  get disposed(): boolean {
    return this.#prepared === null;
  }

  /** Current revision, starting at 1. */
  get revision(): number {
    this.#live();
    return this.#revision;
  }

  #live(): Prepared {
    if (!this.#prepared) throw new MargoError('disposed', 'Paint session is disposed; create a new MeshPaintSession.');
    return this.#prepared;
  }

  #expect(revision: number): void {
    if (revision !== this.#revision)
      throw new MargoError('state', 'Paint revision is stale; pass the current session revision.');
  }

  #stroke(handle: PaintStroke): Stroke {
    this.#live();
    if (!this.#active || handle !== this.#active.handle)
      throw new MargoError('state', 'Paint stroke is not active on this session; begin a stroke before painting.');
    return this.#active;
  }

  #patch(bounds: Bounds | null): PaintPatch | null {
    if (!bounds) return null;
    const { texture } = this.#live().scene,
      { minX: x, minY: y, maxX, maxY } = bounds,
      pixels: number[] = [];
    for (let row = y; row <= maxY; row++) {
      const offset = (row * texture.width + x) * 4;
      for (let i = offset; i < offset + (maxX - x + 1) * 4; i++) pixels.push(texture.pixels[i]);
    }
    return {
      x,
      y,
      width: maxX - x + 1,
      height: maxY - y + 1,
      pixels,
      sequence: ++this.#sequence,
      revision: this.#revision,
    };
  }

  /** Open the single stroke transaction at `expectedRevision`. */
  begin(expectedRevision: number): PaintStroke {
    this.#live();
    this.#expect(expectedRevision);
    if (this.#active)
      throw new MargoError('state', 'Paint stroke is already active; commit or cancel it before beginning another.');
    const handle = Object.freeze({ revision: this.#revision });
    this.#active = { handle, originals: new Map(), pending: null, ever: null };
    return handle;
  }

  /** Paint a face-local square dab at a surface hit, optionally mirrored across object-local then world X. */
  surface(
    stroke: PaintStroke,
    hit: PaintHit,
    color: string,
    size = 1,
    symmetry = false,
    options: PaintOptions = {},
  ): void {
    this.#stroke(stroke);
    const { scene, index } = this.#live();
    applyPreparedPaintSurface(scene, index, scene.texture, hit, color, size, symmetry, options, this.#observe);
  }

  /** Paint a dab at atlas pixel coordinates, clipped to the face under it or to free canvas. */
  atlas(stroke: PaintStroke, x: number, y: number, color: string, size = 1, options: PaintOptions = {}): void {
    this.#stroke(stroke);
    const { scene, index } = this.#live();
    applyPreparedPaintAtlas(scene, index, scene.texture, x, y, color, size, options, this.#observe);
  }

  /** Dirty rectangle written since the last flush, or null when nothing changed. */
  flush(stroke: PaintStroke): PaintPatch | null {
    const current = this.#stroke(stroke),
      result = this.#patch(current.pending);
    current.pending = null;
    return result;
  }

  /** Close the stroke and return the owned atlas, or null when the stroke changed no byte overall. */
  commit(stroke: PaintStroke, expectedRevision: number): PaintAtlas | null {
    const current = this.#stroke(stroke);
    this.#expect(expectedRevision);
    const { texture } = this.#live().scene;
    let changed = false;
    for (const [index, original] of current.originals)
      for (let channel = 0; channel < 4 && !changed; channel++)
        changed = original[channel] !== texture.pixels[index * 4 + channel];
    this.#active = null;
    if (!changed) return null;
    this.#revision++;
    return { width: texture.width, height: texture.height, pixels: [...texture.pixels] };
  }

  /** Restore every byte the stroke wrote and return the rectangle it covered, or null when it wrote nothing. */
  cancel(stroke: PaintStroke): PaintPatch | null {
    const current = this.#stroke(stroke),
      { pixels } = this.#live().scene.texture;
    for (const [index, original] of current.originals)
      for (let channel = 0; channel < 4; channel++) pixels[index * 4 + channel] = original[channel];
    const result = this.#patch(current.ever);
    this.#active = null;
    return result;
  }

  /** Snapshot a new scene, dropping any active stroke; returns the new revision. A failed snapshot changes nothing. */
  replace(scene: PaintScene): number {
    this.#live();
    this.#prepared = prepare(scene);
    this.#active = null;
    return ++this.#revision;
  }

  /** Release the snapshot. Safe to call repeatedly. */
  dispose(): void {
    this.#active = null;
    this.#prepared = null;
  }

  /** Same as {@link MeshPaintSession.dispose}, for `using` declarations. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
