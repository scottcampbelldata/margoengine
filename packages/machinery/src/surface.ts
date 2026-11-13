/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { meshRuntime } from '@margoengine/core/extension';
import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import type { Engine, EnginePlugin, Vec3 } from '@margoengine/core/extension';
import { machineryMemory } from './runtime.js';
import { checkCount, countLimit } from '../../shared/limits.js';
/** A moving surface (a belt or roller): `velocity` in scene units per second, `angularVelocity` in radians per second about the node, and `contactOffset` from the node to the contact point. */
export interface SurfaceCarrier {
  node: MeshHandle;
  velocity?: Vec3;
  angularVelocity?: Vec3;
  contactOffset?: Vec3;
}
/** A part carried by a surface: the `carrier` index it rides, a `lane` (parts in one lane may not overlap), its unit `axis` along the lane, `halfLength`, `friction` (default 0.5), `mass` (default 1) and unit `contactNormal` (default up). */
export interface ConveyingPart {
  node: MeshHandle;
  carrier: number;
  lane: number;
  axis: Vec3;
  halfLength: number;
  friction?: number;
  mass?: number;
  contactNormal?: Vec3;
}
/** Options for {@link SurfacePhysics}. */
export interface SurfaceOptions {
  /** Gravity in scene units per second squared that bounds friction (0 or more). Default 9.80665. */
  gravity?: number;
  /** Most parts, and separately most carriers (default 100,000 each; up to core's 8,388,608 entities). */
  maxParts?: number;
}
const zero: Vec3 = [0, 0, 0],
  up: Vec3 = [0, 1, 0];
const finite = (v: number) => typeof v === 'number' && Number.isFinite(Math.fround(v));
function vector(v: Vec3): void {
  if (typeof v !== 'object' || v === null || v.length !== 3)
    throw new TypeError('A surface vector must be three finite numbers; pass [x, y, z].');
  for (let a = 0; a < 3; a++)
    if (!finite(v[a])) throw new TypeError('A surface vector must be three finite numbers; pass [x, y, z].');
}
/** A live mesh handle, checked before use: parts and carriers come from app data that may be malformed. */
function live(node: MeshHandle | undefined, what: string): void {
  if (typeof (node as { check?: unknown } | null | undefined)?.check !== 'function')
    throw new TypeError(`A surface ${what} needs a live mesh node; pass a node created by the engine.`);
  node!.check();
}
const record = (value: unknown, what: string): void => {
  if (typeof value !== 'object' || value === null)
    throw new TypeError(`A surface ${what} must be an object; pass a ${what} object.`);
};
/**
 * Friction-limited conveying on belts and rollers, solved in WebAssembly. Create it with `await SurfacePhysics.attach(engine, parts, carriers)`;
 * each frame moves every part toward its carrier's surface velocity, bounded by friction. `setCarrier(part, carrier)` transfers a part.
 *
 * @example
 * const belt = await SurfacePhysics.attach(engine, [{ node: box, carrier: 0, lane: 0, axis: [1, 0, 0], halfLength: 0.2 }], [{ node: band, velocity: [1, 0, 0] }]);
 */
