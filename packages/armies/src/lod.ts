/// <reference lib="esnext.disposable" preserve="true" />
// A crowd of people at every distance in two draws: members big on screen are skinned on the GPU from the bone texture
// (SkinnedCrowd: the full mesh, two clips blended), the rest play the vertex animation of the simplified mesh posed from
// the same bone rows (VATCrowd: no skinning work at all), and members off screen or too small to see are not drawn.
// Which member goes where is planned every frame from its size on screen (the projected height of its bounding
// sphere, as level-of-detail selection by screen size in the crowd survey of Beacco, Pelechano and Andujar 2016), the
// nearest first, inside a budget: at most so many skinned members, so many far members and so many vertices posed a
// frame. A hysteresis band keeps a member at the boundary from flickering between levels in an interactive view; it is
// 0 by default, so every frame is a pure function of the members and the camera and a film seeks exactly. The hand-over
// itself shows no jump: both levels pose from the same bone rows (./bake.js).
import type { EngineKernel } from '@margoengine/core';
import type { SkinnedCrowd, SkinnedCrowdInstance } from '@margoengine/animation/instanced-skin';
import type { VATCrowd, VATCrowdOptions } from '@margoengine/animation/vat';
import type { PersonBake } from './bake.js';

/** A member's level: not drawn (off the frustum, too small or over budget). */
export const HIDDEN = 0;
/** A member's level: the far vertex animation of the simplified mesh. */
export const FAR = 1;
/** A member's level: skinned near on the GPU, the full mesh with two clips blended. */
export const NEAR = 2;

/** One person for {@link PersonCrowd.update}. */
export interface CrowdPerson {
  /** Column-major world matrix, 16 numbers: place, heading and size. */
  readonly matrix: ArrayLike<number>;
  /** Clip index into the bake's clips. */
  readonly clip: number;
  /** Seconds into it. */
  readonly offset: number;
  /** A second clip blended in by the near level (the far level shows whichever has more weight). Default none. */
  readonly blendClip?: number;
  readonly blendOffset?: number;
  /** 0 to 1. Default 0. */
  readonly blend?: number;
  /** Atlas region: an outfit. */
  readonly uvTransform?: { readonly offset?: readonly number[]; readonly scale?: readonly number[] };
}

/** The camera the levels are planned for: a core `Camera` fits. */
export interface CrowdView {
  /** Eye position. */
  readonly position: ArrayLike<number>;
  /** Vertical field of view, degrees. */
  readonly fov: number;
  /** Frustum planes (six of `[nx, ny, nz, d]`, inside where `n . p + d >= 0`), as a core Camera keeps them. Default none: nothing culled. */
  readonly planes?: ArrayLike<number>;
  /**
   * A core Camera's own update (`camera.update(aspect, webgpu)`): {@link PersonCrowd.update} calls it first, so the
   * planes are this frame's and not the last render's (a core Camera only refreshes them as it renders: before the
   * first render they are all zero, and a moving camera's lag a frame, so a sought frame would plan differently).
   */
  update?(aspect: number, webgpu: boolean): void;
}

/** The crowd budget and level switch points. Every number is a ceiling or a fraction of the viewport height. */
export interface CrowdBudget {
  /** Most members skinned near. Default 128. */
  near?: number;
  /** Most members drawn far. Default 16384. */
  far?: number;
  /** Most vertices posed a frame, near and far together. Default 8,000,000. */
  vertices?: number;
  /** A member at least this fraction of the viewport tall is skinned near (budget allowing). Default 0.08: about 40 m for a man in a 35 degree view. */
  nearScreen?: number;
  /** A member smaller than this fraction of the viewport is not drawn. Default 0.002: two pixels of a 1080 line view. */
  cullScreen?: number;
  /** While near, a member stays near down to `nearScreen * (1 - hysteresis)`. Default 0: frames depend on nothing but the camera, so a film seeks exactly. */
  hysteresis?: number;
}

const DEFAULTS = { near: 128, far: 16384, vertices: 8_000_000, nearScreen: 0.08, cullScreen: 0.002, hysteresis: 0 };

