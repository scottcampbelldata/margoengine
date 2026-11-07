// @margoengine/gltf-pro/physics: KHR_physics_rigid_bodies (Draft, Khronos glTF pull request 2424) and KHR_implicit_shapes
// (Release Candidate, pull request 2370), as read on 2026-11-06. Motions, colliders, triggers, materials, filters and joints
// become bodies of @margoengine/physics, which loads only here, so authored physics survives export.
import { composeMatrix, invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { normalizeQuaternion, rotationToQuaternion } from '@margoengine/math/quat';
import type {
  ColliderOptions,
  JointDof,
  JointOptions,
  MotorOptions,
  Physics,
  PhysicsBody,
  PhysicsJoint,
  RapierModule,
} from '@margoengine/physics';
import { margoError } from '../../shared/errors.js';
import type { GLTFDocument, GLTFPrimitive } from '../../shared/gltf.js';
import { packPrimitive } from './pack.js';
import type { PBRModel } from './index.js';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type Matrix = Float64Array;
type GenericOptions = Extract<JointOptions, { type: 'generic' }>;
/** A collider as the world takes it, with the frame on its body that `colliderFor` adds. */
type Collider = PhysicsBody['colliders'][number];

/** A shape of KHR_implicit_shapes as the file has it. */
interface ImplicitShape {
  type?: string;
  box?: { size?: number[] };
  sphere?: { radius?: number };
  cylinder?: { height?: number; radiusTop?: number; radiusBottom?: number };
  capsule?: { height?: number; radiusTop?: number; radiusBottom?: number };
  plane?: { sizeX?: number; sizeZ?: number; doubleSided?: boolean };
}
interface Geometry {
  shape?: number;
  node?: number;
  /** Not in the draft as read, but in the files its reference exporter writes: a mesh in place of a node. */
  mesh?: number;
  convexHull?: boolean;
}
interface Filter {
  collisionSystems?: string[];
  collideWithSystems?: string[];
  notCollideWithSystems?: string[];
}
interface Material {
  staticFriction?: number;
  dynamicFriction?: number;
  restitution?: number;
  frictionCombine?: string;
  restitutionCombine?: string;
}
interface Limit {
  linearAxes?: number[];
  angularAxes?: number[];
  min?: number;
  max?: number;
  stiffness?: number;
  damping?: number;
}
interface Drive {
  type?: 'linear' | 'angular';
  mode?: 'force' | 'acceleration';
  axis?: number;
  maxForce?: number;
  positionTarget?: number;
  velocityTarget?: number;
  stiffness?: number;
  damping?: number;
}
interface JointDef {
  limits?: Limit[];
  drives?: Drive[];
}
interface Motion {
  isKinematic?: boolean;
  mass?: number;
  centerOfMass?: number[];
  inertiaDiagonal?: number[];
  inertiaOrientation?: number[];
  linearVelocity?: number[];
  angularVelocity?: number[];
  gravityFactor?: number;
}
interface NodePhysics {
  motion?: Motion;
  collider?: { geometry?: Geometry; physicsMaterial?: number; collisionFilter?: number };
  trigger?: { geometry?: Geometry; nodes?: number[]; collisionFilter?: number };
  joint?: { connectedNode?: number; joint?: number; enableCollision?: boolean };
}
interface NodeDoc {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extensions?: { KHR_physics_rigid_bodies?: NodePhysics };
}
/** One collider or trigger of the file, on the body of `base`. */
interface Part {
  node: number;
  base: number;
  geometry: Geometry;
  extra: object;
  made?: Collider;
  size?: Vec3;
}
interface Track {
  pointer: string;
  times: ArrayLike<number>;
  values: ArrayLike<number>;
  mode: string;
}

/** Options of {@link applyGLTFPhysics}. */
export interface GLTFPhysicsOptions {
  /** The world to add to. Default: a new one on the model's engine, after `Physics.load()`. */
  physics?: Physics;
}
/** A trigger volume of the file: its node, and the body that carries it. */
export interface GLTFTrigger {
  nodeIndex: number;
  body: PhysicsBody;
}
/** Something the file asks for that this physics world holds only approximately. */
export interface GLTFPhysicsNote {
  /** The node it applies to, or -1 for the file as a whole. */
  nodeIndex: number;
  /** What differs from the file, in words. */
  note: string;
}
/** A collider going into or out of a trigger. */
export interface GLTFTriggerEvent {
  entered: boolean;
  /** The trigger: its node, or the node of the compound trigger it is part of. */
  nodeIndex: number;
  /** The node of the collider that moved, or -1 for a collider the file does not hold. */
  colliderNodeIndex: number;
  /** The node with the motion that collider belongs to, or -1 for none. */
  motionNodeIndex: number;
  /** The body of that collider. */
  body: PhysicsBody;
}
/** The physics of a model, made by {@link applyGLTFPhysics}. */
export interface GLTFPhysics {
  readonly physics: Physics;
  /** The body of each node with a motion or a static collider, by node index. */
  readonly bodies: ReadonlyMap<number, PhysicsBody>;
  /** The joint of each node with one, by node index. */
  readonly joints: ReadonlyMap<number, PhysicsJoint>;
  readonly triggers: readonly GLTFTrigger[];
  /** Everything held approximately; empty means the file is represented as written. */
  readonly notes: readonly GLTFPhysicsNote[];
  /** The body that moves `nodeIndex`: its own, or the nearest parent's. */
  bodyOf(nodeIndex: number): PhysicsBody | undefined;
  /**
   * Writes a property the draft's object model calls mutable: a joint drive's `maxForce`, `positionTarget`,
   * `velocityTarget`, `stiffness` or `damping`, or a motion's `linearVelocity`, `angularVelocity` or `gravityFactor`.
   * @returns false for a pointer this does not write.
   */
  setPointer(pointer: string, value: number | readonly number[]): boolean;
  /** Calls `listener` as colliders enter and leave a trigger; returns a remover. */
  onTrigger(listener: (event: GLTFTriggerEvent) => void): () => void;
  /** Removes the bodies and joints, and the world too when it was made here. */
  dispose(): void;
}

const invalid = (what: string) =>
  new TypeError(`Invalid ${what}; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`);
// The defaults of the extension's schema.
const shapeDefaults = { box: [1, 1, 1], sphere: 0.5, height: 0.5, radius: 0.25 };
const materialDefaults = { friction: 0.6, restitution: 0 };

function localMatrix(node: NodeDoc): Matrix {
  if (node.matrix) return Float64Array.from(node.matrix);
  return composeMatrix(
    node.translation ?? [0, 0, 0],
    node.rotation ?? [0, 0, 0, 1],
    node.scale ?? [1, 1, 1],
    new Float64Array(16),
  );
}
/** Scale, rotation and translation of a matrix without shear. A mirrored matrix keeps a proper rotation: X takes the flip. */
function split(m: ArrayLike<number>): { position: Vec3; rotation: Quat; scale: Vec3 } {
  const scale: Vec3 = [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])],
    volume =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (volume < 0) scale[0] = -scale[0];
  const rotation: Quat = [0, 0, 0, 1];
  rotationToQuaternion(m, rotation, scale[0] || 1, scale[1] || 1, scale[2] || 1);
  normalizeQuaternion(rotation, rotation);
  return { position: [m[12], m[13], m[14]], rotation, scale };
}
/** `m` with its scale taken out. */
function rigid(m: ArrayLike<number>): Matrix {
  const { position, rotation } = split(m);
  return composeMatrix(position, rotation, [1, 1, 1], new Float64Array(16));
}
function relative(from: ArrayLike<number>, to: ArrayLike<number>): Matrix {
  const inverse = invertMatrix(rigid(from), new Float64Array(16));
  if (!inverse) throw invalid('KHR_physics_rigid_bodies node transform');
  return multiplyMatrices(inverse, to, new Float64Array(16));
}
function rotate(m: ArrayLike<number>, v: readonly number[]): Vec3 {
  const r = rigid(m);
  return [0, 1, 2].map((i) => r[i] * v[0] + r[4 + i] * v[1] + r[8 + i] * v[2]) as Vec3;
}
const vector = (v: readonly number[]) => ({ x: v[0], y: v[1], z: v[2] });

