/// <reference lib="esnext.disposable" preserve="true" />
// Breakable rigid bodies over Margo's own @margoengine/physics kernel (BREAK-01, X-42, X-43).
// Clean-room implementation citing Raghavachary (2002), Parker & O'Brien (2009),
// Müller, Chentanez & Kim (2013), and Mirtich (1996).
import type { EngineKernel, Geometry, Mesh, PbrMaterial } from '@margoengine/core';
import { Mesh as CoreMesh, meshRuntime } from '@margoengine/core/extension';
import type { PhysicsBody } from '../body.js';
import type { DebugLines } from '../debug.js';
import { eulerToQuat, rotateVec, type Quat, type Vec3 } from '../math.js';
import type { ContactForceEvent, Physics, PhysicsAttachment } from '../physics.js';
import type { ColliderGeometry, ColliderOptions, CompoundPart, InteractionGroups } from '../shapes.js';
import {
  buildBreakableDebugLines,
  type BreakableDebugRenderOptions,
  type DebugBodyView,
  type DebugIslandView,
} from './debug.js';
import { breakableFault, breakableInput } from './errors.js';
import { BondRecord, findConnectedComponents, type BreakableBond } from './graph.js';
import {
  buildIslandMeshes,
  combineCellMassProperties,
  createBoxPolyhedron,
  createPolyhedronFromGeometry,
  generateVoronoiSites,
  polyhedronBounds,
  voronoiFracturePolyhedron,
  type BreakableCell,
  type BreakableFracturePattern,
  type BreakableMaterialGroup,
  type BreakablePolyhedron,
} from './polyhedron.js';

/** Fracture generation strategy: upfront Voronoi cells (`'prefractured'`) or runtime impact-clustered (`'impact'`). */
export type BreakableFractureMode = 'prefractured' | 'impact';

/** Cell metadata passed to a custom {@link BreakableBodyOptions.anchors} predicate. */
export interface BreakableAnchorQuery {
  /** Zero-based cell index. */
  readonly index: number;
  /** Cell centre of mass in the parent body's local frame. */
  readonly centroid: readonly [number, number, number];
  /** Cell AABB minimum corner in the parent body's local frame. */
  readonly boundsMin: readonly [number, number, number];
  /** Cell AABB maximum corner in the parent body's local frame. */
  readonly boundsMax: readonly [number, number, number];
  /** Cell volume in cubic metres. */
  readonly volume: number;
  /** Cell mass in kilograms. */
  readonly mass: number;
  /** Parent body AABB minimum corner in local space. */
  readonly bodyBoundsMin: readonly [number, number, number];
  /** Parent body AABB maximum corner in local space. */
  readonly bodyBoundsMax: readonly [number, number, number];
}

/** How grounded/supported anchor chunks are selected on a {@link BreakableBody}. */
export type BreakableAnchorMode =
  | 'none'
  | 'bottom'
  | 'perimeter'
  | 'all-boundary'
  | readonly number[]
  | ((cell: BreakableAnchorQuery) => boolean);

/** Information passed to a custom per-bond strength callback. */
export interface BreakableBondInput {
  /** First cell index. */
  readonly cellA: number;
  /** Second cell index. */
  readonly cellB: number;
  /** Shared cut-face area in square metres. */
  readonly area: number;
  /** Shared cut-face centroid in the parent body's local frame. */
  readonly centroid: readonly [number, number, number];
  /** Unit normal from `cellA` toward `cellB`. */
  readonly normal: readonly [number, number, number];
}

/** Event delivered to `onBreak` callbacks when a {@link BreakableBody} fractures and spawns fragments. */
export interface BreakEvent {
  /** The breakable body that fractured. */
  readonly body: BreakableBody;
  /** World-space point where the fracturing impact or blast occurred. */
  readonly impactPoint: readonly [number, number, number];
  /** Scalar impulse magnitude (N·s) that triggered this fracture. */
  readonly impulse: number;
  /** Newly spawned dynamic fragments detached during this fracture. */
  readonly fragments: readonly BreakableFragment[];
}

/** Options for {@link BreakableWorld.applyExplosion} and {@link BreakableBody.applyExplosion}. */
export interface BreakableExplosionOptions {
  /** Upward lift share added to radial blast impulses so debris arcs upward (default `0.25`). */
  lift?: number;
}

/** Options for adding a breakable rigid body to a {@link BreakableWorld}. */
export interface BreakableBodyOptions {
  /** Box dimensions `[width, height, depth]` in metres. Ignored when `geometry` is passed; defaults to mesh bounds or `[1, 1, 1]`. */
  size?: Vec3;
  /** Closed convex mesh geometry to fracture instead of a box. */
  geometry?: ColliderGeometry;
  /** World position `[x, y, z]`. Defaults to `mesh.position` or `[0, 0, 0]`. */
  position?: Vec3;
  /** World rotation quaternion `[x, y, z, w]`. Defaults to `mesh.rotation` or `[0, 0, 0, 1]`. */
  rotation?: Quat;
  /** Initial rigid-body type (`'fixed'` by default when `anchors` is set, `'dynamic'` otherwise). */
  type?: 'dynamic' | 'fixed';
  /** `'prefractured'` builds Voronoi cells upfront; `'impact'` clusters cells around the first breaking impact (default `'prefractured'`). */
  fractureMode?: BreakableFractureMode;
  /** Number of Voronoi cells to generate, integer `2..256` (default `12`). */
  cellCount?: number;
  /** Explicit local-space Voronoi generator sites; overrides `cellCount` and `pattern`. */
  sites?: readonly Vec3[];
  /** Site distribution pattern when `sites` is omitted: `'uniform'`, `'brick'`, or `'radial'` (default `'uniform'`). */
  pattern?: BreakableFracturePattern;
  /** Deterministic integer seed for Voronoi site generation (default `1`). */
  seed?: number;
  /** Base impulse threshold in N·s required to sever a bond (default `25`). */
  bondStrength?: number;
  /** Optional callback returning an explicit impulse threshold in N·s for each bond. */
  bondStrengthFn?: (bond: BreakableBondInput) => number;
  /** Scale each bond's strength by `bond.area / meanArea` so thin necks break first (default `true`). */
  areaWeightedStrength?: boolean;
  /** Minimum contact impulse (N·s) before damage accumulates, filtering resting gravity weight (default `Math.max(0.5, bondStrength * 0.2)`). */
  minImpactImpulse?: number;
  /** Default world-space damage radius in metres for contact impacts (default `0.45 * maxExtent`). */
  impactRadius?: number;
  /** Which chunks stay grounded/anchored so unsupported overhangs detach and fall (default `'none'`). */
  anchors?: BreakableAnchorMode;
  /** Relative thickness tolerance for `'bottom'`, `'perimeter'`, and `'all-boundary'` anchors (default `0.06`). */
  anchorTolerance?: number;
  /** Material density in kg/m³ used for exact polyhedral mass and inertia (default `1`). */
  density?: number;
  /** Collider friction coefficient (default `0.5`). */
  friction?: number;
  /** Collider restitution coefficient (default `0.15`). */
  restitution?: number;
  /** Exterior material applied to spawned fragment meshes (defaults to intact `mesh.material`). */
  material?: PbrMaterial;
  /** Optional interior cut-face material; when set, each fragment spawns an interior child mesh for cut faces. */
  interiorMaterial?: PbrMaterial;
  /** Planar UV scale in 1/metres for generated exterior and interior UVs (default `1`). */
  uvScale?: number;
  /** Collision groups for the intact body and surviving anchored pieces. */
  collisionGroups?: number | InteractionGroups;
  /** Optional collision groups applied to detached debris fragments; overrides the world's `debrisCollisionGroups`. */
  debrisCollisionGroups?: number | InteractionGroups;
  /** If true, detached multi-chunk islands split immediately into individual chunk bodies (default `false`). */
  splitIslands?: boolean;
  /** If true, detached multi-chunk islands continue accumulating damage and can fracture again on secondary impacts (default `true`). */
  secondaryFracture?: boolean;
  /** Per-body callback fired whenever this body fractures and spawns fragments. */
  onBreak?: (event: BreakEvent) => void;
  /** Arbitrary user payload attached to this breakable body. */
  userData?: unknown;
}

/** What {@link BreakableWorld.takeSnapshot} returns: the live pieces' ids and the world's state words. */
export interface BreakableSnapshot {
  /** Ids of the live pieces, in order; a restore needs the same ones. */
  readonly islands: readonly number[];
  /** Bond damage, runtime splits, debris timers and contact impulses, as numbers. */
  readonly words: Float64Array;
}

/** Options for creating a {@link BreakableWorld}. */
export interface BreakableWorldOptions {
  /** Engine used to create fragment render meshes (auto-detected from core meshes passed to `add()` when omitted). */
  engine?: EngineKernel | null;
  /** Maximum active debris fragments kept alive before oldest fragments are recycled (default `128`). */
  maxDebris?: number;
  /** Debris lifetime in seconds before automatic removal; pass `Infinity` to keep forever (default `30`). */
  debrisLifetime?: number;
  /** Linear speed threshold in m/s below which debris counts toward fast sleep (default `0.15`). */
  debrisSleepThreshold?: number;
  /** Angular speed threshold in rad/s below which debris counts toward fast sleep (default `0.25`). */
  debrisAngularSleepThreshold?: number;
  /** Seconds a slow debris fragment must remain below sleep thresholds before sleeping (default `0.4`). */
  debrisSleepTime?: number;
  /** Optional collision groups applied to all spawned debris fragments unless overridden per body. */
  debrisCollisionGroups?: number | InteractionGroups;
  /** World-level callback fired whenever any breakable body fractures. */
  onBreak?: (event: BreakEvent) => void;
}

