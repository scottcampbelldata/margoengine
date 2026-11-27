// The MLS-MPM liquid of GPULiquid (`@margoengine/water/liquid`): options, the particle layout and the CPU twin that runs
// the same five passes as the WGSL (liquid-mpm-shaders.ts), in f64 with the GPU's fixed-point sums. The WebGL2 layer steps
// the liquid with it, and the tests check the method against it. Method: the moving least squares material point method
// (Hu et al. 2018) with APIC transfers (Jiang et al. 2015), density from the grid and the Tait equation of state (Becker and
// Teschner 2007), quadratic B-spline weights (Steffen et al. 2008). Sources: docs/clean-room.md, "GPU particle liquid".
import { fault } from '../../shared/errors.js';

/** A world-space vector [x, y, z]. */
export type LiquidVec3 = readonly [number, number, number];

/** Floats per particle record: position, density ratio, velocity, unused, then the three rows of C, each padded to 4. */
export const LIQUID_PARTICLE_FLOATS = 20;
/** Most particles one GPULiquid holds. */
export const MAX_GPU_LIQUID_PARTICLES = 1_048_576;
/** Most grid nodes one GPULiquid holds (64 MiB of grid). */
export const MAX_GPU_LIQUID_NODES = 4_194_304;
/** Most colliders one GPULiquid takes. */
export const MAX_LIQUID_COLLIDERS = 8;
/** The Tait exponent of the equation of state (Becker and Teschner 2007, water). */
export const LIQUID_GAMMA = 7;
/** Fixed-point scale of the grid's mass and momentum sums: integer sums do not depend on the order of the adds. */
export const LIQUID_FIXED = 65_536;
/** Fixed-point scale of the collider impulse sums. */
export const LIQUID_FORCE_FIXED = 1_024;
/** Grid nodes of padding outside each container face. */
export const LIQUID_PAD = 2;
/** Courant number of one substep against the speed of sound. */
export const LIQUID_CFL = 0.4;
/** Density ratio the pressure is computed at most from, so the fixed-point sums cannot overflow. */
export const LIQUID_MAX_RATIO = 3;

/** An axis-aligned box in world units. */
export interface LiquidBox {
  /** Lowest corner. */
  min: LiquidVec3;
  /** Highest corner; above `min` on every axis. */
  max: LiquidVec3;
}

/** The pointer, a stirring stick: grid nodes within `radius` take on its velocity. */
export interface LiquidPointer {
  /** World position, inside or near the container. */
  position: LiquidVec3;
  /** World velocity in m/s. Default: from the change of `position` between frames (zero for `step()` and the CPU twin). */
  velocity?: LiquidVec3;
  /** Reach in world units, > 0. Default 0.1 times the container's longest side. */
  radius?: number;
  /** How fast the liquid takes on the pointer's velocity at its centre, 1/s, 0..10000. Default 40. */
  strength?: number;
}

/** A rigid body the liquid flows round: it pushes the liquid, and `GPULiquid.forces` reports what the liquid pushes back. */
export interface LiquidCollider {
  /** `'sphere'` (uses `radius`) or `'box'` (uses `halfExtents` and `rotation`). */
  shape: 'sphere' | 'box';
  /** Centre in world units. */
  position: LiquidVec3;
  /** Sphere radius, > 0. Default 0.1. */
  radius?: number;
  /** Box half size per axis, each > 0. Default [0.1, 0.1, 0.1]. */
  halfExtents?: LiquidVec3;
  /** Box orientation, a unit quaternion [x, y, z, w]. Default [0, 0, 0, 1]. */
  rotation?: readonly [number, number, number, number];
  /** Linear velocity in m/s. Default zero. */
  velocity?: LiquidVec3;
  /** Angular velocity in rad/s about the centre. Default zero. */
  angularVelocity?: LiquidVec3;
  /** Coulomb friction of the liquid on the surface, 0 (slip) to 10. Default 0.2. */
  friction?: number;
}

/** Debug view: particles coloured by speed or density, the grid, the container, colliders and the pointer. */
export interface LiquidDebugOptions {
  /** Turns the view on. Default false. */
  enabled?: boolean;
  /** Colour particles by `'speed'` or `'density'`, or `'off'` to keep the liquid surface. Default `'speed'`. */
  particles?: 'speed' | 'density' | 'off';
  /** Speed drawn at the top of the colour ramp, m/s, > 0. Default the speed of a fall through the container's height. */
  speedScale?: number;
  /** Draws the grid on the container's floor and back wall. Default true. */
  grid?: boolean;
  /** Draws the container's edges. Default true. */
  container?: boolean;
  /** Draws the colliders and the pointer. Default true. */
  colliders?: boolean;
}

