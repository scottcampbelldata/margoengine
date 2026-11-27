// The MLS-MPM liquid of GPULiquid (`@margoengine/water/liquid`): options, the particle layout and the CPU twin that runs
// the same five passes as the WGSL (liquid-mpm-shaders.ts), in f64 with the GPU's fixed-point sums. The WebGL2 layer steps
// the liquid with it, and the tests check the method against it. Method: the moving least squares material point method
// (Hu et al. 2018) with APIC transfers (Jiang et al. 2015), density from the grid and the Tait equation of state (Becker and
// Teschner 2007), quadratic B-spline weights (Steffen et al. 2008). Sources: docs/clean-room.md, "GPU particle liquid".
import { fault } from '../../shared/errors.js';

/** A world-space vector [x, y, z]. */
export type LiquidVec3 = readonly [number, number, number];

/**
 * Floats per particle record: position (0..2), density over rest density (3), velocity (4..6), liquid index (7), the
 * APIC matrix C row by row (8..16) and the particle's linear RGB colour (17..19).
 */
export const LIQUID_PARTICLE_FLOATS = 20;
/** Offset of a particle's colour in its record. */
export const LIQUID_COLOR_OFFSET = 17;
/**
 * Words per grid node: while particles scatter, the fixed-point sums of weight, mass, momentum (3) and colour (3); after
 * the grid update the node's velocity (3), mass and weight as f32 bits, the colour sums kept.
 */
export const LIQUID_GRID_STRIDE = 8;
/** Most liquids one GPULiquid holds. */
export const MAX_LIQUIDS = 4;
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
/** Collider shapes as the WGSL numbers them. */
export const LIQUID_COLLIDER_KINDS = { sphere: 0, box: 1, capsule: 2, plane: 3, mesh: 4 } as const;
/** Most distance samples all of one liquid's mesh colliders hold together (eight fields of 64³). */
export const MAX_LIQUID_MESH_SAMPLES = 8 * 64 ** 3;
/** Most triangle-sample pairs one {@link bakeLiquidMesh} call works through, which bounds its time. */
export const MAX_LIQUID_MESH_WORK = 2 ** 30;

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

/**
 * A signed distance field of a triangle mesh in its own frame, made by {@link bakeLiquidMesh}: `resolution`³ samples on a
 * lattice spanning `center ± half`, negative inside the mesh.
 */
export interface LiquidMeshShape {
  /** Samples per axis, integer 2..64. */
  readonly resolution: number;
  /** Centre of the sampled box in the mesh's frame. */
  readonly center: LiquidVec3;
  /** Half size of the sampled box per axis, each > 0. */
  readonly half: LiquidVec3;
  /** resolution³ signed distances in world units, x fastest. */
  readonly distances: Float32Array;
}