/** A spawned dynamic fragment detached from a {@link BreakableBody}. */
export interface BreakableFragment {
  /** Unique fragment identifier within its {@link BreakableWorld}. */
  readonly id: number;
  /** The parent breakable body this fragment detached from. */
  readonly parent: BreakableBody;
  /** Live dynamic rigid body simulating this fragment. */
  readonly body: PhysicsBody;
  /** Exterior render mesh (or combined mesh when no `interiorMaterial` was configured), or `null` headless. */
  readonly mesh: Mesh | null;
  /** Child mesh rendering interior cut faces when `interiorMaterial` was configured, or `null`. */
  readonly interiorMesh: Mesh | null;
  /** Combined render geometry centred on the fragment's centre of mass. */
  readonly geometry: Geometry;
  /** Exterior-only geometry centred on the fragment's centre of mass, or `null`. */
  readonly exteriorGeometry: Geometry | null;
  /** Interior cut-face geometry centred on the fragment's centre of mass, or `null`. */
  readonly interiorGeometry: Geometry | null;
  /** Planar-projected UV coordinates matching `geometry` vertices. */
  readonly uvs: Float32Array;
  /** Material groups partitioning `geometry.indices` into exterior (`0`) and interior (`1`) slots. */
  readonly materialGroups: readonly BreakableMaterialGroup[];
  /** Indices of the Voronoi cells belonging to this fragment. */
  readonly cellIndices: readonly number[];
  /** Exact enclosed volume in cubic metres. */
  readonly volume: number;
  /** Exact mass in kilograms. */
  readonly mass: number;
  /** True for detached dynamic debris managed by the debris budget and lifetime policy. */
  readonly isDebris: boolean;
  /** Elapsed simulation age in seconds since this fragment spawned. */
  readonly age: number;
  /** Whether the fragment's rigid body is currently sleeping. */
  readonly sleeping: boolean;
  /** True once this fragment has been removed by lifetime expiry, debris cap, reset, or disposal. */
  readonly removed: boolean;
}

interface ActiveIsland {
  readonly id: number;
  readonly owner: BreakableBody;
  readonly body: PhysicsBody;
  readonly mesh: Mesh | null;
  readonly interiorMesh: Mesh | null;
  readonly ownsMesh: boolean;
  readonly originOffset: [number, number, number];
  readonly cellIndices: number[];
  readonly anchored: boolean;
  readonly isDebris: boolean;
  readonly fragment: FragmentRecord | null;
  removed: boolean;
}

class FragmentRecord implements BreakableFragment {
  readonly id: number;
  readonly parent: BreakableBody;
  readonly body: PhysicsBody;
  readonly mesh: Mesh | null;
  readonly interiorMesh: Mesh | null;
  readonly geometry: Geometry;
  readonly exteriorGeometry: Geometry | null;
  readonly interiorGeometry: Geometry | null;
  readonly uvs: Float32Array;
  readonly materialGroups: readonly BreakableMaterialGroup[];
  readonly cellIndices: readonly number[];
  readonly volume: number;
  readonly mass: number;
  readonly isDebris = true;
  age = 0;
  slowTime = 0;
  removed = false;

  constructor(params: {
    id: number;
    parent: BreakableBody;
    body: PhysicsBody;
    mesh: Mesh | null;
    interiorMesh: Mesh | null;
    geometry: Geometry;
    exteriorGeometry: Geometry | null;
    interiorGeometry: Geometry | null;
    uvs: Float32Array;
    materialGroups: readonly BreakableMaterialGroup[];
    cellIndices: readonly number[];
    volume: number;
    mass: number;
  }) {
    this.id = params.id;
    this.parent = params.parent;
    this.body = params.body;
    this.mesh = params.mesh;
    this.interiorMesh = params.interiorMesh;
    this.geometry = params.geometry;
    this.exteriorGeometry = params.exteriorGeometry;
    this.interiorGeometry = params.interiorGeometry;
    this.uvs = params.uvs;
    this.materialGroups = params.materialGroups;
    this.cellIndices = params.cellIndices;
    this.volume = params.volume;
    this.mass = params.mass;
  }

  get sleeping(): boolean {
    return !this.removed && this.body.valid && this.body.sleeping;
  }
}

const sameSite = (a: Vec3 | null, b: Vec3 | null): boolean =>
  a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

const snapshotMismatch = () =>
  breakableFault(
    'state',
    'The breakable world has other pieces than the snapshot: restore it before a break or a removal, or take a new snapshot',
  );

/** Packs two collider handles into one exact map key (handles stay far below 2^26). */
const PAIR_KEY = 0x4000000;

interface PendingContactImpact {
  readonly island: ActiveIsland;
  readonly point: [number, number, number];
  readonly impulseVec: [number, number, number];
  readonly impulseMag: number;
}

function checkPositiveFinite(value: number, label: string): void {
  if (!(value > 0 && Number.isFinite(value)))
    throw breakableInput(`${label} must be a positive finite number (got ${value})`);
}

function checkNonNegativeFinite(value: number, label: string): void {
  if (!(value >= 0 && Number.isFinite(value)))
    throw breakableInput(`${label} must be a finite number >= 0 (got ${value})`);
}

function checkQuat(q: Quat): void {
  if (!Array.isArray(q) && !ArrayBuffer.isView(q)) throw breakableInput('Rotation must be a quaternion [x, y, z, w]');
  const [x, y, z, w] = q;
  const sq = q.length === 4 ? x * x + y * y + z * z + w * w : 0;
  if (!(sq > 0 && Number.isFinite(sq)))
    throw breakableInput('Rotation must be four finite numbers [x, y, z, w], not all zero');
}

function worldToParentLocal(
  worldPoint: Vec3,
  islandPos: Vec3,
  islandRot: Quat,
  originOffset: Vec3,
): [number, number, number] {
  const dx = worldPoint[0] - islandPos[0];
  const dy = worldPoint[1] - islandPos[1];
  const dz = worldPoint[2] - islandPos[2];
  const invRot: Quat = [-islandRot[0], -islandRot[1], -islandRot[2], islandRot[3]];
  const local = rotateVec(invRot, [dx, dy, dz]);
  return [local[0] + originOffset[0], local[1] + originOffset[1], local[2] + originOffset[2]];
}

function parentLocalToWorld(
  localPoint: Vec3,
  islandPos: Vec3,
  islandRot: Quat,
  originOffset: Vec3,
): [number, number, number] {
  const rel: Vec3 = [localPoint[0] - originOffset[0], localPoint[1] - originOffset[1], localPoint[2] - originOffset[2]];
  const turned = rotateVec(islandRot, rel);
  return [islandPos[0] + turned[0], islandPos[1] + turned[1], islandPos[2] + turned[2]];
}

/** The collider of an island: one convex hull for one cell, a compound of convex hulls about `centroid` for more. */
function cellsCollider(
  cells: readonly BreakableCell[],
  centroid: Vec3,
  settings: {
    density: number;
    friction: number;
    restitution: number;
    collisionGroups?: number | InteractionGroups;
  },
): ColliderOptions {
  // Every cell is a hull the kernel builds: voronoiFracturePolyhedron keeps only cells whose hull it has built.
  const common = { ...settings, contactForceEvents: true };
  if (cells.length === 1) return { shape: 'convexHull', points: cells[0]!.hullPoints, ...common };
  const parts: CompoundPart[] = cells.map((c) => ({
    shape: 'convexHull',
    points: c.hullPoints,
    offset: [c.centroid[0] - centroid[0], c.centroid[1] - centroid[1], c.centroid[2] - centroid[2]],
  }));
  return { shape: 'compound', parts, ...common };
}

function checkVec3(value: unknown, label: string): asserts value is Vec3 {
  const v = value as ArrayLike<number>;
  if (
    !(Array.isArray(value) || ArrayBuffer.isView(value)) ||
    v.length !== 3 ||
    !Number.isFinite(v[0]) ||
    !Number.isFinite(v[1]) ||
    !Number.isFinite(v[2])
  )
    throw breakableInput(`${label} must be [x, y, z], three finite numbers`);
}

/** A destructible rigid body managed by a {@link BreakableWorld}. */
export class BreakableBody {
  /** Unique identifier within its {@link BreakableWorld}. */
  readonly id: number;
  /** Original intact render mesh supplied to {@link BreakableWorld.add}, or `null` headless. */
  readonly mesh: Mesh | null;
  /** Fracture generation strategy for this body. */
  readonly fractureMode: BreakableFractureMode;
  /** Arbitrary user payload. */
  userData: unknown;

  /** @internal */
  readonly basePolyhedron: BreakablePolyhedron;
  /** @internal */
  readonly boundsMin: [number, number, number];
  /** @internal */
  readonly boundsMax: [number, number, number];
  /** @internal */
  readonly initialPosition: [number, number, number];
  /** @internal */
  readonly initialRotation: [number, number, number, number];
  /** @internal */
  readonly initialType: 'dynamic' | 'fixed';
  /** @internal */
  readonly isBox: boolean;
  /** @internal */
  readonly boxHalfExtents: [number, number, number];
  /** @internal */
  readonly cellCount: number;
  /** @internal */
  readonly customSites?: readonly Vec3[];
  /** @internal */
  readonly pattern: BreakableFracturePattern;
  /** @internal */
  readonly seed: number;
  /** @internal */
  readonly bondStrengthFn?: (bond: BreakableBondInput) => number;
  /** @internal */
  readonly areaWeightedStrength: boolean;
  /** @internal */
  readonly explicitMinImpactImpulse?: number;
  /** @internal */
  readonly defaultImpactRadius: number;
  /** @internal */
  readonly anchorMode: BreakableAnchorMode;
  /** @internal */
  readonly anchorTolerance: number;
  /** @internal */
  readonly density: number;
  /** @internal */
  readonly friction: number;
  /** @internal */
  readonly restitution: number;
  /** @internal */
  readonly exteriorMaterial?: PbrMaterial;
  /** @internal */
  readonly interiorMaterial?: PbrMaterial;
  /** @internal */
  readonly uvScale: number;
  /** @internal */
  readonly collisionGroups?: number | InteractionGroups;
  /** @internal */
  readonly debrisCollisionGroups?: number | InteractionGroups;
  /** @internal */
  readonly splitIslands: boolean;
  /** @internal */
  readonly secondaryFracture: boolean;
  /** @internal */
  readonly onBreakCallback?: (event: BreakEvent) => void;

