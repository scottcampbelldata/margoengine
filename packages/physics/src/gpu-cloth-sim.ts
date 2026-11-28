// The CPU half of `@margoengine/physics/gpu-cloth`: options, the cloth's topology (edges coloured so no two of a colour
// share a particle), the packed per-substep, pin and collider records the GPU and the CPU route read. The CPU route that runs
// the same passes in the same order (the WebGL2 compatibility layer, Node, and the check the GPU run is compared with) is the
// Rust kernel packages/physics/cloth-kernel, loaded by cloth/kernel.ts.
// Method: position-based dynamics (Müller, Heidelberger, Hennix and Ratcliff 2007) with Verlet velocities (Jakobsen 2001),
// compliant distance constraints of XPBD (Macklin, Müller and Chentanez 2016) solved once a substep in many substeps
// (Macklin, Storey, Lu, Terdiman, Chentanez, Jeschke and Müller 2019), Gauss-Seidel by edge colour, position-based friction
// (Macklin, Müller, Chentanez and Kim 2014) and a flat plate's quadratic drag (Hoerner 1965). Sources: docs/clean-room.md,
// "GPU cloth".
import type { Quat, Vec3 } from '@margoengine/math';
import type { FlowField, FlowSample } from '@margoengine/math/fields';
import { MargoError } from '@margoengine/math/errors';
import type { PhysicsBody } from './body.js';
import type { DebugLines } from './debug.js';
import type { SoftBodyDesc } from './soft.js';

/** Most particles one cloth holds. */
export const MAX_GPU_CLOTH_PARTICLES = 262_144;
/** Most colliders one cloth meets. */
export const MAX_GPU_CLOTH_COLLIDERS = 32;
/** Most substeps a step (the default is 30). */
export const MAX_GPU_CLOTH_SUBSTEPS = 64;
/** Most substeps one frame runs in all; a slower frame drops the time past this. */
export const GPU_CLOTH_FRAME_SUBSTEPS = 256;
/** Most edges at one particle (structural, shear and bend together): the colouring's 32 colours need at most 2 x 16 - 1. */
export const MAX_GPU_CLOTH_DEGREE = 16;
/** Floats of one draw vertex: position and 1, normal and 0, tangent and handedness, two UV sets, colour (gltf PBR layout). */
export const GPU_CLOTH_VERTEX_FLOATS = 20;
/** Floats of one substep's record (256 bytes, the uniform offset alignment). */
export const GPU_CLOTH_SLOT_FLOATS = 64;
/** Floats of one collider's record. */
export const GPU_CLOTH_COLLIDER_FLOATS = 32;
/** Edge kinds: index into the compliance triple. */
export const EDGE_STRETCH = 0,
  EDGE_SHEAR = 1,
  EDGE_BEND = 2;
/** Collider type codes in the packed record. */
export const SHAPE_SPHERE = 0,
  SHAPE_CAPSULE = 1,
  SHAPE_BOX = 2,
  SHAPE_PLANE = 3,
  SHAPE_SDF = 4;
const NO_EDGE = 0xffffffff;
const THREAD_SHEAR = 3; // soft.ts: the kind of a cell's diagonal in `edgeKinds`

/** A coded error of the GPU cloth entry, linking its help entry. */
export function clothError(message: string, code: 'unsupported' | 'state' | 'disposed' = 'unsupported'): MargoError {
  return new MargoError(code, `${message} See https://margoengine.com/errors#gpu-cloth`);
}

/** A signed distance field the cloth collides with: `MeshSDF` of `@margoengine/bvh/sdf` passes as it is. */
export interface GPUClothSDF {
  /** Samples, x fastest, then y, then z: negative inside, positive outside, in metres. */
  readonly data: Float32Array;
  /** Samples per axis, each at least 2. */
  readonly size: readonly [number, number, number];
  /** The corner of the first sample, in the collider's own space. */
  readonly min: Vec3;
  /** The corner of the last sample. */
  readonly max: Vec3;
}

/** The shape of a collider, in its own space (a capsule's axis and a plane's normal are its local +y). */
export type GPUClothShape =
  | { shape: 'sphere'; radius: number }
  | { shape: 'capsule'; radius: number; halfHeight: number }
  | { shape: 'box'; halfExtents: Vec3 }
  | { shape: 'plane' }
  | { shape: 'sdf'; sdf: GPUClothSDF };

/** A collider for {@link GPUCloth.addCollider}: a shape and where it is. */
export type GPUClothColliderDesc = GPUClothShape & {
  /** Its position: in the world, or on `body` (default [0, 0, 0]). */
  position?: Vec3;
  /** Its rotation [x, y, z, w]: in the world, or on `body` (default none). */
  rotation?: Quat;
  /** A plane's normal, used in place of `rotation` (default [0, 1, 0]). */
  normal?: Vec3;
  /** A rigid body it rides on: read every frame, after the physics step (default none: it stays where it is put). */
  body?: PhysicsBody | null;
  /** Coulomb friction with the cloth (default the cloth's `friction`). */
  friction?: number;
};