/** A rigid body the liquid flows round: it pushes the liquid, and `GPULiquid.forces` reports what the liquid pushes back. */
export interface LiquidCollider {
  /**
   * `'sphere'` (uses `radius`), `'box'` (`halfExtents`, `rotation`), `'capsule'` (`radius`, `halfHeight` along its local
   * y, `rotation`), `'plane'` (the half space behind `position` across `normal`; the liquid stays on the normal's side)
   * or `'mesh'` (`mesh` from {@link bakeLiquidMesh}, `rotation`).
   */
  shape: 'sphere' | 'box' | 'capsule' | 'plane' | 'mesh';
  /** Centre in world units: a point on a plane, the origin of a mesh's frame. */
  position: LiquidVec3;
  /** Sphere or capsule radius, > 0. Default 0.1. */
  radius?: number;
  /** Box half size per axis, each > 0. Default [0.1, 0.1, 0.1]. */
  halfExtents?: LiquidVec3;
  /** Capsule: half the length of its axis segment along its local y, >= 0. Default 0.1. */
  halfHeight?: number;
  /** Plane normal, pointing to the liquid's side; any length above 0. Default [0, 1, 0]. */
  normal?: LiquidVec3;
  /** Mesh: its distance field from {@link bakeLiquidMesh}. Required for `'mesh'`. */
  mesh?: LiquidMeshShape;
  /** Box, capsule or mesh orientation, a unit quaternion [x, y, z, w]. Default [0, 0, 0, 1]. */
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
  /**
   * Colour particles by `'speed'`, `'density'` or their own `'color'` (each liquid's, as it mixes), or `'off'` to keep the
   * liquid surface. Default `'speed'`.
   */
  particles?: 'speed' | 'density' | 'color' | 'off';
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
  /**
   * Up to 4 liquids, each with its own start box, density, viscosity and colour; they share the container, the grid and
   * the speed of sound, and `count` is split between them by the volume of their boxes. A heavier liquid sinks through a
   * lighter one. Default one liquid from `fill`, `density` and `viscosity`.
   */
  liquids?: readonly LiquidKindOptions[];
  /**
   * How fast neighbouring particles' colours blend, 1/s, 0 to 1000: each particle's colour relaxes towards the mean
   * colour of the liquid round it at this rate, so a dye spreads where the liquid stirs. 0 keeps every colour. Default 0.
   */
  mixing?: number;
  /** Speed of sound in m/s, 0.05..1000; higher is stiffer and takes more substeps. Default 2 * sqrt(|g| * box height). */
  speedOfSound?: number;
  /** Kinematic viscosity in m²/s, 0 up to cellSize² / (8 * substep). Default 0.0005. */
  viscosity?: number;
  /**
   * Surface tension in N/m (water 0.072), from 0 up to the explicit limit density * cellSize³ / (2 pi substep²), by the
   * continuum surface force on the grid in its conservative form. It pulls the free surface tight: drops round up, jets break into beads, the
   * pressure inside a drop of radius R is 2 sigma / R. At a tank's grid scale water's own value is too small to see; raise
   * it to see the scale the grid resolves. Adds one compute pass a substep. Default 0.
   */
  surfaceTension?: number;
  /**
   * Adhesion of the liquid to the container's walls and the colliders: the acceleration in m/s² that pulls liquid
   * towards a surface, in full within one cell of it and fading to nothing at two, 0 to 1000. Above gravity a film
   * clings to the ceiling and wets the walls; a collider takes the opposite pull. Default 0.
   */
  adhesion?: number;
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

/** One liquid of {@link GPULiquidOptions.liquids}. */
export interface LiquidKindOptions {
  /** Its start box inside the container; boxes of different liquids must not overlap. Default `fill` (first liquid only). */
  fill?: LiquidBox;
  /** Density in kg/m³, 0.001 to 1,000,000. Default the options' `density`. */
  density?: number;
  /** Kinematic viscosity in m²/s, in the same range as `viscosity`. Default the options' `viscosity`. */
  viscosity?: number;
  /** Linear RGB colour, each 0 to 1; the surface tints the light through it. Default [1, 1, 1] (the surface's own colour). */
  color?: LiquidVec3;
}

/** A checked liquid with its start block. */
export interface ResolvedLiquidKind {
  fillMin: LiquidVec3;
  fillMax: LiquidVec3;
  lattice: LiquidVec3;
  /** First particle and number of particles. */
  start: number;
  count: number;
  density: number;
  /** density over the options' density, the particle's mass in units of particleMass. */
  massRatio: number;
  viscosity: number;
  color: LiquidVec3;
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
  surfaceTension: number;
  adhesion: number;
  /** The liquids; the first's fill and lattice are also `fillMin`, `fillMax` and `lattice`. */
  kinds: ResolvedLiquidKind[];
  mixing: number;
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
  /** 0 sphere, 1 box, 2 capsule, 3 plane, 4 mesh. */
  kind: 0 | 1 | 2 | 3 | 4;
  position: LiquidVec3;
  /** Sphere radius, box half size, capsule radius and half height, plane unit normal, or a mesh field's half size. */
  half: LiquidVec3;
  rotation: readonly [number, number, number, number];
  velocity: LiquidVec3;
  angularVelocity: LiquidVec3;
  friction: number;
  /** A mesh's distance field. */
  mesh?: LiquidMeshShape;
}

/** The liquid's state: interleaved particle records (the GPU buffer's layout), the collider impulse sums and the grid. */
export interface LiquidState {
  /** count * LIQUID_PARTICLE_FLOATS floats. */
  particles: Float32Array;
  /** Per collider: impulse on the body (x, y, z) then its moment about the centre (x, y, z), in fixed-point units. */
  impulses: Float64Array;
  /** The grid of the last substep, LIQUID_GRID_STRIDE words a node: after the update velocity, mass, weight, colour sums. */
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
  const liquidList = options.liquids ?? [{}];
  if (!Array.isArray(liquidList) || liquidList.length < 1 || liquidList.length > MAX_LIQUIDS)
    throw liquidError(`GPULiquid liquids must be an array of 1 to ${MAX_LIQUIDS} liquids`);
  const fills = liquidList.map((k, i) => {
    if (!k || typeof k !== 'object') throw liquidError(`GPULiquid liquids[${i}] must be an object`);
    if (i > 0 && k.fill === undefined) throw liquidError(`GPULiquid liquids[${i}].fill is required; give each liquid after the first its own box`);
    const f = i === 0 && k.fill === undefined ? fill : box(k.fill, fill, `liquids[${i}].fill`);
    for (let a = 0; a < 3; a++)
      if (f.min[a]! < container.min[a]! || f.max[a]! > container.max[a]!)
        throw liquidError(i ? `GPULiquid liquids[${i}].fill must lie inside box` : 'GPULiquid fill must lie inside box');
    return f;
  });
  for (let i = 0; i < fills.length; i++)
    for (let j = 0; j < i; j++)
      if ([0, 1, 2].every((a) => fills[i]!.min[a]! < fills[j]!.max[a]! && fills[j]!.min[a]! < fills[i]!.max[a]!))
        throw liquidError(`GPULiquid liquids[${j}] and liquids[${i}] start in overlapping boxes; move one so they only touch`);
  // The start lattice: one spacing s for every liquid, rounded to whole columns in x and z per box, filled from its
  // floor; count is split by volume.
  const volumes = fills.map((f) => (f.max[0] - f.min[0]) * (f.max[1] - f.min[1]) * (f.max[2] - f.min[2]));
  const total = volumes.reduce((a, b) => a + b, 0);
  const s = Math.cbrt(total / count);
  let given = 0;
  const blocks = fills.map((f, i) => {
    const n = i === fills.length - 1 ? count - given : Math.round((count * volumes[i]!) / total);
    if (n < 1) throw liquidError(`GPULiquid liquids[${i}].fill gets no particles of ${count}; enlarge it or raise count`);
    const start = given;
    given += n;
    const nx = Math.max(1, Math.round((f.max[0] - f.min[0]) / s)),
      nz = Math.max(1, Math.round((f.max[2] - f.min[2]) / s));
    const lattice: LiquidVec3 = [(f.max[0] - f.min[0]) / nx, s, (f.max[2] - f.min[2]) / nz];
    return { fillMin: f.min, fillMax: f.max, lattice, start, count: n };
  });
  if (given !== count) throw liquidError(`GPULiquid liquids split ${count} particles into ${given}; enlarge the smaller boxes`);
  const lattice = blocks[0]!.lattice;
  const longest = Math.max(size[0]!, size[1]!, size[2]!);
  // The mean volume a particle starts with, the rest density's.
  const volume = blocks.reduce((a, b) => a + b.count * b.lattice[0] * b.lattice[1] * b.lattice[2], 0) / count;
  const spacing = Math.cbrt(volume);
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
  // Brackbill et al. (1992): an explicit capillary step needs dt < sqrt(rho h^3 / (2 pi sigma)).
  const density0 = num(options.density, 1000, 'density', 1e-3, 1e6);
  const tensionMax = (density0 * h * h * h) / (2 * Math.PI * maxSubstep * maxSubstep);
  const surfaceTension = num(options.surfaceTension, 0, 'surfaceTension', 0, tensionMax);
  const adhesion = num(options.adhesion, 0, 'adhesion', 0, 1000);
  const mixing = num(options.mixing, 0, 'mixing', 0, 1000);
  const kinds = blocks.map((b, i): ResolvedLiquidKind => {
    const k = liquidList[i]!;
    const kd = num(k.density, density0, `liquids[${i}].density`, 1e-3, 1e6);
    return {
      ...b,
      density: kd,
      massRatio: kd / density0,
      viscosity: num(k.viscosity, viscosity, `liquids[${i}].viscosity`, 0, (h * h) / (8 * maxSubstep)),
      color: vec(k.color, [1, 1, 1], `liquids[${i}].color`, 0, 1),
    };
  });
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
  let meshSamples = 0;
  const colliders = list.map((c, i): ResolvedCollider => {
    const name = `colliders[${i}]`;
    const kind = c && typeof c === 'object' ? LIQUID_COLLIDER_KINDS[c.shape as keyof typeof LIQUID_COLLIDER_KINDS] : undefined;
    if (kind === undefined || !Object.hasOwn(LIQUID_COLLIDER_KINDS, c.shape))
      throw liquidError(`GPULiquid ${name}.shape must be 'sphere', 'box', 'capsule', 'plane' or 'mesh'`);
    const r = c.rotation ?? [0, 0, 0, 1];
    if (!Array.isArray(r) || r.length !== 4 || r.some((x) => typeof x !== 'number' || !Number.isFinite(x)))
      throw liquidError(`GPULiquid ${name}.rotation must be a quaternion [x, y, z, w]`);
    const ql = Math.hypot(r[0]!, r[1]!, r[2]!, r[3]!);
    if (Math.abs(ql - 1) > 1e-3) throw liquidError(`GPULiquid ${name}.rotation must have length 1, not ${ql}`);
    let half: LiquidVec3;
    let mesh: LiquidMeshShape | undefined;
    if (kind === 0) {
      const radius = num(c.radius, 0.1, `${name}.radius`, 1e-6, 1e6);
      half = [radius, radius, radius];
    } else if (kind === 1) half = vec(c.halfExtents, [0.1, 0.1, 0.1], `${name}.halfExtents`, 1e-6, 1e6);
    else if (kind === 2)
      half = [num(c.radius, 0.1, `${name}.radius`, 1e-6, 1e6), num(c.halfHeight, 0.1, `${name}.halfHeight`, 0, 1e6), 0];
    else if (kind === 3) {
      const n = vec(c.normal, [0, 1, 0], `${name}.normal`);
      const l = Math.hypot(n[0], n[1], n[2]);
      if (!(l > 1e-9)) throw liquidError(`GPULiquid ${name}.normal must not be zero`);
      half = [n[0] / l, n[1] / l, n[2] / l];
    } else {
      mesh = checkMeshShape(c.mesh, `${name}.mesh`);
      meshSamples += mesh.distances.length;
      half = mesh.half;
    }
    return {
      kind,
      position: vec(c.position, [0, 0, 0], `${name}.position`),
      half,
      rotation: [r[0]! / ql, r[1]! / ql, r[2]! / ql, r[3]! / ql],
      velocity: vec(c.velocity, [0, 0, 0], `${name}.velocity`, -1e4, 1e4),
      angularVelocity: vec(c.angularVelocity, [0, 0, 0], `${name}.angularVelocity`, -1e4, 1e4),
      friction: num(c.friction, 0.2, `${name}.friction`, 0, 10),
      ...(mesh ? { mesh } : {}),
    };
  });
  if (meshSamples > MAX_LIQUID_MESH_SAMPLES)
    throw liquidError(`GPULiquid mesh colliders hold ${meshSamples} distance samples, over ${MAX_LIQUID_MESH_SAMPLES}; bake them at a lower resolution`);
  const d = options.debug ?? {};
  if (!d || typeof d !== 'object') throw liquidError('GPULiquid debug must be an object');
  for (const key of ['enabled', 'grid', 'container', 'colliders'] as const)
    if (d[key] !== undefined && typeof d[key] !== 'boolean') throw liquidError(`GPULiquid debug.${key} must be true or false`);
  const mode = d.particles ?? 'speed';
  if (mode !== 'speed' && mode !== 'density' && mode !== 'color' && mode !== 'off')
    throw liquidError(`GPULiquid debug.particles must be 'speed', 'density', 'color' or 'off', not ${String(mode)}`);
  const debug: Required<LiquidDebugOptions> = {
    enabled: d.enabled ?? false,
    particles: mode,
    speedScale: num(d.speedScale, Math.max(0.1, Math.sqrt(2 * g * size[1]!)), 'debug.speedScale', 1e-6, 1e6),
    grid: d.grid ?? true,
    container: d.container ?? true,
    colliders: d.colliders ?? true,
  };
  return {
    count,
    boxMin: container.min,
    boxMax: container.max,
    fillMin: blocks[0]!.fillMin,
    fillMax: blocks[0]!.fillMax,
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
    surfaceTension,
    adhesion,
    kinds,
    mixing,
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

/**
 * The start state: each liquid's block on its lattice, every particle within a quarter spacing of its site, at rest,
 * with its liquid's index and colour.
 */
export function createLiquidState(params: ResolvedLiquidParams): LiquidState {
  const { count, boxMin, boxMax } = params;
  const particles = new Float32Array(count * LIQUID_PARTICLE_FLOATS);
  params.kinds.forEach((k, kind) => {
    const { fillMin, fillMax, lattice } = k;
    const nx = Math.max(1, Math.round((fillMax[0] - fillMin[0]) / lattice[0]));
    const nz = Math.max(1, Math.round((fillMax[2] - fillMin[2]) / lattice[2]));
    for (let j = 0; j < k.count; j++) {
      const i = k.start + j;
      const ix = j % nx,
        iz = Math.floor(j / nx) % nz,
        iy = Math.floor(j / (nx * nz));
      const site = [ix + 0.5, iy + 0.5, iz + 0.5];
      const b = i * LIQUID_PARTICLE_FLOATS;
      for (let a = 0; a < 3; a++) {
        const jitter = (pcg(params.seed * 3 + a + 3 * i * 0x9e37) / 4294967296 - 0.5) * 0.5;
        const x = fillMin[a]! + (site[a]! + jitter) * lattice[a]!;
        particles[b + a] = Math.min(boxMax[a]!, Math.max(boxMin[a]!, x));
      }
      particles[b + 3] = 1;
      particles[b + 7] = kind;
      particles.set(k.color, b + LIQUID_COLOR_OFFSET);
    }
  });
  return {
    particles,
    impulses: new Float64Array(MAX_LIQUID_COLLIDERS * 6),
    grid: new Float64Array(params.nodes * LIQUID_GRID_STRIDE),
  };
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

/** Checks a mesh field from {@link bakeLiquidMesh} (or one built the same way) and returns it. */
function checkMeshShape(m: unknown, name: string): LiquidMeshShape {
  const shape = m as LiquidMeshShape;
  if (!m || typeof m !== 'object' || !(shape.distances instanceof Float32Array))
    throw liquidError(`GPULiquid ${name} must be a field from bakeLiquidMesh(positions, indices)`);
  const n = shape.resolution;
  if (!Number.isInteger(n) || n < 2 || n > 64 || shape.distances.length !== n * n * n)
    throw liquidError(`GPULiquid ${name}.resolution must be an integer 2 to 64 with resolution³ distances`);
  vec(shape.center, [0, 0, 0], `${name}.center`);
  vec(shape.half, [1, 1, 1], `${name}.half`, 1e-6, 1e6);
  for (let i = 0; i < shape.distances.length; i++)
    if (!Number.isFinite(shape.distances[i])) throw liquidError(`GPULiquid ${name}.distances[${i}] is not finite`);
  return shape;
}

/** Closest point to p on the triangle abc (Ericson 2005, Real-Time Collision Detection, 5.1.5), as its squared distance. */
function triangleDistance2(p: number[], t: ArrayLike<number>, o: number): number {
  const ax = t[o]!, ay = t[o + 1]!, az = t[o + 2]!;
  const abx = t[o + 3]! - ax, aby = t[o + 4]! - ay, abz = t[o + 5]! - az;
  const acx = t[o + 6]! - ax, acy = t[o + 7]! - ay, acz = t[o + 8]! - az;
  const apx = p[0]! - ax, apy = p[1]! - ay, apz = p[2]! - az;
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  let u: number, v: number;
  const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  const va = d3 * d6 - d5 * d4,
    vb = d5 * d2 - d1 * d6,
    vc = d1 * d4 - d3 * d2;
  if (d1 <= 0 && d2 <= 0) (u = 0), (v = 0);
  else if (d3 >= 0 && d4 <= d3) (u = 1), (v = 0);
  else if (d6 >= 0 && d5 <= d6) (u = 0), (v = 1);
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) (u = d1 / (d1 - d3)), (v = 0);
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) (u = 0), (v = d2 / (d2 - d6));
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    (u = 1 - w), (v = w);
  } else {
    const denom = 1 / (va + vb + vc);
    (u = vb * denom), (v = vc * denom);
  }
  const ex = apx - u * abx - v * acx,
    ey = apy - u * aby - v * acy,
    ez = apz - u * abz - v * acz;
  return ex * ex + ey * ey + ez * ez;
}

/**
 * The solid angle the triangle abc spans seen from p (Van Oosterom and Strackee 1983); summed over a mesh and divided by
 * 4 pi it is the generalized winding number (Jacobson et al. 2013), 1 inside a closed mesh and 0 outside, and about the
 * same for a mesh with small holes.
 */
function solidAngle(p: number[], t: ArrayLike<number>, o: number): number {
  const ax = t[o]! - p[0]!, ay = t[o + 1]! - p[1]!, az = t[o + 2]! - p[2]!;
  const bx = t[o + 3]! - p[0]!, by = t[o + 4]! - p[1]!, bz = t[o + 5]! - p[2]!;
  const cx = t[o + 6]! - p[0]!, cy = t[o + 7]! - p[1]!, cz = t[o + 8]! - p[2]!;
  const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
  const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  const div = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb + (bx * cx + by * cy + bz * cz) * la;
  return 2 * Math.atan2(det, div);
}

/** Options of {@link bakeLiquidMesh}. */
export interface LiquidMeshBakeOptions {
  /** Samples per axis of the field, integer 2..64. Default 32. */
  resolution?: number;
  /** Room round the mesh's bounds on every side, in world units, >= 0. Default 2 / resolution of the longest side. */
  margin?: number;
}

/**
 * Bakes a closed triangle mesh (positions [x, y, z, ...] in its own frame, and triangle indices, or none for a triangle
 * soup) into the signed distance field a `'mesh'` collider uses: the distance to the nearest triangle (Ericson 2005),
 * negative where the generalized winding number (Jacobson et al. 2013) is above one half in size, so either winding of the
 * triangles works. The work is resolution³ times
 * the triangle count, at most {@link MAX_LIQUID_MESH_WORK}; simplify the mesh or lower the resolution past that.
 */
export function bakeLiquidMesh(
  positions: ArrayLike<number>,
  indices?: ArrayLike<number> | null,
  options: LiquidMeshBakeOptions = {},
): LiquidMeshShape {
  if (!positions || typeof positions.length !== 'number' || positions.length < 9 || positions.length % 3 !== 0)
    throw liquidError('bakeLiquidMesh positions must be [x, y, z, ...] of at least three vertices');
  const verts = positions.length / 3;
  for (let i = 0; i < positions.length; i++)
    if (typeof positions[i] !== 'number' || !Number.isFinite(positions[i]))
      throw liquidError(`bakeLiquidMesh positions[${i}] is not a finite number`);
  const index = indices ?? Array.from({ length: verts }, (_, i) => i);
  if (typeof index.length !== 'number' || index.length < 3 || index.length % 3 !== 0)
    throw liquidError('bakeLiquidMesh indices must be three a triangle');
  const tris = index.length / 3;
  const corners = new Float64Array(tris * 9);
  for (let i = 0; i < index.length; i++) {
    const v = index[i]!;
    if (!Number.isInteger(v) || v < 0 || v >= verts) throw liquidError(`bakeLiquidMesh indices[${i}] is not a vertex`);
    corners.set([positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!], i * 3);
  }
  if (!options || typeof options !== 'object') throw liquidError('bakeLiquidMesh options must be an object');
  const n = num(options.resolution, 32, 'bakeLiquidMesh resolution', 2, 64, true);
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < corners.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, corners[i + a]!);
      hi[a] = Math.max(hi[a]!, corners[i + a]!);
    }
  const longest = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  if (!(longest > 0)) throw liquidError('bakeLiquidMesh positions span no volume');
  const margin = num(options.margin, (2 * longest) / n, 'bakeLiquidMesh margin', 0, 1e6);
  if (n ** 3 * tris > MAX_LIQUID_MESH_WORK)
    throw liquidError(
      `bakeLiquidMesh would test ${n ** 3 * tris} triangle-sample pairs, over ${MAX_LIQUID_MESH_WORK}; simplify the mesh to ${Math.floor(MAX_LIQUID_MESH_WORK / n ** 3)} triangles or lower the resolution`,
    );
  const center: LiquidVec3 = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
  const half: LiquidVec3 = [0, 1, 2].map((a) => Math.max((hi[a]! - lo[a]!) / 2 + margin, 1e-6)) as unknown as LiquidVec3;
  const distances = new Float32Array(n ** 3);
  const p = [0, 0, 0];
  for (let k = 0, i = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let l = 0; l < n; l++, i++) {
        p[0] = center[0] - half[0] + (2 * half[0] * l) / (n - 1);
        p[1] = center[1] - half[1] + (2 * half[1] * j) / (n - 1);
        p[2] = center[2] - half[2] + (2 * half[2] * k) / (n - 1);
        let best = Infinity,
          winding = 0;
        for (let t = 0; t < tris; t++) {
          best = Math.min(best, triangleDistance2(p, corners, t * 9));
          winding += solidAngle(p, corners, t * 9);
        }
        const d = Math.sqrt(best);
        distances[i] = Math.abs(winding) / (4 * Math.PI) > 0.5 ? -d : d;
      }
  return { resolution: n, center, half, distances };
}