/** Options of {@link GPULiquid}; every field but `count`, `box`, `fill`, `resolution`, `seed` and `surface` can change live. */
export interface GPULiquidOptions {
  /** Particles, integer 1..1,048,576. Default 65,536. */
  count?: number;
  /** The container: its walls hold the liquid (free slip). Default { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }. */
  box?: LiquidBox;
  /**
   * Where the particles start, a box inside the container filled on a jittered lattice from the floor up; the particles'
   * packing there is the rest density. Default the left 40% of the container, 60% of its height, its full depth.
   */
  fill?: LiquidBox;
  /** Grid cells along the container's longest side, integer 8..256. Default: two particle spacings per cell. */
  resolution?: number;
  /** Gravity in m/s². Default [0, -9.81, 0]. */
  gravity?: LiquidVec3;
  /** Liquid density in kg/m³, for `forces`. Default 1000 (water). */
  density?: number;
  /** Speed of sound in m/s, 0.05..1000; higher is stiffer and takes more substeps. Default 2 * sqrt(|g| * box height). */
  speedOfSound?: number;
  /** Kinematic viscosity in m²/s, 0 up to cellSize² / (8 * substep). Default 0.0005. */
  viscosity?: number;
  /** Most substeps one frame takes, integer 1..256; a frame that needs more runs in slow motion. Default 32. */
  maxSubsteps?: number;
  /** Seed of the start lattice's jitter, integer 0..2^32 - 1. Default 0. */
  seed?: number;
  /** Stops the frame steps; `step()` still runs. Default false. */
  paused?: boolean;
  /** The pointer, or null for none. Default null. */
  pointer?: LiquidPointer | null;
  /** Up to 8 rigid bodies. Default none. */
  colliders?: readonly LiquidCollider[];
  /** Debug view. Default off. */
  debug?: LiquidDebugOptions;
}

/** The resolved, checked parameters the CPU twin and the GPU step run on. */
export interface ResolvedLiquidParams {
  count: number;
  boxMin: LiquidVec3;
  boxMax: LiquidVec3;
  fillMin: LiquidVec3;
  fillMax: LiquidVec3;
  /** Lattice spacing per axis of the start block. */
  lattice: LiquidVec3;
  /** Grid cell size per axis: the container's size over its whole number of cells, so every wall lies on a node. */
  cell: LiquidVec3;
  /** The smallest of `cell`, which sets the substep. */
  cellSize: number;
  /** Cells per axis inside the container. */
  cells: readonly [number, number, number];
  /** Grid nodes per axis. */
  dims: readonly [number, number, number];
  nodes: number;
  /** World position of grid node 0. */
  origin: LiquidVec3;
  /** Rest density in particles per cell volume. */
  restDensity: number;
  gravity: LiquidVec3;
  density: number;
  /** Mass of one particle in kg. */
  particleMass: number;
  speedOfSound: number;
  viscosity: number;
  /** Longest substep in seconds: LIQUID_CFL * h / c. */
  maxSubstep: number;
  maxSubsteps: number;
  seed: number;
  paused: boolean;
  pointer: { position: LiquidVec3; velocity: LiquidVec3; radius: number; strength: number } | null;
  colliders: ResolvedCollider[];
  debug: Required<LiquidDebugOptions>;
}

/** A checked collider with its defaults filled in. */
export interface ResolvedCollider {
  kind: 0 | 1;
  position: LiquidVec3;
  /** Sphere radius, or box half size. */
  half: LiquidVec3;
  rotation: readonly [number, number, number, number];
  velocity: LiquidVec3;
  angularVelocity: LiquidVec3;
  friction: number;
}

/** The liquid's state: interleaved particle records (the GPU buffer's layout) and the collider impulse sums. */
export interface LiquidState {
  /** count * LIQUID_PARTICLE_FLOATS floats. */
  particles: Float32Array;
  /** Per collider: impulse on the body (x, y, z) then its moment about the centre (x, y, z), in fixed-point units. */
  impulses: Float64Array;
  /** The grid of the last substep: per node mass, then velocity (after the grid update). */
  grid: Float64Array;
}

/** A copy of a liquid's state; `GPULiquid.restore` takes it back. */
export interface LiquidSnapshot {
  count: number;
  steps: number;
  particles: Float32Array;
}

/** The force and moment a collider took from the liquid over the last frame, in N and N m. */
export interface LiquidForce {
  force: [number, number, number];
  torque: [number, number, number];
}

/** Live statistics of a GPULiquid. */
export interface LiquidStats {
  count: number;
  backend: 'webgpu' | 'webgl2-compat';
  /** Grid nodes per axis and in all. */
  dims: readonly [number, number, number];
  nodes: number;
  /** Cell size h in world units. */
  cellSize: number;
  /** Rest density in particles per cell. */
  restDensity: number;
  /** Substeps taken in all. */
  steps: number;
  /** Substeps of the last frame, and their length in seconds. */
  frameSubsteps: number;
  substep: number;
  /** False when the last frame needed more than `maxSubsteps` and ran in slow motion. */
  realTime: boolean;
  /** Compute dispatches of the last frame (five a substep). */
  dispatches: number;
  /** Draw calls of the debug view in the last frame. */
  debugDraws: number;
}

/** The coded error of the GPU liquid; the message names the value and links the help entry. */
export function liquidError(message: string): Error {
  return fault('unsupported', message, 'gpu-liquid');
}

const num = (v: unknown, fallback: number, name: string, min: number, max: number, integer = false): number => {
  const n = v === undefined ? fallback : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    throw liquidError(`GPULiquid ${name} is ${String(n)}; pass ${integer ? 'an integer' : 'a finite number'} from ${min} to ${max}`);
  return n;
};