/** Live settings of a {@link GPUCloth}; every field has a default and can change between frames. */
export interface GPUClothOptions {
  /** Gravity in m/s^2 (default the `physics` world's, else [0, -9.81, 0]), times the description's gravity scale. */
  gravity?: Vec3;
  /**
   * The wind in m/s: a velocity, a function of the cloth's time in seconds, or a `FlowField` of `@margoengine/math/fields`
   * (the framework's shared wind, ATMO-01), sampled once a frame at the cloth's centre at the cloth's time, its density the
   * air's unless `airDensity` is given (default still air).
   */
  wind?: Vec3 | ((time: number) => Vec3) | FlowField;
  /** How much the wind varies over the cloth and in time, 0 to 1 (default 0.25): gusts that make a flag flap. */
  turbulence?: number;
  /** Air density, kg/m^3 (default 1.2). 0 turns the air off. */
  airDensity?: number;
  /** A face's drag coefficient across it (default 1.17, a flat plate, Hoerner 1965). */
  drag?: number;
  /** Compliance of the structural edges, m/N (default 0: inextensible). */
  stretchCompliance?: number;
  /** Compliance of the shear edges, a cell's diagonals (default 0). */
  shearCompliance?: number;
  /** Compliance of the bend edges (default: the CPU cloth's 10 Hz bend edges on the mean particle mass). */
  bendCompliance?: number;
  /** Linear damping, 1/s (default the description's `setLinearDamping`, else 0). */
  damping?: number;
  /** Coulomb friction with colliders (default 0.4). */
  friction?: number;
  /** How far the cloth keeps from colliders, metres (default the description's particle radius, else half its shortest edge). */
  thickness?: number;
  /** Fixed step, seconds (default 1/60, 1/480 to 1/15). */
  timestep?: number;
  /** Substeps a step, 1 to 64 (default 30): more hold a light cloth in strong gusts closer to its length. */
  substeps?: number;
  /**
   * Long range attachments (Kim, Chentanez and Mueller 2012): each free particle is kept within its rest distance along the
   * cloth, times 1 + `tetherSlack`, of its nearest pinned particle, so a pinned cloth does not stretch under its own swing
   * however few substeps it has (default true).
   */
  tethers?: boolean;
  /** How far past its rest distance along the cloth a particle may go from its pin, as a fraction (default 0.01). */
  tetherSlack?: number;
  /** Stop stepping (default false); `step()` still steps. */
  paused?: boolean;
}

/** Options of the debug lines, {@link GPUCloth.debugRender}. */
export interface GPUClothDebugOptions {
  /** Structural and shear edges, coloured by strain from green (rest) to red (`strainRange` stretched) (default true). */
  edges?: boolean;
  /** Bend edges in grey (default false). */
  bendEdges?: boolean;
  /** A yellow cross at each pinned particle (default true). */
  pins?: boolean;
  /** The colliders' outlines in cyan (default true). */
  colliders?: boolean;
  /** Each particle's normal, `normalLength` long (default false). */
  normals?: boolean;
  /** The wind at the cloth's centre, an arrow 0.1 s of air long (default true). */
  wind?: boolean;
  /** The strain drawn full red (default 0.1). */
  strainRange?: number;
  /** Length of a drawn normal, metres (default 0.05). */
  normalLength?: number;
}

/** A cloth's state as {@link GPUCloth.snapshot} copied it; {@link GPUCloth.restore} puts it back. */
export interface GPUClothSnapshot {
  readonly count: number;
  readonly steps: number;
  readonly time: number;
  /** Particles (x, y, z, inverse mass), velocities, predicted positions and normals (and area), four floats each. */
  readonly state: Float32Array;
}

/** Live statistics of a {@link GPUCloth}. */
export interface GPUClothStats {
  /** Where it steps: on the GPU, on the CPU twin on the WebGL2 layer, or on the CPU twin unattached. */
  backend: 'webgpu' | 'webgl2-compat' | 'cpu';
  /** Fixed steps taken. */
  steps: number;
  /** Colours of edges, the constraint passes of one substep. */
  colors: number;
  /** Particles. */
  count: number;
  /**
   * Work the CPU routes did, counted by the kernel (deterministic, for speed proofs): substeps, particle updates, edge
   * solves and particle-collider tests. The WebGPU route does the same work on the GPU and does not count it.
   */
  work: { substeps: number; particles: number; edges: number; colliderTests: number };
  /**
   * With threads, each thread's share of the CPU route's work so far (particle updates, edge solves and collider tests; the
   * main thread first), summing to `work`'s: the static schedule fixes it by the counts alone.
   */
  threadWork?: number[];
}

/** Resolved settings of one frame. */
export interface ResolvedClothParams {
  gravity: Vec3;
  wind: Vec3;
  turbulence: number;
  dragK: number;
  compliance: Vec3;
  damping: number;
  friction: number;
  thickness: number;
  timestep: number;
  substeps: number;
  paused: boolean;
  tethers: boolean;
  tetherSlack: number;
}

/** The cloth's fixed parts, built once from its description. */
export interface ClothTopology {
  count: number;
  rest: Float32Array;
  masses: Float32Array;
  /** Each particle's third of its triangles' rest area, m^2. */
  area: Float32Array;
  triangles: Uint32Array;
  uvs: Float32Array;
  /** Offsets (count + 1) then the triangles at each particle. */
  adjacency: Uint32Array;
  /** Four u32 an edge (i, j, rest length bits, kind), grouped by colour, each colour padded to `pad` edges. */
  edges: Uint32Array;
  /** First edge and edge count (padded) of each colour. */
  colors: [start: number, count: number][];
  /** Every real edge as (i, j, kind), for the debug lines. */
  pairs: Uint32Array;
  gravityScale: number;
  damping: number;
  thickness: number;
  bendCompliance: number;
}