/** Checks a budget and fills in the defaults. */
export function crowdBudget(budget: CrowdBudget = {}): Required<CrowdBudget> {
  const b = { ...DEFAULTS, ...budget };
  if (!(Number.isInteger(b.near) && b.near >= 0 && b.near <= 65536)) throw new RangeError('Crowd budget near must be a whole number from 0 to 65536');
  if (!(Number.isInteger(b.far) && b.far >= 0 && b.far <= 1048576)) throw new RangeError('Crowd budget far must be a whole number from 0 to 1048576');
  if (!(b.vertices >= 0 && Number.isFinite(b.vertices))) throw new RangeError('Crowd budget vertices must be 0 or more');
  if (!(b.nearScreen > 0 && b.nearScreen <= 10)) throw new RangeError('Crowd budget nearScreen must be above 0 and at most 10');
  if (!(b.cullScreen >= 0 && b.cullScreen < b.nearScreen)) throw new RangeError('Crowd budget cullScreen must be 0 or more and below nearScreen');
  if (!(b.hysteresis >= 0 && b.hysteresis < 1)) throw new RangeError('Crowd budget hysteresis must be 0 or more and below 1');
  return b;
}

/** What {@link planCrowd} needs of each member: its bounding sphere. */
export interface PlannedMember {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Bounding sphere radius. */
  readonly radius: number;
}

/**
 * The level of every member: {@link NEAR}, {@link FAR} or {@link HIDDEN}. Members off the frustum or smaller than
 * `cullScreen` are hidden; the rest, nearest first, go near while they are at least `nearScreen` tall and the near and
 * vertex budgets allow, otherwise far while the far and vertex budgets allow. Pure: the same members, view, budget and
 * `previous` levels give the same plan.
 * @param previous Last frame's levels, for the hysteresis band; ignored when hysteresis is 0.
 */
export function planCrowd(
  members: readonly PlannedMember[],
  view: CrowdView,
  budget: CrowdBudget,
  vertices: { near: number; far: number },
  previous?: ArrayLike<number>,
  out: Uint8Array = new Uint8Array(members.length),
): Uint8Array {
  const b = crowdBudget(budget),
    n = members.length,
    e = view.position,
    t = Math.tan(((view.fov > 0 && view.fov < 180 ? view.fov : 60) * Math.PI) / 360),
    planes = view.planes,
    screen = new Float64Array(n),
    order: number[] = [];
  if (out.length < n) throw new RangeError('planCrowd out must hold a level per member');
  out.fill(HIDDEN, 0, n);
  for (let i = 0; i < n; i++) {
    const m = members[i]!,
      d = Math.hypot(m.x - e[0]!, m.y - e[1]!, m.z - e[2]!);
    let inside = true;
    if (planes)
      for (let p = 0; p < 6 && inside; p++)
        inside = planes[p * 4]! * m.x + planes[p * 4 + 1]! * m.y + planes[p * 4 + 2]! * m.z + planes[p * 4 + 3]! >= -m.radius;
    // Projected height of the bounding sphere as a fraction of the viewport (an eye inside it fills the view).
    screen[i] = d > m.radius ? (2 * m.radius) / (2 * d * t) : Infinity;
    if (inside && screen[i]! >= b.cullScreen) order.push(i);
  }
  order.sort((a, c) => screen[c]! - screen[a]! || a - c);
  let near = 0,
    far = 0,
    posed = 0;
  for (const i of order) {
    const was = previous?.[i] === NEAR,
      big = screen[i]! >= b.nearScreen * (was && b.hysteresis > 0 ? 1 - b.hysteresis : 1);
    if (big && near < b.near && posed + vertices.near <= b.vertices) {
      out[i] = NEAR;
      near++;
      posed += vertices.near;
    } else if (far < b.far && posed + vertices.far <= b.vertices) {
      out[i] = FAR;
      far++;
      posed += vertices.far;
    }
  }
  return out;
}

/** Options of {@link PersonCrowd}. */
export interface PersonCrowdOptions extends VATCrowdOptions, CrowdBudget {}

/**
 * A crowd of one baked person at every distance: near members skinned, far ones a vertex animation, the rest culled,
 * planned each `update` inside the budget. `near` and `far` are the two draws, for `shadows.add` and `lighting.add`.
 */
