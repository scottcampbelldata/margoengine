// The flock's model, options and CPU twin (`@margoengine/vfx/flocking`). The WebGPU solver in flocking-shaders.ts runs
// the same steps in the same order in f32; this file is the reference for the tests and the WebGL2 layer's route.
// Sources: docs/clean-room.md, "GPU flocking".
import { parseColor, type ColorInput } from '@margoengine/math/color';
import { MargoError } from '@margoengine/math/errors';
import { createRandom } from '@margoengine/math/mathutils';

/** Maximum boid count accepted by `GPUFlock`. */
export const MAX_FLOCK_BOIDS = 262_144;
/** Maximum live attractors supported per flock. */
export const MAX_FLOCK_ATTRACTORS = 16;
/** Maximum live predators supported per flock. */
export const MAX_FLOCK_PREDATORS = 16;
/** Maximum live sphere obstacles supported per flock. */
export const MAX_FLOCK_OBSTACLES = 32;
/** Maximum triangles accepted for a custom boid mesh. */
export const MAX_FLOCK_MESH_TRIANGLES = 16_384;
/** Longest single integration step in seconds; a longer `dt` is split into equal steps no longer than this. */
export const FLOCK_MAX_SUBSTEP = 0.05;
/** Longest `dt` one `step` call or `stepFlockCPU` call takes, in seconds. */
export const FLOCK_MAX_STEP = 1;
/** Floats per boid in a state or snapshot: x, y, z, animation phase, vx, vy, vz, bank angle. */
export const FLOCK_BOID_FLOATS = 8;

/** 3D vector tuple. */
export type FlockVec3 = readonly [number, number, number];

/** Built-in visual and locomotion preset for a flock. */
export type FlockPreset = 'bird' | 'fish';

/** Axis-aligned box or sphere domain that contains the flock. */
export type FlockBounds =
  | {
      shape: 'box';
      /** Center of the box in world units. Default `[0, 0, 0]`. */
      center?: FlockVec3;
      /** Positive half-extents `[hx, hy, hz]` in world units. */
      halfSize: FlockVec3;
    }
  | {
      shape: 'sphere';
      /** Center of the sphere in world units. Default `[0, 0, 0]`. */
      center?: FlockVec3;
      /** Positive sphere radius in world units. */
      radius: number;
    };

/** Point attractor that draws nearby boids toward a target position. */
export interface FlockAttractor {
  /** World-space position of the attractor. */
  position: FlockVec3;
  /** Steering pull weight, `>= 0`. Default `2.5`. */
  strength?: number;
  /** Influence radius in world units, `>= 0` (`0` means infinite range). Default `0`. */
  radius?: number;
}

/** Moving or static predator (or the pointer) that boids flee from within its radius. */
export interface FlockPredator {
  /** World-space position of the predator. */
  position: FlockVec3;
  /** Detection and flee radius in world units, `> 0`. Default `6`. */
  radius?: number;
  /** Flee acceleration weight, `>= 0`. Default `12`. */
  strength?: number;
}

/** Sphere obstacle that boids steer around and bounce off. */
export interface FlockObstacle {
  /** World-space center of the sphere obstacle. */
  position: FlockVec3;
  /** Positive sphere radius in world units. */
  radius: number;
  /** Avoidance steering weight, `>= 0`. Default `8`. */
  strength?: number;
}

/** Custom triangle mesh for instanced boid rendering (`+Z` forward, `+Y` up, `+X` right). */
export interface FlockGeometry {
  /** Flat xyz vertex positions. */
  positions: ArrayLike<number>;
  /** Optional flat xyz vertex normals (face normals when omitted). */
  normals?: ArrayLike<number>;
  /** Optional triangle index list. */
  indices?: ArrayLike<number>;
  /** Optional per-vertex animation weight in `0..1` driving wing-flap or tail-swim displacement. */
  weights?: ArrayLike<number>;
}

/**
 * An interleaved mesh, six floats a vertex (x, y, z, nx, ny, nz) and triangle indices: the layout of a core
 * `Geometry`, so `model.meshes[i].geometry` of a loaded glTF passes as it is.
 */
export interface FlockInterleavedGeometry {
  /** Six floats a vertex: position then normal. */
  readonly vertices: ArrayLike<number>;
  /** Triangle indices into the vertices. */
  readonly indices: ArrayLike<number>;
}

/** Built-in debug overlay settings for a `GPUFlock`. */
export interface FlockDebugOptions {
  /** Enable or disable the debug overlay. Default `false`. */
  enabled?: boolean;
  /** Draw a velocity line on every boid, coloured from slow (blue) to fast (red). Default `true`. */
  velocities?: boolean;
  /** Draw the flock's bounds and the inspected boid's grid cell and its 3 x 3 x 3 neighbourhood. Default `true`. */
  grid?: boolean;
  /** Draw the inspected boid's separation sphere and its neighbour radius as a vision cone. Default `true`. */
  perception?: boolean;
  /** Draw the inspected boid's velocity and its separation, alignment, cohesion and predator steering. Default `true`. */
  vectors?: boolean;
  /** Zero-based index of the inspected boid. Default `0`. */
  selectedIndex?: number;
}

