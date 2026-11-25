// Scene helpers people know from react-three-drei (Float, Center, Resize, ScreenSizer) and model-viewer (the interaction
// prompt), as plain functions over meshes: no React, no per-frame callbacks of their own. Clean room from the helpers'
// documented behaviour; no drei or model-viewer source was read.
import type { Mesh, Scene } from '@margoengine/core';
import { rangeError, typeError } from '../../shared/errors.js';
import { traverse, worldMatrix } from './index.js';

/** A world-space axis-aligned box. */
export interface WorldBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * The exact world-space box of every mesh with a geometry under `target` (a mesh and its descendants, or a whole
 * scene), from its vertices and world matrices; null when none has a geometry. Reads every vertex once.
 * @example
 * const box = worldBounds(model); // { min: [x, y, z], max: [x, y, z] } | null
 */
export function worldBounds(target: Mesh | Scene): WorldBox | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  traverse(target, (mesh) => {
    const geometry = mesh.geometry;
    if (!geometry || !geometry.vertices.length) return;
    const m = worldMatrix(mesh),
      v = geometry.vertices;
    for (let i = 0; i < v.length; i += 6) {
      const x = v[i],
        y = v[i + 1],
        z = v[i + 2];
      for (let a = 0; a < 3; a++) {
        const w = m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a];
        if (w < min[a]) min[a] = w;
        if (w > max[a]) max[a] = w;
      }
    }
  });
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** Where on an axis of the box `center` puts `target`: the low end, the middle or the high end. */
export type BoxAlign = 'min' | 'center' | 'max';
/** Options of {@link center}. */
export interface CenterOptions {
  /** Per axis, which part of the box lands on `target` (default `'center'` on all three; `{ y: 'min' }` stands it on the target). */
  align?: { x?: BoxAlign; y?: BoxAlign; z?: BoxAlign };
  /** World point to land on (default the origin). */
  target?: readonly [number, number, number];
}
const anchor = (box: WorldBox, axis: 0 | 1 | 2, align: BoxAlign): number =>
  align === 'min' ? box.min[axis] : align === 'max' ? box.max[axis] : (box.min[axis] + box.max[axis]) / 2;

/**
 * Moves `root` so its world box (see {@link worldBounds}) sits on `target`, as drei's Center does: by default the box's
 * centre on the origin, or per axis its low or high end. The move is added to `root.position`, which is in its parent's
 * space, so it equals the world move when the parent is not rotated or scaled. Returns the box after the move, or null
 * (nothing moved) when nothing under `root` has a geometry.
 * @example
 * center(model, { align: { y: 'min' } }); // centred on x and z, standing on y = 0
 */
export function center(root: Mesh, options: CenterOptions = {}): WorldBox | null {
  const box = worldBounds(root);
  if (!box) return null;
  const { align = {}, target = [0, 0, 0] } = options,
    modes = [align.x ?? 'center', align.y ?? 'center', align.z ?? 'center'] as BoxAlign[];
  for (const mode of modes)
    if (mode !== 'min' && mode !== 'center' && mode !== 'max')
      throw typeError("center: align takes 'min', 'center' or 'max'; pass one of those", 'arguments');
  if (target.length !== 3 || target.some((v) => !Number.isFinite(v)))
    throw typeError('center: target must be three finite numbers; pass [x, y, z]', 'arguments');
  const delta = [0, 1, 2].map((a) => target[a] - anchor(box, a as 0 | 1 | 2, modes[a]));
  root.position.set(root.position.x + delta[0], root.position.y + delta[1], root.position.z + delta[2]);
  return {
    min: box.min.map((v, a) => v + delta[a]) as WorldBox['min'],
    max: box.max.map((v, a) => v + delta[a]) as WorldBox['max'],
  };
}