export class SurfacePhysics implements EnginePlugin {
  readonly name = 'surface-physics';
  private engine?: Engine;
  private disposed = false;
  private constructor(
    readonly parts: readonly ConveyingPart[],
    readonly carriers: readonly SurfaceCarrier[],
    readonly options: SurfaceOptions,
    private readonly memory: Awaited<ReturnType<typeof machineryMemory>>,
    readonly data: Float32Array,
  ) {}
  /** `engine.use(await SurfacePhysics.create(parts, carriers, options))`; resolves to the attached SurfacePhysics. */
  static async attach(
    engine: EngineKernel,
    parts: readonly ConveyingPart[],
    carriers: readonly SurfaceCarrier[],
    options?: SurfaceOptions,
  ): Promise<SurfacePhysics> {
    const value = await SurfacePhysics.create(parts, carriers, options);
    engine.use(value);
    return value;
  }
  static async create(
    parts: readonly ConveyingPart[],
    carriers: readonly SurfaceCarrier[],
    options: SurfaceOptions = {},
  ): Promise<SurfacePhysics> {
    if (!Array.isArray(parts) || !Array.isArray(carriers))
      throw new TypeError('Surface parts and carriers must be arrays; pass an array of each.');
    const limit = countLimit('maxParts', options?.maxParts);
    checkCount('Too many surface parts', parts.length, limit, 'maxParts');
    checkCount('Too many surface carriers', carriers.length, limit, 'maxParts');
    if (
      !parts.length ||
      !carriers.length ||
      !Number.isFinite(options.gravity ?? 9.80665) ||
      (options.gravity ?? 9.80665) < 0
    )
      throw new RangeError(
        'Surface physics needs at least one part and one carrier and a finite gravity of 0 or more; add them or fix the gravity.',
      );
    const memory = await machineryMemory(parts.length * 27 * 4);
    return new SurfacePhysics(
      parts,
      carriers,
      options,
      memory,
      new Float32Array(memory.buffer, memory.ptr, parts.length * 26),
    );
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'Surface physics is disposed; create a new SurfacePhysics.');
    const seen = new Set<MeshHandle>(),
      axes = new Map<number, Vec3>(),
      n = this.parts.length;
    for (const carrier of this.carriers) {
      record(carrier, 'carrier');
      live(carrier.node, 'carrier');
      if (meshRuntime(carrier.node).engine !== engine)
        throw new TypeError(
          'Carrier belongs to another engine; pass nodes created by the engine this SurfacePhysics is added to.',
        );
    }
    for (let i = 0; i < n; i++) {
      const p = this.parts[i];
      record(p, 'part');
      live(p.node, 'part');
      const node = meshRuntime(p.node);
      vector(p.axis);
      vector(p.contactNormal ?? up);
      if (
        node.engine !== engine ||
        engine.store.parents[node.id] !== -1 ||
        engine.store.constrained[node.id] & 7 ||
        seen.has(p.node) ||
        !Number.isSafeInteger(p.lane) ||
        p.lane < 0 ||
        p.lane > 16_777_215 ||
        !Number.isSafeInteger(p.carrier) ||
        !this.carriers[p.carrier] ||
        ![p.halfLength, p.friction ?? 0.5, p.mass ?? 1].every(finite) ||
        p.halfLength < 0 ||
        (p.friction ?? 0.5) < 0 ||
        (p.mass ?? 1) <= 0 ||
        Math.abs(Math.hypot(...p.axis) - 1) > 1e-5 ||
        Math.abs(Math.hypot(...(p.contactNormal ?? up)) - 1) > 1e-5
      )
        throw new TypeError(
          'Conveying part needs a root node from this engine used once, a lane from 0 to 16777215, a valid carrier, unit axis and contactNormal, halfLength, friction of 0 or more and mass above 0; check the part.',
        );
      const prior = axes.get(p.lane);
      if (prior && prior.some((v, a) => Math.abs(v - p.axis[a]) > 1e-5)) throw new TypeError('Lane axes must agree');
      axes.set(p.lane, p.axis);
      seen.add(p.node);
      this.data[9 * n + i] = p.friction ?? 0.5;
      this.data[10 * n + i] = p.halfLength;
      this.data[11 * n + i] = p.lane;
      this.data[15 * n + i] = p.mass ?? 1;
      for (let a = 0; a < 3; a++) {
        this.data[(12 + a) * n + i] = p.axis[a];
        this.data[(17 + a) * n + i] = (p.contactNormal ?? up)[a];
      }
    }
    this.engine = engine;
    this.onPreUpdate(0);
  }
  setCarrier(index: number, carrier: number): void {
    if (!this.parts[index] || !Number.isSafeInteger(index) || !Number.isSafeInteger(carrier) || !this.carriers[carrier])
      throw new RangeError(
        'Carrier transfer needs a part index and a carrier index that exist; pass indices below the part and carrier counts.',
      );
    this.parts[index].carrier = carrier;
  }
  onPreUpdate(delta: number): void {
    const engine = this.engine;
    if (!engine || this.disposed)
      throw new MargoError(
        'state',
        'Surface physics is not attached; add it to an engine with engine.use(physics) before updating.',
      );
    const n = this.parts.length,
      d = this.data;
    for (let i = 0; i < n; i++) {
      const p = this.parts[i],
        node = meshRuntime(p.node),
        carrier = this.carriers[p.carrier];
      node.check();
      if (engine.store.parents[node.id] !== -1 || engine.store.constrained[node.id] & 7 || !carrier)
        throw new MargoError(
          'state',
          'Conveying part gained a parent or joint, or its carrier is missing; keep parts as unparented roots with a valid carrier.',
        );
      carrier.node.check();
      const v = carrier.velocity ?? zero,
        w = carrier.angularVelocity ?? zero,
        r = carrier.contactOffset ?? zero;
      vector(v);
      vector(w);
      vector(r);
      let x = v[0] + w[1] * r[2] - w[2] * r[1],
        y = v[1] + w[2] * r[0] - w[0] * r[2],
        z = v[2] + w[0] * r[1] - w[1] * r[0];
      const nx = d[17 * n + i],
        ny = d[18 * n + i],
        nz = d[19 * n + i],
        normal = x * nx + y * ny + z * nz;
      x -= normal * nx;
      y -= normal * ny;
      z -= normal * nz;
      d[i] = node.position.x;
      d[n + i] = node.position.y;
      d[2 * n + i] = node.position.z;
      d[6 * n + i] = x;
      d[7 * n + i] = y;
      d[8 * n + i] = z;
      d[16 * n + i] = meshRuntime(carrier.node).id;
    }
    const error = this.memory.api.surface_tick(this.memory.ptr, n, delta, this.options.gravity ?? 9.80665);
    if (error)
      throw new RangeError(
        `Surface state is not finite or has an overlapping lane at part ${error - 1}; use finite part data and give each lane its own space.`,
      );
    for (let i = 0; i < n; i++) {
      const id = meshRuntime(this.parts[i].node).id,
        t = engine.store.transforms;
      t.x[id] = d[i];
      t.y[id] = d[n + i];
      t.z[id] = d[2 * n + i];
    }
  }
  dispose(): void {
    this.engine = undefined;
    this.disposed = true;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