/** Configuration options for `GPUFlock`. Every option except `count` can change between frames. */
export interface GPUFlockOptions {
  /** Number of boids in the flock, integer `1..262,144`. Fixed at attach. Default `4096`. */
  count?: number;
  /** PRNG seed for the starting positions, velocities and phases, a 32-bit integer. Default `1337`. */
  seed?: number;
  /** Visual and animation preset: `'bird'` (wing flap + banking) or `'fish'` (sinusoidal tail swim). Default `'bird'`. */
  preset?: FlockPreset;
  /** Optional custom mesh overriding the built-in bird or fish mesh (a glTF mesh's `geometry` passes). Default `null`. */
  geometry?: FlockGeometry | FlockInterleavedGeometry | null;
  /** Containment domain (`box` or `sphere`). Default box `halfSize: [18, 10, 18]` centered at origin. */
  bounds?: FlockBounds;
  /** Soft steering margin inside the domain boundary in world units, `>= 0`. Default `3`. */
  boundsMargin?: number;
  /** Inward turn-back strength near the domain boundary, `>= 0`. Default `6`. */
  boundsStrength?: number;
  /** Separation rule weight (Reynolds 1987, collision avoidance), `>= 0`. Default `1.8`. */
  separation?: number;
  /** Alignment rule weight (Reynolds 1987, velocity matching), `>= 0`. Default `1.1`. */
  alignment?: number;
  /** Cohesion rule weight (Reynolds 1987, flock centering), `>= 0`. Default `1`. */
  cohesion?: number;
  /** Perception radius for alignment and cohesion in world units, `> 0`. Default `2.6`. */
  neighborRadius?: number;
  /** Repulsion radius for separation in world units, `> 0`. Default `1.1`. */
  separationRadius?: number;
  /** Full forward vision cone angle in radians `[0.05, 2*PI]`; neighbours behind it are not seen. Default `1.5 * PI`. */
  visionAngle?: number;
  /**
   * Most neighbours a boid steers by, integer `1..128`, taken in grid order (cell by cell, lowest index first in a cell);
   * it bounds the work a boid does in a dense crowd. Default `24`.
   */
  maxNeighbors?: number;
  /** Minimum cruising speed in world units per second, `> 0`. Default `4`. */
  minSpeed?: number;
  /** Maximum cruising speed in world units per second, `>= minSpeed`. Default `10`. */
  maxSpeed?: number;
  /** Maximum flocking steering acceleration in world units per second squared, `> 0`. Default `14`. */
  maxForce?: number;
  /** Maximum lateral (centripetal) turning acceleration in world units per second squared, `> 0`. Default `12`. */
  maxTurnAccel?: number;
  /** Up to 16 live attractors read each frame. Default `[]`. */
  attractors?: readonly FlockAttractor[];
  /** Up to 16 live predators read each frame (a pointer is a predator at its world position). Default `[]`. */
  predators?: readonly FlockPredator[];
  /** Up to 32 live sphere obstacles read each frame. Default `[]`. */
  obstacles?: readonly FlockObstacle[];
  /** Uniform mesh scale per boid, `> 0` (the mesh is scaled so its farthest vertex is 1 first). Default `0.42`. */
  scale?: number;
  /** Banking roll sensitivity to lateral turn acceleration, `>= 0`. Default `0.55`. */
  bankStrength?: number;
  /** Base wing-flap or tail-swim frequency in Hz, `>= 0`. Default `5.5` (bird) or `7` (fish). */
  flapFrequency?: number;
  /** Wing-flap or tail-swim vertex displacement amplitude, `>= 0`. Default `0.45`. */
  flapAmplitude?: number;
  /** Primary boid body color (linear RGB or hex). Default `'#e8eef8'` (bird) or `'#38c6e8'` (fish). */
  color?: ColorInput;
  /** Secondary wingtip/fin accent color varied across boids. Default `'#4c7cc2'` (bird) or `'#f0a83c'` (fish). */
  accentColor?: ColorInput;
  /** World-space direction toward the key directional light (non-zero). Default `[0.45, 1, 0.35]`. */
  lightDirection?: FlockVec3;
  /** Directional light color (linear RGB or hex). Default `[1, 1, 1]`. */
  lightColor?: ColorInput;
  /** Hemisphere ambient floor in `0..1`. Default `0.38`. */
  ambient?: number;
  /** Pause frame-driven integration while keeping rendering active (`step(dt)` still runs). Default `false`. */
  paused?: boolean;
  /** Initial debug overlay settings. */
  debug?: FlockDebugOptions;
}

/** Live statistics of a `GPUFlock`. */
export interface FlockStats {
  /** Active boid count. */
  count: number;
  /** Where the flock steps: `'webgpu'` compute, or `'webgl2-compat'`, the CPU twin on the WebGL2 layer. */
  backend: 'webgpu' | 'webgl2-compat';
  /** Draw calls submitted in the last rendered frame. */
  drawCalls: number;
  /** Number of uniform-grid hash buckets in use. */
  gridCells: number;
  /** Integration steps run since attach, reset or restore (a long `dt` counts each of its equal steps). */
  steps: number;
  /** Whether the debug overlay is currently enabled. */
  debugEnabled: boolean;
}

/** Normalized parameters after validation and defaulting. */
export interface ResolvedFlockParams {
  count: number;
  seed: number;
  preset: FlockPreset;
  boundsShape: 0 | 1;
  boundsCenter: [number, number, number];
  boundsHalf: [number, number, number];
  boundsRadius: number;
  boundsMargin: number;
  boundsStrength: number;
  separation: number;
  alignment: number;
  cohesion: number;
  neighborRadius: number;
  separationRadius: number;
  visionAngle: number;
  cosHalfVision: number;
  maxNeighbors: number;
  minSpeed: number;
  maxSpeed: number;
  maxForce: number;
  maxTurnAccel: number;
  scale: number;
  bankStrength: number;
  flapFrequency: number;
  flapAmplitude: number;
  color: [number, number, number];
  accentColor: [number, number, number];
  lightDirection: [number, number, number];
  lightColor: [number, number, number];
  ambient: number;
  paused: boolean;
  attractors: readonly FlockAttractor[];
  predators: readonly FlockPredator[];
  obstacles: readonly FlockObstacle[];
  debug: Required<FlockDebugOptions>;
}

/** CPU-side simulation state, for tests and the WebGL2 compatibility layer's route. */
export interface FlockSimulationState {
  /** Number of boids. */
  readonly count: number;
  /** Eight floats a boid: x, y, z, animation phase, vx, vy, vz, bank angle (length `count * 8`). */
  readonly boids: Float32Array;
  /** Eight `vec4f` records for the inspected boid, the debug overlay's input (length `32`). */
  readonly debugData: Float32Array;
  /** Scratch buffers reused by every step. */
  readonly scratch: {
    next: Float32Array;
    cellCounts: Uint32Array;
    cellOffsets: Uint32Array;
    cellCursor: Uint32Array;
    boidCell: Uint32Array;
    sortedIdx: Uint32Array;
    seen: Uint32Array;
    gridCells: number;
  };
}

/** A copy of a flock's state that `restore` takes back. */
export interface FlockSnapshot {
  /** Number of boids. */
  readonly count: number;
  /** Integration steps run when it was taken. */
  readonly steps: number;
  /** Eight floats a boid: x, y, z, animation phase, vx, vy, vz, bank angle. */
  readonly boids: Float32Array;
}

/** Default flock configuration values. */
export const DEFAULT_FLOCK_OPTIONS = /* @__PURE__ */ Object.freeze({
  count: 4096,
  seed: 1337,
  preset: 'bird' as FlockPreset,
  boundsMargin: 3.0,
  boundsStrength: 6.0,
  separation: 1.8,
  alignment: 1.1,
  cohesion: 1.0,
  neighborRadius: 2.6,
  separationRadius: 1.1,
  visionAngle: Math.PI * 1.5,
  maxNeighbors: 24,
  minSpeed: 4.0,
  maxSpeed: 10.0,
  maxForce: 14.0,
  maxTurnAccel: 12.0,
  scale: 0.42,
  bankStrength: 0.55,
  flapAmplitude: 0.45,
  ambient: 0.38,
});

/** A flock input that cannot be used: code `unsupported`, the message naming the input and its fix, and the help link. */
export function flockError(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#flocking`);
}