const vec = (v: unknown, fallback: LiquidVec3, name: string, min = -1e9, max = 1e9): LiquidVec3 => {
  const a = v === undefined ? fallback : v;
  if (!Array.isArray(a) && !ArrayBuffer.isView(a))
    throw liquidError(`GPULiquid ${name} must be [x, y, z]`);
  const t = a as ArrayLike<number>;
  if (t.length !== 3) throw liquidError(`GPULiquid ${name} must be [x, y, z]`);
  for (let i = 0; i < 3; i++)
    if (typeof t[i] !== 'number' || !Number.isFinite(t[i]) || t[i]! < min || t[i]! > max)
      throw liquidError(`GPULiquid ${name} must be three finite numbers from ${min} to ${max}`);
  return [t[0]!, t[1]!, t[2]!];
};

const box = (v: unknown, fallback: LiquidBox, name: string): LiquidBox => {
  const b = v === undefined ? fallback : v;
  if (!b || typeof b !== 'object') throw liquidError(`GPULiquid ${name} must be { min: [x, y, z], max: [x, y, z] }`);
  const min = vec((b as LiquidBox).min, fallback.min, `${name}.min`);
  const max = vec((b as LiquidBox).max, fallback.max, `${name}.max`);
  if (!(max[0] > min[0] && max[1] > min[1] && max[2] > min[2]))
    throw liquidError(`GPULiquid ${name}.max must be above ${name}.min on every axis`);
  return { min, max };
};