const vec = (v: unknown, name: string): Vec3 => {
  const a = v as ArrayLike<number> | undefined;
  if (!a || typeof a !== 'object' || a.length !== 3 || ![0, 1, 2].every((k) => Number.isFinite(a[k])))
    throw clothError(`GPUCloth ${name} must be three finite numbers [x, y, z].`);
  return [a[0]!, a[1]!, a[2]!];
};
const quat = (v: unknown, name: string): Quat => {
  const a = v as ArrayLike<number> | undefined;
  if (!a || typeof a !== 'object' || a.length !== 4 || ![0, 1, 2, 3].every((k) => Number.isFinite(a[k])))
    throw clothError(`GPUCloth ${name} must be a quaternion of four finite numbers [x, y, z, w].`);
  const l = Math.hypot(a[0]!, a[1]!, a[2]!, a[3]!);
  if (!(l > 0)) throw clothError(`GPUCloth ${name} is a zero quaternion; pass a unit quaternion.`);
  return [a[0]! / l, a[1]! / l, a[2]! / l, a[3]! / l];
};
const num = (v: unknown, fallback: number, name: string, min: number, max = Infinity): number => {
  const n = v === undefined ? fallback : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
    throw clothError(`GPUCloth ${name} is ${String(n)}; pass a finite number from ${min} to ${max}.`);
  return n;
};

const flowSample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };

/**
 * Checks and fills in every setting for this frame; `time` is the cloth's time, for a wind function, and `centre` where a
 * flow-field wind is sampled.
 */
export function resolveClothParams(
  options: GPUClothOptions,
  topology: ClothTopology,
  worldGravity: Vec3 | undefined,
  time: number,
  centre: Vec3 = [0, 0, 0],
): ResolvedClothParams {
  if (!options || typeof options !== 'object') throw clothError('GPUCloth options must be an object.');
  const g = options.gravity === undefined ? (worldGravity ?? [0, -9.81, 0]) : vec(options.gravity, 'gravity');
  const s = topology.gravityScale;
  const source = options.wind;
  let density = options.airDensity;
  let wind: Vec3;
  if (typeof source === 'function') wind = vec(source(time), 'wind(time)');
  else if (source && typeof source === 'object' && typeof (source as FlowField).sample === 'function') {
    const flow = source as FlowField;
    const at = flow.sample(centre[0], centre[1], centre[2], time, flowSample);
    wind = vec(at.velocity, 'wind.sample(...).velocity');
    if (density === undefined) density = num(at.density, 0, 'wind.sample(...).density', 0, 2000);
  } else wind = vec(source ?? [0, 0, 0], 'wind');
  const substeps = num(options.substeps, 30, 'substeps', 1, MAX_GPU_CLOTH_SUBSTEPS);
  if (!Number.isInteger(substeps))
    throw clothError(`GPUCloth substeps is ${substeps}; pass a whole number from 1 to 64.`);
  return {
    gravity: [g[0] * s, g[1] * s, g[2] * s],
    wind,
    turbulence: num(options.turbulence, 0.25, 'turbulence', 0, 1),
    dragK: 0.5 * num(density, 1.2, 'airDensity', 0, 2000) * num(options.drag, 1.17, 'drag', 0, 10),
    compliance: [
      num(options.stretchCompliance, 0, 'stretchCompliance', 0),
      num(options.shearCompliance, 0, 'shearCompliance', 0),
      num(options.bendCompliance, topology.bendCompliance, 'bendCompliance', 0),
    ],
    damping: num(options.damping, topology.damping, 'damping', 0, 1000),
    friction: num(options.friction, 0.4, 'friction', 0, 10),
    thickness: num(options.thickness, topology.thickness, 'thickness', 0, 10),
    timestep: num(options.timestep, 1 / 60, 'timestep', 1 / 480, 1 / 15),
    substeps,
    paused: options.paused === undefined ? false : !!options.paused,
    tethers: options.tethers === undefined ? true : !!options.tethers,
    tetherSlack: num(options.tetherSlack, 0.01, 'tetherSlack', 0, 10),
  };
}