/** Power-of-two spatial-hash table size: 16,384 to 65,536 buckets, so one two-level 256-wide prefix scan covers it. */
export function gridCellsForCount(count: number): number {
  if (count > 32_768) return 65_536;
  if (count > 12_288) return 32_768;
  return 16_384;
}

/** Spatial hash of a grid cell (Teschner et al. 2003), the same bits as the WGSL solver's. */
export function hashCell(cx: number, cy: number, cz: number, mask: number): number {
  const hx = Math.imul(cx | 0, 73856093);
  const hy = Math.imul(cy | 0, 19349663);
  const hz = Math.imul(cz | 0, 83492791);
  return ((hx ^ hy ^ hz) >>> 0) & mask;
}

/** FNV-1a (32-bit) of the state's bytes as 8 hex digits: equal states give equal hashes. */
export function flockStateHash(boids: Float32Array): string {
  const bytes = new Uint8Array(boids.buffer, boids.byteOffset, boids.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

const finiteNum = (v: unknown, fallback: number, name: string, min: number, max = Infinity): number => {
  const n = v === undefined ? fallback : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
    throw flockError(`Flock ${name} is ${String(n)}; pass a finite number from ${min} to ${max}.`);
  return n;
};

const finiteInt = (v: unknown, fallback: number, name: string, min: number, max: number): number => {
  const n = v === undefined ? fallback : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
    throw flockError(`Flock ${name} is ${String(n)}; pass a whole number from ${min} to ${max}.`);
  return n;
};

const vec3 = (v: unknown, name: string): FlockVec3 => {
  const a = v as ArrayLike<unknown> | undefined;
  if (!a || a.length !== 3 || ![0, 1, 2].every((i) => typeof a[i] === 'number' && Number.isFinite(a[i])))
    throw flockError(`Flock ${name} must be three finite numbers [x, y, z].`);
  return a as unknown as FlockVec3;
};

const color = (value: ColorInput, name: string): [number, number, number] => {
  const out = new Float32Array(3);
  try {
    parseColor(value, out, 0);
  } catch (cause) {
    throw flockError(`Flock ${name} is not a colour (${(cause as Error).message}); pass a hex string or linear [r, g, b].`);
  }
  return [out[0], out[1], out[2]];
};

const list = <T>(value: readonly T[] | undefined, max: number, name: string): readonly T[] => {
  const items = value ?? [];
  if (!Array.isArray(items) || items.length > max)
    throw flockError(`Flock ${name} must be an array of at most ${max} items; pass fewer.`);
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') throw flockError(`Flock ${name}[${i}] must be an object with a position.`);
  });
  return items;
};

/** Validates and resolves `GPUFlockOptions`; throws a coded `MargoError` naming the bad option. */
export function resolveFlockParams(options: GPUFlockOptions = {}, fixedCount?: number): ResolvedFlockParams {
  if (options === null || typeof options !== 'object')
    throw flockError('GPUFlock options must be an object; pass {} or a GPUFlockOptions literal.');
  const count = fixedCount ?? finiteInt(options.count, DEFAULT_FLOCK_OPTIONS.count, 'count', 1, MAX_FLOCK_BOIDS);
  const seed = finiteInt(options.seed, DEFAULT_FLOCK_OPTIONS.seed, 'seed', -2_147_483_648, 2_147_483_647);
  const preset = options.preset ?? DEFAULT_FLOCK_OPTIONS.preset;
  if (preset !== 'bird' && preset !== 'fish')
    throw flockError(`Flock preset is ${String(preset)}; pass 'bird' or 'fish'.`);

  const bounds = options.bounds ?? { shape: 'box' as const, halfSize: [18, 10, 18] as const };
  if (!bounds || typeof bounds !== 'object' || (bounds.shape !== 'box' && bounds.shape !== 'sphere'))
    throw flockError("Flock bounds must have shape 'box' or 'sphere'; pass { shape: 'box', halfSize: [18, 10, 18] }.");
  const center = vec3(bounds.center ?? [0, 0, 0], 'bounds.center');
  let boundsHalf: [number, number, number];
  let boundsRadius: number;
  if (bounds.shape === 'box') {
    const half = vec3(bounds.halfSize, 'bounds.halfSize');
    if (!(half[0] > 0 && half[1] > 0 && half[2] > 0))
      throw flockError('Flock bounds.halfSize components must be above 0; pass positive half-extents.');
    boundsHalf = [half[0], half[1], half[2]];
    boundsRadius = Math.hypot(half[0], half[1], half[2]);
  } else {
    boundsRadius = finiteNum(bounds.radius, 18, 'bounds.radius', 0.001);
    boundsHalf = [boundsRadius, boundsRadius, boundsRadius];
  }

  const neighborRadius = finiteNum(options.neighborRadius, DEFAULT_FLOCK_OPTIONS.neighborRadius, 'neighborRadius', 0.01);
  const separationRadius = finiteNum(
    options.separationRadius,
    DEFAULT_FLOCK_OPTIONS.separationRadius,
    'separationRadius',
    0.005,
  );
  const visionAngle = finiteNum(options.visionAngle, DEFAULT_FLOCK_OPTIONS.visionAngle, 'visionAngle', 0.05, Math.PI * 2);
  const maxNeighbors = finiteInt(options.maxNeighbors, DEFAULT_FLOCK_OPTIONS.maxNeighbors, 'maxNeighbors', 1, 128);
  const minSpeed = finiteNum(options.minSpeed, DEFAULT_FLOCK_OPTIONS.minSpeed, 'minSpeed', 0.01);
  const maxSpeed = finiteNum(options.maxSpeed, DEFAULT_FLOCK_OPTIONS.maxSpeed, 'maxSpeed', minSpeed);
  const maxForce = finiteNum(options.maxForce, DEFAULT_FLOCK_OPTIONS.maxForce, 'maxForce', 0.01);
  const maxTurnAccel = finiteNum(options.maxTurnAccel, DEFAULT_FLOCK_OPTIONS.maxTurnAccel, 'maxTurnAccel', 0.01);

  const attractors = list(options.attractors, MAX_FLOCK_ATTRACTORS, 'attractors');
  attractors.forEach((a, i) => {
    vec3(a.position, `attractors[${i}].position`);
    finiteNum(a.strength, 2.5, `attractors[${i}].strength`, 0);
    finiteNum(a.radius, 0, `attractors[${i}].radius`, 0);
  });
  const predators = list(options.predators, MAX_FLOCK_PREDATORS, 'predators');
  predators.forEach((p, i) => {
    vec3(p.position, `predators[${i}].position`);
    finiteNum(p.radius, 6, `predators[${i}].radius`, 0.01);
    finiteNum(p.strength, 12, `predators[${i}].strength`, 0);
  });
  const obstacles = list(options.obstacles, MAX_FLOCK_OBSTACLES, 'obstacles');
  obstacles.forEach((o, i) => {
    vec3(o.position, `obstacles[${i}].position`);
    finiteNum(o.radius, Number.NaN, `obstacles[${i}].radius`, 0.01);
    finiteNum(o.strength, 8, `obstacles[${i}].strength`, 0);
  });

  const lightDir = vec3(options.lightDirection ?? [0.45, 1, 0.35], 'lightDirection');
  const lightLen = Math.hypot(lightDir[0], lightDir[1], lightDir[2]);
  if (!(lightLen > 1e-6)) throw flockError('Flock lightDirection must not be zero; pass e.g. [0.45, 1, 0.35].');

  const dbg = options.debug ?? {};
  if (typeof dbg !== 'object' || dbg === null)
    throw flockError('Flock debug must be an object; pass { enabled, velocities?, grid?, perception?, vectors? }.');
  const selectedIndex = finiteInt(dbg.selectedIndex, 0, 'debug.selectedIndex', 0, Math.max(0, count - 1));

  return {
    count,
    seed,
    preset,
    boundsShape: bounds.shape === 'sphere' ? 1 : 0,
    boundsCenter: [center[0], center[1], center[2]],
    boundsHalf,
    boundsRadius,
    boundsMargin: finiteNum(options.boundsMargin, DEFAULT_FLOCK_OPTIONS.boundsMargin, 'boundsMargin', 0),
    boundsStrength: finiteNum(options.boundsStrength, DEFAULT_FLOCK_OPTIONS.boundsStrength, 'boundsStrength', 0),
    separation: finiteNum(options.separation, DEFAULT_FLOCK_OPTIONS.separation, 'separation', 0),
    alignment: finiteNum(options.alignment, DEFAULT_FLOCK_OPTIONS.alignment, 'alignment', 0),
    cohesion: finiteNum(options.cohesion, DEFAULT_FLOCK_OPTIONS.cohesion, 'cohesion', 0),
    neighborRadius,
    separationRadius,
    visionAngle,
    cosHalfVision: Math.cos(visionAngle * 0.5),
    maxNeighbors,
    minSpeed,
    maxSpeed,
    maxForce,
    maxTurnAccel,
    scale: finiteNum(options.scale, DEFAULT_FLOCK_OPTIONS.scale, 'scale', 0.001),
    bankStrength: finiteNum(options.bankStrength, DEFAULT_FLOCK_OPTIONS.bankStrength, 'bankStrength', 0),
    flapFrequency: finiteNum(options.flapFrequency, preset === 'bird' ? 5.5 : 7.0, 'flapFrequency', 0),
    flapAmplitude: finiteNum(options.flapAmplitude, DEFAULT_FLOCK_OPTIONS.flapAmplitude, 'flapAmplitude', 0),
    color: color(options.color ?? (preset === 'bird' ? '#e8eef8' : '#38c6e8'), 'color'),
    accentColor: color(options.accentColor ?? (preset === 'bird' ? '#4c7cc2' : '#f0a83c'), 'accentColor'),
    lightDirection: [lightDir[0] / lightLen, lightDir[1] / lightLen, lightDir[2] / lightLen],
    lightColor: color(options.lightColor ?? [1, 1, 1], 'lightColor'),
    ambient: finiteNum(options.ambient, DEFAULT_FLOCK_OPTIONS.ambient, 'ambient', 0, 1),
    paused: Boolean(options.paused ?? false),
    attractors,
    predators,
    obstacles,
    debug: {
      enabled: Boolean(dbg.enabled ?? false),
      velocities: Boolean(dbg.velocities ?? true),
      grid: Boolean(dbg.grid ?? true),
      perception: Boolean(dbg.perception ?? true),
      vectors: Boolean(dbg.vectors ?? true),
      selectedIndex,
    },
  };
}