/** Checks `options` and fills in every default; throws the coded error for the first bad value. */
export function resolveLiquidParams(options: GPULiquidOptions = {}, fixedCount?: number): ResolvedLiquidParams {
  if (!options || typeof options !== 'object') throw liquidError('GPULiquid options must be an object');
  const count = fixedCount ?? num(options.count, 65_536, 'count', 1, MAX_GPU_LIQUID_PARTICLES, true);
  const container = box(options.box, { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }, 'box');
  const size = [0, 1, 2].map((a) => container.max[a]! - container.min[a]!);
  const fill = box(
    options.fill,
    {
      min: container.min,
      max: [container.min[0] + 0.4 * size[0]!, container.min[1] + 0.6 * size[1]!, container.max[2]],
    },
    'fill',
  );
  for (let a = 0; a < 3; a++)
    if (fill.min[a]! < container.min[a]! || fill.max[a]! > container.max[a]!)
      throw liquidError('GPULiquid fill must lie inside box');
  // The start lattice: equal spacing s in the fill volume, rounded to whole columns in x and z, filled from the floor.
  const fs = [0, 1, 2].map((a) => fill.max[a]! - fill.min[a]!);
  const s = Math.cbrt((fs[0]! * fs[1]! * fs[2]!) / count);
  const nx = Math.max(1, Math.round(fs[0]! / s)),
    nz = Math.max(1, Math.round(fs[2]! / s));
  const lattice: LiquidVec3 = [fs[0]! / nx, s, fs[2]! / nz];
  const longest = Math.max(size[0]!, size[1]!, size[2]!);
  const spacing = Math.cbrt(lattice[0] * lattice[1] * lattice[2]);
  const autoRes = Math.min(256, Math.max(8, Math.round(longest / (2 * spacing))));
  const resolution = num(options.resolution, autoRes, 'resolution', 8, 256, true);
  const h0 = longest / resolution;
  const cells = [0, 1, 2].map((a) => Math.round(size[a]! / h0)) as [number, number, number];
  for (let a = 0; a < 3; a++)
    if (cells[a]! < 4)
      throw liquidError(`GPULiquid box is ${cells[a]} cells across on axis ${'xyz'[a]}; it needs 4, so raise resolution`);
  const cell: LiquidVec3 = [size[0]! / cells[0], size[1]! / cells[1], size[2]! / cells[2]];
  const h = Math.min(cell[0], cell[1], cell[2]);
  const dims = cells.map((n) => n + 2 * LIQUID_PAD + 1) as [number, number, number];
  const nodes = dims[0] * dims[1] * dims[2];
  if (nodes > MAX_GPU_LIQUID_NODES)
    throw liquidError(`GPULiquid grid of ${nodes} nodes is over ${MAX_GPU_LIQUID_NODES}; pass a lower resolution`);
  const gravity = vec(options.gravity, [0, -9.81, 0], 'gravity', -1000, 1000);
  const density = num(options.density, 1000, 'density', 1e-3, 1e6);
  const g = Math.hypot(gravity[0], gravity[1], gravity[2]);
  const autoC = Math.max(0.5, 2 * Math.sqrt(g * size[1]!));
  const speedOfSound = num(options.speedOfSound, autoC, 'speedOfSound', 0.05, 1000);
  const maxSubstep = (LIQUID_CFL * h) / speedOfSound;
  const viscosity = num(options.viscosity, Math.min(5e-4, (h * h) / (8 * maxSubstep)), 'viscosity', 0, (h * h) / (8 * maxSubstep));
  const maxSubsteps = num(options.maxSubsteps, 32, 'maxSubsteps', 1, 256, true);
  const seed = num(options.seed, 0, 'seed', 0, 2 ** 32 - 1, true);
  if (options.paused !== undefined && typeof options.paused !== 'boolean')
    throw liquidError('GPULiquid paused must be true or false');
  let pointer: ResolvedLiquidParams['pointer'] = null;
  const p = options.pointer;
  if (p !== undefined && p !== null) {
    if (typeof p !== 'object') throw liquidError('GPULiquid pointer must be { position, velocity?, radius?, strength? } or null');
    pointer = {
      position: vec(p.position, [0, 0, 0], 'pointer.position'),
      velocity: vec(p.velocity, [0, 0, 0], 'pointer.velocity', -1e4, 1e4),
      radius: num(p.radius, 0.1 * longest, 'pointer.radius', 1e-6, 1e6),
      strength: num(p.strength, 40, 'pointer.strength', 0, 10_000),
    };
  }
  const list = options.colliders ?? [];
  if (!Array.isArray(list)) throw liquidError('GPULiquid colliders must be an array');
  if (list.length > MAX_LIQUID_COLLIDERS)
    throw liquidError(`GPULiquid takes at most ${MAX_LIQUID_COLLIDERS} colliders, not ${list.length}`);
  const colliders = list.map((c, i): ResolvedCollider => {
    const name = `colliders[${i}]`;
    if (!c || typeof c !== 'object' || (c.shape !== 'sphere' && c.shape !== 'box'))
      throw liquidError(`GPULiquid ${name}.shape must be 'sphere' or 'box'`);
    const r = c.rotation ?? [0, 0, 0, 1];
    if (!Array.isArray(r) || r.length !== 4 || r.some((x) => typeof x !== 'number' || !Number.isFinite(x)))
      throw liquidError(`GPULiquid ${name}.rotation must be a quaternion [x, y, z, w]`);
    const ql = Math.hypot(r[0]!, r[1]!, r[2]!, r[3]!);
    if (Math.abs(ql - 1) > 1e-3) throw liquidError(`GPULiquid ${name}.rotation must have length 1, not ${ql}`);
    const half =
      c.shape === 'sphere'
        ? ((x: number): LiquidVec3 => [x, x, x])(num(c.radius, 0.1, `${name}.radius`, 1e-6, 1e6))
        : vec(c.halfExtents, [0.1, 0.1, 0.1], `${name}.halfExtents`, 1e-6, 1e6);
    return {
      kind: c.shape === 'sphere' ? 0 : 1,
      position: vec(c.position, [0, 0, 0], `${name}.position`),
      half,
      rotation: [r[0]! / ql, r[1]! / ql, r[2]! / ql, r[3]! / ql],
      velocity: vec(c.velocity, [0, 0, 0], `${name}.velocity`, -1e4, 1e4),
      angularVelocity: vec(c.angularVelocity, [0, 0, 0], `${name}.angularVelocity`, -1e4, 1e4),
      friction: num(c.friction, 0.2, `${name}.friction`, 0, 10),
    };
  });
  const d = options.debug ?? {};
  if (!d || typeof d !== 'object') throw liquidError('GPULiquid debug must be an object');
  for (const key of ['enabled', 'grid', 'container', 'colliders'] as const)
    if (d[key] !== undefined && typeof d[key] !== 'boolean') throw liquidError(`GPULiquid debug.${key} must be true or false`);
  const mode = d.particles ?? 'speed';
  if (mode !== 'speed' && mode !== 'density' && mode !== 'off')
    throw liquidError(`GPULiquid debug.particles must be 'speed', 'density' or 'off', not ${String(mode)}`);
  const debug: Required<LiquidDebugOptions> = {
    enabled: d.enabled ?? false,
    particles: mode,
    speedScale: num(d.speedScale, Math.max(0.1, Math.sqrt(2 * g * size[1]!)), 'debug.speedScale', 1e-6, 1e6),
    grid: d.grid ?? true,
    container: d.container ?? true,
    colliders: d.colliders ?? true,
  };
  const volume = lattice[0] * lattice[1] * lattice[2];
  return {
    count,
    boxMin: container.min,
    boxMax: container.max,
    fillMin: fill.min,
    fillMax: fill.max,
    lattice,
    cell,
    cellSize: h,
    cells,
    dims,
    nodes,
    origin: [container.min[0] - LIQUID_PAD * cell[0], container.min[1] - LIQUID_PAD * cell[1], container.min[2] - LIQUID_PAD * cell[2]],
    restDensity: (cell[0] * cell[1] * cell[2]) / volume,
    gravity,
    density,
    particleMass: density * volume,
    speedOfSound,
    viscosity,
    maxSubstep,
    maxSubsteps,
    seed,
    paused: options.paused ?? false,
    pointer,
    colliders,
    debug,
  };
}

/** Equal substeps for `dt` seconds: `ceil(dt / maxSubstep)` of them, at most `cap`; past the cap each is maxSubstep long. */
export function liquidSubsteps(p: ResolvedLiquidParams, dt: number, cap = Infinity): { n: number; h: number } {
  if (!(dt > 0)) return { n: 0, h: 0 };
  const n = Math.ceil(dt / p.maxSubstep - 1e-9);
  return n <= cap ? { n, h: dt / n } : { n: cap, h: p.maxSubstep };
}

/** A hash of 32 bits for the start jitter (Jarzynski and Olano 2020, PCG). */
const pcg = (v: number): number => {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
};