  private readonly world: BreakableWorld;
  private _bondStrength: number;
  private _cells: BreakableCell[] = [];
  private _bonds: BondRecord[] = [];
  private _anchoredFlags: Uint8Array = new Uint8Array(0);
  private _islands: ActiveIsland[] = [];
  private _fragments: FragmentRecord[] = [];
  private _broken = false;
  private _removed = false;
  private _intactDamage = 0;
  /** The local point a runtime (`'impact'`) split clustered its cells around, or null before one. */
  private _impactSite: [number, number, number] | null = null;

  /** @internal */
  constructor(world: BreakableWorld, id: number, mesh: Mesh | null, options: BreakableBodyOptions) {
    this.world = world;
    this.id = id;
    this.mesh = mesh;
    this.userData = options.userData;

    // Resolve base convex polyhedron from explicit geometry, explicit box size, mesh geometry, or unit box.
    let poly: BreakablePolyhedron;
    let isBox = false;
    if (options.geometry) {
      poly = createPolyhedronFromGeometry(options.geometry);
    } else if (options.size) {
      checkVec3(options.size, 'Breakable size');
      poly = createBoxPolyhedron(options.size[0], options.size[1], options.size[2]);
      isBox = true;
    } else if (mesh?.geometry) {
      poly = createPolyhedronFromGeometry(mesh.geometry);
    } else {
      poly = createBoxPolyhedron(1, 1, 1);
      isBox = true;
    }
    this.basePolyhedron = poly;
    this.isBox = isBox;
    const b = polyhedronBounds(poly);
    this.boundsMin = b.min;
    this.boundsMax = b.max;
    this.boxHalfExtents = [(b.max[0] - b.min[0]) * 0.5, (b.max[1] - b.min[1]) * 0.5, (b.max[2] - b.min[2]) * 0.5];

    const pos = options.position ?? (mesh ? [mesh.position.x, mesh.position.y, mesh.position.z] : [0, 0, 0]);
    const rot =
      options.rotation ??
      (mesh ? eulerToQuat(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z) : ([0, 0, 0, 1] as const));
    checkVec3(pos, 'Breakable position');
    checkQuat(rot);
    this.initialPosition = [pos[0], pos[1], pos[2]];
    this.initialRotation = [rot[0], rot[1], rot[2], rot[3]];

    this.anchorMode = options.anchors ?? 'none';
    const hasAnchors = this.anchorMode !== 'none' && !(Array.isArray(this.anchorMode) && this.anchorMode.length === 0);
    this.initialType = options.type ?? (hasAnchors ? 'fixed' : 'dynamic');
    if (this.initialType !== 'dynamic' && this.initialType !== 'fixed')
      throw breakableInput(`Breakable body type must be 'dynamic' or 'fixed' (got ${String(this.initialType)})`);

    this.fractureMode = options.fractureMode ?? 'prefractured';
    if (this.fractureMode !== 'prefractured' && this.fractureMode !== 'impact')
      throw breakableInput(`fractureMode must be 'prefractured' or 'impact' (got ${String(this.fractureMode)})`);

    this.cellCount = options.cellCount ?? 12;
    if (!Number.isInteger(this.cellCount) || this.cellCount < 2 || this.cellCount > 256)
      throw breakableInput(`cellCount must be an integer from 2 to 256 (got ${this.cellCount})`);

    if (options.sites) {
      if (options.sites.length < 2)
        throw breakableInput(`sites must contain at least 2 points (got ${options.sites.length})`);
      for (let i = 0; i < options.sites.length; i++) checkVec3(options.sites[i]!, `sites[${i}]`);
      this.customSites = options.sites.map((s) => [s[0], s[1], s[2]] as const);
    }

    this.pattern = options.pattern ?? 'uniform';
    if (this.pattern !== 'uniform' && this.pattern !== 'brick' && this.pattern !== 'radial')
      throw breakableInput(`pattern must be 'uniform', 'brick' or 'radial' (got ${String(this.pattern)})`);

    this.seed = options.seed ?? 1;
    if (!Number.isSafeInteger(this.seed)) throw breakableInput(`seed must be a safe integer (got ${this.seed})`);

    this._bondStrength = options.bondStrength ?? 25;
    checkPositiveFinite(this._bondStrength, 'bondStrength');
    this.bondStrengthFn = options.bondStrengthFn;
    this.areaWeightedStrength = options.areaWeightedStrength ?? true;

    if (options.minImpactImpulse !== undefined) {
      checkNonNegativeFinite(options.minImpactImpulse, 'minImpactImpulse');
      this.explicitMinImpactImpulse = options.minImpactImpulse;
    }

    const maxExtent = Math.max(
      this.boundsMax[0] - this.boundsMin[0],
      this.boundsMax[1] - this.boundsMin[1],
      this.boundsMax[2] - this.boundsMin[2],
    );
    this.defaultImpactRadius = options.impactRadius ?? Math.max(0.25, maxExtent * 0.45);
    checkPositiveFinite(this.defaultImpactRadius, 'impactRadius');

    this.anchorTolerance = options.anchorTolerance ?? 0.06;
    checkNonNegativeFinite(this.anchorTolerance, 'anchorTolerance');

    this.density = options.density ?? 1;
    checkPositiveFinite(this.density, 'density');

    this.friction = options.friction ?? 0.5;
    checkNonNegativeFinite(this.friction, 'friction');

    this.restitution = options.restitution ?? 0.15;
    if (!(this.restitution >= 0 && this.restitution <= 1 && Number.isFinite(this.restitution)))
      throw breakableInput(`restitution must be in [0, 1] (got ${this.restitution})`);

    this.uvScale = options.uvScale ?? 1;
    checkPositiveFinite(this.uvScale, 'uvScale');

    this.exteriorMaterial = options.material ?? mesh?.material;
    this.interiorMaterial = options.interiorMaterial;
    this.collisionGroups = options.collisionGroups;
    this.debrisCollisionGroups = options.debrisCollisionGroups;
    this.splitIslands = options.splitIslands ?? false;
    this.secondaryFracture = options.secondaryFracture ?? true;
    this.onBreakCallback = options.onBreak;

    this.initializeIntact();
  }

  private assertLive(): void {
    if (this._removed || this.world.disposed)
      throw breakableFault('disposed', 'BreakableBody was removed or its BreakableWorld was disposed');
  }

  /** Minimum contact impulse (N·s) required before contactforce events accumulate damage. */
  get effectiveMinImpactImpulse(): number {
    return this.explicitMinImpactImpulse ?? Math.max(0.5, this._bondStrength * 0.2);
  }

  /** Base impulse threshold in N·s required to sever a bond; updating scales all current bonds proportionally. */
  get bondStrength(): number {
    return this._bondStrength;
  }

  set bondStrength(value: number) {
    this.assertLive();
    checkPositiveFinite(value, 'bondStrength');
    const ratio = value / this._bondStrength;
    this._bondStrength = value;
    for (let i = 0; i < this._bonds.length; i++) {
      this._bonds[i]!.strength *= ratio;
    }
  }

  /** True once at least one fracture has detached fragments from this body. */
  get broken(): boolean {
    return this._broken;
  }

  /** True once this body has been removed from its world. */
  get removed(): boolean {
    return this._removed;
  }

  /** Primary intact or surviving anchored rigid body, or `null` if fully shattered into debris. */
  get body(): PhysicsBody | null {
    for (let i = 0; i < this._islands.length; i++) {
      const island = this._islands[i]!;
      if (!island.removed && !island.isDebris) return island.body;
    }
    return null;
  }

  /** Every live rigid body currently representing this breakable (intact, anchored islands, and debris). */
  get bodies(): readonly PhysicsBody[] {
    const out: PhysicsBody[] = [];
    for (let i = 0; i < this._islands.length; i++) {
      const island = this._islands[i]!;
      if (!island.removed && island.body.valid) out.push(island.body);
    }
    return out;
  }

  /** Generated Voronoi cells (populated immediately when `prefractured`, or on fracture when `impact`). */
  get cells(): readonly BreakableCell[] {
    return this._cells;
  }

  /** Connection-graph bonds between adjacent Voronoi cells. */
  get bonds(): readonly BreakableBond[] {
    return this._bonds;
  }

  /** Currently live detached fragments spawned from this body. */
  get fragments(): readonly BreakableFragment[] {
    return this._fragments.filter((f) => !f.removed);
  }

  /** Sum of accumulated damage across all bonds (or intact damage prior to runtime fracture). */
  get totalDamage(): number {
    if (this._bonds.length === 0) return this._intactDamage;
    let sum = 0;
    for (let i = 0; i < this._bonds.length; i++) sum += this._bonds[i]!.damage;
    return sum;
  }

  /** Pre-computes Voronoi cells, connection bonds, and support anchors if not yet generated. */
  prefracture(impactPointWorld?: Vec3): void {
    this.assertLive();
    if (this._cells.length > 0) return;

    let localImpact: Vec3 | undefined;
    if (impactPointWorld) {
      checkVec3(impactPointWorld, 'impactPoint');
      const intact = this._islands[0];
      if (intact && !intact.removed) {
        localImpact = worldToParentLocal(
          impactPointWorld,
          intact.body.position,
          intact.body.rotation,
          intact.originOffset,
        );
      } else {
        localImpact = worldToParentLocal(impactPointWorld, this.initialPosition, this.initialRotation, [0, 0, 0]);
      }
    }

    this.generateCellsAndGraph(localImpact);
    // Attach generated cells to the existing intact island.
    const intact = this._islands[0];
    if (intact && !intact.removed && intact.cellIndices.length === 0) {
      for (let i = 0; i < this._cells.length; i++) intact.cellIndices.push(i);
    }
  }