function compose(a: Quat, b: Quat = [0, 0, 0, 1]): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
/** `position` plus `offset` turned by `q`. */
function place(position: Vec3, q: Quat, offset: Vec3 = [0, 0, 0]): Vec3 {
  const [x, y, z, w] = q,
    [a, b, c] = offset,
    tx = 2 * (y * c - z * b),
    ty = 2 * (z * a - x * c),
    tz = 2 * (x * b - y * a);
  return [
    position[0] + a + w * tx + y * tz - z * ty,
    position[1] + b + w * ty + z * tx - x * tz,
    position[2] + c + w * tz + x * ty - y * tx,
  ];
}

/**
 * Packed interaction groups per filter, the last entry for colliders without one: one group for each distinct filter.
 * Comparing whole filters pair by pair keeps the draft's test exact: `A` meets `B` only when each lets the other in, and a
 * list is met when all of the other's systems are on it, which group masks alone could not say. A collider in no system
 * is on no list: it meets whatever does not name its partners, as the draft's defaults intend.
 * @throws RangeError past 15 distinct filters, as a world has 16 groups.
 */
export function filterMasks(filters: readonly Filter[]): { memberships: number; filter: number }[] {
  const named = [...filters, {} as Filter],
    key = (f: Filter) => JSON.stringify([f.collisionSystems, f.collideWithSystems, f.notCollideWithSystems]),
    distinct = [...new Map(named.map((f) => [key(f), f])).values()];
  if (distinct.length > 16)
    throw new RangeError(
      'KHR_physics_rigid_bodies: more than 15 distinct collision filters; merge filters that act alike in the file',
    );
  const listed = (a: Filter, list: string[]) => !!a.collisionSystems?.length && a.collisionSystems.every((s) => list.includes(s)),
    lets = (b: Filter, a: Filter) =>
      (!b.collideWithSystems || listed(a, b.collideWithSystems)) &&
      (!b.notCollideWithSystems || !listed(a, b.notCollideWithSystems)),
    masks = distinct.map((a, i) => ({
      memberships: 1 << i,
      filter: distinct.reduce((mask, b, j) => (lets(a, b) && lets(b, a) ? mask | (1 << j) : mask), 0),
    }));
  return named.map((f) => masks[distinct.findIndex((d) => key(d) === key(f))]);
}