/** The trilinear sample of a mesh field at local point (x, y, z) clamped into its box, plus the distance to the box. */
function meshSample(m: LiquidMeshShape, x: number, y: number, z: number): number {
  const n = m.resolution;
  const l = [x - m.center[0], y - m.center[1], z - m.center[2]];
  let outside = 0;
  const g = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const q = Math.min(m.half[a]!, Math.max(-m.half[a]!, l[a]!));
    outside += (l[a]! - q) ** 2;
    g[a] = ((q + m.half[a]!) / (2 * m.half[a]!)) * (n - 1);
  }
  const i0 = g.map((v) => Math.min(n - 2, Math.floor(v)));
  const f = g.map((v, a) => v - i0[a]!);
  const at = (i: number, j: number, k: number) => m.distances[i0[0]! + i + n * (i0[1]! + j + n * (i0[2]! + k))]!;
  let v = 0;
  for (let k = 0; k < 2; k++)
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++)
        v += (i ? f[0]! : 1 - f[0]!) * (j ? f[1]! : 1 - f[1]!) * (k ? f[2]! : 1 - f[2]!) * at(i, j, k);
  return v + Math.sqrt(outside);
}

/** Signed distance from `x` to collider `c` and the outward normal there. */
export function colliderDistance(c: ResolvedCollider, x: LiquidVec3, normal: number[]): number {
  const dx = x[0] - c.position[0],
    dy = x[1] - c.position[1],
    dz = x[2] - c.position[2];
  if (c.kind === 3) {
    normal[0] = c.half[0];
    normal[1] = c.half[1];
    normal[2] = c.half[2];
    return dx * c.half[0] + dy * c.half[1] + dz * c.half[2];
  }
  if (c.kind === 2 || c.kind === 4) {
    const [qx, qy, qz, qw] = c.rotation;
    const [lx, ly, lz] = rotate(-qx, -qy, -qz, qw, dx, dy, dz);
    let d: number, nx: number, ny: number, nz: number;
    if (c.kind === 2) {
      const py = ly - Math.min(c.half[1], Math.max(-c.half[1], ly));
      const l = Math.hypot(lx, py, lz);
      [nx, ny, nz] = l > 0 ? [lx / l, py / l, lz / l] : [1, 0, 0];
      d = l - c.half[0];
    } else {
      // The field's gradient by central differences half a sample apart.
      const m = c.mesh!;
      const e = m.half.map((h) => h / (m.resolution - 1));
      d = meshSample(m, lx, ly, lz);
      nx = meshSample(m, lx + e[0]!, ly, lz) - meshSample(m, lx - e[0]!, ly, lz);
      ny = meshSample(m, lx, ly + e[1]!, lz) - meshSample(m, lx, ly - e[1]!, lz);
      nz = meshSample(m, lx, ly, lz + e[2]!) - meshSample(m, lx, ly, lz - e[2]!);
      const l = Math.hypot(nx, ny, nz);
      [nx, ny, nz] = l > 0 ? [nx / l, ny / l, nz / l] : [0, 1, 0];
    }
    const w = rotate(qx, qy, qz, qw, nx, ny, nz);
    normal[0] = w[0];
    normal[1] = w[1];
    normal[2] = w[2];
    return d;
  }
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
/** c at node (ix, iy, iz): its mass with the wall mirrors, plus the colliders' cover, over the rest density. */
function surfaceColor(p: ResolvedLiquidParams, grid: Float64Array, ix: number, iy: number, iz: number, scratch: number[][]): number {
  const [mx, my, mz, x, normal] = scratch as [number[], number[], number[], [number, number, number], number[]];
  const [nx, ny] = p.dims;
  const kx = wallMirrors(p, 0, ix, mx),
    ky = wallMirrors(p, 1, iy, my),
    kz = wallMirrors(p, 2, iz, mz);
  let m = 0;
  for (let z = 0; z < kz; z++)
    for (let y = 0; y < ky; y++) for (let k = 0; k < kx; k++) m += grid[(mx[k]! + nx * (my[y]! + ny * mz[z]!)) * LIQUID_GRID_STRIDE]!;
  let ghost = 0;
  if (p.colliders.length) {
    x[0] = p.origin[0] + ix * p.cell[0];
    x[1] = p.origin[1] + iy * p.cell[1];
    x[2] = p.origin[2] + iz * p.cell[2];
    const hc = Math.cbrt(p.cell[0] * p.cell[1] * p.cell[2]);
    for (const c of p.colliders) ghost += splineCover(-colliderDistance(c, x, normal) / hc);
  }
  return m / LIQUID_FIXED / p.restDensity + ghost;
}

/**
 * The gradient of c at every node of the grid (before its update) and its length, by central differences of c, the
 * density over rest density with the walls mirrored and the colliders read as liquid at rest (one-sided at the grid's
 * edge), four floats a node; `grid` holds the fixed-point sums of the particle-to-grid passes.
 */
export function liquidSurfaceNormals(p: ResolvedLiquidParams, grid: Float64Array): Float64Array {
  const [nx, ny, nz] = p.dims;
  const scratch = [[0, 0], [0, 0], [0, 0], [0, 0, 0], [0, 0, 0]];
  const color = new Float64Array(p.nodes);
  for (let iz = 0, n = 0; iz < nz; iz++)
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++, n++) color[n] = surfaceColor(p, grid, ix, iy, iz, scratch);
  const out = new Float64Array(p.nodes * 4);
  for (let iz = 0, n = 0; iz < nz; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++, n++) {
        const i = [ix, iy, iz];
        const g = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
          const up = [...i],
            dn = [...i];
          up[a] = Math.min(p.dims[a]! - 1, i[a]! + 1);
          dn[a] = Math.max(0, i[a]! - 1);
          const at = (v: number[]) => color[v[0]! + nx * (v[1]! + ny * v[2]!)]!;
          g[a] = (at(up) - at(dn)) / ((up[a]! - dn[a]!) * p.cell[a]!);
        }
        out[n * 4] = Math.fround(g[0]!);
        out[n * 4 + 1] = Math.fround(g[1]!);
        out[n * 4 + 2] = Math.fround(g[2]!);
        out[n * 4 + 3] = Math.fround(Math.hypot(g[0]!, g[1]!, g[2]!));
      }
  return out;
}