/** Options of {@link resize}. */
export interface ResizeOptions {
  /** Which extent to match: the longest of the three (default) or one axis. */
  axis?: 'longest' | 'x' | 'y' | 'z';
}
/**
 * Scales `root` uniformly so its world box measures `size` along `axis` (default the longest side), as drei's Resize
 * does. The factor multiplies `root.scale`. Returns the factor, or null (nothing changed) when nothing under `root` has a
 * geometry or the box is flat along the chosen axis.
 * @example
 * resize(model, 2); // the longest side is now 2 world units
 */
export function resize(root: Mesh, size: number, { axis = 'longest' }: ResizeOptions = {}): number | null {
  if (!Number.isFinite(size) || size <= 0)
    throw rangeError('resize: size must be a positive finite number', 'arguments');
  if (!['longest', 'x', 'y', 'z'].includes(axis))
    throw typeError("resize: axis is 'longest', 'x', 'y' or 'z'; pass one of those", 'arguments');
  const box = worldBounds(root);
  if (!box) return null;
  const extent = [0, 1, 2].map((a) => box.max[a] - box.min[a]),
    along = axis === 'longest' ? Math.max(...extent) : extent['xyz'.indexOf(axis)];
  if (!(along > 0)) return null;
  const factor = size / along;
  root.scale.set(root.scale.x * factor, root.scale.y * factor, root.scale.z * factor);
  return factor;
}

/**
 * The uniform scale that makes a 1-unit object span `pixels` screen pixels at `distance` from a perspective camera with
 * vertical field of view `fov` (radians) on a viewport `viewportHeight` pixels tall: what drei's ScreenSizer applies.
 * Multiply by the object's own size to make it cover that many pixels instead. Pass the camera's distance to the object
 * each frame and set `mesh.scale` to the result to keep a marker or label the same size on screen.
 * @example
 * const s = screenSizeScale({ distance: 12, fov: Math.PI / 3, viewportHeight: 720, pixels: 48 });
 * marker.scale.setAll(s);
 */
export function screenSizeScale(options: {
  distance: number;
  fov: number;
  viewportHeight: number;
  pixels: number;
}): number {
  const { distance, fov, viewportHeight, pixels } = options ?? ({} as typeof options);
  if (
    ![distance, fov, viewportHeight, pixels].every(Number.isFinite) ||
    distance <= 0 ||
    viewportHeight <= 0 ||
    pixels < 0
  )
    throw rangeError(
      'screenSizeScale: distance and viewportHeight must be positive and fov and pixels finite',
      'arguments',
    );
  if (!(fov > 0 && fov < Math.PI))
    throw rangeError('screenSizeScale: fov is the vertical angle in radians, between 0 and PI', 'arguments');
  return (2 * distance * Math.tan(fov / 2) * pixels) / viewportHeight;
}

/** Options of {@link float}. */
export interface FloatOptions {
  /** Speed of the motion (default 1). */
  speed?: number;
  /** Strength of the tilt, 0 for none (default 1). */
  rotationIntensity?: number;
  /** Strength of the bob, 0 for none (default 1). */
  floatIntensity?: number;
  /** World-unit range of the bob before `floatIntensity` (default [-0.1, 0.1]). */
  floatingRange?: readonly [number, number];
  /** Phase offset in seconds, so several meshes do not move together (default 0). */
  offset?: number;
}
/** A mesh gently bobbing and tilting; drive it with `update`. */
export interface Floater {
  /** Poses the mesh for `seconds` of animation time (any monotonic clock). */
  update(seconds: number): void;
  /** Puts the mesh back where `float` found it and stops writing to it. */
  dispose(): void;
}
/**
 * Makes `mesh` bob and tilt around where it is now, as drei's Float does. Call `update(time)` each frame; the motion is a
 * pure function of time, so it pauses, scrubs and replays. It writes `position.y` and `rotation` (x, y, z) from the values
 * the mesh had when `float` was called.
 * @example
 * const floater = float(trophy, { floatIntensity: 2 });
 * floater.update(performance.now() / 1000);
 */