const ring = (y: number, radius: number, scale: Vec3, out: number[], steps = 16) => {
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push(Math.cos(a) * radius * scale[0], y * scale[1], Math.sin(a) * radius * scale[2]);
  }
};
/** 194 points on a sphere: per half, six rings of 16 and a pole. */
const ball = (y: number, radius: number, scale: Vec3, out: number[]) => {
  for (const sign of [1, -1])
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * (Math.PI / 2);
      if (i === 6) out.push(0, (y + sign * radius) * scale[1], 0);
      else ring(y + sign * Math.sin(a) * radius, Math.cos(a) * radius, scale, out);
    }
};

/** What a shape of the file is at `scale`, in the world's collider terms, with a note where it cannot be exact. */
export function shapeCollider(
  shape: ImplicitShape,
  scale: Vec3,
  rapier: Pick<RapierModule, 'ColliderDesc' | 'HalfSpace'>,
): { collider: ColliderOptions; note?: string } {
  const [sx, sy, sz] = scale,
    even = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(a, b),
    round = even(sx, sz),
    hull = (points: number[], note: string) => ({
      collider: { shape: 'convexHull', points: Float32Array.from(points) } as ColliderOptions,
      note,
    });
  switch (shape.type) {
    case 'box': {
      const [x, y, z] = shape.box?.size ?? shapeDefaults.box;
      return { collider: { shape: 'box', halfExtents: [(x * sx) / 2, (y * sy) / 2, (z * sz) / 2] } };
    }
    case 'sphere': {
      const radius = shape.sphere?.radius ?? shapeDefaults.sphere;
      if (round && even(sx, sy)) return { collider: { shape: 'sphere', radius: radius * sx } };
      const points: number[] = [];
      ball(0, radius, scale, points);
      return hull(points, 'a sphere under uneven scale is a convex hull of 194 points');
    }
    case 'cylinder': {
      const height = shape.cylinder?.height ?? shapeDefaults.height,
        top = shape.cylinder?.radiusTop ?? shapeDefaults.radius,
        bottom = shape.cylinder?.radiusBottom ?? shapeDefaults.radius,
        halfHeight = (height / 2) * sy;
      if (round && even(top, bottom)) return { collider: { shape: 'cylinder', halfHeight, radius: top * sx } };
      if (round && !top) return { collider: { shape: 'cone', halfHeight, radius: bottom * sx } };
      if (round && !bottom) return { collider: { shape: 'cone', halfHeight, radius: top * sx, rotation: [1, 0, 0, 0] } };
      const points: number[] = [];
      ring(height / 2, top, scale, points, 32);
      ring(-height / 2, bottom, scale, points, 32);
      return hull(points, 'a cylinder with two radii or uneven scale is a convex hull of 64 points');
    }
    case 'capsule': {
      const height = shape.capsule?.height ?? shapeDefaults.height,
        top = shape.capsule?.radiusTop ?? shapeDefaults.radius,
        bottom = shape.capsule?.radiusBottom ?? shapeDefaults.radius;
      if (round && even(top, bottom) && even(sx, sy))
        return { collider: { shape: 'capsule', halfHeight: (height / 2) * sy, radius: top * sx } };
      const points: number[] = [];
      ball(height / 2, top, scale, points);
      ball(-height / 2, bottom, scale, points);
      return hull(points, 'a capsule with two radii or uneven scale is a convex hull of 388 points');
    }
    case 'plane': {
      const { sizeX, sizeZ, doubleSided } = shape.plane ?? {};
      if (sizeX === undefined && sizeZ === undefined && !doubleSided)
        return { collider: { shape: 'custom', desc: new rapier.ColliderDesc(new rapier.HalfSpace({ x: 0, y: 1, z: 0 }) as never) } };
      // A face has no thickness to solve against, so it is a box 2 mm thick with its top on the plane; an open side goes 1 km.
      const half = 0.001,
        wide = 1000;
      return {
        collider: {
          shape: 'box',
          halfExtents: [sizeX === undefined ? wide : (sizeX * sx) / 2, half, sizeZ === undefined ? wide : (sizeZ * sz) / 2],
          offset: [0, doubleSided ? 0 : -half, 0],
        },
        note: 'a finite or double sided plane is a box 2 mm thick',
      };
    }
    default:
      throw invalid(`KHR_implicit_shapes type ${String(shape.type)}`);
  }
}