  /**
   * Applies localized impact damage at world `point` within `radius`, breaking bonds whose
   * cumulative damage reaches `bond.strength` and detaching unsupported islands as fragments.
   */
  applyImpact(point: Vec3, impulse: number | Vec3, radius?: number): readonly BreakableFragment[] {
    this.assertLive();
    checkVec3(point, 'Impact point');
    let impulseMag: number;
    let impulseDir: [number, number, number] | null = null;
    if (typeof impulse === 'number') {
      checkPositiveFinite(impulse, 'Impact impulse');
      impulseMag = impulse;
    } else {
      checkVec3(impulse, 'Impact impulse');
      impulseMag = Math.hypot(impulse[0], impulse[1], impulse[2]);
      if (!(impulseMag > 0)) throw breakableInput('Impact impulse vector must have a positive magnitude');
      impulseDir = [impulse[0] / impulseMag, impulse[1] / impulseMag, impulse[2] / impulseMag];
    }
    const effectiveRadius = radius ?? this.defaultImpactRadius;
    checkPositiveFinite(effectiveRadius, 'Impact radius');

    return this.applyDamageInternal(point, impulseMag, impulseDir, effectiveRadius, false, 0);
  }

  /**
   * Applies radial explosion damage and outward blast impulse centred at `center` within `radius`.
   */
  applyExplosion(
    center: Vec3,
    impulse: number,
    radius: number,
    options: BreakableExplosionOptions = {},
  ): readonly BreakableFragment[] {
    this.assertLive();
    checkVec3(center, 'Explosion center');
    checkPositiveFinite(impulse, 'Explosion impulse');
    checkPositiveFinite(radius, 'Explosion radius');
    const lift = options.lift ?? 0.25;
    checkNonNegativeFinite(lift, 'Explosion lift');

    return this.applyDamageInternal(center, impulse, null, radius, true, lift);
  }

  /** Resets this breakable body to its undamaged intact state and cleans up all spawned fragments. */
  reset(): void {
    this.assertLive();
    this.clearIslandsAndFragments();
    this._broken = false;
    this._intactDamage = 0;
    if (this.fractureMode === 'impact') {
      this._cells = [];
      this._bonds = [];
      this._anchoredFlags = new Uint8Array(0);
      this._impactSite = null;
    } else {
      for (let i = 0; i < this._bonds.length; i++) this._bonds[i]!.reset();
    }
    if (this.mesh) {
      this.mesh.visible = true;
      this.mesh.setPosition(this.initialPosition);
      this.mesh.setQuaternion(this.initialRotation);
    }
    this.initializeIntact();
  }

  /** Removes this breakable body and all of its fragments from its {@link BreakableWorld}. */
  remove(): void {
    if (this._removed) return;
    this.world.remove(this);
  }

  /** @internal */
  disposeInternal(): void {
    if (this._removed) return;
    this.clearIslandsAndFragments();
    this._removed = true;
  }

  /** @internal */
  debugView(): DebugBodyView {
    const intact = this._islands.find((i) => !i.removed && !i.isDebris);
    const islands: DebugIslandView[] = [];
    for (let i = 0; i < this._islands.length; i++) {
      const island = this._islands[i]!;
      if (island.removed || !island.body.valid) continue;
      islands.push({
        position: island.body.position,
        rotation: island.body.rotation,
        originOffset: island.originOffset,
        cellIndices: island.cellIndices,
        isDebris: island.isDebris,
        sleeping: island.body.sleeping,
      });
    }
    return {
      basePolyhedron: this.basePolyhedron,
      cells: this._cells,
      bonds: this._bonds,
      anchoredFlags: this._anchoredFlags,
      islands,
      intactPose:
        intact && intact.body.valid ? { position: intact.body.position, rotation: intact.body.rotation } : null,
    };
  }

  /** @internal */
  applyContactImpact(
    island: ActiveIsland,
    worldPoint: Vec3,
    impulseVec: Vec3,
    impulseMag: number,
  ): readonly BreakableFragment[] {
    if (this._removed || island.removed || !island.body.valid) return [];
    const dir: [number, number, number] | null =
      impulseMag > 1e-9 ? [impulseVec[0] / impulseMag, impulseVec[1] / impulseMag, impulseVec[2] / impulseMag] : null;
    return this.applyDamageToIsland(island, worldPoint, impulseMag, dir, this.defaultImpactRadius, false, 0, true);
  }

  /** @internal */
  removeIslandInternal(island: ActiveIsland): void {
    if (island.removed) return;
    island.removed = true;
    this.world.unregisterIsland(island);
    if (island.body.valid) {
      this.world.physics.removeBody(island.body);
    }
    // Mesh.dispose() does nothing to a mesh already gone, as after the engine's own dispose.
    if (island.ownsMesh) {
      island.interiorMesh?.dispose();
      island.mesh?.dispose();
    }
    if (island.fragment) {
      island.fragment.removed = true;
      this.world.unregisterDebris(island.fragment);
    }
  }

  private clearIslandsAndFragments(): void {
    const snapshot = [...this._islands];
    for (let i = 0; i < snapshot.length; i++) {
      this.removeIslandInternal(snapshot[i]!);
    }
    this._islands.length = 0;
    this._fragments.length = 0;
  }

  private initializeIntact(): void {
    if (this.fractureMode === 'prefractured' && this._cells.length === 0) {
      this.generateCellsAndGraph(undefined);
    }

    // Build ONE single intact rigid body so resting jitter while undamaged is strictly zero.
    const collider: ColliderOptions = this.isBox
      ? {
          shape: 'box',
          halfExtents: this.boxHalfExtents,
          density: this.density,
          friction: this.friction,
          restitution: this.restitution,
          collisionGroups: this.collisionGroups,
          contactForceEvents: true,
        }
      : {
          shape: 'convexHull',
          points: Float32Array.from(this.basePolyhedron.vertices.flat()),
          density: this.density,
          friction: this.friction,
          restitution: this.restitution,
          collisionGroups: this.collisionGroups,
          contactForceEvents: true,
        };

    const body = this.world.physics.addBody(this.mesh, {
      type: this.initialType,
      position: this.initialPosition,
      rotation: this.initialRotation,
      colliders: collider,
      userData: this.userData,
    });

    const cellIndices: number[] = [];
    for (let i = 0; i < this._cells.length; i++) cellIndices.push(i);

    const island: ActiveIsland = {
      id: this.world.nextIslandId(),
      owner: this,
      body,
      mesh: this.mesh,
      interiorMesh: null,
      ownsMesh: false,
      originOffset: [0, 0, 0],
      cellIndices,
      anchored: this.initialType === 'fixed',
      isDebris: false,
      fragment: null,
      removed: false,
    };
    this._islands.push(island);
    this.world.registerIsland(island);
  }

  /** @internal Words for {@link BreakableWorld.takeSnapshot}: damage, the impact site of a runtime split, every bond. */
  writeState(out: number[]): void {
    const site = this._impactSite;
    out.push(this._broken ? 1 : 0, this._intactDamage, this._cells.length);
    out.push(site ? site[0] : NaN, site ? site[1] : NaN, site ? site[2] : NaN, this._bonds.length);
    for (let i = 0; i < this._bonds.length; i++) {
      const bond = this._bonds[i]!;
      out.push(bond.damage, bond.broken ? 1 : 0, bond.strength);
    }
  }

  /** @internal Puts back what {@link BreakableBody.writeState} wrote, from `at`; returns the word after it. */
  readState(words: Float64Array, at: number): number {
    this._broken = words[at] === 1;
    this._intactDamage = words[at + 1]!;
    const cells = words[at + 2]!;
    const site: Vec3 | null = Number.isNaN(words[at + 3]) ? null : [words[at + 3]!, words[at + 4]!, words[at + 5]!];
    if (cells !== this._cells.length || (this.fractureMode === 'impact' && !sameSite(site, this._impactSite))) {
      // A runtime split that came after (or before) the snapshot: undo it, or make it again from the same impact site.
      const intact = this._islands[0]!;
      intact.cellIndices.length = 0;
      if (cells === 0) {
        this._cells = [];
        this._bonds = [];
        this._anchoredFlags = new Uint8Array(0);
        this._impactSite = null;
      } else {
        this.generateCellsAndGraph(site ?? undefined);
        for (let i = 0; i < this._cells.length; i++) intact.cellIndices.push(i);
      }
    }
    at += 6;
    const bonds = words[at++]!;
    if (bonds !== this._bonds.length) throw snapshotMismatch();
    for (let i = 0; i < bonds; i++) {
      const bond = this._bonds[i] as BondRecord;
      bond.damage = words[at++]!;
      bond.broken = words[at++] === 1;
      bond.strength = words[at++]!;
    }
    return at;
  }

  /** @internal The ids of the live islands, intact or anchored or debris, for a snapshot's check. */
  islandIds(out: number[]): void {
    for (let i = 0; i < this._islands.length; i++) if (!this._islands[i]!.removed) out.push(this._islands[i]!.id);
  }

  private generateCellsAndGraph(localImpact?: Vec3): void {
    this._impactSite =
      localImpact && this.fractureMode === 'impact' ? [localImpact[0], localImpact[1], localImpact[2]] : null;
    const sites =
      this.customSites ??
      generateVoronoiSites(
        this.boundsMin,
        this.boundsMax,
        this.cellCount,
        this.seed,
        localImpact && this.fractureMode === 'impact' ? 'impact' : this.pattern,
        localImpact,
        this.defaultImpactRadius,
      );
    const result = voronoiFracturePolyhedron(this.basePolyhedron, sites, this.density, this.uvScale);
    this._cells = [...result.cells];

    // Compute mean cut-face area so areaWeightedStrength keeps average bond strength equal to bondStrength.
    let totalArea = 0;
    for (let i = 0; i < result.adjacencies.length; i++) totalArea += result.adjacencies[i]!.area;
    const meanArea = result.adjacencies.length > 0 ? totalArea / result.adjacencies.length : 1;

    this._bonds = result.adjacencies.map((adj, index) => {
      let strength = this._bondStrength;
      if (this.bondStrengthFn) {
        strength = this.bondStrengthFn({
          cellA: adj.cellA,
          cellB: adj.cellB,
          area: adj.area,
          centroid: adj.centroid,
          normal: adj.normal,
        });
        checkPositiveFinite(strength, 'bondStrengthFn result');
      } else if (this.areaWeightedStrength && meanArea > 1e-12) {
        // Clamp weight to [0.35, 2.5] so tiny sliver faces aren't instant dust and broad faces aren't indestructible.
        const weight = Math.min(2.5, Math.max(0.35, adj.area / meanArea));
        strength = this._bondStrength * weight;
      }
      return new BondRecord(index, adj.cellA, adj.cellB, adj.area, adj.centroid, adj.normal, strength);
    });

    this._anchoredFlags = this.computeAnchoredFlags();
  }