/** The start state: the fill block on its lattice, every particle within a quarter spacing of its site, at rest. */
export function createLiquidState(params: ResolvedLiquidParams): LiquidState {
  const { count, fillMin, fillMax, lattice, boxMin, boxMax } = params;
  const nx = Math.max(1, Math.round((fillMax[0] - fillMin[0]) / lattice[0]));
  const nz = Math.max(1, Math.round((fillMax[2] - fillMin[2]) / lattice[2]));
  const particles = new Float32Array(count * LIQUID_PARTICLE_FLOATS);
  for (let i = 0; i < count; i++) {
    const ix = i % nx,
      iz = Math.floor(i / nx) % nz,
      iy = Math.floor(i / (nx * nz));
    const site = [ix + 0.5, iy + 0.5, iz + 0.5];
    const b = i * LIQUID_PARTICLE_FLOATS;
    for (let a = 0; a < 3; a++) {
      const jitter = (pcg(params.seed * 3 + a + 3 * i * 0x9e37) / 4294967296 - 0.5) * 0.5;
      const x = fillMin[a]! + (site[a]! + jitter) * lattice[a]!;
      particles[b + a] = Math.min(boxMax[a]!, Math.max(boxMin[a]!, x));
    }
    particles[b + 3] = 1;
  }
  return { particles, impulses: new Float64Array(MAX_LIQUID_COLLIDERS * 6), grid: new Float64Array(params.nodes * 4) };
}