/**
 * div T / sigma at node (ix, iy, iz) into `out`, by central differences (one-sided at the grid's edge) of column j of
 * T / sigma = |g| I - g g^T / |g| at the neighbours along j.
 */
function surfaceForce(p: ResolvedLiquidParams, surf: Float64Array, ix: number, iy: number, iz: number, out: number[]): void {
  const [nx, ny] = p.dims;
  const i = [ix, iy, iz];
  out[0] = out[1] = out[2] = 0;
  for (let j = 0; j < 3; j++) {
    const up = [...i],
      dn = [...i];
    up[j] = Math.min(p.dims[j]! - 1, i[j]! + 1);
    dn[j] = Math.max(0, i[j]! - 1);
    const span = (up[j]! - dn[j]!) * p.cell[j]!;
    for (const [v, sign] of [
      [up, 1],
      [dn, -1],
    ] as const) {
      const o = (v[0]! + nx * (v[1]! + ny * v[2]!)) * 4;
      const l = surf[o + 3]!;
      if (!(l > 0)) continue;
      const k = surf[o + j]! / l;
      for (let r = 0; r < 3; r++) out[r] = out[r]! + (sign * ((r === j ? l : 0) - surf[o + r]! * k)) / span;
    }
  }
}

/** A node under this share of rest density takes the surface force as one at it. */
export const LIQUID_TENSION_FLOOR = 0.25;