  private computeAnchoredFlags(): Uint8Array {
    const n = this._cells.length;
    const flags = new Uint8Array(n);
    const mode = this.anchorMode;
    if (mode === 'none') return flags;

    if (Array.isArray(mode)) {
      for (let i = 0; i < mode.length; i++) {
        const idx = mode[i]!;
        if (Number.isInteger(idx) && idx >= 0 && idx < n) flags[idx] = 1;
      }
      return flags;
    }

    if (typeof mode === 'function') {
      for (let i = 0; i < n; i++) {
        const c = this._cells[i]!;
        if (
          mode({
            index: c.index,
            centroid: c.centroid,
            boundsMin: c.boundsMin,
            boundsMax: c.boundsMax,
            volume: c.volume,
            mass: c.mass,
            bodyBoundsMin: this.boundsMin,
            bodyBoundsMax: this.boundsMax,
          })
        ) {
          flags[i] = 1;
        }
      }
      return flags;
    }

    const sx = this.boundsMax[0] - this.boundsMin[0];
    const sy = this.boundsMax[1] - this.boundsMin[1];
    const sz = this.boundsMax[2] - this.boundsMin[2];
    const tolX = Math.max(1e-4, sx * this.anchorTolerance);
    const tolY = Math.max(1e-4, sy * this.anchorTolerance);
    const tolZ = Math.max(1e-4, sz * this.anchorTolerance);

    if (mode === 'bottom') {
      const cutY = this.boundsMin[1] + tolY;
      for (let i = 0; i < n; i++) {
        if (this._cells[i]!.boundsMin[1] <= cutY) flags[i] = 1;
      }
      return flags;
    }

    if (mode === 'perimeter') {
      // Anchor the four perimeter edges perpendicular to the thinnest axis (e.g. window glass in a frame).
      const thinAxis = sx <= sy && sx <= sz ? 0 : sy <= sx && sy <= sz ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const c = this._cells[i]!;
        const touchX = c.boundsMin[0] <= this.boundsMin[0] + tolX || c.boundsMax[0] >= this.boundsMax[0] - tolX;
        const touchY = c.boundsMin[1] <= this.boundsMin[1] + tolY || c.boundsMax[1] >= this.boundsMax[1] - tolY;
        const touchZ = c.boundsMin[2] <= this.boundsMin[2] + tolZ || c.boundsMax[2] >= this.boundsMax[2] - tolZ;
        const anchored = thinAxis === 0 ? touchY || touchZ : thinAxis === 1 ? touchX || touchZ : touchX || touchY;
        if (anchored) flags[i] = 1;
      }
      return flags;
    }