export function float(mesh: Mesh, options: FloatOptions = {}): Floater {
  mesh.check();
  const { speed = 1, rotationIntensity = 1, floatIntensity = 1, floatingRange = [-0.1, 0.1], offset = 0 } = options;
  if (
    ![speed, rotationIntensity, floatIntensity, offset].every(Number.isFinite) ||
    speed < 0 ||
    rotationIntensity < 0 ||
    floatIntensity < 0
  )
    throw rangeError('float: speed and the intensities must be finite and not negative, offset finite', 'arguments');
  if (floatingRange.length !== 2 || !floatingRange.every(Number.isFinite) || floatingRange[0] > floatingRange[1])
    throw rangeError('float: floatingRange is [low, high] with low <= high', 'arguments');
  const base = { y: mesh.position.y, rx: mesh.rotation.x, ry: mesh.rotation.y, rz: mesh.rotation.z };
  let live = true;
  return {
    update(seconds) {
      if (!live) return;
      if (!Number.isFinite(seconds)) throw rangeError('float: update takes finite seconds', 'arguments');
      const t = ((seconds + offset) / 4) * speed,
        bob = Math.sin(t) / 10; // -0.1 to 0.1
      mesh.rotation.set(
        base.rx + (Math.cos(t) / 8) * rotationIntensity,
        base.ry + (Math.sin(t) / 8) * rotationIntensity,
        base.rz + (Math.sin(t) / 20) * rotationIntensity,
      );
      const low = floatingRange[0] * floatIntensity,
        high = floatingRange[1] * floatIntensity;
      mesh.position.y = base.y + low + ((bob + 0.1) / 0.2) * (high - low);
    },
    dispose() {
      if (!live) return;
      live = false;
      mesh.rotation.set(base.rx, base.ry, base.rz);
      mesh.position.y = base.y;
    },
  };
}

/** Options of {@link InteractionPrompt}. */
export interface InteractionPromptOptions {
  /** Milliseconds without interaction before the prompt shows (default 3000). */
  threshold?: number;
  /** Show it again after the user stops interacting for `threshold` once more (default false: only until the first interaction). */
  repeat?: boolean;
}
/**
 * The timing of a "you can drag this" hint, as model-viewer's interaction prompt: it becomes `visible` once
 * `threshold` ms pass with no interaction and hides at the first one. Drive it from your own clock and show or hide
 * your own hint (a hand icon, a wiggle) from `visible`.
 * @example
 * const prompt = new InteractionPrompt({ threshold: 2500 });
 * canvas.addEventListener('pointerdown', () => prompt.interact(performance.now()));
 * // each frame: prompt.update(performance.now()); hint.hidden = !prompt.visible;
 */
export class InteractionPrompt {
  readonly threshold: number;
  readonly repeat: boolean;
  #since: number | null = null;
  #used = false;
  #visible = false;
  constructor({ threshold = 3000, repeat = false }: InteractionPromptOptions = {}) {
    if (!Number.isFinite(threshold) || threshold < 0)
      throw rangeError('InteractionPrompt: threshold is finite milliseconds >= 0', 'arguments');
    this.threshold = threshold;
    this.repeat = repeat;
  }
  /** Whether the hint should show now. */
  get visible(): boolean {
    return this.#visible;
  }
  /** The user interacted at `now` (ms): hides the hint and restarts the wait when `repeat` is set. */
  interact(now: number): void {
    if (!Number.isFinite(now)) throw rangeError('InteractionPrompt: now is finite milliseconds', 'arguments');
    this.#used = true;
    this.#visible = false;
    this.#since = now;
  }
  /** Advances to `now` (ms); returns `visible`. The first call starts the wait. */
  update(now: number): boolean {
    if (!Number.isFinite(now)) throw rangeError('InteractionPrompt: now is finite milliseconds', 'arguments');
    this.#since ??= now;
    if (!this.#visible && (this.repeat || !this.#used) && now - this.#since >= this.threshold) this.#visible = true;
    return this.#visible;
  }
}