/**
 * Built-in swept-wing bird mesh (`+Z` forward, `+Y` up, `+X` right).
 * Per-vertex `weights` are `0` along the spine and `1` at the wingtips for the wing flap.
 */
export function createBirdGeometry(): FlockGeometry {
  const positions = new Float32Array([
    0.0, 0.04, 0.95, // 0 beak
    0.0, 0.16, 0.25, // 1 dorsal ridge
    0.0, -0.1, 0.2, // 2 keel/belly
    0.0, 0.02, -0.55, // 3 tail root
    -0.42, 0.08, 0.12, // 4 left wing mid
    -1.0, 0.02, -0.18, // 5 left wingtip
    0.42, 0.08, 0.12, // 6 right wing mid
    1.0, 0.02, -0.18, // 7 right wingtip
    -0.28, 0.07, -0.92, // 8 left tail tip
    0.28, 0.07, -0.92, // 9 right tail tip
    -0.16, 0.01, -0.25, // 10 left trailing shoulder
    0.16, 0.01, -0.25, // 11 right trailing shoulder
  ]);
  const weights = new Float32Array([0.0, 0.0, 0.0, 0.0, 0.45, 1.0, 0.45, 1.0, 0.18, 0.18, 0.15, 0.15]);
  const indices = new Uint32Array([
    0, 4, 1, 0, 1, 6, // fuselage top
    0, 2, 4, 0, 6, 2, // fuselage bottom
    1, 10, 3, 1, 3, 11, // rear dorsal
    2, 3, 10, 2, 11, 3, // rear belly
    1, 4, 10, 4, 5, 10, 2, 10, 4, 4, 10, 5, // left wing, both faces
    1, 11, 6, 6, 11, 7, 2, 6, 11, 6, 7, 11, // right wing, both faces
    3, 8, 9, 3, 9, 8, // tail fan, both faces
  ]);
  return { positions, indices, weights };
}

/**
 * Built-in fish mesh (`+Z` forward, `+Y` up, `+X` right).
 * Per-vertex `weights` rise from `0` at the snout to `1` at the tail fin for the swimming wave.
 */