export class PersonCrowd {
  /** Level of each member after the last update. */
  levels: Uint8Array = new Uint8Array(0);
  /** Members drawn near, far, and not drawn, after the last update. */
  readonly counts = { near: 0, far: 0, hidden: 0 };
  /** Vertices posed by the last update's draws. */
  posed = 0;
  readonly budget: Required<CrowdBudget>;
  disposed = false;
  private readonly spheres: { x: number; y: number; z: number; radius: number }[] = [];
  private constructor(
    private readonly engine: EngineKernel,
    readonly bake: PersonBake,
    readonly near: SkinnedCrowd,
    readonly far: VATCrowd,
    budget: Required<CrowdBudget>,
  ) {
    this.budget = budget;
  }
  /**
   * Builds the two draws of `bake` and attaches them to the engine. The crowd draws need WebGPU (or the WebGL2
   * compatibility layer). Loads `@margoengine/animation/instanced-skin` and `/vat` on first use.
   * @example
   * const people = await PersonCrowd.attach(engine, bake, {map: atlas});
   * engine.onUpdate(() => people.update(members, engine.camera));
   */
  static async attach(engine: EngineKernel, bake: PersonBake, options: PersonCrowdOptions = {}): Promise<PersonCrowd> {
    if (!bake?.near || !bake.far || !bake.farBones) throw new TypeError('PersonCrowd needs a bake from bakePerson');
    const budget = crowdBudget(options),
      look: VATCrowdOptions = { color: options.color, map: options.map, roughness: options.roughness, metalness: options.metalness },
      [{ SkinnedCrowd }, { VATCrowd }] = await Promise.all([import('@margoengine/animation/instanced-skin'), import('@margoengine/animation/vat')]);
    const near = new SkinnedCrowd(bake.near, look),
      far = new VATCrowd(bake.far, look);
    engine.use(near as never);
    engine.use(far as never);
    return new PersonCrowd(engine, bake, near, far, budget);
  }
  /**
   * Plans the levels for `view` and writes every drawn member into its draw. Call once a frame, after the members moved
   * and the camera was placed. A core Camera is brought up to date first, at `aspect` (default the canvas's), so the
   * plan depends only on the members and where the camera is now.
   * @throws RangeError for a member with a clip not in the bake or a bad matrix.
   */
  update(people: readonly CrowdPerson[], view: CrowdView, aspect?: number): this {
    if (this.disposed) throw new RangeError('PersonCrowd is disposed; attach a new one with PersonCrowd.attach');
    if (typeof view.update === 'function') {
      const canvas = this.engine.canvas,
        a = aspect ?? (canvas?.width && canvas.height ? canvas.width / canvas.height : 1);
      if (!(a > 0 && Number.isFinite(a))) throw new RangeError('PersonCrowd update aspect must be a finite number above 0');
      view.update(a, this.engine.backend === 'webgpu');
    }
    const n = people.length,
      height = this.bake.height || 1,
      s = this.spheres;
    while (s.length < n) s.push({ x: 0, y: 0, z: 0, radius: 0 });
    for (let i = 0; i < n; i++) {
      const m = people[i]!.matrix;
      if (!m || m.length !== 16) throw new RangeError('A crowd person needs a 16-number matrix');
      const scale = Math.hypot(m[4]!, m[5]!, m[6]!),
        // A sphere round the standing body: centre at half height, radius a little over half of it.
        h = height * scale;
      s[i]!.x = m[12]! + m[4]! * height * 0.5;
      s[i]!.y = m[13]! + m[5]! * height * 0.5;
      s[i]!.z = m[14]! + m[6]! * height * 0.5;
      s[i]!.radius = 0.55 * h;
    }
    const previous = this.levels;
    this.levels = planCrowd(s.slice(0, n), view, this.budget, { near: this.bake.near.vertexCount, far: this.bake.far.vertexCount }, previous);
    let near = 0,
      far = 0;
    const instance: SkinnedCrowdInstance & { matrix?: ArrayLike<number> } = {};
    for (let i = 0; i < n; i++) {
      const level = this.levels[i];
      if (level === HIDDEN) continue;
      const p = people[i]!,
        blend = p.blend ?? 0;
      if (level === NEAR) {
        instance.matrix = p.matrix;
        instance.clip = p.clip;
        instance.offset = p.offset;
        instance.speed = 0;
        instance.blendClip = p.blendClip ?? p.clip;
        instance.blendOffset = p.blendOffset ?? p.offset;
        instance.blendSpeed = 0;
        instance.blend = blend;
        instance.uvTransform = p.uvTransform ?? WHOLE;
        if (near < this.near.count) this.near.set(near, instance);
        else this.near.add(instance);
        near++;
      } else {
        // The far level plays one clip: the one with more weight.
        const second = blend > 0.5 && p.blendClip !== undefined,
          far1 = { matrix: p.matrix, clip: second ? p.blendClip! : p.clip, offset: second ? (p.blendOffset ?? p.offset) : p.offset, speed: 0, uvTransform: p.uvTransform ?? WHOLE };
        if (far < this.far.count) this.far.set(far, far1);
        else this.far.add(far1);
        far++;
      }
    }
    this.near.truncate(near);
    this.far.truncate(far);
    this.counts.near = near;
    this.counts.far = far;
    this.counts.hidden = n - near - far;
    this.posed = near * this.bake.near.vertexCount + far * this.bake.far.vertexCount;
    return this;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.near.dispose();
    this.far.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
const WHOLE = { offset: [0, 0], scale: [1, 1] };