/** FNV-1a of the particle bytes, as 8 hex digits. */
export function liquidStateHash(particles: Float32Array): string {
  const bytes = new Uint8Array(particles.buffer, particles.byteOffset, particles.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** WGSL's round(): halves go to the even integer. */
const roundEven = (x: number): number => {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
};
const LIMIT = 2e9;
/** One fixed-point term as the GPU adds it. */
const fixed = (x: number, scale: number): number => roundEven(Math.min(LIMIT, Math.max(-LIMIT, x * scale)));

/** Signed distance from `x` to collider `c` and the outward normal there. */
export function colliderDistance(c: ResolvedCollider, x: LiquidVec3, normal: number[]): number {
  const dx = x[0] - c.position[0],
    dy = x[1] - c.position[1],
    dz = x[2] - c.position[2];
  if (c.kind === 0) {
    const l = Math.hypot(dx, dy, dz);
    if (l > 0) {
      normal[0] = dx / l;
      normal[1] = dy / l;
      normal[2] = dz / l;
    } else {
      normal[0] = 0;
      normal[1] = 1;
      normal[2] = 0;
    }
    return l - c.half[0];
  }
  const [qx, qy, qz, qw] = c.rotation;
  const local = rotate(-qx, -qy, -qz, qw, dx, dy, dz);
  const q = [Math.abs(local[0]) - c.half[0], Math.abs(local[1]) - c.half[1], Math.abs(local[2]) - c.half[2]];
  const sx = local[0] < 0 ? -1 : 1,
    sy = local[1] < 0 ? -1 : 1,
    sz = local[2] < 0 ? -1 : 1;
  const ox = Math.max(q[0]!, 0),
    oy = Math.max(q[1]!, 0),
    oz = Math.max(q[2]!, 0);
  const outside = Math.hypot(ox, oy, oz);
  let n: number[];
  if (outside > 0) n = [(ox * sx) / outside, (oy * sy) / outside, (oz * sz) / outside];
  else if (q[0]! >= q[1]! && q[0]! >= q[2]!) n = [sx, 0, 0];
  else if (q[1]! >= q[2]!) n = [0, sy, 0];
  else n = [0, 0, sz];
  const w = rotate(qx, qy, qz, qw, n[0]!, n[1]!, n[2]!);
  normal[0] = w[0];
  normal[1] = w[1];
  normal[2] = w[2];
  return outside + Math.min(Math.max(q[0]!, q[1]!, q[2]!), 0);
}

/** Rotates v by the unit quaternion q: v + 2 q.xyz x (q.xyz x v + w v). */
function rotate(qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number): [number, number, number] {
  const tx = qy * vz - qz * vy + qw * vx,
    ty = qz * vx - qx * vz + qw * vy,
    tz = qx * vy - qy * vx + qw * vz;
  return [vx + 2 * (qy * tz - qz * ty), vy + 2 * (qz * tx - qx * tz), vz + 2 * (qx * ty - qy * tx)];
}


/** The quadratic B-spline weights and the base node of one particle, per axis (f in w[o + 3]). */
function stencil(p: ResolvedLiquidParams, x: number, a: number, w: Float64Array, o: number): number {
  const g = (x - p.origin[a]!) / p.cell[a]!;
  const base = Math.min(p.dims[a]! - 3, Math.max(0, Math.floor(g - 0.5)));
  const f = g - base;
  w[o] = 0.5 * (1.5 - f) * (1.5 - f);
  w[o + 1] = 0.75 - (f - 1) * (f - 1);
  w[o + 2] = 0.5 * (f - 0.5) * (f - 0.5);
  w[o + 3] = f;
  return base;
}

/** A particle within this many cells of a collider reads the collider as liquid at rest in its density. */
const GHOST_REACH = 3;

/**
 * The share of a rest-liquid node's mass that lies on the far side of a flat face t cells from the node (t > 0 inside
 * the body): the integral of the quadratic B-spline up to t, 0 below -1.5 and 1 above 1.5. A collider reads as liquid at
 * rest in the density, as the mirrored walls do, so a particle against it has its full density.
 */
export function splineCover(t: number): number {
  if (t <= -1.5) return 0;
  if (t >= 1.5) return 1;
  if (t < -0.5) return (t + 1.5) ** 3 / 6;
  if (t <= 0.5) return 1 / 6 + 0.75 * (t + 0.5) - (t * t * t + 0.125) / 3;
  return 1 - (1.5 - t) ** 3 / 6;
}

/**
 * The node indices whose mass stands for node i on one axis in the density: i itself, and its mirror across a wall it is
 * within two cells of. Mirroring the liquid's mass across each wall makes the walls read as liquid at rest, so a particle
 * at a wall has its full density (the B-spline is symmetric and every wall lies on a node). Writes them to `out` and
 * returns how many.
 */
export function wallMirrors(p: ResolvedLiquidParams, a: number, i: number, out: number[]): number {
  const lo = LIQUID_PAD,
    hi = LIQUID_PAD + p.cells[a]!;
  out[0] = i;
  let m = -1;
  if (i >= lo - 2 && i <= lo + 2) m = 2 * lo - i;
  else if (i >= hi - 2 && i <= hi + 2) m = 2 * hi - i;
  if (m < 0 || m >= p.dims[a]!) return 1;
  out[1] = m;
  return 2;
}

/**
 * Advances the CPU twin by `dt` seconds in `ceil(dt / maxSubstep)` equal substeps (at most `cap`, see
 * {@link liquidSubsteps}); returns the substeps taken. The collider impulse sums start from zero.
 */
export function stepLiquidCPU(state: LiquidState, params: ResolvedLiquidParams, dt: number, cap = Infinity): number {
  if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0 || dt > 1)
    throw liquidError(`GPULiquid step dt is ${String(dt)}; pass seconds from 0 to 1`);
  const { n, h } = liquidSubsteps(params, dt, cap);
  state.impulses.fill(0);
  for (let s = 0; s < n; s++) substep(state, params, h);
  return n;
}

function substep(state: LiquidState, p: ResolvedLiquidParams, dt: number): void {
  const { particles, grid, impulses } = state;
  const F = LIQUID_PARTICLE_FLOATS,
    S = LIQUID_FIXED,
    cell = p.cell;
  const [nx, ny] = p.dims;
  const k4 = [4 / (cell[0] * cell[0]), 4 / (cell[1] * cell[1]), 4 / (cell[2] * cell[2])];
  const kp = (dt * p.speedOfSound * p.speedOfSound) / LIQUID_GAMMA;
  const kv = dt * p.viscosity;
  const w = new Float64Array(12);
  const base = [0, 0, 0];
  const d = [0, 0, 0];
  const kd = [0, 0, 0];
  const mx = [0, 0],
    my = [0, 0],
    mz = [0, 0];
  const at = (ix: number, iy: number, iz: number) => (ix + nx * (iy + ny * iz)) * 4;
  const normal = [0, 0, 0];
  const x: [number, number, number] = [0, 0, 0];
  const hc = Math.cbrt(cell[0] * cell[1] * cell[2]);
  // d = x_i - x_p for stencil node (aa, bb, c), and kd = D^-1 d with D^-1 = diag(4 / h^2).
  const offsets = (aa: number, bb: number, c: number) => {
    d[0] = (aa - w[3]!) * cell[0];
    d[1] = (bb - w[7]!) * cell[1];
    d[2] = (c - w[11]!) * cell[2];
    for (let r = 0; r < 3; r++) kd[r] = k4[r]! * d[r]!;
  };
  grid.fill(0);

  // P2G, mass and APIC momentum: m_i += w, (m v)_i += w (v + C d).
  for (let i = 0; i < p.count; i++) {
    const b = i * F;
    for (let a = 0; a < 3; a++) base[a] = stencil(p, particles[b + a]!, a, w, a * 4);
    for (let c = 0; c < 3; c++)
      for (let bb = 0; bb < 3; bb++)
        for (let aa = 0; aa < 3; aa++) {
          const weight = w[aa]! * w[4 + bb]! * w[8 + c]!;
          offsets(aa, bb, c);
          const node = at(base[0]! + aa, base[1]! + bb, base[2]! + c);
          grid[node] += fixed(weight, S);
          for (let r = 0; r < 3; r++) {
            const row = b + 8 + r * 4;
            const cd = particles[row]! * d[0]! + particles[row + 1]! * d[1]! + particles[row + 2]! * d[2]!;
            grid[node + 1 + r] += fixed(weight * (particles[b + 4 + r]! + cd), S);
          }
        }
  }

  // P2G, stress: density from the grid's mass (mirrored across the walls), Tait pressure (zero below rest density) and
  // viscous stress; the momentum term is -dt vol sigma D^-1 d.
  for (let i = 0; i < p.count; i++) {
    const b = i * F;
    for (let a = 0; a < 3; a++) base[a] = stencil(p, particles[b + a]!, a, w, a * 4);
    let rho = 0;
    let near = 0;
    for (let k = 0; k < p.colliders.length; k++) {
      x[0] = particles[b]!;
      x[1] = particles[b + 1]!;
      x[2] = particles[b + 2]!;
      if (colliderDistance(p.colliders[k]!, x, normal) < GHOST_REACH * hc) near |= 1 << k;
    }
    for (let c = 0; c < 3; c++)
      for (let bb = 0; bb < 3; bb++)
        for (let aa = 0; aa < 3; aa++) {
          const kx = wallMirrors(p, 0, base[0]! + aa, mx),
            ky = wallMirrors(p, 1, base[1]! + bb, my),
            kz = wallMirrors(p, 2, base[2]! + c, mz);
          let m = 0;
          for (let z = 0; z < kz; z++)
            for (let y = 0; y < ky; y++) for (let x = 0; x < kx; x++) m += grid[at(mx[x]!, my[y]!, mz[z]!)]!;
          let ghost = 0;
          if (near) {
            x[0] = p.origin[0] + (base[0]! + aa) * cell[0];
            x[1] = p.origin[1] + (base[1]! + bb) * cell[1];
            x[2] = p.origin[2] + (base[2]! + c) * cell[2];
            for (let k = 0; k < p.colliders.length; k++)
              if (near & (1 << k)) ghost += splineCover(-colliderDistance(p.colliders[k]!, x, normal) / hc);
          }
          rho += w[aa]! * w[4 + bb]! * w[8 + c]! * (m / S + ghost * p.restDensity);
        }
    const ratio = rho / p.restDensity;
    particles[b + 3] = ratio;
    const capped = Math.min(Math.fround(ratio), LIQUID_MAX_RATIO);
    const pc = capped > 1 ? (kp * (capped ** LIQUID_GAMMA - 1)) / capped : 0;
    for (let c = 0; c < 3; c++)
      for (let bb = 0; bb < 3; bb++)
        for (let aa = 0; aa < 3; aa++) {
          const weight = w[aa]! * w[4 + bb]! * w[8 + c]!;
          offsets(aa, bb, c);
          const node = at(base[0]! + aa, base[1]! + bb, base[2]! + c);
          for (let r = 0; r < 3; r++) {
            // (C + C^T) kd, row r: C[r] . kd plus column r of C . kd.
            const row = b + 8 + r * 4;
            const cd = particles[row]! * kd[0]! + particles[row + 1]! * kd[1]! + particles[row + 2]! * kd[2]!;
            const ctd = particles[b + 8 + r]! * kd[0]! + particles[b + 12 + r]! * kd[1]! + particles[b + 16 + r]! * kd[2]!;
            grid[node + 1 + r] += fixed(weight * (pc * kd[r]! - kv * (cd + ctd)), S);
          }
        }
  }

  // Grid update: velocity, gravity, the pointer, the speed limit, the colliders, the walls.
  const vmax = p.cellSize / dt;
  const pointer = p.pointer;
  const lo = LIQUID_PAD;
  for (let iz = 0, node = 0; iz < p.dims[2]; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++, node += 4) {
        const mf = grid[node]!;
        if (mf <= 0) {
          grid[node] = grid[node + 1] = grid[node + 2] = grid[node + 3] = 0;
          continue;
        }
        const m = mf / S;
        let vx = grid[node + 1]! / S / m + p.gravity[0] * dt,
          vy = grid[node + 2]! / S / m + p.gravity[1] * dt,
          vz = grid[node + 3]! / S / m + p.gravity[2] * dt;
        x[0] = p.origin[0] + ix * cell[0];
        x[1] = p.origin[1] + iy * cell[1];
        x[2] = p.origin[2] + iz * cell[2];
        if (pointer) {
          const ex = x[0] - pointer.position[0],
            ey = x[1] - pointer.position[1],
            ez = x[2] - pointer.position[2];
          const q = (ex * ex + ey * ey + ez * ez) / (pointer.radius * pointer.radius);
          if (q < 1) {
            const k = 1 - Math.exp(-pointer.strength * (1 - q) * (1 - q) * dt);
            vx += (pointer.velocity[0] - vx) * k;
            vy += (pointer.velocity[1] - vy) * k;
            vz += (pointer.velocity[2] - vz) * k;
          }
        }
        const speed = Math.hypot(vx, vy, vz);
        if (speed > vmax) {
          vx *= vmax / speed;
          vy *= vmax / speed;
          vz *= vmax / speed;
        }
        for (let k = 0; k < p.colliders.length; k++) {
          const c = p.colliders[k]!;
          if (colliderDistance(c, x, normal) >= 0) continue;
          const rx = x[0] - c.position[0],
            ry = x[1] - c.position[1],
            rz = x[2] - c.position[2];
          const [ax, ay, az] = c.angularVelocity;
          const bx = c.velocity[0] + ay * rz - az * ry,
            by = c.velocity[1] + az * rx - ax * rz,
            bz = c.velocity[2] + ax * ry - ay * rx;
          let tx = vx - bx,
            ty = vy - by,
            tz = vz - bz;
          const vn = tx * normal[0]! + ty * normal[1]! + tz * normal[2]!;
          if (vn >= 0) continue;
          tx -= vn * normal[0]!;
          ty -= vn * normal[1]!;
          tz -= vn * normal[2]!;
          const lt = Math.hypot(tx, ty, tz);
          const keep = lt > 1e-9 ? Math.max(0, 1 - (c.friction * -vn) / lt) : 0;
          const nvx = bx + tx * keep,
            nvy = by + ty * keep,
            nvz = bz + tz * keep;
          // The body takes the opposite of the liquid's change of momentum, and its moment about the centre.
          const jx = -m * (nvx - vx),
            jy = -m * (nvy - vy),
            jz = -m * (nvz - vz);
          const o = k * 6,
            FS = LIQUID_FORCE_FIXED;
          impulses[o] += fixed(jx, FS);
          impulses[o + 1] += fixed(jy, FS);
          impulses[o + 2] += fixed(jz, FS);
          impulses[o + 3] += fixed(ry * jz - rz * jy, FS);
          impulses[o + 4] += fixed(rz * jx - rx * jz, FS);
          impulses[o + 5] += fixed(rx * jy - ry * jx, FS);
          vx = nvx;
          vy = nvy;
          vz = nvz;
        }
        // Walls, free slip: no node on or past a wall moves further out.
        if ((ix <= lo && vx < 0) || (ix >= lo + p.cells[0] && vx > 0)) vx = 0;
        if ((iy <= lo && vy < 0) || (iy >= lo + p.cells[1] && vy > 0)) vy = 0;
        if ((iz <= lo && vz < 0) || (iz >= lo + p.cells[2] && vz > 0)) vz = 0;
        grid[node] = m;
        grid[node + 1] = Math.fround(vx);
        grid[node + 2] = Math.fround(vy);
        grid[node + 3] = Math.fround(vz);
      }

  // G2P: velocity and APIC C = sum w v (D^-1 d)^T, advect, out of the colliders, inside the walls.
  for (let i = 0; i < p.count; i++) {
    const b = i * F;
    for (let a = 0; a < 3; a++) base[a] = stencil(p, particles[b + a]!, a, w, a * 4);
    let vx = 0,
      vy = 0,
      vz = 0;
    const B = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let c = 0; c < 3; c++)
      for (let bb = 0; bb < 3; bb++)
        for (let aa = 0; aa < 3; aa++) {
          const weight = w[aa]! * w[4 + bb]! * w[8 + c]!;
          offsets(aa, bb, c);
          const node = at(base[0]! + aa, base[1]! + bb, base[2]! + c);
          const gx = grid[node + 1]!,
            gy = grid[node + 2]!,
            gz = grid[node + 3]!;
          vx += weight * gx;
          vy += weight * gy;
          vz += weight * gz;
          for (let r = 0; r < 3; r++) {
            B[r] = B[r]! + weight * gx * kd[r]!;
            B[3 + r] = B[3 + r]! + weight * gy * kd[r]!;
            B[6 + r] = B[6 + r]! + weight * gz * kd[r]!;
          }
        }
    x[0] = particles[b]! + vx * dt;
    x[1] = particles[b + 1]! + vy * dt;
    x[2] = particles[b + 2]! + vz * dt;
    const v = [vx, vy, vz];
    // A particle that entered a collider goes back to its surface and loses its speed into it; the body takes that
    // momentum, so every push of the body on the liquid is counted (the grid's and this one).
    for (let k = 0; k < p.colliders.length; k++) {
      const c = p.colliders[k]!;
      const sdf = colliderDistance(c, x, normal);
      if (sdf >= 0) continue;
      for (let a = 0; a < 3; a++) x[a] = x[a]! - sdf * normal[a]!;
      const rx = x[0] - c.position[0],
        ry = x[1] - c.position[1],
        rz = x[2] - c.position[2];
      const [ax, ay, az] = c.angularVelocity;
      const vn =
        (v[0]! - (c.velocity[0] + ay * rz - az * ry)) * normal[0]! +
        (v[1]! - (c.velocity[1] + az * rx - ax * rz)) * normal[1]! +
        (v[2]! - (c.velocity[2] + ax * ry - ay * rx)) * normal[2]!;
      if (vn >= 0) continue;
      for (let a = 0; a < 3; a++) v[a] = v[a]! - vn * normal[a]!;
      const jx = vn * normal[0]!,
        jy = vn * normal[1]!,
        jz = vn * normal[2]!;
      const o = k * 6,
        FS = LIQUID_FORCE_FIXED;
      impulses[o] += fixed(jx, FS);
      impulses[o + 1] += fixed(jy, FS);
      impulses[o + 2] += fixed(jz, FS);
      impulses[o + 3] += fixed(ry * jz - rz * jy, FS);
      impulses[o + 4] += fixed(rz * jx - rx * jz, FS);
      impulses[o + 5] += fixed(rx * jy - ry * jx, FS);
    }
    for (let a = 0; a < 3; a++) {
      if (x[a]! < p.boxMin[a]!) {
        x[a] = p.boxMin[a]!;
        if (v[a]! < 0) v[a] = 0;
      } else if (x[a]! > p.boxMax[a]!) {
        x[a] = p.boxMax[a]!;
        if (v[a]! > 0) v[a] = 0;
      }
      particles[b + a] = x[a]!;
      particles[b + 4 + a] = v[a]!;
      particles[b + 8 + a * 4] = B[a * 3]!;
      particles[b + 9 + a * 4] = B[a * 3 + 1]!;
      particles[b + 10 + a * 4] = B[a * 3 + 2]!;
    }
  }
}