const DOFS: readonly JointDof[] = ['linX', 'linY', 'linZ', 'angX', 'angY', 'angZ'];
const driveDof = (drive: Drive): JointDof => {
  if (!(drive.axis! >= 0 && drive.axis! <= 2) || (drive.type !== 'linear' && drive.type !== 'angular'))
    throw invalid('KHR_physics_rigid_bodies joint drive');
  return DOFS[(drive.type === 'linear' ? 0 : 3) + drive.axis!];
};
const driveMotor = (drive: Drive): MotorOptions => ({
  targetPosition: drive.positionTarget ?? 0,
  targetVelocity: drive.velocityTarget ?? 0,
  stiffness: drive.stiffness ?? 0,
  damping: drive.damping ?? 0,
  model: drive.mode === 'force' ? 'force' : 'acceleration',
  ...(drive.maxForce !== undefined ? { maxForce: drive.maxForce } : {}),
});

/**
 * The file's limits and drives as one generic joint. A limit on one axis is exact, closed or a range. A limit on several
 * axes at once is a distance or angle from rest: closed it is exact, otherwise a range on each axis, a box where the draft
 * has a sphere or a cone. Limits are hard, so a limit's stiffness only adds a note. Limits on one axis narrow each other.
 */
export function jointOptions(
  { limits = [], drives = [] }: JointDef,
  notes: string[] = [],
): Pick<GenericOptions, 'locked' | 'limits' | 'motors'> {
  const locked = new Set<JointDof>(),
    ranges: Partial<Record<JointDof, [number, number]>> = {},
    motors: Partial<Record<JointDof, MotorOptions>> = {};
  for (const limit of limits) {
    const axes = limit.linearAxes ?? limit.angularAxes;
    if (!axes?.length || axes.length > 3 || (limit.linearAxes && limit.angularAxes))
      throw invalid('KHR_physics_rigid_bodies joint limit');
    if (limit.stiffness !== undefined) notes.push('a soft joint limit is held hard');
    const many = axes.length > 1,
      // One unit range past which a linear limit means no limit, and the turn an angle measure ends at.
      wide = limit.linearAxes ? 1e6 : Math.PI;
    if (many && limit.max === undefined) {
      if (limit.min) notes.push('a lower limit on several axes at once is not held');
      continue;
    }
    if (many && limit.min) notes.push('a lower limit on several axes at once is not held');
    if (many && limit.max) notes.push(`a limit on ${axes.length} axes at once is a range on each axis`);
    const hi = Math.min(limit.max ?? wide, wide),
      lo = many ? -hi : Math.max(limit.min ?? -wide, -wide);
    for (const axis of axes) {
      if (!(axis >= 0 && axis <= 2)) throw invalid('KHR_physics_rigid_bodies joint axis');
      const dof = DOFS[(limit.linearAxes ? 0 : 3) + axis],
        now = ranges[dof];
      if (lo === 0 && hi === 0) locked.add(dof);
      else ranges[dof] = now ? [Math.max(now[0], lo), Math.min(now[1], hi)] : [lo, hi];
    }
  }
  // A locked axis in the limit list would turn back into a limited one.
  for (const dof of locked) delete ranges[dof];
  for (const drive of drives) motors[driveDof(drive)] = driveMotor(drive);
  return { locked: [...locked], limits: ranges, motors };
}

/** A scalar animation track at `time` by its sampler's interpolation. */
function sampleTrack({ times, values, mode }: Track, time: number): number {
  const cubic = mode === 'CUBICSPLINE',
    value = (k: number) => values[cubic ? k * 3 + 1 : k],
    last = times.length - 1;
  if (time <= times[0]) return value(0);
  if (time >= times[last]) return value(last);
  let k = 0;
  while (times[k + 1] <= time) k++;
  const span = times[k + 1] - times[k],
    u = (time - times[k]) / span;
  if (mode === 'STEP') return value(k);
  if (!cubic) return value(k) + (value(k + 1) - value(k)) * u;
  const u2 = u * u,
    u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * value(k) +
    (u3 - 2 * u2 + u) * span * values[k * 3 + 2] +
    (-2 * u3 + 3 * u2) * value(k + 1) +
    (u3 - u2) * span * values[(k + 1) * 3]
  );
}

const drivePointer =
  /^\/extensions\/KHR_physics_rigid_bodies\/physicsJoints\/(\d+)\/drives\/(\d+)\/(maxForce|positionTarget|velocityTarget|stiffness|damping)$/;
const motionPointer = /^\/nodes\/(\d+)\/extensions\/KHR_physics_rigid_bodies\/motion\/(linearVelocity|angularVelocity|gravityFactor)$/;

/**
 * Builds a model's KHR_physics_rigid_bodies in a physics world: a node with a motion is a body that moves it, with its
 * descendants' colliders on it; a collider with no motion above it is fixed; triggers are sensors; joints connect the two
 * attachment frames. Nodes the file animates are kinematic and follow their animation, scale included, and the file's
 * KHR_animation_pointer channels on joint drives play on the world's clock. Loads `@margoengine/physics`.
 *
 * @example
 * const model = await loadGLTF(engine, '/door.gltf');
 * const world = await applyGLTFPhysics(model);
 * world.onTrigger(({entered, nodeIndex}) => console.log(entered, nodeIndex));
 * @throws TypeError for a file that breaks the extension's rules.
 * @throws RangeError past 15 distinct collision filters.
 */