/** Builds the cloth's fixed parts from a soft-body description with triangles; `alignment` is the edge colours' padding. */
export function buildClothTopology(
  desc: SoftBodyDesc,
  uvs: ArrayLike<number> | undefined,
  alignment = 16,
): ClothTopology {
  const d = desc as unknown as {
    positions?: number[];
    edgePairs?: number[];
    edgeKinds?: number[];
    bendPairs?: number[];
    triangles?: number[];
    grid?: { nu: number; nv: number; wrap: boolean } | null;
    radius?: number | null;
    gravity?: number;
    damping?: number;
    pinned?: Set<number>;
    resolvedMasses?: () => number[];
  };
  if (!d || !Array.isArray(d.positions) || typeof d.resolvedMasses !== 'function')
    throw clothError(
      'GPUCloth needs a SoftBodyDesc from @margoengine/physics/soft (cloth, clothAnisotropic or trimesh).',
    );
  const count = d.positions.length / 3;
  if (count < 3 || count > MAX_GPU_CLOTH_PARTICLES)
    throw clothError(`GPUCloth holds 3 to ${MAX_GPU_CLOTH_PARTICLES} particles, not ${count}.`);
  const tris = d.triangles ?? [];
  if (tris.length === 0)
    throw clothError(
      'GPUCloth draws triangles: build the description with SoftBodyDesc.cloth, clothAnisotropic or trimesh.',
    );
  if (d.grid?.wrap)
    throw clothError(
      'GPUCloth does not take a clothTube (its seam); build it as a trimesh, or step it on the CPU with SoftBodies.',
    );
  const rest = Float32Array.from(d.positions);
  const masses = Float32Array.from(d.resolvedMasses());
  for (let i = 0; i < count; i++)
    if (!(masses[i]! > 0))
      throw clothError(`GPUCloth particle ${i} has mass ${masses[i]}; give every particle a positive mass.`);

  // Each particle's share of area (a third of each triangle it is in) and the triangles at each particle.
  const area = new Float32Array(count);
  const degree = new Uint32Array(count + 1);
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const ax = rest[b * 3]! - rest[a * 3]!,
      ay = rest[b * 3 + 1]! - rest[a * 3 + 1]!,
      az = rest[b * 3 + 2]! - rest[a * 3 + 2]!,
      bx = rest[c * 3]! - rest[a * 3]!,
      by = rest[c * 3 + 1]! - rest[a * 3 + 1]!,
      bz = rest[c * 3 + 2]! - rest[a * 3 + 2]!;
    const third = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 6;
    for (const k of [a, b, c]) {
      area[k] = area[k]! + third;
      degree[k + 1]!++;
    }
  }
  for (let i = 0; i < count; i++) degree[i + 1] = degree[i + 1]! + degree[i]!;
  const adjacency = new Uint32Array(count + 1 + tris.length);
  adjacency.set(degree, 0);
  const fill = degree.slice(0, count);
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) adjacency[count + 1 + fill[tris[t + k]!]!++] = t / 3;

  // Texture coordinates: given, the grid's, or the rest shape laid flat on its two longest extents.
  let uv: Float32Array;
  if (uvs) {
    if (uvs.length !== count * 2)
      throw clothError(`GPUCloth uvs need two numbers a particle: ${count * 2}, not ${uvs.length}.`);
    uv = Float32Array.from(uvs);
    if (!uv.every(Number.isFinite)) throw clothError('GPUCloth uvs must be finite numbers.');
  } else if (d.grid) {
    const { nu, nv } = d.grid;
    uv = new Float32Array(count * 2);
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        uv[(i * nv + j) * 2] = i / (nu - 1);
        uv[(i * nv + j) * 2 + 1] = j / (nv - 1);
      }
  } else {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < rest.length; i++) {
      min[i % 3] = Math.min(min[i % 3]!, rest[i]!);
      max[i % 3] = Math.max(max[i % 3]!, rest[i]!);
    }
    const size = [0, 1, 2].map((k) => max[k]! - min[k]!);
    const [ua, va] = [0, 1, 2].sort((a, b) => size[b]! - size[a]! || a - b) as [number, number, number];
    uv = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      uv[i * 2] = size[ua]! > 0 ? (rest[i * 3 + ua]! - min[ua]!) / size[ua]! : 0;
      uv[i * 2 + 1] = size[va]! > 0 ? (rest[i * 3 + va]! - min[va]!) / size[va]! : 0;
    }
  }

  // Edges: the description's structural and shear edges, then its bend edges, each with its rest length.
  const list: number[] = [];
  const push = (pairs: number[] | undefined, kind: (e: number) => number): void => {
    if (!pairs) return;
    for (let e = 0; e < pairs.length; e += 2) {
      const i = pairs[e]!,
        j = pairs[e + 1]!;
      if (i === j || i >= count || j >= count) continue;
      list.push(i, j, kind(e / 2));
    }
  };
  push(d.edgePairs, (e) => (d.edgeKinds?.[e] === THREAD_SHEAR ? EDGE_SHEAR : EDGE_STRETCH));
  push(d.bendPairs, () => EDGE_BEND);
  const edgeCount = list.length / 3;
  // Greedy colouring in edge order (deterministic): an edge takes the lowest colour neither end has yet.
  const used = new Uint32Array(count);
  const color = new Uint8Array(edgeCount);
  let colors = 0;
  let shortest = Infinity;
  const length = new Float32Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    const i = list[e * 3]!,
      j = list[e * 3 + 1]!;
    const free = ~(used[i]! | used[j]!) >>> 0;
    if (free === 0)
      throw clothError(
        `GPUCloth particle ${used[i] === 0xffffffff ? i : j} has more than ${MAX_GPU_CLOTH_DEGREE} edges; use a mesh with fewer edges a particle, or SoftBodies on the CPU.`,
      );
    const c = 31 - Math.clz32(free & -free);
    color[e] = c;
    used[i] = used[i]! | (1 << c);
    used[j] = used[j]! | (1 << c);
    colors = Math.max(colors, c + 1);
    length[e] = Math.hypot(
      rest[i * 3]! - rest[j * 3]!,
      rest[i * 3 + 1]! - rest[j * 3 + 1]!,
      rest[i * 3 + 2]! - rest[j * 3 + 2]!,
    );
    if (list[e * 3 + 2] !== EDGE_BEND && length[e]! > 0) shortest = Math.min(shortest, length[e]!);
  }
  const perColor = new Array<number>(colors).fill(0);
  for (let e = 0; e < edgeCount; e++) perColor[color[e]!]!++;
  const ranges: [number, number][] = [];
  let at = 0;
  for (let c = 0; c < colors; c++) {
    const padded = Math.ceil(perColor[c]! / alignment) * alignment;
    ranges.push([at, padded]);
    at += padded;
  }
  const edges = new Uint32Array(at * 4).fill(NO_EDGE);
  const bits = new Float32Array(1),
    bitsU = new Uint32Array(bits.buffer);
  const next = ranges.map(([start]) => start);
  for (let e = 0; e < edgeCount; e++) {
    const o = next[color[e]!]!++ * 4;
    edges[o] = list[e * 3]!;
    edges[o + 1] = list[e * 3 + 1]!;
    bits[0] = length[e]!;
    edges[o + 2] = bitsU[0]!;
    edges[o + 3] = list[e * 3 + 2]!;
  }

  let invMassSum = 0;
  for (let i = 0; i < count; i++) invMassSum += 1 / masses[i]!;
  // The CPU cloth's bend edges: 10 Hz on the two masses they join, k = (2 pi f)^2 / (w_i + w_j), so alpha = (w_i + w_j) / (2 pi f)^2.
  const bendCompliance = (2 * (invMassSum / count)) / (2 * Math.PI * 10) ** 2;
  const radius = d.radius ?? null;
  return {
    count,
    rest,
    masses,
    area,
    triangles: Uint32Array.from(tris),
    uvs: uv,
    adjacency,
    edges,
    colors: ranges,
    pairs: Uint32Array.from(list),
    gravityScale: Number.isFinite(d.gravity) ? d.gravity! : 1,
    damping: Number.isFinite(d.damping) ? d.damping! : 0,
    thickness: radius !== null && radius >= 0 ? radius : Number.isFinite(shortest) ? shortest / 2 : 0.01,
    bendCompliance,
  };
}