export function createFishGeometry(): FlockGeometry {
  const positions = new Float32Array([
    0.0, 0.0, 0.92, // 0 snout
    0.0, 0.24, 0.25, // 1 dorsal front
    0.0, -0.2, 0.22, // 2 ventral front
    -0.22, 0.02, 0.22, // 3 left flank
    0.22, 0.02, 0.22, // 4 right flank
    0.0, 0.12, -0.35, // 5 peduncle top
    0.0, -0.1, -0.35, // 6 peduncle bottom
    0.0, 0.36, -0.12, // 7 dorsal fin peak
    0.0, 0.32, -0.95, // 8 upper tail tip
    0.0, -0.28, -0.95, // 9 lower tail tip
    0.0, 0.02, -0.68, // 10 tail fork notch
    -0.46, -0.08, 0.02, // 11 left pectoral fin tip
    0.46, -0.08, 0.02, // 12 right pectoral fin tip
  ]);
  const weights = new Float32Array([0.0, 0.12, 0.12, 0.12, 0.12, 0.55, 0.55, 0.38, 1.0, 1.0, 0.8, 0.22, 0.22]);
  const indices = new Uint32Array([
    0, 3, 1, 0, 1, 4, 0, 2, 3, 0, 4, 2, // head
    1, 3, 5, 1, 5, 4, 2, 5, 3, 2, 4, 5, 3, 6, 5, 4, 5, 6, 2, 6, 3, 2, 4, 6, // body to peduncle
    1, 7, 5, 1, 5, 7, // dorsal fin, both faces
    5, 8, 10, 5, 10, 8, 6, 10, 9, 6, 9, 10, 5, 10, 6, 5, 6, 10, // forked tail, both faces
    3, 11, 2, 3, 2, 11, 4, 2, 12, 4, 12, 2, // pectoral fins, both faces
  ]);
  return { positions, indices, weights };
}

const numbers = (a: ArrayLike<number>, name: string): void => {
  for (let i = 0; i < a.length; i++)
    if (typeof a[i] !== 'number' || !Number.isFinite(a[i]))
      throw flockError(`Flock geometry ${name}[${i}] is not finite; pass finite numbers.`);
};

/** Splits an interleaved mesh (six floats a vertex, a core `Geometry`'s layout) into a `FlockGeometry`. */
function deinterleave(mesh: FlockInterleavedGeometry): FlockGeometry {
  const v = mesh.vertices;
  if (!v || typeof v.length !== 'number' || v.length % 6 !== 0)
    throw flockError('Flock geometry vertices must hold six floats a vertex (x, y, z, nx, ny, nz).');
  const n = v.length / 6;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = v[i * 6 + a];
      normals[i * 3 + a] = v[i * 6 + 3 + a];
    }
  return { positions, normals, indices: mesh.indices };
}

/** Validates and packs a mesh into corner records (two `vec4f` a triangle corner) and scales it to a unit radius. */
export function packFlockGeometry(
  geometry: FlockGeometry | FlockInterleavedGeometry,
  preset: FlockPreset,
): { corners: Float32Array; vertexCount: number } {
  if (!geometry || typeof geometry !== 'object')
    throw flockError('Flock geometry must be an object; pass { positions, indices? } or a glTF mesh geometry.');
  const g = 'vertices' in geometry ? deinterleave(geometry) : geometry;
  const pos = g.positions;
  if (!pos || typeof pos.length !== 'number' || pos.length < 9 || pos.length % 3 !== 0)
    throw flockError('Flock geometry positions must be xyz triples with at least one triangle.');
  numbers(pos, 'positions');

  const numVerts = pos.length / 3;
  const idx = g.indices;
  const cornerCount = idx ? idx.length : numVerts;
  if (cornerCount < 3 || cornerCount % 3 !== 0 || cornerCount / 3 > MAX_FLOCK_MESH_TRIANGLES)
    throw flockError(`Flock geometry must have 1 to ${MAX_FLOCK_MESH_TRIANGLES} whole triangles.`);
  if (idx)
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i];
      if (!Number.isInteger(v) || v < 0 || v >= numVerts)
        throw flockError(`Flock geometry indices[${i}] is ${String(v)}; pass integers from 0 to ${numVerts - 1}.`);
    }
  const normals = g.normals;
  if (normals !== undefined) {
    if (typeof normals.length !== 'number' || normals.length !== pos.length)
      throw flockError('Flock geometry normals must match the positions in length.');
    numbers(normals, 'normals');
  }
  const weights = g.weights;
  if (weights !== undefined) {
    if (typeof weights.length !== 'number' || weights.length !== numVerts)
      throw flockError('Flock geometry weights must hold one number a vertex.');
    for (let i = 0; i < weights.length; i++)
      if (typeof weights[i] !== 'number' || !(weights[i] >= 0 && weights[i] <= 1))
        throw flockError(`Flock geometry weights[${i}] must be from 0 to 1.`);
  }

  let maxRad = 0;
  for (let i = 0; i < numVerts; i++) maxRad = Math.max(maxRad, Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
  if (!(maxRad > 1e-6)) throw flockError('Flock geometry positions all sit at the origin; pass a mesh with a size.');

  const corners = new Float32Array(cornerCount * 8);
  const tri = [0, 0, 0];
  for (let t = 0; t < cornerCount; t += 3) {
    tri[0] = idx ? idx[t] : t;
    tri[1] = idx ? idx[t + 1] : t + 1;
    tri[2] = idx ? idx[t + 2] : t + 2;
    const [i0, i1, i2] = tri;
    const ux = pos[i1 * 3] - pos[i0 * 3], uy = pos[i1 * 3 + 1] - pos[i0 * 3 + 1], uz = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
    const vx = pos[i2 * 3] - pos[i0 * 3], vy = pos[i2 * 3 + 1] - pos[i0 * 3 + 1], vz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
    let fnx = uy * vz - uz * vy, fny = uz * vx - ux * vz, fnz = ux * vy - uy * vx;
    const fl = Math.hypot(fnx, fny, fnz) || 1;
    fnx /= fl;
    fny /= fl;
    fnz /= fl;
    for (let k = 0; k < 3; k++) {
      const vi = tri[k];
      const px = pos[vi * 3] / maxRad, py = pos[vi * 3 + 1] / maxRad, pz = pos[vi * 3 + 2] / maxRad;
      let nx = fnx, ny = fny, nz = fnz;
      if (normals) {
        const nl = Math.hypot(normals[vi * 3], normals[vi * 3 + 1], normals[vi * 3 + 2]) || 1;
        nx = normals[vi * 3] / nl;
        ny = normals[vi * 3 + 1] / nl;
        nz = normals[vi * 3 + 2] / nl;
      }
      // Without weights a bird flaps by distance from its spine and a fish swims by distance behind its head.
      const w = weights
        ? weights[vi]
        : preset === 'bird'
          ? Math.min(1, Math.abs(px))
          : Math.min(1, Math.max(0, (0.5 - pz) * 0.7));
      const colorMix =
        preset === 'bird'
          ? Math.min(1, Math.abs(px) * 0.9 + Math.max(0, -pz) * 0.25)
          : Math.min(1, Math.max(0, py * 1.4 + 0.35));
      const o = (t + k) * 8;
      corners[o] = px;
      corners[o + 1] = py;
      corners[o + 2] = pz;
      corners[o + 3] = w;
      corners[o + 4] = nx;
      corners[o + 5] = ny;
      corners[o + 6] = nz;
      corners[o + 7] = colorMix;
    }
  }
  return { corners, vertexCount: cornerCount };
}