export async function applyGLTFPhysics(model: PBRModel, options: GLTFPhysicsOptions = {}): Promise<GLTFPhysics> {
  const { Physics: World, collisionGroups } = await import('@margoengine/physics').catch((error) => {
    throw margoError(
      'unsupported',
      `glTF physics needs @margoengine/physics (${error instanceof Error ? error.message : error}): install it to use @margoengine/gltf-pro/physics`,
    );
  });
  if (!options.physics) await World.load();
  const engine = model['engine'],
    own = !options.physics,
    physics = options.physics ?? World.attach(engine),
    doc = model.asset.doc as GLTFDocument & Record<string, any>,
    nodes = (doc.nodes ?? []) as NodeDoc[],
    root = ((doc.extensions as any)?.KHR_physics_rigid_bodies ?? {}) as { physicsMaterials?: Material[]; collisionFilters?: Filter[]; physicsJoints?: JointDef[] },
    shapes: ImplicitShape[] = (doc.extensions as any)?.KHR_implicit_shapes?.shapes ?? [],
    materials: Material[] = root.physicsMaterials ?? [],
    filters: Filter[] = root.collisionFilters ?? [],
    jointDefs: JointDef[] = structuredClone(root.physicsJoints ?? []),
    masks = filterMasks(filters),
    parents = new Int32Array(nodes.length).fill(-1),
    notes: GLTFPhysicsNote[] = [],
    bodies = new Map<number, PhysicsBody>(),
    joints = new Map<number, PhysicsJoint>(),
    jointsOf = new Map<number, PhysicsJoint[]>(),
    triggers: GLTFTrigger[] = [],
    follow: { body: PhysicsBody; node: number }[] = [],
    removers: (() => void)[] = [],
    colliderNode = new Map<Collider, number>();
  const note = (nodeIndex: number, text: string) => {
    if (!notes.some((n) => n.nodeIndex === nodeIndex && n.note === text)) notes.push({ nodeIndex, note: text });
  };
  nodes.forEach((node, i) => node?.children?.forEach((child) => (parents[child] = i)));
  const data = (i: number) => nodes[i]?.extensions?.KHR_physics_rigid_bodies;
  engine?.store.tick(false);
  // World matrices: the live ones, or the file's chain for a node outside the scene.
  const world = (i: number): Matrix => {
    const mesh = model.nodes[i];
    if (mesh) return Float64Array.from(mesh.matrix);
    const parent = parents[i];
    return parent < 0 ? localMatrix(nodes[i]) : multiplyMatrices(world(parent), localMatrix(nodes[i]), new Float64Array(16));
  };
  const carrier = (i: number): number => {
    for (let n = i; n >= 0; n = parents[n]) if (data(n)?.motion) return n;
    return -1;
  };
  const animated = new Set<number>(),
    rescaled = new Set<number>(),
    tracks: Track[] = [];
  for (const animation of doc.animations ?? [])
    for (const channel of animation.channels ?? []) {
      const target = channel.target as { node?: number; path?: string; extensions?: Record<string, any> },
        pointer = target?.extensions?.KHR_animation_pointer?.pointer as string | undefined,
        found = pointer ? /^\/nodes\/(\d+)\/(translation|rotation|scale|matrix)$/.exec(pointer) : undefined,
        index = pointer ? found?.[1] : target?.node,
        path = pointer ? found?.[2] : target?.path;
      if (index !== undefined && path !== 'weights') {
        animated.add(+index);
        if (path === 'scale' || path === 'matrix') rescaled.add(+index);
      }
      if (!pointer) continue;
      const drive = drivePointer.exec(pointer);
      if (drive) {
        const sampler = animation.samplers[channel.sampler];
        tracks.push({
          pointer,
          times: model.asset.accessor(sampler.input, 'SCALAR'),
          values: model.asset.accessor(sampler.output, 'SCALAR'),
          mode: sampler.interpolation ?? 'LINEAR',
        });
      } else if (pointer.includes('KHR_physics_rigid_bodies'))
        note(-1, `the animated property ${pointer} is not followed`);
    }
  const above = (i: number, set: Set<number>) => {
    for (let n = i; n >= 0; n = parents[n]) if (set.has(n)) return true;
    return false;
  };
  // Geometry of a mesh, from the file, as positions and indices.
  const meshes = new Map<number, { positions: Float32Array; indices: ArrayLike<number> }[]>();
  const meshData = (index: number) => {
    let list = meshes.get(index);
    if (!list) {
      const mesh = doc.meshes?.[index];
      if (!mesh) throw invalid('KHR_physics_rigid_bodies geometry mesh');
      list = mesh.primitives
        .filter((p: GLTFPrimitive) => (p.mode ?? 4) >= 4)
        .map((p: GLTFPrimitive) => {
          const { vertices, indices } = packPrimitive(model.asset, p),
            positions = new Float32Array((vertices.length / 20) * 3);
          // The 80-byte vertex of gltf-pro begins with its position.
          for (let v = 0, o = 0; o < vertices.length; v += 3, o += 20) positions.set(vertices.subarray(o, o + 3), v);
          return { positions, indices };
        });
      meshes.set(index, list);
    }
    return list;
  };
  // Triangles of a geometry in the frame of its reference, at `scale`.
  const triangles = (geometry: Geometry, scale: Vec3) => {
    const points: number[] = [],
      indices: number[] = [];
    const add = (mesh: number, m: ArrayLike<number>) => {
      for (const part of meshData(mesh)) {
        const base = points.length / 3;
        for (let v = 0; v < part.positions.length; v += 3) {
          const x = part.positions[v],
            y = part.positions[v + 1],
            z = part.positions[v + 2];
          for (let a = 0; a < 3; a++) points.push((m[a] * x + m[4 + a] * y + m[8 + a] * z + m[12 + a]) * scale[a]);
        }
        for (let k = 0; k < part.indices.length; k++) indices.push(base + part.indices[k]);
      }
    };
    const walk = (i: number, m: ArrayLike<number>) => {
      if (!nodes[i]) throw invalid('KHR_physics_rigid_bodies geometry node');
      if (nodes[i].mesh !== undefined) add(nodes[i].mesh!, m);
      for (const child of nodes[i].children ?? [])
        walk(child, multiplyMatrices(m, localMatrix(nodes[child]), new Float64Array(16)));
    };
    const identity = composeMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1], new Float64Array(16));
    if (geometry.node !== undefined) walk(geometry.node, identity);
    else add(geometry.mesh!, identity);
    return { points, indices };
  };
  // The collider of a part in its body's frame, or none where the file's scale leaves no volume.
  const colliderFor = (part: Part): ColliderOptions | undefined => {
    const { geometry, node: nodeIndex } = part,
      { position, rotation, scale } = split(relative(world(part.base), world(nodeIndex))),
      size = scale.map(Math.abs) as Vec3;
    part.size = size;
    if (size.some((s) => s === 0)) return undefined;
    if ((geometry.shape === undefined) === (geometry.node === undefined && geometry.mesh === undefined))
      throw invalid('KHR_physics_rigid_bodies geometry');
    let collider: ColliderOptions;
    if (geometry.shape !== undefined) {
      const shape = shapes[geometry.shape];
      if (!shape) throw invalid('KHR_implicit_shapes shape index');
      const made = shapeCollider(shape, size, physics.rapier);
      collider = made.collider;
      if (made.note) note(nodeIndex, made.note);
    } else {
      const { points, indices } = triangles(geometry, size);
      if (!points.length) return undefined;
      collider = geometry.convexHull
        ? { shape: 'convexHull', points: Float32Array.from(points) }
        : { shape: 'trimesh', vertices: Float32Array.from(points), indices: Uint32Array.from(indices) };
    }
    const own = collider as { offset?: Vec3; rotation?: Quat };
    return {
      ...collider,
      ...part.extra,
      offset: place(position, rotation, own.offset),
      rotation: compose(rotation, own.rotation),
    };
  };
  const settings = (node: number, filter: number | undefined, material?: number) => {
    const out: Record<string, unknown> = {};
    if (filters.length) {
      const mask = masks[filter ?? filters.length];
      if (!mask) throw invalid('KHR_physics_rigid_bodies collisionFilter');
      out.collisionGroups = collisionGroups(mask.memberships, mask.filter);
    }
    if (material !== undefined) {
      const m = materials[material];
      if (!m) throw invalid('KHR_physics_rigid_bodies physicsMaterial');
      const combine = (rule?: string) => (rule === 'minimum' ? 'min' : rule === 'maximum' ? 'max' : rule),
        moving = m.dynamicFriction ?? materialDefaults.friction;
      if ((m.staticFriction ?? materialDefaults.friction) !== moving)
        note(node, 'static friction is not separate: the dynamic value is used');
      out.friction = moving;
      out.restitution = m.restitution ?? materialDefaults.restitution;
      if (m.frictionCombine) out.frictionCombine = combine(m.frictionCombine);
      if (m.restitutionCombine) out.restitutionCombine = combine(m.restitutionCombine);
    }
    return out;
  };
  // Every collider and trigger, by the node whose body carries it.
  const parts = new Map<number, Part[]>(),
    triggerOf = new Map<number, number>();
  const attach = (node: number, geometry: Geometry | undefined, extra: object) => {
    if (!geometry) throw invalid('KHR_physics_rigid_bodies geometry');
    const owner = carrier(node),
      base = owner >= 0 ? owner : node;
    if (!parts.has(base)) parts.set(base, []);
    parts.get(base)!.push({ node, base, geometry, extra });
  };
  nodes.forEach((_, i) => {
    const { collider, trigger } = data(i) ?? {};
    if (collider) attach(i, collider.geometry, settings(i, collider.collisionFilter, collider.physicsMaterial));
    if (trigger?.nodes) for (const child of trigger.nodes) triggerOf.set(child, i);
    // A trigger detects and has no mass.
    if (trigger?.geometry) attach(i, trigger.geometry, { ...settings(i, trigger.collisionFilter), sensor: true, density: 0 });
  });
  // Rapier puts a slow body to sleep, and a drive that is still pulling it would stop short of its target.
  const driven = new Set<number>();
  nodes.forEach((_, i) => {
    const joint = data(i)?.joint;
    if (joint && jointDefs[joint.joint!]?.drives?.length)
      for (const node of [i, joint.connectedNode!]) driven.add(carrier(node));
  });
  const body = (i: number, type: 'dynamic' | 'kinematicVelocity' | 'fixed') => {
    const mesh = model.nodes[i],
      follows = !!mesh && above(i, animated),
      list = parts.get(i) ?? [],
      present = list.map((part) => ({ part, collider: colliderFor(part) })).filter((entry) => entry.collider),
      colliders = present.map((entry) => entry.collider!),
      { position, rotation } = split(world(i)),
      awake = driven.has(i) ? { canSleep: false } : {},
      made =
        mesh && type !== 'fixed' && !follows
          ? physics.addBody(mesh, { type, colliders, ...awake })
          : physics.addBody(null, { type: follows ? 'kinematicPosition' : type, position, rotation, colliders, ...awake });
    present.forEach(({ part }, k) => {
      part.made = made.colliders[k];
      colliderNode.set(made.colliders[k], part.node);
    });
    if (follows) follow.push({ body: made, node: i });
    bodies.set(i, made);
    return made;
  };
  const bodyFor = (i: number): PhysicsBody | undefined => {
    const owner = carrier(i);
    return bodies.get(owner >= 0 ? owner : i);
  };
  // The body behind one attachment frame and the frame in its space. A node on nothing that moves gets a fixed body of its own.
  const anchor = (i: number): [PhysicsBody, { position: Vec3; rotation: Quat }] => {
    const owner = carrier(i),
      base = owner >= 0 ? owner : i;
    return [bodies.get(base) ?? body(base, 'fixed'), split(relative(world(base), world(i)))];
  };
  const massOf = (made: PhysicsBody, motion: Motion, scale: Vec3) => {
    const { mass: kilograms, inertiaDiagonal: inertia, centerOfMass: centre, inertiaOrientation: frame } = motion;
    if (kilograms === undefined && !inertia && !centre) return;
    const { raw } = made,
      computed = raw.mass(),
      com = raw.localCom(),
      principal = raw.principalInertia(),
      axes = raw.principalInertiaLocalFrame(),
      total = kilograms ?? computed,
      // A shape's inertia grows with its mass. Rapier reads 0 as infinite, as the draft does.
      over = computed > 0 ? total / computed : 0;
    for (const collider of made.colliders) collider.setDensity(0);
    raw.setAdditionalMassProperties(
      total,
      centre ? vector(centre.map((v, a) => v * scale[a])) : com,
      inertia ? vector(inertia) : vector([principal.x * over, principal.y * over, principal.z * over]),
      frame ? { x: frame[0], y: frame[1], z: frame[2], w: frame[3] } : inertia ? { x: 0, y: 0, z: 0, w: 1 } : axes,
      true,
    );
    raw.recomputeMassPropertiesFromColliders();
  };
  const dispose = () => {
    for (const stop of removers.splice(0)) stop();
    for (const joint of joints.values()) joint.remove();
    for (const made of bodies.values()) physics.removeBody(made);
    if (own) physics.dispose();
  };
  try {
    nodes.forEach((_, i) => {
      const motion = data(i)?.motion;
      if (!motion) return;
      const matrix = world(i),
        made = body(i, motion.isKinematic ? 'kinematicVelocity' : 'dynamic');
      if (motion.linearVelocity) made.raw.setLinvel(vector(rotate(matrix, motion.linearVelocity)), true);
      if (motion.angularVelocity) made.raw.setAngvel(vector(rotate(matrix, motion.angularVelocity)), true);
      if (motion.gravityFactor !== undefined) made.raw.setGravityScale(motion.gravityFactor, true);
      if (!motion.isKinematic) massOf(made, motion, split(matrix).scale);
    });
    for (const i of parts.keys()) if (!bodies.has(i)) body(i, 'fixed');
    nodes.forEach((_, i) => {
      if (data(i)?.trigger?.geometry) triggers.push({ nodeIndex: i, body: bodyFor(i)! });
    });
    nodes.forEach((_, i) => {
      const joint = data(i)?.joint;
      if (!joint) return;
      const def = jointDefs[joint.joint!],
        other = joint.connectedNode!;
      if (!def || !nodes[other]) throw invalid('KHR_physics_rigid_bodies joint');
      const said: string[] = [],
        shape = jointOptions(def, said),
        [a, frameA] = anchor(i),
        [b, frameB] = anchor(other);
      for (const text of said) note(i, text);
      if (a === b) return note(i, 'a joint between two nodes of one body has no effect');
      const made = physics.addJoint(a, b, {
        type: 'generic',
        ...shape,
        anchorA: frameA.position,
        frameA: frameA.rotation,
        anchorB: frameB.position,
        frameB: frameB.rotation,
        contactsEnabled: !!joint.enableCollision,
      });
      joints.set(i, made);
      if (!jointsOf.has(joint.joint!)) jointsOf.set(joint.joint!, []);
      jointsOf.get(joint.joint!)!.push(made);
    });
  } catch (error) {
    dispose();
    throw error;
  }
  const setPointer = (pointer: string, value: number | readonly number[]) => {
    const drive = drivePointer.exec(pointer);
    if (drive) {
      const def = jointDefs[+drive[1]],
        target = def?.drives?.[+drive[2]];
      if (!target || typeof value !== 'number') return false;
      (target as Record<string, unknown>)[drive[3]] = value;
      for (const joint of jointsOf.get(+drive[1]) ?? []) joint.setAxisMotor(driveDof(target), driveMotor(target));
      return true;
    }
    const motion = motionPointer.exec(pointer),
      made = motion && bodies.get(+motion[1]);
    if (!motion || !made) return false;
    if (motion[2] === 'gravityFactor') {
      if (typeof value !== 'number') return false;
      made.raw.setGravityScale(value, true);
      return true;
    }
    if (typeof value === 'number') return false;
    const turned = vector(rotate(world(+motion[1]), value));
    if (motion[2] === 'linearVelocity') made.raw.setLinvel(turned, true);
    else made.raw.setAngvel(turned, true);
    return true;
  };
  // A follower's collider is rebuilt when its node's scale moves, as a shape has no scale of its own.
  const resize = (part: Part, made: PhysicsBody) => {
    const before = part.size!,
      { scale } = split(relative(world(part.base), world(part.node)));
    if (scale.every((s, a) => Math.abs(Math.abs(s) - before[a]) <= 1e-6 * before[a])) return;
    if (part.made) {
      colliderNode.delete(part.made);
      made.removeCollider(part.made);
      part.made = undefined;
    }
    const collider = colliderFor(part);
    if (!collider) return;
    part.made = made.addCollider(collider);
    colliderNode.set(part.made, part.node);
  };
  if (follow.length || tracks.length) {
    let clock = 0;
    const length = tracks.reduce((end, track) => Math.max(end, track.times[track.times.length - 1]), 0);
    removers.push(
      physics.on('beforestep', (step) => {
        if (tracks.length) {
          clock += step;
          const time = length > 0 ? clock % length : 0;
          for (const track of tracks) setPointer(track.pointer, sampleTrack(track, time));
        }
        for (const { body: moving, node } of follow) {
          const { position, rotation } = split(world(node));
          moving.raw.setNextKinematicTranslation(vector(position));
          moving.raw.setNextKinematicRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] });
          for (const part of parts.get(node) ?? []) if (above(part.node, rescaled)) resize(part, moving);
        }
      }),
    );
  }
  const outermost = (i: number) => {
    let top = i;
    while (triggerOf.has(top)) top = triggerOf.get(top)!;
    return top;
  };
  let closed = false;
  return {
    physics,
    bodies,
    joints,
    triggers,
    notes,
    bodyOf: bodyFor,
    setPointer,
    onTrigger(listener) {
      // A compound trigger is one volume: a collider enters with its first part and leaves with its last.
      const inside = new Map<string, number>();
      const tell = (entered: boolean) => (event: { colliderA: Collider; colliderB: Collider; bodyA: PhysicsBody; bodyB: PhysicsBody }) => {
        for (const [sensor, other, body] of [
          [event.colliderA, event.colliderB, event.bodyB],
          [event.colliderB, event.colliderA, event.bodyA],
        ] as const) {
          const part = colliderNode.get(sensor);
          if (part === undefined || !sensor.isSensor() || other.isSensor()) continue;
          const nodeIndex = outermost(part),
            key = `${nodeIndex}/${other.handle}`,
            count = (inside.get(key) ?? 0) + (entered ? 1 : -1);
          if (count) inside.set(key, count);
          else inside.delete(key);
          if (count !== (entered ? 1 : 0)) continue;
          const colliderNodeIndex = colliderNode.get(other) ?? -1;
          listener({
            entered,
            nodeIndex,
            colliderNodeIndex,
            motionNodeIndex: colliderNodeIndex < 0 ? -1 : carrier(colliderNodeIndex),
            body,
          });
        }
      };
      const stops = [physics.on('intersectionstart', tell(true)), physics.on('intersectionend', tell(false))],
        stop = () => stops.forEach((off) => off());
      removers.push(stop);
      return stop;
    },
    dispose() {
      if (closed) return;
      closed = true;
      dispose();
    },
  };
}