    // 'all-boundary'
    for (let i = 0; i < n; i++) {
      const c = this._cells[i]!;
      if (
        c.boundsMin[0] <= this.boundsMin[0] + tolX ||
        c.boundsMax[0] >= this.boundsMax[0] - tolX ||
        c.boundsMin[1] <= this.boundsMin[1] + tolY ||
        c.boundsMax[1] >= this.boundsMax[1] - tolY ||
        c.boundsMin[2] <= this.boundsMin[2] + tolZ ||
        c.boundsMax[2] >= this.boundsMax[2] - tolZ
      ) {
        flags[i] = 1;
      }
    }
    return flags;
  }

  private applyDamageInternal(
    worldPoint: Vec3,
    impulseMag: number,
    impulseDir: [number, number, number] | null,
    radius: number,
    isExplosion: boolean,
    lift: number,
  ): readonly BreakableFragment[] {
    const allSpawned: BreakableFragment[] = [];
    const snapshot = [...this._islands];
    for (let i = 0; i < snapshot.length; i++) {
      const island = snapshot[i]!;
      if (island.removed || !island.body.valid) continue;
      if (island.isDebris && !this.secondaryFracture && !isExplosion) continue;
      const spawned = this.applyDamageToIsland(
        island,
        worldPoint,
        impulseMag,
        impulseDir,
        radius,
        isExplosion,
        lift,
        false,
      );
      for (let k = 0; k < spawned.length; k++) allSpawned.push(spawned[k]!);
    }
    return allSpawned;
  }

  private applyDamageToIsland(
    island: ActiveIsland,
    worldPoint: Vec3,
    impulseMag: number,
    impulseDir: [number, number, number] | null,
    radius: number,
    isExplosion: boolean,
    lift: number,
    fromContact: boolean,
  ): readonly BreakableFragment[] {
    if (island.removed || !island.body.valid) return [];

    const pos = island.body.position;
    const rot = island.body.rotation;
    const localPoint = worldToParentLocal(worldPoint, pos, rot, island.originOffset);

    // Distance check against body bounds (expanded by radius) for quick rejection.
    const cx = Math.min(this.boundsMax[0], Math.max(this.boundsMin[0], localPoint[0]));
    const cy = Math.min(this.boundsMax[1], Math.max(this.boundsMin[1], localPoint[1]));
    const cz = Math.min(this.boundsMax[2], Math.max(this.boundsMin[2], localPoint[2]));
    const distToBox = Math.hypot(localPoint[0] - cx, localPoint[1] - cy, localPoint[2] - cz);
    if (distToBox > radius) return [];

    // Runtime impact-clustered Voronoi mode: stay intact until cumulative damage crosses fracture threshold.
    if (this._cells.length === 0) {
      const share = Math.max(0, 1 - distToBox / radius);
      const effective = impulseMag * share;
      if (!(effective > 0)) return [];
      this._intactDamage += effective;
      if (this._intactDamage < this._bondStrength) {
        // Light tap on dynamic intact body: transfer physical nudge without shattering yet.
        if (!fromContact && island.body.type === 'dynamic') {
          this.nudgeBody(island.body, worldPoint, impulseMag, impulseDir, share, isExplosion, lift);
        }
        return [];
      }
      // Threshold reached: cluster Voronoi sites around the local impact point!
      this.generateCellsAndGraph(localPoint);
      for (let i = 0; i < this._cells.length; i++) island.cellIndices.push(i);
      // Apply the accumulated damage plus current impulse to the freshly created local bonds.
      impulseMag = this._intactDamage;
      this._intactDamage = 0;
    }

    // Single-cell debris cannot fracture further, though explosions still push it outward.
    if (island.cellIndices.length <= 1) {
      if (isExplosion && island.body.type === 'dynamic') {
        const d = Math.hypot(pos[0] - worldPoint[0], pos[1] - worldPoint[1], pos[2] - worldPoint[2]);
        if (d <= radius) {
          const share = Math.max(0, 1 - d / radius);
          this.nudgeBody(island.body, worldPoint, impulseMag, null, share, true, lift);
        }
      }
      return [];
    }

    const memberSet = new Set<number>(island.cellIndices);
    let anyBondDamaged = false;
    let anyBondBroke = false;

    for (let i = 0; i < this._bonds.length; i++) {
      const bond = this._bonds[i]!;
      if (bond.broken) continue;
      if (!memberSet.has(bond.cellA) || !memberSet.has(bond.cellB)) continue;
      const dx = bond.localCentroid[0] - localPoint[0];
      const dy = bond.localCentroid[1] - localPoint[1];
      const dz = bond.localCentroid[2] - localPoint[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;
      const falloff = Math.max(0, 1 - dist / radius);
      const delta = impulseMag * falloff;
      if (delta > 0) {
        bond.damage += delta;
        anyBondDamaged = true;
        if (bond.damage >= bond.strength) {
          bond.broken = true;
          anyBondBroke = true;
        }
      }
    }

    if (!anyBondBroke) {
      if (anyBondDamaged && !fromContact && island.body.type === 'dynamic') {
        const share = Math.max(0, 1 - distToBox / radius);
        this.nudgeBody(island.body, worldPoint, impulseMag, impulseDir, share, isExplosion, lift);
      }
      return [];
    }

    // Resolve connected components across remaining unbroken bonds (X-42 structural support).
    const components = findConnectedComponents(
      island.cellIndices,
      this._cells.length,
      this._bonds,
      this._anchoredFlags,
    );

    const detached = components.length > 1 || (island.anchored && components.length === 1 && !components[0]!.anchored);
    if (!detached) {
      if (!fromContact && island.body.type === 'dynamic') {
        const share = Math.max(0, 1 - distToBox / radius);
        this.nudgeBody(island.body, worldPoint, impulseMag, impulseDir, share, isExplosion, lift);
      }
      return [];
    }

    // Snapshot parent rigid-body kinematics before removing the parent body.
    const parentPos = island.body.position;
    const parentRot = island.body.rotation;
    const parentLinVel = island.body.linearVelocity;
    const parentAngVel = island.body.angularVelocity;
    const parentWorldCom = island.body.worldCenterOfMass;
    const parentOrigin = island.originOffset;

    // Hide the original intact mesh once fractured (kept alive for clean reset()).
    if (!island.ownsMesh && this.mesh) {
      this.mesh.visible = false;
    }

    this.removeIslandInternal(island);
    const idx = this._islands.indexOf(island);
    if (idx >= 0) this._islands.splice(idx, 1);

    this._broken = true;

    // Partition components into surviving anchored islands vs detached dynamic fragments.
    const newFragments: FragmentRecord[] = [];
    const detachedGroups: { cells: BreakableCell[]; indices: number[] }[] = [];

    for (let i = 0; i < components.length; i++) {
      const comp = components[i]!;
      const compCells = comp.cells.map((cIdx) => this._cells[cIdx]!);
      if (comp.anchored) {
        this.spawnAnchoredIsland(compCells, comp.cells, parentPos, parentRot, parentOrigin);
      } else if (this.splitIslands && compCells.length > 1) {
        for (let k = 0; k < compCells.length; k++) {
          detachedGroups.push({
            cells: [compCells[k]!],
            indices: [comp.cells[k]!],
          });
        }
      } else {
        detachedGroups.push({ cells: compCells, indices: comp.cells });
      }
    }

    // Compute falloff weights for distributing residual blast/impact push across detached fragments near the hit.
    const fragWeights: number[] = [];
    let totalWeight = 0;
    for (let i = 0; i < detachedGroups.length; i++) {
      const group = detachedGroups[i]!;
      const props = group.cells.length === 1 ? group.cells[0]! : combineCellMassProperties(group.cells);
      const worldCom = parentLocalToWorld(props.centroid, parentPos, parentRot, parentOrigin);
      const d = Math.hypot(worldCom[0] - worldPoint[0], worldCom[1] - worldPoint[1], worldCom[2] - worldPoint[2]);
      const w = d < radius ? Math.max(0, 1 - d / radius) : 0;
      fragWeights.push(w);
      totalWeight += w;
    }

    for (let i = 0; i < detachedGroups.length; i++) {
      const group = detachedGroups[i]!;
      const weight = fragWeights[i]!;
      const frag = this.spawnDetachedFragment(
        group.cells,
        group.indices,
        parentPos,
        parentRot,
        parentOrigin,
        parentWorldCom,
        parentLinVel,
        parentAngVel,
      );
      newFragments.push(frag);

      // Apply localized impact/explosion push only to detached fragments inside the blast/impact radius.
      if (weight > 0) {
        const fragPos = frag.body.position;
        if (isExplosion) {
          const share = weight;
          this.nudgeBody(frag.body, worldPoint, impulseMag, null, share, true, lift);
        } else if (!fromContact || island.anchored) {
          // For fixed structures hit by a ball or direct applyImpact, transfer a proportional share of the impulse.
          const share = totalWeight > 1e-6 ? weight / totalWeight : 0;
          const kick = impulseMag * share * (fromContact ? 0.35 : 0.75);
          if (kick > 0) {
            if (impulseDir) {
              frag.body.applyImpulse([impulseDir[0] * kick, impulseDir[1] * kick, impulseDir[2] * kick]);
            } else {
              const dx = fragPos[0] - worldPoint[0];
              const dy = fragPos[1] - worldPoint[1];
              const dz = fragPos[2] - worldPoint[2];
              const len = Math.hypot(dx, dy, dz);
              const dir: [number, number, number] = len > 1e-6 ? [dx / len, dy / len, dz / len] : [0, 1, 0];
              frag.body.applyImpulse([dir[0] * kick, dir[1] * kick, dir[2] * kick]);
            }
          }
        }
      }
    }

    if (newFragments.length > 0) {
      this.world.enforceDebrisBudget();
      const event: BreakEvent = {
        body: this,
        impactPoint: [worldPoint[0], worldPoint[1], worldPoint[2]],
        impulse: impulseMag,
        fragments: newFragments,
      };
      this.onBreakCallback?.(event);
      this.world.emitBreak(event);
    }

    return newFragments;
  }

  private nudgeBody(
    body: PhysicsBody,
    worldPoint: Vec3,
    impulseMag: number,
    impulseDir: [number, number, number] | null,
    share: number,
    isExplosion: boolean,
    lift: number,
  ): void {
    const push = impulseMag * share;
    if (!(push > 0)) return;
    if (impulseDir && !isExplosion) {
      body.applyImpulse([impulseDir[0] * push, impulseDir[1] * push, impulseDir[2] * push], worldPoint);
      return;
    }
    const p = body.position;
    const dx = p[0] - worldPoint[0];
    const dy = p[1] - worldPoint[1];
    const dz = p[2] - worldPoint[2];
    const len = Math.hypot(dx, dy, dz);
    const ux = len > 1e-6 ? dx / len : 0;
    const uy = len > 1e-6 ? dy / len : 1;
    const uz = len > 1e-6 ? dz / len : 0;
    body.applyImpulse([ux * push, (uy + (isExplosion ? lift : 0)) * push, uz * push]);
  }

  private createMeshesForIsland(
    geometry: Geometry,
    exteriorGeometry: Geometry | null,
    interiorGeometry: Geometry | null,
    worldPos: Vec3,
    worldRot: Quat,
  ): { mesh: Mesh | null; interiorMesh: Mesh | null } {
    const engine = this.world.resolveEngine(this.mesh);
    if (!engine) return { mesh: null, interiorMesh: null };

    const useDualMaterials = Boolean(this.interiorMaterial && interiorGeometry);
    const rootGeom = useDualMaterials ? (exteriorGeometry ?? geometry) : geometry;
    const mesh = engine.createMesh();
    mesh.setGeometry(rootGeom);
    if (this.exteriorMaterial) mesh.setMaterial(this.exteriorMaterial);
    mesh.setPosition(worldPos);
    mesh.setQuaternion(worldRot);

    let interiorMesh: Mesh | null = null;
    if (useDualMaterials && interiorGeometry && this.interiorMaterial) {
      interiorMesh = engine.createMesh(mesh);
      interiorMesh.setGeometry(interiorGeometry);
      interiorMesh.setMaterial(this.interiorMaterial);
    }

    return { mesh, interiorMesh };
  }

  private spawnAnchoredIsland(
    compCells: readonly BreakableCell[],
    cellIndices: number[],
    parentPos: Vec3,
    parentRot: Quat,
    parentOrigin: Vec3,
  ): void {
    const single = compCells.length === 1;
    const props = single ? compCells[0]! : combineCellMassProperties(compCells);
    const islandCentroid: [number, number, number] = [props.centroid[0], props.centroid[1], props.centroid[2]];
    const worldPos = parentLocalToWorld(islandCentroid, parentPos, parentRot, parentOrigin);

    const meshBundle = single
      ? {
          geometry: compCells[0]!.geometry,
          exteriorGeometry: compCells[0]!.exteriorGeometry,
          interiorGeometry: compCells[0]!.interiorGeometry,
        }
      : buildIslandMeshes(compCells, islandCentroid, this.uvScale);

    const { mesh, interiorMesh } = this.createMeshesForIsland(
      meshBundle.geometry,
      meshBundle.exteriorGeometry,
      meshBundle.interiorGeometry,
      worldPos,
      parentRot,
    );

    const collider = cellsCollider(compCells, islandCentroid, {
      density: this.density,
      friction: this.friction,
      restitution: this.restitution,
      collisionGroups: this.collisionGroups,
    });

    const body = this.world.physics.addBody(mesh, {
      type: 'fixed',
      position: worldPos,
      rotation: parentRot,
      colliders: collider,
      userData: this.userData,
    });

    const island: ActiveIsland = {
      id: this.world.nextIslandId(),
      owner: this,
      body,
      mesh,
      interiorMesh,
      ownsMesh: mesh !== null,
      originOffset: islandCentroid,
      cellIndices: [...cellIndices],
      anchored: true,
      isDebris: false,
      fragment: null,
      removed: false,
    };
    this._islands.push(island);
    this.world.registerIsland(island);
  }

  private spawnDetachedFragment(
    compCells: readonly BreakableCell[],
    cellIndices: number[],
    parentPos: Vec3,
    parentRot: Quat,
    parentOrigin: Vec3,
    parentWorldCom: Vec3,
    parentLinVel: Vec3,
    parentAngVel: Vec3,
  ): FragmentRecord {
    const single = compCells.length === 1;
    const props = single ? compCells[0]! : combineCellMassProperties(compCells);
    const islandCentroid: [number, number, number] = [props.centroid[0], props.centroid[1], props.centroid[2]];
    const worldPos = parentLocalToWorld(islandCentroid, parentPos, parentRot, parentOrigin);

    // Exact rigid-body velocity inheritance: v_frag = v_parent + omega_parent × (r_frag - r_parent).
    const rx = worldPos[0] - parentWorldCom[0];
    const ry = worldPos[1] - parentWorldCom[1];
    const rz = worldPos[2] - parentWorldCom[2];
    const inheritedVel: [number, number, number] = [
      parentLinVel[0] + (parentAngVel[1] * rz - parentAngVel[2] * ry),
      parentLinVel[1] + (parentAngVel[2] * rx - parentAngVel[0] * rz),
      parentLinVel[2] + (parentAngVel[0] * ry - parentAngVel[1] * rx),
    ];

    const meshBundle = single
      ? {
          geometry: compCells[0]!.geometry,
          exteriorGeometry: compCells[0]!.exteriorGeometry,
          interiorGeometry: compCells[0]!.interiorGeometry,
          uvs: compCells[0]!.uvs,
          materialGroups: compCells[0]!.materialGroups,
        }
      : buildIslandMeshes(compCells, islandCentroid, this.uvScale);

    const { mesh, interiorMesh } = this.createMeshesForIsland(
      meshBundle.geometry,
      meshBundle.exteriorGeometry,
      meshBundle.interiorGeometry,
      worldPos,
      parentRot,
    );

    const groups = this.debrisCollisionGroups ?? this.world.debrisCollisionGroups ?? this.collisionGroups;
    const collider = cellsCollider(compCells, islandCentroid, {
      density: this.density,
      friction: this.friction,
      restitution: this.restitution,
      collisionGroups: groups,
    });

    const body = this.world.physics.addBody(mesh, {
      type: 'dynamic',
      position: worldPos,
      rotation: parentRot,
      linearVelocity: inheritedVel,
      angularVelocity: parentAngVel,
      colliders: collider,
      userData: this.userData,
    });

    // Apply exact polyhedral mass and principal inertia tensor (Mirtich 1996).
    body.setMassProperties({
      mass: Math.max(1e-5, props.mass),
      centerOfMass: [0, 0, 0],
      inertia: props.principalInertia,
      inertiaFrame: props.inertiaFrame,
    });

    const fragment = new FragmentRecord({
      id: this.world.nextFragmentId(),
      parent: this,
      body,
      mesh,
      interiorMesh,
      geometry: meshBundle.geometry,
      exteriorGeometry: meshBundle.exteriorGeometry,
      interiorGeometry: meshBundle.interiorGeometry,
      uvs: meshBundle.uvs,
      materialGroups: meshBundle.materialGroups,
      cellIndices: [...cellIndices],
      volume: props.volume,
      mass: props.mass,
    });

    const island: ActiveIsland = {
      id: this.world.nextIslandId(),
      owner: this,
      body,
      mesh,
      interiorMesh,
      ownsMesh: mesh !== null,
      originOffset: islandCentroid,
      cellIndices: [...cellIndices],
      anchored: false,
      isDebris: true,
      fragment,
      removed: false,
    };

    this._islands.push(island);
    this._fragments.push(fragment);
    this.world.registerIsland(island);
    this.world.registerDebris(fragment, island);
    return fragment;
  }
}