/** Seeds a `FlockSimulationState` inside the bounds: the same seed gives the same state. */
export function createFlockState(options: GPUFlockOptions = {}): FlockSimulationState {
  const p = resolveFlockParams(options);
  const rand = createRandom(p.seed);
  const boids = new Float32Array(p.count * FLOCK_BOID_FLOATS);
  const gridCells = gridCellsForCount(p.count);
  const span = 0.72;
  const midSpeed = (p.minSpeed + p.maxSpeed) * 0.5;

  for (let i = 0; i < p.count; i++) {
    let x: number, y: number, z: number;
    if (p.boundsShape === 1) {
      // Uniform in a ball of 72% of the radius: radius by the cube root, direction uniform on the sphere.
      const u = rand();
      const cosTheta = rand() * 2 - 1;
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const phi = rand() * Math.PI * 2;
      const r = p.boundsRadius * span * Math.cbrt(u);
      x = p.boundsCenter[0] + r * sinTheta * Math.cos(phi);
      y = p.boundsCenter[1] + r * cosTheta;
      z = p.boundsCenter[2] + r * sinTheta * Math.sin(phi);
    } else {
      x = p.boundsCenter[0] + (rand() * 2 - 1) * p.boundsHalf[0] * span;
      y = p.boundsCenter[1] + (rand() * 2 - 1) * p.boundsHalf[1] * span;
      z = p.boundsCenter[2] + (rand() * 2 - 1) * p.boundsHalf[2] * span;
    }
    const dirCos = (rand() * 2 - 1) * 0.4;
    const dirSin = Math.sqrt(Math.max(0, 1 - dirCos * dirCos));
    const yaw = rand() * Math.PI * 2;
    const speed = midSpeed * (0.85 + rand() * 0.3);
    const o = i * FLOCK_BOID_FLOATS;
    boids[o] = x;
    boids[o + 1] = y;
    boids[o + 2] = z;
    boids[o + 3] = rand() * Math.PI * 2;
    boids[o + 4] = Math.cos(yaw) * dirSin * speed;
    boids[o + 5] = dirCos * speed;
    boids[o + 6] = Math.sin(yaw) * dirSin * speed;
    boids[o + 7] = 0;
  }

  return {
    count: p.count,
    boids,
    debugData: new Float32Array(32),
    scratch: {
      next: new Float32Array(p.count * FLOCK_BOID_FLOATS),
      cellCounts: new Uint32Array(gridCells),
      cellOffsets: new Uint32Array(gridCells),
      cellCursor: new Uint32Array(gridCells),
      boidCell: new Uint32Array(p.count),
      sortedIdx: new Uint32Array(p.count),
      seen: new Uint32Array(27),
      gridCells,
    },
  };
}

/** How many equal steps no longer than `FLOCK_MAX_SUBSTEP` a `dt` splits into; throws for a `dt` out of range. */
export function flockSubsteps(dt: number): number {
  if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0 || dt > FLOCK_MAX_STEP)
    throw flockError(`Flock step dt is ${String(dt)}; pass seconds from 0 to ${FLOCK_MAX_STEP}, and call step again for more.`);
  return dt === 0 ? 0 : Math.ceil(dt / FLOCK_MAX_SUBSTEP - 1e-9);
}

/**
 * Advances a `FlockSimulationState` by `dt` seconds (0 to 1, split into equal steps of at most 0.05 s) with the
 * WebGPU solver's model, steps and order: counting sort into hash buckets, 3 x 3 x 3 cell neighbourhood, the rules,
 * then integration. Ignores `paused`. Returns the number of steps run.
 */
export function stepFlockCPU(state: FlockSimulationState, options: GPUFlockOptions, dt: number): number {
  const n = flockSubsteps(dt);
  if (!n) return 0;
  const p = resolveFlockParams(options, state.count);
  for (let s = 0; s < n; s++) substep(state, p, dt / n);
  return n;
}