/**
 * Each particle's nearest pinned particle along the cloth and the rest distance to it (Dijkstra over the structural and
 * shear edges from every pin at once), two u32 a particle: the pin's index (0xffffffff for none, and for a pin itself)
 * and the distance's float bits.
 */
export function buildClothTethers(topology: ClothTopology, pinned: Iterable<number>): Uint32Array {
  const N = topology.count,
    out = new Uint32Array(N * 2),
    outF = new Float32Array(out.buffer),
    dist = new Float64Array(N).fill(Infinity),
    anchor = new Uint32Array(N).fill(NO_EDGE);
  const { pairs, rest } = topology;
  // Neighbours by particle (compressed rows), each with its rest length.
  const degree = new Uint32Array(N + 1);
  for (let e = 0; e < pairs.length; e += 3)
    if (pairs[e + 2] !== EDGE_BEND) {
      degree[pairs[e]! + 1]!++;
      degree[pairs[e + 1]! + 1]!++;
    }
  for (let i = 0; i < N; i++) degree[i + 1] = degree[i + 1]! + degree[i]!;
  const next = new Uint32Array(degree[N]!),
    length = new Float64Array(degree[N]!),
    fill = degree.slice(0, N);
  for (let e = 0; e < pairs.length; e += 3) {
    if (pairs[e + 2] === EDGE_BEND) continue;
    const i = pairs[e]!,
      j = pairs[e + 1]!,
      l = Math.hypot(
        rest[i * 3]! - rest[j * 3]!,
        rest[i * 3 + 1]! - rest[j * 3 + 1]!,
        rest[i * 3 + 2]! - rest[j * 3 + 2]!,
      );
    next[fill[i]!] = j;
    length[fill[i]!++] = l;
    next[fill[j]!] = i;
    length[fill[j]!++] = l;
  }
  // A binary heap of particles by distance, ties by index, so the result does not depend on the order of the pins.
  const heap: number[] = [];
  const less = (a: number, b: number): boolean => dist[a]! < dist[b]! || (dist[a] === dist[b] && a < b);
  const push = (i: number): void => {
    heap.push(i);
    for (let k = heap.length - 1; k > 0; ) {
      const up = (k - 1) >> 1;
      if (!less(heap[k]!, heap[up]!)) break;
      [heap[k], heap[up]] = [heap[up]!, heap[k]!];
      k = up;
    }
  };
  const pop = (): number => {
    const top = heap[0]!,
      last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let k = 0; ; ) {
        const l = 2 * k + 1,
          r = l + 1;
        let m = k;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === k) break;
        [heap[k], heap[m]] = [heap[m]!, heap[k]!];
        k = m;
      }
    }
    return top;
  };
  for (const i of pinned) {
    dist[i] = 0;
    anchor[i] = i;
    push(i);
  }
  const done = new Uint8Array(N);
  while (heap.length) {
    const i = pop();
    if (done[i]) continue;
    done[i] = 1;
    for (let k = degree[i]!; k < degree[i + 1]!; k++) {
      const j = next[k]!,
        d = dist[i]! + length[k]!;
      if (d < dist[j]! || (d === dist[j] && anchor[i]! < anchor[j]!)) {
        dist[j] = d;
        anchor[j] = anchor[i]!;
        push(j);
      }
    }
  }
  for (let i = 0; i < N; i++) {
    out[i * 2] = anchor[i] === i ? NO_EDGE : anchor[i]!;
    outF[i * 2 + 1] = Number.isFinite(dist[i]) ? dist[i]! : 0;
  }
  return out;
}

/** One pin: a particle held at a point, or carried by a body. */
export interface ClothPin {
  index: number;
  point: Vec3;
  body: PhysicsBody | null;
  /** Where the pin was when the last step ended (the start of the next). */
  from: Vec3;
}

/** One collider as the cloth holds it; its pose is read each frame. */
export class ClothCollider {
  /** The shape it has. */
  readonly shape: GPUClothShape['shape'];
  /** @internal */ readonly desc: GPUClothShape;
  private pos: Vec3;
  private rot: Quat;
  /** Coulomb friction with the cloth, or undefined for the cloth's. */
  friction: number | undefined;
  /** The body it rides on, or null. */
  readonly body: PhysicsBody | null;
  /** @internal Pose at the end of the last step: position then rotation. */
  from: number[] | null = null;
  /** @internal Set by the cloth that holds it. */
  removed = false;
  /** @internal */ onRemove: (() => void) | null = null;