/**
 * Manages destructible rigid bodies, cumulative impact/contact damage, Voronoi fracture, support
 * anchor graphs, debris lifetime/budgeting, and debug overlays over a {@link Physics} world.
 */
export class BreakableWorld implements PhysicsAttachment {
  /** Underlying physics world this breakable manager is attached to. */
  readonly physics: Physics;
  /** Optional collision groups applied to spawned debris fragments. */
  readonly debrisCollisionGroups?: number | InteractionGroups;

  private engine: EngineKernel | null;
  private _maxDebris: number;
  private _debrisLifetime: number;
  private readonly debrisSleepThresholdSq: number;
  private readonly debrisAngularSleepThresholdSq: number;
  private readonly debrisSleepTime: number;
  private _disposed = false;

  private nextBodyCounter = 1;
  private nextIslandCounter = 1;
  private nextFragmentCounter = 1;

  private readonly _bodies = new Set<BreakableBody>();
  private readonly islandByBody = new Map<PhysicsBody, ActiveIsland>();
  private readonly debrisOrder: {
    fragment: FragmentRecord;
    island: ActiveIsland;
  }[] = [];
  private readonly breakListeners = new Set<(event: BreakEvent) => void>();
  private readonly pendingImpacts: PendingContactImpact[] = [];
  /** Each touching collider pair's normal impulse this step and last step, by {@link PAIR_KEY}-packed handles. */
  private pairImpulse = new Map<number, number>();
  private lastPairImpulse = new Map<number, number>();
  private readonly unsubContactForce: () => void;

  /**
   * Creates a {@link BreakableWorld} attached to `physics`, listening for `contactforce` impulses
   * and stepping debris policies automatically after each fixed physics step.
   */
  constructor(physics: Physics, options: BreakableWorldOptions = {}) {
    if (!physics || typeof physics.on !== 'function' || typeof physics.attach !== 'function')
      throw breakableInput('BreakableWorld requires a live Physics instance');
    if (physics.isDisposed)
      throw breakableFault('disposed', 'Physics world is already disposed; create a new Physics before BreakableWorld');

    this.physics = physics;
    this.engine = options.engine ?? null;
    this._maxDebris = options.maxDebris ?? 128;
    if (!Number.isInteger(this._maxDebris) || this._maxDebris < 0)
      throw breakableInput(`maxDebris must be a non-negative integer (got ${this._maxDebris})`);

    this._debrisLifetime = options.debrisLifetime ?? 30;
    if (!(this._debrisLifetime > 0) && this._debrisLifetime !== Infinity)
      throw breakableInput(`debrisLifetime must be > 0 or Infinity (got ${this._debrisLifetime})`);

    const linThresh = options.debrisSleepThreshold ?? 0.15;
    const angThresh = options.debrisAngularSleepThreshold ?? 0.25;
    const sleepTime = options.debrisSleepTime ?? 0.4;
    checkNonNegativeFinite(linThresh, 'debrisSleepThreshold');
    checkNonNegativeFinite(angThresh, 'debrisAngularSleepThreshold');
    checkNonNegativeFinite(sleepTime, 'debrisSleepTime');
    this.debrisSleepThresholdSq = linThresh * linThresh;
    this.debrisAngularSleepThresholdSq = angThresh * angThresh;
    this.debrisSleepTime = sleepTime;
    this.debrisCollisionGroups = options.debrisCollisionGroups;

    if (options.onBreak) this.breakListeners.add(options.onBreak);

    this.unsubContactForce = physics.on('contactforce', (event) => this.handleContactForce(event));
    physics.attach(this);
  }

  /** True once {@link BreakableWorld.dispose} has been called. */
  get disposed(): boolean {
    return this._disposed;
  }

  /** Every breakable body currently registered in this world. */
  get bodies(): readonly BreakableBody[] {
    return [...this._bodies];
  }

  /** Every currently active debris fragment across all breakable bodies, oldest first. */
  get debris(): readonly BreakableFragment[] {
    return this.debrisOrder.map((entry) => entry.fragment);
  }

  /** Current count of live debris fragments. */
  get debrisCount(): number {
    return this.debrisOrder.length;
  }

  /** Maximum live debris fragments allowed before oldest pieces are recycled. */
  get maxDebris(): number {
    return this._maxDebris;
  }

  set maxDebris(value: number) {
    this.assertLive();
    if (!Number.isInteger(value) || value < 0)
      throw breakableInput(`maxDebris must be a non-negative integer (got ${value})`);
    this._maxDebris = value;
    this.enforceDebrisBudget();
  }

  /** Debris lifetime in seconds (`Infinity` keeps debris until removed or capped). */
  get debrisLifetime(): number {
    return this._debrisLifetime;
  }

  set debrisLifetime(value: number) {
    this.assertLive();
    if (!(value > 0) && value !== Infinity)
      throw breakableInput(`debrisLifetime must be > 0 or Infinity (got ${value})`);
    this._debrisLifetime = value;
  }

  private assertLive(): void {
    if (this._disposed) throw breakableFault('disposed', 'BreakableWorld is disposed; create a new BreakableWorld');
  }

  /** Adds a destructible body (optionally bound to a core `mesh`) to the world. */
  add(mesh: Mesh | null, options: BreakableBodyOptions = {}): BreakableBody {
    this.assertLive();
    if (mesh && mesh instanceof CoreMesh && !this.engine) {
      this.engine = meshRuntime(mesh).engine;
    }
    const body = new BreakableBody(this, this.nextBodyCounter++, mesh, options);
    this._bodies.add(body);
    return body;
  }

  /** Removes a breakable body and all of its fragments from the world. */
  remove(body: BreakableBody): void {
    if (!this._bodies.delete(body)) return;
    body.disposeInternal();
  }

  /** Subscribes to fracture events across all breakable bodies; returns an unsubscribe function. */
  onBreak(listener: (event: BreakEvent) => void): () => void {
    this.assertLive();
    if (typeof listener !== 'function') throw breakableInput('onBreak requires a listener function');
    this.breakListeners.add(listener);
    return () => {
      this.breakListeners.delete(listener);
    };
  }

  /** Applies a localized impact at world `point` to every breakable body within `radius`. */
  applyImpact(point: Vec3, impulse: number | Vec3, radius?: number): readonly BreakableFragment[] {
    this.assertLive();
    checkVec3(point, 'Impact point');
    const spawned: BreakableFragment[] = [];
    for (const body of [...this._bodies]) {
      const frags = body.applyImpact(point, impulse, radius);
      for (let i = 0; i < frags.length; i++) spawned.push(frags[i]!);
    }
    return spawned;
  }

  /** Applies an explosion at world `center` within `radius` to every breakable body and fragment. */
  applyExplosion(
    center: Vec3,
    impulse: number,
    radius: number,
    options: BreakableExplosionOptions = {},
  ): readonly BreakableFragment[] {
    this.assertLive();
    checkVec3(center, 'Explosion center');
    checkPositiveFinite(impulse, 'Explosion impulse');
    checkPositiveFinite(radius, 'Explosion radius');
    const spawned: BreakableFragment[] = [];
    for (const body of [...this._bodies]) {
      const frags = body.applyExplosion(center, impulse, radius, options);
      for (let i = 0; i < frags.length; i++) spawned.push(frags[i]!);
    }
    return spawned;
  }

  /**
   * Builds line segments (`{ vertices, colors }`) for unfractured cell seams, bond health
   * (green -> yellow -> red), anchor pins, and active vs sleeping debris, compatible with
   * `@margoengine/lines` (`new Line({ mode: 'segments', positions: vertices, colors })`) and
   * `physics.debugRender()`.
   */
  debugRender(options: BreakableDebugRenderOptions = {}): DebugLines {
    this.assertLive();
    const views: DebugBodyView[] = [];
    for (const body of this._bodies) views.push(body.debugView());
    return buildBreakableDebugLines(views, options);
  }

  /** Resets every breakable body in the world back to its undamaged intact state. */
  reset(): void {
    this.assertLive();
    this.pendingImpacts.length = 0;
    this.pairImpulse.clear();
    this.lastPairImpulse.clear();
    for (const body of this._bodies) body.reset();
  }

  /**
   * Everything the breakable world carries outside the kernel (bond damage, runtime splits, debris ages and sleep timers,
   * the impulses its contacts are measured against), for {@link BreakableWorld.restoreSnapshot}. Take it with
   * `physics.takeSnapshot()`: the two together step on to the same bits.
   */
  takeSnapshot(): BreakableSnapshot {
    this.assertLive();
    const islands: number[] = [];
    const out: number[] = [this.nextBodyCounter, this.nextIslandCounter, this.nextFragmentCounter];
    for (const body of this._bodies) {
      out.push(body.id);
      body.islandIds(islands);
      body.writeState(out);
    }
    out.push(this.debrisOrder.length);
    for (const { fragment } of this.debrisOrder) out.push(fragment.id, fragment.age, fragment.slowTime);
    const keys = [...this.lastPairImpulse.keys()].sort((x, y) => x - y);
    out.push(keys.length);
    for (const key of keys) out.push(key, this.lastPairImpulse.get(key)!);
    return { islands, words: Float64Array.from(out) };
  }