/** Cells from a wall or collider that adhesion reaches. */
export const LIQUID_ADHESION_REACH = 2;

/**
 * The adhesion profile: 1 within half the reach of a surface, falling smoothly (a cubic Hermite step) to 0 at the
 * reach. Akinci et al. (2013) pull liquid towards a boundary the same way but leave the band next to it at zero, so
 * SPH particles are not drawn into the boundary's particles; here the walls and colliders are hard constraints on the
 * grid, and the nodes next to them, a whole cell apart, are the ones that must hold the liquid, so the profile is full
 * there.
 */
export function adhesionKernel(d: number, reach: number): number {
  if (d >= reach) return 0;
  if (d <= reach / 2) return 1;
  const t = (d - reach / 2) / (reach / 2);
  return (1 - t) * (1 - t) * (1 + 2 * t);
}

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
  const G = LIQUID_GRID_STRIDE;
  const mixing = p.mixing ? 1 - Math.exp(-p.mixing * dt) : 0;
  const w = new Float64Array(12);
  const base = [0, 0, 0];
  const d = [0, 0, 0];
  const kd = [0, 0, 0];
  const mx = [0, 0],
    my = [0, 0],
    mz = [0, 0];
  const at = (ix: number, iy: number, iz: number) => (ix + nx * (iy + ny * iz)) * G;
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

  // P2G: weight n_i += w (the number density), mass m_i += w m_p and APIC momentum (m v)_i += w m_p (v + C d), in units
  // of particleMass; the colour sums when the colours mix.
  for (let i = 0; i < p.count; i++) {
    const b = i * F;
    const mr = p.kinds[particles[b + 7]!]!.massRatio;
    for (let a = 0; a < 3; a++) base[a] = stencil(p, particles[b + a]!, a, w, a * 4);
    for (let c = 0; c < 3; c++)
      for (let bb = 0; bb < 3; bb++)
        for (let aa = 0; aa < 3; aa++) {
          const weight = w[aa]! * w[4 + bb]! * w[8 + c]!;
          offsets(aa, bb, c);
          const node = at(base[0]! + aa, base[1]! + bb, base[2]! + c);
          grid[node] += fixed(weight, S);
          grid[node + 1] += fixed(weight * mr, S);
          for (let r = 0; r < 3; r++) {
            const row = b + 8 + r * 3;
            const cd = particles[row]! * d[0]! + particles[row + 1]! * d[1]! + particles[row + 2]! * d[2]!;
            grid[node + 2 + r] += fixed(weight * mr * (particles[b + 4 + r]! + cd), S);
            if (mixing) grid[node + 5 + r] += fixed(weight * particles[b + LIQUID_COLOR_OFFSET + r]!, S);
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
    // Each liquid's Tait pressure on the shared number density (Solenthaler and Pajarola 2008) and its own viscosity.
    const kind = p.kinds[particles[b + 7]!]!;
    const pc = capped > 1 ? (kind.massRatio * kp * (capped ** LIQUID_GAMMA - 1)) / capped : 0;
    const kv = dt * kind.viscosity * kind.massRatio;
    for (let c = 0; c < 3; c++)
      for (let bb = 0; bb < 3; bb++)
        for (let aa = 0; aa < 3; aa++) {
          const weight = w[aa]! * w[4 + bb]! * w[8 + c]!;
          offsets(aa, bb, c);
          const node = at(base[0]! + aa, base[1]! + bb, base[2]! + c);
          for (let r = 0; r < 3; r++) {
            // (C + C^T) kd, row r: C[r] . kd plus column r of C . kd.
            const row = b + 8 + r * 3;
            const cd = particles[row]! * kd[0]! + particles[row + 1]! * kd[1]! + particles[row + 2]! * kd[2]!;
            const ctd = particles[b + 8 + r]! * kd[0]! + particles[b + 11 + r]! * kd[1]! + particles[b + 14 + r]! * kd[2]!;
            grid[node + 2 + r] += fixed(weight * (pc * kd[r]! - kv * (cd + ctd)), S);
          }
        }
  }

  // Surface tension: per node the gradient of c, the density over rest density with the walls mirrored and the
  // colliders read as liquid at rest (as in the stress pass), by central differences.
  const surf = p.surfaceTension ? liquidSurfaceNormals(p, grid) : undefined;
  const ks = (dt * p.surfaceTension) / p.density;
  const f3 = [0, 0, 0];

  // Grid update: velocity, gravity, surface tension, the pointer, adhesion, the speed limit, the colliders, the walls.
  const vmax = p.cellSize / dt;
  const pointer = p.pointer;
  const lo = LIQUID_PAD;
  for (let iz = 0, node = 0; iz < p.dims[2]; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++, node += G) {
        const mf = grid[node + 1]!;
        if (mf <= 0) {
          grid.fill(0, node, node + G);
          continue;
        }
        const m = mf / S;
        const count = grid[node]! / S;
        let vx = grid[node + 2]! / S / m + p.gravity[0] * dt,
          vy = grid[node + 3]! / S / m + p.gravity[1] * dt,
          vz = grid[node + 4]! / S / m + p.gravity[2] * dt;
        x[0] = p.origin[0] + ix * cell[0];
        x[1] = p.origin[1] + iy * cell[1];
        x[2] = p.origin[2] + iz * cell[2];
        if (surf) {
          // The continuum surface force in its conservative form (Lafaurie et al. 1994): f = div T with the capillary
          // tensor T = sigma (|grad c| I - grad c grad c^T / |grad c|), which equals sigma kappa grad c (Brackbill et al.
          // 1992) but needs no unit normal where |grad c| is small. The acceleration is f / rho at the node, so the
          // force's integral across the surface is the Laplace jump; a node under LIQUID_TENSION_FLOOR of rest density
          // (the far edge of the particles' spread) is pushed as one at that density, so near-empty nodes are not flung.
          surfaceForce(p, surf, ix, iy, iz, f3);
          const cw = 1 / (Math.max(count / p.restDensity, LIQUID_TENSION_FLOOR) * (m / Math.max(count, 1e-30)));
          vx += ks * cw * f3[0]!;
          vy += ks * cw * f3[1]!;
          vz += ks * cw * f3[2]!;
        }
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
        // Adhesion: liquid one to two cells from a wall is pulled towards it.
        if (p.adhesion) {
          const reach = LIQUID_ADHESION_REACH * p.cellSize;
          for (let a = 0; a < 3; a++) {
            const pull = p.adhesion * dt * (adhesionKernel(x[a]! - p.boxMin[a]!, reach) - adhesionKernel(p.boxMax[a]! - x[a]!, reach));
            if (a === 0) vx -= pull;
            else if (a === 1) vy -= pull;
            else vz -= pull;
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
          const sd = colliderDistance(c, x, normal);
          if (p.adhesion && sd > 0) {
            // Adhesion to the collider: the liquid is pulled in along -n and the body takes the opposite pull.
            const a = p.adhesion * dt * adhesionKernel(sd, LIQUID_ADHESION_REACH * p.cellSize);
            if (a > 0) {
              vx -= a * normal[0]!;
              vy -= a * normal[1]!;
              vz -= a * normal[2]!;
              const rx = x[0] - c.position[0],
                ry = x[1] - c.position[1],
                rz = x[2] - c.position[2];
              const jx = m * a * normal[0]!,
                jy = m * a * normal[1]!,
                jz = m * a * normal[2]!;
              const o = k * 6,
                FS = LIQUID_FORCE_FIXED;
              impulses[o] += fixed(jx, FS);
              impulses[o + 1] += fixed(jy, FS);
              impulses[o + 2] += fixed(jz, FS);
              impulses[o + 3] += fixed(ry * jz - rz * jy, FS);
              impulses[o + 4] += fixed(rz * jx - rx * jz, FS);
              impulses[o + 5] += fixed(rx * jy - ry * jx, FS);
            }
          }
          if (sd >= 0) continue;
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
        grid[node] = Math.fround(vx);
        grid[node + 1] = Math.fround(vy);
        grid[node + 2] = Math.fround(vz);
        grid[node + 3] = m;
        grid[node + 4] = count;
      }

  // G2P: velocity and APIC C = sum w v (D^-1 d)^T, advect, out of the colliders, inside the walls.
  for (let i = 0; i < p.count; i++) {
    const b = i * F;
    for (let a = 0; a < 3; a++) base[a] = stencil(p, particles[b + a]!, a, w, a * 4);
    let vx = 0,
      vy = 0,
      vz = 0;
    const B = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const tint = [0, 0, 0];
    let around = 0;
    for (let c = 0; c < 3; c++)
      for (let bb = 0; bb < 3; bb++)
        for (let aa = 0; aa < 3; aa++) {
          const weight = w[aa]! * w[4 + bb]! * w[8 + c]!;
          offsets(aa, bb, c);
          const node = at(base[0]! + aa, base[1]! + bb, base[2]! + c);
          const gx = grid[node]!,
            gy = grid[node + 1]!,
            gz = grid[node + 2]!;
          if (mixing) {
            around += weight * grid[node + 4]!;
            for (let r = 0; r < 3; r++) tint[r] = tint[r]! + (weight * grid[node + 5 + r]!) / S;
          }
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
      const mr = p.kinds[particles[b + 7]!]!.massRatio;
      const jx = mr * vn * normal[0]!,
        jy = mr * vn * normal[1]!,
        jz = mr * vn * normal[2]!;
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
      particles[b + 8 + a * 3] = B[a * 3]!;
      particles[b + 9 + a * 3] = B[a * 3 + 1]!;
      particles[b + 10 + a * 3] = B[a * 3 + 2]!;
      // Mixing: the colour relaxes towards the weighted mean colour of the liquid round it.
      if (mixing && around > 0) {
        const o = b + LIQUID_COLOR_OFFSET + a;
        particles[o] = particles[o]! + (tint[a]! / around - particles[o]!) * mixing;
      }
    }
  }
}