  /** @internal Use {@link GPUCloth.addCollider}. */
  constructor(desc: GPUClothColliderDesc) {
    if (!desc || typeof desc !== 'object')
      throw clothError('A GPUCloth collider is an object such as {shape: "sphere", radius}.');
    switch (desc.shape) {
      case 'sphere':
        num(desc.radius, NaN, 'sphere radius', 0);
        this.desc = { shape: 'sphere', radius: desc.radius };
        break;
      case 'capsule':
        num(desc.radius, NaN, 'capsule radius', 0);
        num(desc.halfHeight, NaN, 'capsule halfHeight', 0);
        this.desc = { shape: 'capsule', radius: desc.radius, halfHeight: desc.halfHeight };
        break;
      case 'box': {
        const h = vec(desc.halfExtents, 'box halfExtents');
        if (!h.every((x) => x >= 0)) throw clothError('GPUCloth box halfExtents must be 0 or more.');
        this.desc = { shape: 'box', halfExtents: h };
        break;
      }
      case 'plane':
        this.desc = { shape: 'plane' };
        break;
      case 'sdf': {
        const f = desc.sdf;
        if (!f || !(f.data instanceof Float32Array) || !f.size || f.size.length !== 3)
          throw clothError(
            'A GPUCloth sdf collider needs {data: Float32Array, size, min, max} (a MeshSDF passes as it is).',
          );
        const [x, y, z] = f.size;
        if (![x, y, z].every((n) => Number.isInteger(n) && n >= 2) || f.data.length !== x * y * z)
          throw clothError(
            `GPUCloth sdf size ${f.size.join(' x ')} must be whole numbers of 2 or more matching data (${f.data.length}).`,
          );
        const min = vec(f.min, 'sdf min'),
          max = vec(f.max, 'sdf max');
        if (![0, 1, 2].every((k) => max[k]! > min[k]!))
          throw clothError('GPUCloth sdf max must be above min on every axis.');
        if (!f.data.every(Number.isFinite)) throw clothError('GPUCloth sdf data must be finite distances.');
        this.desc = { shape: 'sdf', sdf: { data: f.data, size: [x, y, z], min, max } };
        break;
      }
      default:
        throw clothError(
          `GPUCloth collider shape ${String((desc as { shape?: unknown }).shape)}; use sphere, capsule, box, plane or sdf.`,
        );
    }
    this.shape = this.desc.shape;
    this.pos = vec(desc.position ?? [0, 0, 0], 'collider position');
    this.rot =
      desc.shape === 'plane' && desc.normal !== undefined
        ? fromUp(vec(desc.normal, 'plane normal'))
        : quat(desc.rotation ?? [0, 0, 0, 1], 'collider rotation');
    this.friction = desc.friction === undefined ? undefined : num(desc.friction, 0, 'collider friction', 0, 10);
    this.body = desc.body ?? null;
    if (this.body && typeof (this.body as { position?: unknown }).position !== 'object')
      throw clothError('A GPUCloth collider body is a PhysicsBody of @margoengine/physics.');
  }
  /** Position in the world, or on its body. Setting it moves the collider over the next step. */
  get position(): Vec3 {
    return this.pos;
  }
  set position(value: Vec3) {
    this.pos = vec(value, 'collider position');
  }
  /** Rotation [x, y, z, w] in the world, or on its body. */
  get rotation(): Quat {
    return this.rot;
  }
  set rotation(value: Quat) {
    this.rot = quat(value, 'collider rotation');
  }
  /** Stops the cloth meeting it. */
  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.onRemove?.();
  }
  /** @internal The world pose now: position then rotation, seven numbers. */
  pose(): number[] {
    if (!this.body) return [...this.pos, ...this.rot];
    if (!this.body.valid)
      throw clothError('A GPUCloth collider rides on a removed body; remove the collider first.', 'state');
    const p = this.body.position,
      q = this.body.rotation as unknown as Quat,
      o = rotate(q, this.pos),
      r = mulQuat(q, this.rot);
    return [p[0] + o[0], p[1] + o[1], p[2] + o[2], ...r];
  }
}

/** The rotation taking +y to `n`. */
function fromUp(n: Vec3): Quat {
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!(l > 0)) throw clothError('GPUCloth plane normal must have a length.');
  const [x, y, z] = [n[0] / l, n[1] / l, n[2] / l];
  if (y < -0.999999) return [1, 0, 0, 0];
  // Half-way quaternion between (0, 1, 0) and n: axis (0, 1, 0) x n = (z, 0, -x), w = 1 + y, normalised.
  const q = [z, 0, -x, 1 + y];
  const m = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
  return [q[0]! / m, 0, q[2]! / m, q[3]! / m];
}
/** Rotates `v` by the unit quaternion `q`. */
export function rotate(q: ArrayLike<number>, v: ArrayLike<number>): Vec3 {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  const tx = 2 * (y * v[2]! - z * v[1]!),
    ty = 2 * (z * v[0]! - x * v[2]!),
    tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}