  /**
   * Puts the breakable world back as {@link BreakableWorld.takeSnapshot} found it, with `physics.restoreSnapshot()`. The
   * same pieces must be live: a break or a removal since the snapshot is refused, and nothing changes.
   * @throws MargoError (`state`) when the pieces are not the snapshot's.
   */
  restoreSnapshot(snapshot: BreakableSnapshot): this {
    this.assertLive();
    const islands: number[] = [];
    for (const body of this._bodies) body.islandIds(islands);
    const words = snapshot?.words;
    if (
      !(words instanceof Float64Array) ||
      islands.length !== snapshot.islands.length ||
      islands.some((id, i) => id !== snapshot.islands[i])
    )
      throw snapshotMismatch();
    let at = 3;
    for (const body of this._bodies) {
      if (words[at++] !== body.id) throw snapshotMismatch();
      at = body.readState(words, at);
    }
    if (words[at++] !== this.debrisOrder.length) throw snapshotMismatch();
    for (const { fragment } of this.debrisOrder) {
      if (words[at++] !== fragment.id) throw snapshotMismatch();
      fragment.age = words[at++]!;
      fragment.slowTime = words[at++]!;
    }
    this.nextBodyCounter = words[0]!;
    this.nextIslandCounter = words[1]!;
    this.nextFragmentCounter = words[2]!;
    this.pairImpulse.clear();
    this.lastPairImpulse.clear();
    for (let n = words[at++]!; n > 0; n--, at += 2) this.lastPairImpulse.set(words[at]!, words[at + 1]!);
    return this;
  }

  /** @internal PhysicsAttachment hook executed after each fixed physics step. */
  afterStep(dt: number): void {
    if (this._disposed) return;

    // 1. Flush queued contactforce impacts from the step.
    if (this.pendingImpacts.length > 0) {
      const batch = this.pendingImpacts.splice(0, this.pendingImpacts.length);
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i]!;
        if (item.island.removed || item.island.owner.removed) continue;
        item.island.owner.applyContactImpact(item.island, item.point, item.impulseVec, item.impulseMag);
      }
    }
    // This step's pair impulses are what the next step's are measured against; a pair that did not touch starts at 0.
    const last = this.lastPairImpulse;
    last.clear();
    this.lastPairImpulse = this.pairImpulse;
    this.pairImpulse = last;

    // 2. Advance debris ages, apply fast sleep, and expire fragments past debrisLifetime.
    if (this.debrisOrder.length > 0) {
      const expired: ActiveIsland[] = [];
      for (let i = 0; i < this.debrisOrder.length; i++) {
        const entry = this.debrisOrder[i]!;
        const frag = entry.fragment;
        if (frag.removed || !frag.body.valid) {
          expired.push(entry.island);
          continue;
        }
        frag.age += dt;
        if (frag.age >= this._debrisLifetime) {
          expired.push(entry.island);
          continue;
        }
        if (!frag.body.sleeping) {
          const lv = frag.body.linearVelocity;
          const av = frag.body.angularVelocity;
          const linSq = lv[0] * lv[0] + lv[1] * lv[1] + lv[2] * lv[2];
          const angSq = av[0] * av[0] + av[1] * av[1] + av[2] * av[2];
          if (linSq <= this.debrisSleepThresholdSq && angSq <= this.debrisAngularSleepThresholdSq) {
            frag.slowTime += dt;
            if (frag.slowTime >= this.debrisSleepTime) {
              frag.body.sleep();
              frag.slowTime = 0;
            }
          } else {
            frag.slowTime = 0;
          }
        }
      }
      for (let i = 0; i < expired.length; i++) {
        const island = expired[i]!;
        island.owner.removeIslandInternal(island);
      }
    }

    this.enforceDebrisBudget();
  }

  /** @internal PhysicsAttachment hook when an external caller removes a rigid body directly. */
  bodyRemoved(body: PhysicsBody): void {
    const island = this.islandByBody.get(body);
    if (!island) return;
    this.islandByBody.delete(body);
    island.removed = true;
    if (island.fragment) {
      island.fragment.removed = true;
      this.unregisterDebris(island.fragment);
    }
  }

  /** Disposes this breakable world, detaching from `physics` and removing all managed bodies and fragment meshes. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.unsubContactForce();
    this.physics.detach(this);
    this.pendingImpacts.length = 0;
    this.pairImpulse.clear();
    this.lastPairImpulse.clear();
    for (const body of [...this._bodies]) body.disposeInternal();
    this._bodies.clear();
    this.islandByBody.clear();
    this.debrisOrder.length = 0;
    this.breakListeners.clear();
    this.engine = null;
  }

  /** Disposes this breakable world when leaving a `using` block. */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** @internal */
  resolveEngine(mesh: Mesh | null): EngineKernel | null {
    if (this.engine && !this.engine.disposed) return this.engine;
    if (mesh && mesh instanceof CoreMesh) {
      const detected = meshRuntime(mesh).engine;
      if (!detected.disposed) {
        this.engine = detected;
        return detected;
      }
    }
    return null;
  }

  /** @internal */
  nextIslandId(): number {
    return this.nextIslandCounter++;
  }

  /** @internal */
  nextFragmentId(): number {
    return this.nextFragmentCounter++;
  }

  /** @internal */
  registerIsland(island: ActiveIsland): void {
    this.islandByBody.set(island.body, island);
  }

  /** @internal */
  unregisterIsland(island: ActiveIsland): void {
    this.islandByBody.delete(island.body);
  }

  /** @internal */
  registerDebris(fragment: FragmentRecord, island: ActiveIsland): void {
    this.debrisOrder.push({ fragment, island });
  }

  /** @internal */
  unregisterDebris(fragment: FragmentRecord): void {
    for (let i = 0; i < this.debrisOrder.length; i++) {
      if (this.debrisOrder[i]!.fragment === fragment) {
        this.debrisOrder.splice(i, 1);
        return;
      }
    }
  }

  /** @internal */
  enforceDebrisBudget(): void {
    while (this.debrisOrder.length > this._maxDebris) {
      // Recycle oldest sleeping fragment first, falling back to oldest overall.
      let evictIndex = -1;
      for (let i = 0; i < this.debrisOrder.length; i++) {
        if (this.debrisOrder[i]!.fragment.sleeping) {
          evictIndex = i;
          break;
        }
      }
      if (evictIndex < 0) evictIndex = 0;
      const victim = this.debrisOrder[evictIndex]!;
      victim.island.owner.removeIslandInternal(victim.island);
    }
  }

  /** @internal */
  emitBreak(event: BreakEvent): void {
    for (const listener of [...this.breakListeners]) listener(event);
  }

  private handleContactForce(event: ContactForceEvent): void {
    if (this._disposed) return;
    const islandA = this.islandByBody.get(event.bodyA);
    const islandB = this.islandByBody.get(event.bodyB);
    if (!islandA && !islandB) return;

    if (!(event.impulse > 0)) return;
    // A pair that keeps touching (a crate at rest, a stack, a steady push) passes about the same impulse every step: only
    // the rise over the pair's last step is an impact, so a load that is carried never wears a bond down.
    const a = event.colliderA.handle;
    const b = event.colliderB.handle;
    const key = a < b ? a * PAIR_KEY + b : b * PAIR_KEY + a;
    const impulse = event.impulse - (this.lastPairImpulse.get(key) ?? 0);
    this.pairImpulse.set(key, event.impulse);
    if (!(impulse > 0)) return;

    // The contact point in world space from the pair's manifold, or the midpoint of the bodies when it has no points.
    let point: [number, number, number] | null = null;
    if (event.colliderA.valid && event.colliderB.valid) {
      const manifolds = this.physics.contactPair(event.colliderA, event.colliderB);
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let count = 0;
      for (let m = 0; m < manifolds.length; m++) {
        const pts = manifolds[m]!.points;
        for (let p = 0; p < pts.length; p++) {
          const pt = pts[p]!;
          sx += (pt.pointA[0] + pt.pointB[0]) * 0.5;
          sy += (pt.pointA[1] + pt.pointB[1]) * 0.5;
          sz += (pt.pointA[2] + pt.pointB[2]) * 0.5;
          count++;
        }
      }
      if (count > 0) point = [sx / count, sy / count, sz / count];
    }
    if (!point) {
      const pA = event.bodyA.valid ? event.bodyA.position : [0, 0, 0];
      const pB = event.bodyB.valid ? event.bodyB.position : [0, 0, 0];
      point = [(pA[0] + pB[0]) * 0.5, (pA[1] + pB[1]) * 0.5, (pA[2] + pB[2]) * 0.5];
    }

    const dir = event.maxForceDirection;

    if (islandA && !islandA.removed && impulse > islandA.owner.effectiveMinImpactImpulse) {
      // Only queue secondary fracture for debris if enabled and multi-cell.
      if (!islandA.isDebris || (islandA.owner.secondaryFracture && islandA.cellIndices.length > 1)) {
        const pA = islandA.body.position;
        const intoA = this.orientImpulseToward(point, pA, dir, impulse);
        this.pendingImpacts.push({
          island: islandA,
          point,
          impulseVec: intoA,
          impulseMag: impulse,
        });
      }
    }

    if (islandB && !islandB.removed && impulse > islandB.owner.effectiveMinImpactImpulse) {
      if (!islandB.isDebris || (islandB.owner.secondaryFracture && islandB.cellIndices.length > 1)) {
        const pB = islandB.body.position;
        const intoB = this.orientImpulseToward(point, pB, dir, impulse);
        this.pendingImpacts.push({
          island: islandB,
          point,
          impulseVec: intoB,
          impulseMag: impulse,
        });
      }
    }
  }

  private orientImpulseToward(
    point: Vec3,
    targetCenter: Vec3,
    direction: Vec3,
    magnitude: number,
  ): [number, number, number] {
    const toCenterX = targetCenter[0] - point[0];
    const toCenterY = targetCenter[1] - point[1];
    const toCenterZ = targetCenter[2] - point[2];
    const lenDir = Math.hypot(direction[0], direction[1], direction[2]);
    if (lenDir > 1e-6) {
      const sign = direction[0] * toCenterX + direction[1] * toCenterY + direction[2] * toCenterZ >= 0 ? 1 : -1;
      return [
        (direction[0] / lenDir) * sign * magnitude,
        (direction[1] / lenDir) * sign * magnitude,
        (direction[2] / lenDir) * sign * magnitude,
      ];
    }
    const lenCenter = Math.hypot(toCenterX, toCenterY, toCenterZ);
    if (lenCenter > 1e-6) {
      return [
        (toCenterX / lenCenter) * magnitude,
        (toCenterY / lenCenter) * magnitude,
        (toCenterZ / lenCenter) * magnitude,
      ];
    }
    return [0, -magnitude, 0];
  }
}