function substep(state: FlockSimulationState, p: ResolvedFlockParams, h: number): void {
  const { count, boids, debugData, scratch } = state;
  const { next, cellCounts, cellOffsets, cellCursor, boidCell, sortedIdx, seen, gridCells } = scratch;
  const mask = gridCells - 1;
  const cellSize = Math.max(p.neighborRadius, p.separationRadius, 0.25);
  // The cell index is taken in f32, as the GPU does, so both sort a boid into the same bucket.
  const invCell = Math.fround(1 / cellSize);
  const cellOf = (x: number) => Math.floor(Math.fround(Math.fround(x) * invCell));
  const neighR2 = p.neighborRadius * p.neighborRadius;
  const sepR = p.separationRadius;
  const cellCap = p.maxNeighbors * 2;
  const F = FLOCK_BOID_FLOATS;

  // 1. Hash each boid into its bucket and count the buckets.
  cellCounts.fill(0);
  for (let i = 0; i < count; i++) {
    const o = i * F;
    const b = hashCell(cellOf(boids[o]), cellOf(boids[o + 1]), cellOf(boids[o + 2]), mask);
    boidCell[i] = b;
    cellCounts[b]++;
  }
  // 2. Exclusive prefix sum: where each bucket starts.
  let running = 0;
  for (let c = 0; c < gridCells; c++) {
    cellOffsets[c] = running;
    cellCursor[c] = running;
    running += cellCounts[c];
  }
  // 3. Stable counting sort: a bucket lists its boids by ascending index, the order the GPU's rank pass gives.
  for (let i = 0; i < count; i++) sortedIdx[cellCursor[boidCell[i]]++] = i;

  const [bcx, bcy, bcz] = p.boundsCenter;
  const [bhx, bhy, bhz] = p.boundsHalf;
  const margin = Math.max(p.boundsMargin, 0.001);
  const twoPi = Math.PI * 2;
  const bankFactor = p.preset === 'fish' ? 0.25 : 1.0;

  // 4. Each boid: its 27 neighbouring cells (each bucket once), the rules, then integration.
  for (let i = 0; i < count; i++) {
    const o = i * F;
    const px = boids[o], py = boids[o + 1], pz = boids[o + 2], phase = boids[o + 3];
    const vx = boids[o + 4], vy = boids[o + 5], vz = boids[o + 6], bank = boids[o + 7];
    const speed = Math.hypot(vx, vy, vz);
    const fx = speed > 1e-5 ? vx / speed : 0;
    const fy = speed > 1e-5 ? vy / speed : 0;
    const fz = speed > 1e-5 ? vz / speed : 1;
    const cx = cellOf(px), cy = cellOf(py), cz = cellOf(pz);

    let sepX = 0, sepY = 0, sepZ = 0, sepCount = 0;
    let aliX = 0, aliY = 0, aliZ = 0;
    let cohX = 0, cohY = 0, cohZ = 0, neighCount = 0;
    let nSeen = 0;

    outer: for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const b = hashCell(cx + dx, cy + dy, cz + dz, mask);
          // Two of the 27 cells can share a bucket; its boids are counted once.
          let dup = false;
          for (let s = 0; s < nSeen; s++) if (seen[s] === b) dup = true;
          if (dup) continue;
          seen[nSeen++] = b;
          const start = cellOffsets[b];
          const lim = Math.min(cellCounts[b], cellCap);
          for (let k = 0; k < lim; k++) {
            const j = sortedIdx[start + k];
            if (j === i) continue;
            const jo = j * F;
            const ddx = boids[jo] - px, ddy = boids[jo + 1] - py, ddz = boids[jo + 2] - pz;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 <= 1e-8 || d2 > neighR2) continue;
            const d = Math.sqrt(d2);
            const dirX = ddx / d, dirY = ddy / d, dirZ = ddz / d;
            const dotFwd = dirX * fx + dirY * fy + dirZ * fz;
            // Separation sees a neighbour in the cone, or any neighbour closer than half the separation radius.
            if (d < sepR && (dotFwd >= p.cosHalfVision || d < sepR * 0.5)) {
              const rep = (sepR - d) / (sepR * Math.max(d, 0.05));
              sepX -= dirX * rep;
              sepY -= dirY * rep;
              sepZ -= dirZ * rep;
              sepCount++;
            }
            if (dotFwd >= p.cosHalfVision) {
              aliX += boids[jo + 4];
              aliY += boids[jo + 5];
              aliZ += boids[jo + 6];
              cohX += boids[jo];
              cohY += boids[jo + 1];
              cohZ += boids[jo + 2];
              if (++neighCount >= p.maxNeighbors) break outer;
            }
          }
        }

    // Reynolds steering: desired velocity at max speed along each rule, minus the current velocity, times its weight.
    let sfX = 0, sfY = 0, sfZ = 0;
    if (sepCount > 0 && p.separation > 0) {
      const sl = Math.hypot(sepX, sepY, sepZ);
      if (sl > 1e-5) {
        const s = p.maxSpeed / sl;
        sfX = (sepX * s - vx) * p.separation;
        sfY = (sepY * s - vy) * p.separation;
        sfZ = (sepZ * s - vz) * p.separation;
      }
    }
    let afX = 0, afY = 0, afZ = 0, cfX = 0, cfY = 0, cfZ = 0;
    if (neighCount > 0) {
      if (p.alignment > 0) {
        const al = Math.hypot(aliX, aliY, aliZ);
        if (al > 1e-5) {
          const s = p.maxSpeed / al;
          afX = (aliX * s - vx) * p.alignment;
          afY = (aliY * s - vy) * p.alignment;
          afZ = (aliZ * s - vz) * p.alignment;
        }
      }
      if (p.cohesion > 0) {
        const tx = cohX / neighCount - px, ty = cohY / neighCount - py, tz = cohZ / neighCount - pz;
        const cl = Math.hypot(tx, ty, tz);
        if (cl > 1e-5) {
          const s = p.maxSpeed / cl;
          cfX = (tx * s - vx) * p.cohesion;
          cfY = (ty * s - vy) * p.cohesion;
          cfZ = (tz * s - vz) * p.cohesion;
        }
      }
    }

    let attX = 0, attY = 0, attZ = 0;
    for (const att of p.attractors) {
      const str = att.strength ?? 2.5;
      if (str <= 0) continue;
      const rad = att.radius ?? 0;
      const dx = att.position[0] - px, dy = att.position[1] - py, dz = att.position[2] - pz;
      const d = Math.hypot(dx, dy, dz);
      if (d > 1e-4 && (rad <= 0 || d < rad)) {
        const falloff = rad > 0 ? 1 - d / rad : 1;
        const s = p.maxSpeed / d;
        attX += (dx * s - vx) * str * falloff;
        attY += (dy * s - vy) * str * falloff;
        attZ += (dz * s - vz) * str * falloff;
      }
    }

    // Predators push straight away, harder the closer they are: strength (1 + 2 u^2), u = 1 - d / radius.
    let pfX = 0, pfY = 0, pfZ = 0;
    let fleeing = false;
    for (const pred of p.predators) {
      const str = pred.strength ?? 12;
      const rad = pred.radius ?? 6;
      if (str <= 0) continue;
      const dx = px - pred.position[0], dy = py - pred.position[1], dz = pz - pred.position[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < rad && d > 1e-5) {
        const u = 1 - d / rad;
        const mag = (str * (1 + 2 * u * u)) / d;
        pfX += dx * mag;
        pfY += dy * mag;
        pfZ += dz * mag;
        fleeing = true;
      }
    }

    let obsX = 0, obsY = 0, obsZ = 0;
    let dodging = false;
    const obsMargin = Math.max(margin * 0.6, sepR);
    for (const obs of p.obstacles) {
      const str = obs.strength ?? 8;
      const avoidR = obs.radius + obsMargin;
      const dx = px - obs.position[0], dy = py - obs.position[1], dz = pz - obs.position[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < avoidR && d > 1e-5) {
        const t = 1 - d / avoidR;
        const mag = (str * t * t * p.maxForce) / d;
        obsX += dx * mag;
        obsY += dy * mag;
        obsZ += dz * mag;
        dodging = true;
      }
    }

    // Containment: a push that grows with the square of the depth into the margin, capped at twice the margin.
    let bndX = 0, bndY = 0, bndZ = 0;
    const bndScale = p.boundsStrength * p.maxForce;
    if (p.boundsShape === 1) {
      const dx = px - bcx, dy = py - bcy, dz = pz - bcz;
      const d = Math.hypot(dx, dy, dz);
      const inner = Math.max(0, p.boundsRadius - margin);
      if (d > inner && d > 1e-5) {
        const t = Math.min(2, (d - inner) / margin);
        const push = (t * t * bndScale) / d;
        bndX = -dx * push;
        bndY = -dy * push;
        bndZ = -dz * push;
      }
    } else {
      const wall = (r: number, half: number): number => {
        const inner = Math.max(0, half - margin);
        if (r > inner) return -(Math.min(2, (r - inner) / margin) ** 2) * bndScale;
        if (r < -inner) return Math.min(2, (-inner - r) / margin) ** 2 * bndScale;
        return 0;
      };
      bndX = wall(px - bcx, bhx);
      bndY = wall(py - bcy, bhy);
      bndZ = wall(pz - bcz, bhz);
    }

    // The flock's own rules share maxForce; fleeing and dodging may add up to 2.5 times it.
    let accX = sfX + afX + cfX + attX + bndX;
    let accY = sfY + afY + cfY + attY + bndY;
    let accZ = sfZ + afZ + cfZ + attZ + bndZ;
    const baseLen = Math.hypot(accX, accY, accZ);
    if (baseLen > p.maxForce) {
      const s = p.maxForce / baseLen;
      accX *= s;
      accY *= s;
      accZ *= s;
    }
    accX += pfX + obsX;
    accY += pfY + obsY;
    accZ += pfZ + obsZ;
    const totalCap = fleeing || dodging ? p.maxForce * 2.5 : p.maxForce;
    const totalLen = Math.hypot(accX, accY, accZ);
    if (totalLen > totalCap) {
      const s = totalCap / totalLen;
      accX *= s;
      accY *= s;
      accZ *= s;
    }

    // Turning is limited to maxTurnAccel across the heading (twice that when fleeing or dodging).
    const aPar = accX * fx + accY * fy + accZ * fz;
    let latX = accX - fx * aPar, latY = accY - fy * aPar, latZ = accZ - fz * aPar;
    const latLen = Math.hypot(latX, latY, latZ);
    const turnCap = fleeing || dodging ? p.maxTurnAccel * 2.0 : p.maxTurnAccel;
    if (latLen > turnCap) {
      const s = turnCap / latLen;
      latX *= s;
      latY *= s;
      latZ *= s;
    }
    accX = fx * aPar + latX;
    accY = fy * aPar + latY;
    accZ = fz * aPar + latZ;

    // Semi-implicit Euler: velocity first, clamped to [minSpeed, maxSpeed] (1.35 times max when fleeing), then position.
    let nvx = vx + accX * h, nvy = vy + accY * h, nvz = vz + accZ * h;
    let nSpd = Math.hypot(nvx, nvy, nvz);
    const hiSpeed = fleeing ? p.maxSpeed * 1.35 : p.maxSpeed;
    if (nSpd < 1e-5) {
      nvx = fx * p.minSpeed;
      nvy = fy * p.minSpeed;
      nvz = fz * p.minSpeed;
      nSpd = p.minSpeed;
    } else if (nSpd < p.minSpeed || nSpd > hiSpeed) {
      const target = nSpd < p.minSpeed ? p.minSpeed : hiSpeed;
      const s = target / nSpd;
      nvx *= s;
      nvy *= s;
      nvz *= s;
      nSpd = target;
    }
    let npx = px + nvx * h, npy = py + nvy * h, npz = pz + nvz * h;

    // A boid inside an obstacle is put back on its surface and bounces off it.
    for (const obs of p.obstacles) {
      const dx = npx - obs.position[0], dy = npy - obs.position[1], dz = npz - obs.position[2];
      const d = Math.hypot(dx, dy, dz);
      const minD = obs.radius + p.scale * 0.35;
      if (d < minD) {
        const nx = d > 1e-5 ? dx / d : 0;
        const ny = d > 1e-5 ? dy / d : 1;
        const nz = d > 1e-5 ? dz / d : 0;
        npx = obs.position[0] + nx * minD;
        npy = obs.position[1] + ny * minD;
        npz = obs.position[2] + nz * minD;
        const vn = nvx * nx + nvy * ny + nvz * nz;
        if (vn < 0) {
          nvx -= 1.5 * vn * nx;
          nvy -= 1.5 * vn * ny;
          nvz -= 1.5 * vn * nz;
        }
      }
    }

    // A boid past the bounds is put back on them and bounces.
    if (p.boundsShape === 1) {
      const dx = npx - bcx, dy = npy - bcy, dz = npz - bcz;
      const d = Math.hypot(dx, dy, dz);
      if (d > p.boundsRadius) {
        const nx = dx / d, ny = dy / d, nz = dz / d;
        npx = bcx + nx * p.boundsRadius;
        npy = bcy + ny * p.boundsRadius;
        npz = bcz + nz * p.boundsRadius;
        const vn = nvx * nx + nvy * ny + nvz * nz;
        if (vn > 0) {
          nvx -= 1.5 * vn * nx;
          nvy -= 1.5 * vn * ny;
          nvz -= 1.5 * vn * nz;
        }
      }
    } else {
      if (npx > bcx + bhx) { npx = bcx + bhx; if (nvx > 0) nvx = -nvx * 0.6; }
      else if (npx < bcx - bhx) { npx = bcx - bhx; if (nvx < 0) nvx = -nvx * 0.6; }
      if (npy > bcy + bhy) { npy = bcy + bhy; if (nvy > 0) nvy = -nvy * 0.6; }
      else if (npy < bcy - bhy) { npy = bcy - bhy; if (nvy < 0) nvy = -nvy * 0.6; }
      if (npz > bcz + bhz) { npz = bcz + bhz; if (nvz > 0) nvz = -nvz * 0.6; }
      else if (npz < bcz - bhz) { npz = bcz - bhz; if (nvz < 0) nvz = -nvz * 0.6; }
    }

    // Bank into the turn (eased at 6 per second) and advance the flap phase faster at higher speed.
    const invSpd = 1 / Math.max(Math.hypot(nvx, nvy, nvz), 1e-5);
    const nfx = nvx * invSpd, nfz = nvz * invSpd;
    let rx = nfz, rz = -nfx;
    const rl = Math.hypot(rx, rz);
    if (rl > 1e-4) {
      rx /= rl;
      rz /= rl;
    } else {
      rx = 1;
      rz = 0;
    }
    const latDotRight = latX * rx + latZ * rz;
    const targetBank = Math.max(-1.1, Math.min(1.1, -latDotRight * p.bankStrength * bankFactor * 0.12));
    const newBank = bank + (targetBank - bank) * Math.min(1, h * 6.0);
    const speedRatio = Math.max(0, Math.min(1, (nSpd - p.minSpeed) / Math.max(p.maxSpeed - p.minSpeed, 1e-3)));
    const rawPhase = phase + h * p.flapFrequency * (0.75 + 0.55 * speedRatio) * twoPi;
    const newPhase = rawPhase - Math.floor(rawPhase / twoPi) * twoPi;

    next[o] = npx;
    next[o + 1] = npy;
    next[o + 2] = npz;
    next[o + 3] = newPhase;
    next[o + 4] = nvx;
    next[o + 5] = nvy;
    next[o + 6] = nvz;
    next[o + 7] = newBank;

    if (i === p.debug.selectedIndex) {
      debugData.set([npx, npy, npz, newBank, nvx, nvy, nvz, neighCount, sfX, sfY, sfZ, sepCount], 0);
      debugData.set([afX, afY, afZ, 0, cfX, cfY, cfZ, 0, pfX, pfY, pfZ, 0, cx, cy, cz, cellSize, 0, 0, 0, 1], 12);
    }
  }
  boids.set(next);
}