function mulQuat(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** The packed records of one frame's steps, the same bytes the GPU and the CPU twin read. */
export interface ClothFrame {
  /** {@link GPU_CLOTH_SLOT_FLOATS} floats a substep. */
  slots: Float32Array;
  slotCount: number;
  /** Substeps a step: the surface pass (normals for the drag, and the draw vertices) runs at the end of each step. */
  substeps: number;
  /** Two vec4 a pin: (from, index bits), (to, 0). */
  pins: Float32Array;
  pinCount: number;
  /** {@link GPU_CLOTH_COLLIDER_FLOATS} floats a collider. */
  colliders: Float32Array;
  colliderCount: number;
  /** Every sdf collider's samples, end to end. */
  sdf: Float32Array;
  /** Whether the tether pass runs. */
  tethers: boolean;
}

/**
 * Packs `steps` steps of `params` from `time`: a slot a substep, the pins and the colliders moving from the pose they had
 * when the last step ended to where they are now, spread evenly over the frame's substeps.
 */
export function packClothFrame(
  params: ResolvedClothParams,
  count: number,
  steps: number,
  time: number,
  pins: readonly ClothPin[],
  colliders: readonly ClothCollider[],
  sdf: Float32Array,
): ClothFrame {
  const sub = params.substeps,
    total = steps * sub,
    dt = params.timestep / sub;
  const slots = new Float32Array(Math.max(1, total) * GPU_CLOTH_SLOT_FLOATS);
  const slotsU = new Uint32Array(slots.buffer);
  for (let s = 0; s < Math.max(1, total); s++) {
    const o = s * GPU_CLOTH_SLOT_FLOATS;
    slots[o] = dt;
    slots[o + 1] = total ? s / total : 1;
    slots[o + 2] = total ? (s + 1) / total : 1;
    // Each step's start is the sum of the steps before it, added one at a time, so a run split into other frames has the same times.
    if (s > 0 && s % sub === 0) time += params.timestep;
    slots[o + 3] = time + ((s % sub) + 1) * dt;
    slots.set(params.gravity, o + 4);
    slots[o + 7] = Math.exp(-params.damping * dt);
    slots.set(params.wind, o + 8);
    slots[o + 11] = params.turbulence;
    slots[o + 12] = params.dragK;
    slots[o + 13] = params.thickness;
    slots[o + 14] = params.friction;
    slotsU[o + 15] = count;
    slots.set(params.compliance, o + 16);
    slotsU[o + 19] = pins.length;
    slotsU[o + 20] = colliders.length;
    slots[o + 21] = 1 + params.tetherSlack;
  }
  const pinData = new Float32Array(Math.max(1, pins.length) * 8);
  const pinU = new Uint32Array(pinData.buffer);
  for (let k = 0; k < pins.length; k++) {
    const pin = pins[k]!;
    const to = pinPoint(pin);
    pinData.set(pin.from, k * 8);
    pinU[k * 8 + 3] = pin.index;
    pinData.set(to, k * 8 + 4);
  }
  const data = new Float32Array(Math.max(1, colliders.length) * GPU_CLOTH_COLLIDER_FLOATS);
  const dataU = new Uint32Array(data.buffer);
  let sdfAt = 0;
  for (let c = 0; c < colliders.length; c++) {
    const col = colliders[c]!,
      o = c * GPU_CLOTH_COLLIDER_FLOATS,
      now = col.pose(),
      from = col.from ?? now,
      d = col.desc;
    dataU[o] = { sphere: SHAPE_SPHERE, capsule: SHAPE_CAPSULE, box: SHAPE_BOX, plane: SHAPE_PLANE, sdf: SHAPE_SDF }[
      d.shape
    ];
    if (d.shape === 'sphere') data[o + 2] = d.radius;
    if (d.shape === 'capsule') {
      data[o + 2] = d.radius;
      data[o + 3] = d.halfHeight;
    }
    data.set(from.slice(0, 3), o + 4);
    data[o + 7] = col.friction ?? params.friction;
    data.set(from.slice(3, 7), o + 8);
    data.set(now.slice(0, 3), o + 12);
    data.set(now.slice(3, 7), o + 16);
    if (d.shape === 'box') data.set(d.halfExtents, o + 20);
    if (d.shape === 'sdf') {
      const f = d.sdf;
      dataU[o + 1] = sdfAt;
      data.set(f.min, o + 20);
      for (let k = 0; k < 3; k++) data[o + 24 + k] = (f.max[k]! - f.min[k]!) / (f.size[k]! - 1);
      for (let k = 0; k < 3; k++) dataU[o + 28 + k] = f.size[k]!;
      sdfAt += f.data.length;
    }
  }
  return {
    slots,
    slotCount: total,
    substeps: sub,
    pins: pinData,
    pinCount: pins.length,
    colliders: data,
    colliderCount: colliders.length,
    sdf,
    tethers: params.tethers && pins.length > 0,
  };
}

/** Where a pin is now: its point in the world, or its point on its body. */
export function pinPoint(pin: ClothPin): Vec3 {
  if (!pin.body) return pin.point;
  if (!pin.body.valid)
    throw clothError(`GPUCloth particle ${pin.index} is attached to a removed body; unpin it first.`, 'state');
  const p = pin.body.position,
    o = rotate(pin.body.rotation, pin.point);
  return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
}

/** FNV-1a over the bytes of a state, as eight hex digits: equal for two runs that did the same. */
export function clothStateHash(state: Float32Array): string {
  const bytes = new Uint8Array(state.buffer, state.byteOffset, state.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

const GREEN = [0.2, 0.9, 0.3],
  RED = [1, 0.15, 0.1],
  GREY = [0.55, 0.55, 0.6, 1],
  YELLOW = [1, 0.85, 0.1, 1],
  CYAN = [0.2, 0.85, 1, 1],
  BLUE = [0.4, 0.6, 1, 1],
  WHITE = [1, 1, 1, 1];

/** The debug lines of a cloth at `state` (see {@link GPUClothDebugOptions}). */
export function clothDebugLines(
  state: Float32Array,
  normals: Float32Array,
  topology: ClothTopology,
  pins: readonly ClothPin[],
  colliders: readonly ClothCollider[],
  wind: Vec3,
  options: GPUClothDebugOptions = {},
): DebugLines {
  if (!options || typeof options !== 'object') throw clothError('GPUCloth.debugRender options must be an object.');
  const range = num(options.strainRange, 0.1, 'debug strainRange', 1e-6, 10),
    normalLength = num(options.normalLength, 0.05, 'debug normalLength', 0, 100);
  const v: number[] = [],
    col: number[] = [];
  const line = (a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>): void => {
    v.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
    col.push(c[0]!, c[1]!, c[2]!, c[3]!, c[0]!, c[1]!, c[2]!, c[3]!);
  };
  const at = (i: number): Vec3 => [state[i * 4]!, state[i * 4 + 1]!, state[i * 4 + 2]!];
  const { pairs, rest } = topology;
  if (options.edges ?? true)
    for (let e = 0; e < pairs.length; e += 3) {
      if (pairs[e + 2] === EDGE_BEND && !options.bendEdges) continue;
      const i = pairs[e]!,
        j = pairs[e + 1]!,
        a = at(i),
        b = at(j);
      if (pairs[e + 2] === EDGE_BEND) {
        line(a, b, GREY);
        continue;
      }
      const L = Math.hypot(
        rest[i * 3]! - rest[j * 3]!,
        rest[i * 3 + 1]! - rest[j * 3 + 1]!,
        rest[i * 3 + 2]! - rest[j * 3 + 2]!,
      );
      const strain = L > 0 ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / L - 1 : 0;
      const t = Math.min(Math.max(strain / range, 0), 1);
      line(a, b, [
        GREEN[0]! + (RED[0]! - GREEN[0]!) * t,
        GREEN[1]! + (RED[1]! - GREEN[1]!) * t,
        GREEN[2]! + (RED[2]! - GREEN[2]!) * t,
        1,
      ]);
    }
  else if (options.bendEdges)
    for (let e = 0; e < pairs.length; e += 3)
      if (pairs[e + 2] === EDGE_BEND) line(at(pairs[e]!), at(pairs[e + 1]!), GREY);
  if (options.pins ?? true)
    for (const pin of pins) {
      const p = at(pin.index),
        s = 0.03;
      line([p[0] - s, p[1], p[2]], [p[0] + s, p[1], p[2]], YELLOW);
      line([p[0], p[1] - s, p[2]], [p[0], p[1] + s, p[2]], YELLOW);
      line([p[0], p[1], p[2] - s], [p[0], p[1], p[2] + s], YELLOW);
    }
  if (options.normals)
    for (let i = 0; i < topology.count; i++) {
      const p = at(i);
      line(
        p,
        [
          p[0] + normals[i * 4]! * normalLength,
          p[1] + normals[i * 4 + 1]! * normalLength,
          p[2] + normals[i * 4 + 2]! * normalLength,
        ],
        BLUE,
      );
    }
  if (options.colliders ?? true) for (const c of colliders) outline(c, line);
  if ((options.wind ?? true) && Math.hypot(wind[0], wind[1], wind[2]) > 0) {
    const m = [0, 0, 0];
    for (let i = 0; i < topology.count; i++)
      for (let k = 0; k < 3; k++) m[k] = m[k]! + state[i * 4 + k]! / topology.count;
    const tip = [m[0]! + wind[0] * 0.1, m[1]! + wind[1] * 0.1, m[2]! + wind[2] * 0.1];
    line(m, tip, WHITE);
    const back = [m[0]! + wind[0] * 0.08, m[1]! + wind[1] * 0.08 + 0.02, m[2]! + wind[2] * 0.08];
    line(tip, back, WHITE);
  }
  return { vertices: new Float32Array(v), colors: new Float32Array(col) };
}

/** A collider's outline: three circles of a sphere, a capsule's rings and lines, a box's edges, a plane's square, an sdf's box. */
function outline(
  c: ClothCollider,
  line: (a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>) => void,
): void {
  const pose = c.pose(),
    x = pose.slice(0, 3),
    q = pose.slice(3, 7),
    world = (p: ArrayLike<number>): number[] => {
      const r = rotate(q, p);
      return [x[0]! + r[0], x[1]! + r[1], x[2]! + r[2]];
    };
  const seg = (a: ArrayLike<number>, b: ArrayLike<number>): void => line(world(a), world(b), CYAN);
  const ring = (r: number, axis: number, y: number): void => {
    for (let k = 0; k < 24; k++) {
      const p = (t: number): number[] => {
        const a = (t * 2 * Math.PI) / 24,
          s = [Math.cos(a) * r, Math.sin(a) * r];
        return axis === 1 ? [s[0]!, y, s[1]!] : axis === 0 ? [y, s[0]!, s[1]!] : [s[0]!, s[1]!, y];
      };
      seg(p(k), p(k + 1));
    }
  };
  const box = (lo: ArrayLike<number>, hi: ArrayLike<number>): void => {
    const corner = (m: number): number[] => [m & 1 ? hi[0]! : lo[0]!, m & 2 ? hi[1]! : lo[1]!, m & 4 ? hi[2]! : lo[2]!];
    for (let m = 0; m < 8; m++) for (const bit of [1, 2, 4]) if (!(m & bit)) seg(corner(m), corner(m | bit));
  };
  const d = c.desc;
  if (d.shape === 'sphere') for (const axis of [0, 1, 2]) ring(d.radius, axis, 0);
  else if (d.shape === 'capsule') {
    ring(d.radius, 1, d.halfHeight);
    ring(d.radius, 1, -d.halfHeight);
    for (const [a, b] of [
      [d.radius, 0],
      [-d.radius, 0],
      [0, d.radius],
      [0, -d.radius],
    ] as const)
      seg([a, -d.halfHeight, b], [a, d.halfHeight, b]);
  } else if (d.shape === 'box')
    box(
      d.halfExtents.map((h) => -h),
      d.halfExtents,
    );
  else if (d.shape === 'plane') {
    const s = 2;
    seg([-s, 0, -s], [s, 0, -s]);
    seg([s, 0, -s], [s, 0, s]);
    seg([s, 0, s], [-s, 0, s]);
    seg([-s, 0, s], [-s, 0, -s]);
    seg([0, 0, 0], [0, 0.3, 0]);
  } else box(d.sdf.min, d.sdf.max);
}
