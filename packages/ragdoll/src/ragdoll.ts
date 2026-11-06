/// <reference lib="esnext.disposable" preserve="true" />
// A ragdoll: one capsule body per bone of a skeleton, joined at the bone origins, with swing and twist limits, that
// either follows the animation (kinematic hit boxes) or drives the bones (limp), and blends back to the animation.
// Written clean room from the public descriptions cited in docs/clean-room.md (swing-twist decomposition, velocity
// level limit impulses with a Baumgarte bias); no engine's source was read.
import type { Engine, EnginePlugin, Mesh } from '@margoengine/core/extension';
import type { Physics, PhysicsBody, PhysicsJoint } from '@margoengine/physics';
import { MargoError } from '@margoengine/math/errors';
import {
  conjugateQuaternion,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';

type Vec3 = readonly [number, number, number];

/**
 * How a bone turns against its parent bone, measured from the rest pose the ragdoll was built in.
 * - `cone`: a ball joint whose bone axis stays inside a cone of half angle `swing` radians around its rest direction
 *   and twists about that axis between `twist[0]` and `twist[1]` radians (shoulders, hips, spine, neck).
 * - `hinge`: one axis of rotation, `axis` in the bone's own local frame, turning between `limits` radians (knees,
 *   elbows, fingers).
 * - `free`: a ball joint with no limits.
 */
export type RagdollJoint =
  | { type: 'cone'; swing?: number; twist?: readonly [number, number] }
  | { type: 'hinge'; axis: Vec3; limits?: readonly [number, number] }
  | { type: 'free' };

/** One bone of a ragdoll built from an explicit list ({@link RagdollOptions.bones}). Every field but `node` has a default. */
export interface RagdollBone {
  /** The skeleton node (a glTF joint) this body moves. */
  node: Mesh;
  /** Joint to the parent bone. Default {@link RagdollOptions.joint}. The root bone has no joint. */
  joint?: RagdollJoint;
  /**
   * Length of the bone's capsule in metres, from the node's origin toward its children. Default: the distance to its
   * children's centre (or to its farthest child when that centre is nearly at the origin). Required for a node with
   * no children.
   */
  length?: number;
  /**
   * Capsule radius in metres. Default {@link RagdollOptions.thickness} times the length, or half the distance of the
   * farthest child from the bone's line when that is more (a pelvis between the legs, a chest between the arms).
   */
  radius?: number;
  /** Mass in kilograms. Default: the capsule volume times {@link RagdollOptions.density}. */
  mass?: number;
}

/** Options of {@link Ragdoll}. Pass `root` (every bone under it) or `bones` (an explicit list); the rest have defaults. */
export interface RagdollOptions {
  /** The skeleton's root bone (usually the hips): it and every descendant at least `minLength` long become bones. */
  root?: Mesh;
  /** An explicit list of bones instead of `root`. One is the root; every other bone's parent node is in the list. */
  bones?: readonly (Mesh | RagdollBone)[];
  /** Joint for every bone that does not set its own. Default `{type: 'cone', swing: π/4, twist: [-π/6, π/6]}`. */
  joint?: RagdollJoint;
  /** With `root`, bones whose farthest child is nearer than this many metres are left out with it (fingers, toes). Default 0.05. */
  minLength?: number;
  /** Capsule radius as a fraction of the bone length, for bones without a `radius`. Default 0.2. */
  thickness?: number;
  /** Body density in kg per cubic metre. Default 1000 (water, about a human body's). */
  density?: number;
  /** Start limp (`true`) or following the animation (`false`). Default false. */
  active?: boolean;
  /** Packed collision groups (`collisionGroups` from physics) for every capsule. Default: group 15, colliding with groups 0 to 14, so the ragdoll's parts do not collide with each other. */
  collisionGroups?: number;
  /** Friction of every capsule. Default 0.6. */
  friction?: number;
  /** Linear damping per body, so a limp ragdoll settles. Default 0.05. */
  linearDamping?: number;
  /** Angular damping per body. Default 0.8. */
  angularDamping?: number;
  /** How hard swing and twist limits push back, as the share of the error removed per physics step, 0 to 1. Default 0.2. */
  limitStiffness?: number;
}

/** A body of a ragdoll and the bone it moves ({@link Ragdoll.bones}). */
export interface RagdollPart {
  /** The skeleton node. */
  readonly node: Mesh;
  /** Its capsule body; apply impulses to it for hits. `body.userData` is `{ragdoll, node}`. */
  readonly body: PhysicsBody;
  /** The joint to the parent bone; null for the root bone. */
  readonly joint: PhysicsJoint | null;
  /** Index of the parent bone in {@link Ragdoll.bones}; -1 for the root bone. */
  readonly parent: number;
  /** Capsule length in metres. */
  readonly length: number;
  /** Capsule radius in metres. */
  readonly radius: number;
  /** Unit direction of the bone in its own frame (the body's frame), toward its children. */
  readonly axis: ArrayLike<number>;
  /** Rest rotation relative to the parent bone, xyzw; what the joint limits measure from. */
  readonly rest: ArrayLike<number>;
  /** The joint as built, every default filled in; null for the root bone. */
  readonly spec: RagdollJoint | null;
  /** The local pose the animation last gave the bone, xyz then xyzw: what motors drive toward. */
  readonly animated: ArrayLike<number>;
  /** True while physics drives this bone. */
  readonly limp: boolean;
  /** How much of this bone's drawn pose is the ragdoll's, 0 (the animation) to 1 (physics). */
  readonly weight: number;
}

/** One bone or several, as nodes or parts: each stands for itself and every bone under it. */
export type RagdollLimb = Mesh | RagdollPart | readonly (Mesh | RagdollPart)[];

interface Cone {
  swing: number;
  min: number;
  max: number;
}
interface Bone extends RagdollPart {
  readonly axis: Float64Array;
  readonly rest: Float64Array;
  readonly cone: Cone | null;
  /** Inverse inertia about the bone axis and across it (0 while kinematic). */
  readonly inertia: Float64Array;
  /** Previous and current physics step poses, xyz then xyzw. */
  readonly prev: Float64Array;
  readonly cur: Float64Array;
  readonly animated: Float64Array;
  /** What the ragdoll last wrote into the node, to tell an animated pose from its own. */
  readonly written: Float64Array;
  /** The physics pose as a local transform: this frame's, or the one frozen by `deactivate`. */
  readonly local: Float64Array;
  /** World pose this frame, physics or animation: xyz then xyzw. */
  readonly world: Float64Array;
  /** Kinematic target, xyz then xyzw. */
  readonly target: [number, number, number, number, number, number, number];
  limp: boolean;
  weight: number;
  /** Weight lost per second while blending back. */
  fade: number;
  /** The next kinematic target is a jump, not a sweep. */
  jump: boolean;
}

const DEFAULT_JOINT: RagdollJoint = { type: 'cone', swing: Math.PI / 4, twist: [-Math.PI / 6, Math.PI / 6] };

const mul = (a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array, at = 0): Float64Array => {
  const ax = a[0],
    ay = a[1],
    az = a[2],
    aw = a[3],
    bx = b[0],
    by = b[1],
    bz = b[2],
    bw = b[3];
  out[at] = aw * bx + ax * bw + ay * bz - az * by;
  out[at + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[at + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[at + 3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
};
/** Shortest-arc rotation taking `from` to `to` (unit vectors). */
function arc(from: ArrayLike<number>, to: ArrayLike<number>, out: Float64Array): Float64Array {
  const d = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (d < -0.999999) {
    // Opposite: any axis perpendicular to `from`.
    let x = 0,
      y = -from[2],
      z = from[1];
    if (Math.hypot(y, z) < 1e-6) {
      x = from[2];
      y = 0;
      z = -from[0];
    }
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = 0;
  } else {
    out[0] = from[1] * to[2] - from[2] * to[1];
    out[1] = from[2] * to[0] - from[0] * to[2];
    out[2] = from[0] * to[1] - from[1] * to[0];
    out[3] = 1 + d;
  }
  return normalizeQuaternion(out, out);
}
/** Spherical blend of the unit quaternions at `a[ai]` and `b[bi]` into `out[oi]`, shortest way round. */
function slerp(
  a: ArrayLike<number>,
  ai: number,
  b: ArrayLike<number>,
  bi: number,
  t: number,
  out: Float64Array,
  oi: number,
) {
  let dot = a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2] + a[ai + 3] * b[bi + 3],
    sign = 1;
  if (dot < 0) {
    sign = -1;
    dot = -dot;
  }
  let left = 1 - t,
    right = t * sign;
  if (dot < 0.9995) {
    const angle = Math.acos(dot),
      sin = Math.sin(angle);
    left = Math.sin((1 - t) * angle) / sin;
    right = (Math.sin(t * angle) / sin) * sign;
  }
  let length = 0;
  for (let k = 0; k < 4; k++) {
    const v = a[ai + k] * left + b[bi + k] * right;
    out[oi + k] = v;
    length += v * v;
  }
  length = Math.sqrt(length);
  for (let k = 0; k < 4; k++) out[oi + k] /= length;
}
/** Child meshes per mesh id, in creation order. */
function childMeshes(engine: Engine): Map<number, Mesh[]> {
  const parents = engine.store.parents,
    map = new Map<number, Mesh[]>();
  for (const mesh of engine.meshes.values()) {
    const parent = parents[mesh.id];
    if (parent === -1) continue;
    let list = map.get(parent);
    if (!list) map.set(parent, (list = []));
    list.push(mesh);
  }
  return map;
}
const positive = (value: unknown, name: string, fix: string): number => {
  if (typeof value !== 'number' || !(value > 0) || value === Infinity)
    throw new RangeError(`Ragdoll ${name} must be a positive finite number; ${fix}`);
  return value;
};

/**
 * A ragdoll on a skeleton: one capsule body per bone, joined at the bone origins with swing and twist limits. Built
 * kinematic, it follows the animation (hit boxes that push the world); `activate()` makes it limp, so physics drives
 * the bones; `deactivate(seconds)` hands the bones back to the animation with a blend. Create it after the Animator so
 * it runs after the animation each frame. Removed with `dispose()` (or `using`) or with the physics world.
 * @example
 * const ragdoll = Ragdoll.attach(physics, { root: model.nodes[hips] });
 * ragdoll.activate(); // limp: physics moves the bones
 * ragdoll.bones[0].body.applyImpulse([0, 0, -40]);
 * ragdoll.deactivate(0.5); // blend back to the animation over half a second
 */
export class Ragdoll implements EnginePlugin {
  /** Plugin name, `ragdoll:<root node id>`. */
  readonly name: string;
  /** The bodies, parents before children; `bones[0]` is the root bone. */
  readonly bones: readonly RagdollPart[];
  private readonly parts: Bone[];
  private readonly engine: Engine;
  private readonly stiffness: number;
  private readonly unsubscribe: Array<() => void> = [];
  /** How many bones are limp. */
  private loose = 0;
  private stepped = 0;
  private attached?: Engine;
  private disposed = false;
  private readonly q = new Float64Array(4);
  private readonly r = new Float64Array(4);
  private readonly s = new Float64Array(4);
  private readonly v = new Float64Array(3);
  private readonly w = new Float64Array(3);
  private readonly c = new Float64Array(3);
  private readonly pose = new Float64Array(7);
  private readonly turnBy = new Float64Array(4);
  private readonly turned = new Float64Array(4);
  /** Angular velocities per bone during the limit pass, xyz each. */
  private omega = new Float64Array(0);

  /**
   * Builds the bodies and joints at the skeleton's current pose, which becomes the rest pose the limits measure from.
   * @param physics The world to add the bodies to.
   * @param options `root` or `bones`, plus optional joint, size and mass settings.
   */
  constructor(
    readonly physics: Physics,
    options: RagdollOptions,
  ) {
    if (typeof physics?.addBody !== 'function' || physics.isDisposed)
      throw new TypeError('A ragdoll needs a live Physics world: new Ragdoll(physics, {root: hips}).');
    if (!options || (options.root === undefined) === (options.bones === undefined))
      throw new TypeError('Ragdoll options need exactly one of root (the hips node) or bones (a list of nodes).');
    const minLength = options.minLength ?? 0.05,
      thickness = options.thickness ?? 0.2,
      density = options.density ?? 1000;
    if (!(minLength >= 0) || minLength === Infinity)
      throw new RangeError('Ragdoll minLength must be a finite number of at least 0; pass metres, e.g. 0.05.');
    positive(thickness, 'thickness', 'pass a fraction of the bone length, e.g. 0.2.');
    positive(density, 'density', 'pass kilograms per cubic metre, e.g. 1000.');
    this.stiffness = options.limitStiffness ?? 0.2;
    if (!(this.stiffness >= 0 && this.stiffness <= 1))
      throw new RangeError('Ragdoll limitStiffness must be from 0 to 1; pass the share of the error removed per step.');
    const list = this.boneList(options, minLength);
    const engine = list[0].node.engine;
    this.engine = engine;
    this.name = 'ragdoll:' + list[0].node.id;
    const store = engine.store,
      parents = store.parents,
      index = new Map<number, number>();
    list.forEach((bone, i) => {
      if (bone.node.engine !== engine)
        throw new TypeError('Ragdoll bones must all belong to one engine; pass nodes of one skeleton.');
      if (index.has(bone.node.id)) throw new TypeError('Ragdoll bones must be distinct; list each node once.');
      index.set(bone.node.id, i);
    });
    // Parents first: a bone's parent is the nearest listed node above it, and only the root may have none.
    const parentOf = list.map((bone) => {
      const parent = parents[bone.node.id];
      return parent !== -1 && index.has(parent) ? index.get(parent)! : -1;
    });
    if (parentOf.filter((p) => p === -1).length !== 1)
      throw new TypeError(
        "Ragdoll bones must form one tree; list every node between the root bone and each other bone (each bone's parent node is a bone).",
      );
    const order: number[] = [];
    const visit = (i: number): void => {
      order.push(i);
      list.forEach((_, j) => parentOf[j] === i && visit(j));
    };
    visit(parentOf.indexOf(-1));
    store.tick(false);
    const children = childMeshes(engine);
    const worldPose = (node: Mesh, out: Float64Array): Float64Array => {
      const m = node.matrix,
        sx = Math.hypot(m[0], m[1], m[2]),
        sy = Math.hypot(m[4], m[5], m[6]),
        sz = Math.hypot(m[8], m[9], m[10]);
      if (!(sx > 0) || Math.abs(sx - sy) > 1e-4 * sx || Math.abs(sx - sz) > 1e-4 * sx)
        throw new RangeError('Ragdoll bones need positive uniform world scales; remove non-uniform bone scales.');
      out[0] = m[12];
      out[1] = m[13];
      out[2] = m[14];
      rotationToQuaternion(m, this.q, sx, sy, sz);
      normalizeQuaternion(this.q, this.q);
      out.set(this.q, 3);
      return out;
    };
    const parts: Bone[] = [],
      created: PhysicsBody[] = [];
    const remap = new Map<number, number>();
    const groups = options.collisionGroups ?? ((0x8000 << 16) | 0x7fff) >>> 0;
    if (!Number.isInteger(groups) || groups < 0 || groups > 0xffffffff)
      throw new RangeError('Ragdoll collisionGroups must be a packed 32-bit integer; build it with collisionGroups().');
    try {
      for (const i of order) {
        const spec = list[i],
          node = spec.node,
          world = worldPose(node, new Float64Array(7)),
          origin = [world[0], world[1], world[2]],
          rotation: [number, number, number, number] = [world[3], world[4], world[5], world[6]],
          inverse = conjugateQuaternion(rotation);
        // The bone runs from the node toward its children: their centre, or the farthest child when that is too close.
        const kids = children.get(node.id) ?? [];
        const ends = kids.map((kid) => worldPose(kid, new Float64Array(7)));
        let direction: number[] = [0, 1, 0],
          reach = 0,
          spread = 0;
        if (ends.length) {
          const centre = [0, 1, 2].map((k) => ends.reduce((sum, end) => sum + end[k], 0) / ends.length - origin[k]);
          let far = centre,
            best = Math.hypot(centre[0], centre[1], centre[2]);
          if (best < 1e-3)
            for (const end of ends) {
              const d = [end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]],
                length = Math.hypot(d[0], d[1], d[2]);
              if (length > best) {
                best = length;
                far = d;
              }
            }
          if (best > 1e-6) {
            direction = rotateByQuaternion(
              far.map((v) => v / best),
              inverse,
            );
            reach = best;
            // How far the children sit off the bone's line (the legs off a pelvis, the arms off a chest).
            for (const end of ends) {
              const d = [end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]],
                along = (d[0] * far[0] + d[1] * far[1] + d[2] * far[2]) / best;
              spread = Math.max(
                spread,
                Math.hypot(
                  d[0] - (far[0] / best) * along,
                  d[1] - (far[1] / best) * along,
                  d[2] - (far[2] / best) * along,
                ),
              );
            }
          }
        }
        const length =
          spec.length !== undefined
            ? positive(spec.length, 'bone length', 'pass metres, or leave it out for a bone with children.')
            : reach;
        if (!(length > 0))
          throw new TypeError(
            `Ragdoll bone "${node.name || node.id}" has no children to measure; give it a length in metres.`,
          );
        const radius =
            spec.radius !== undefined
              ? positive(spec.radius, 'bone radius', 'pass metres, or leave it out for thickness times the length.')
              : Math.max(length * thickness, spread / 2),
          half = Math.max(length / 2 - radius, 1e-3),
          volume = Math.PI * radius * radius * (2 * half + (4 / 3) * radius),
          mass =
            spec.mass !== undefined
              ? positive(
                  spec.mass,
                  'bone mass',
                  'pass kilograms, or leave it out for the capsule volume times density.',
                )
              : volume * density;
        const axis = Float64Array.from(direction);
        const body = physics.addBody(null, {
          type: options.active ? 'dynamic' : 'kinematicPosition',
          position: origin as unknown as Vec3,
          rotation,
          linearDamping: options.linearDamping ?? 0.05,
          angularDamping: options.angularDamping ?? 0.8,
          userData: { ragdoll: this, node },
          colliders: {
            shape: 'capsule',
            halfHeight: half,
            radius,
            offset: [axis[0] * (length / 2), axis[1] * (length / 2), axis[2] * (length / 2)],
            rotation: [...arc([0, 1, 0], axis, new Float64Array(4))] as [number, number, number, number],
            mass,
            friction: options.friction ?? 0.6,
            collisionGroups: groups,
          },
        });
        created.push(body);
        const parent = parentOf[i] === -1 ? -1 : remap.get(parentOf[i])!;
        const rest = new Float64Array([0, 0, 0, 1]);
        let joint: PhysicsJoint | null = null,
          cone: Cone | null = null,
          built: RagdollJoint | null = null;
        if (parent !== -1) {
          const up = parts[parent],
            upInverse = conjugateQuaternion(up.world.subarray(3, 7)),
            anchor = rotateByQuaternion(
              [origin[0] - up.world[0], origin[1] - up.world[1], origin[2] - up.world[2]],
              upInverse,
            );
          mul(upInverse, rotation, rest);
          const spec2 = spec.joint ?? options.joint ?? DEFAULT_JOINT;
          ({ joint, cone, spec: built } = this.join(up.body, body, spec2, anchor, rest));
        }
        // Inverse inertia of a capsule (as a cylinder of the full length): across the axis and about it.
        const across = (mass * (3 * radius * radius + length * length)) / 12,
          about = (mass * radius * radius) / 2;
        const bone: Bone = {
          node,
          body,
          joint,
          parent,
          length,
          radius,
          axis,
          rest,
          spec: built,
          cone,
          inertia: new Float64Array([1 / about, 1 / across]),
          prev: world.slice(),
          cur: world.slice(),
          animated: new Float64Array(7),
          written: new Float64Array(7).fill(NaN),
          local: new Float64Array(7),
          world,
          target: [world[0], world[1], world[2], world[3], world[4], world[5], world[6]],
          limp: !!options.active,
          weight: options.active ? 1 : 0,
          fade: 0,
          jump: !options.active,
        };
        this.readLocal(node, bone.animated);
        bone.local.set(bone.animated);
        remap.set(i, parts.length);
        parts.push(bone);
      }
    } catch (error) {
      for (const bone of parts) bone.joint?.remove();
      for (const body of created) body.remove();
      throw error;
    }
    this.parts = parts;
    this.bones = parts;
    this.omega = new Float64Array(parts.length * 3);
    this.loose = options.active ? parts.length : 0;
    this.unsubscribe.push(
      physics.on('beforestep', () => this.beforeStep()),
      physics.on('afterstep', () => this.afterStep()),
    );
  }

  /** Builds a ragdoll on `physics` and adds it to its bones' engine, after the plugins already there (the Animator). */
  static attach(physics: Physics, options: RagdollOptions): Ragdoll {
    const ragdoll = new Ragdoll(physics, options);
    if (ragdoll.engine.hasPlugin(ragdoll.name)) {
      ragdoll.dispose();
      throw new MargoError(
        'attached',
        'This skeleton already has an attached ragdoll; dispose it first, or use the one you have.',
      );
    }
    try {
      ragdoll.engine.use(ragdoll);
    } catch (error) {
      ragdoll.dispose();
      throw error;
    }
    return ragdoll;
  }

  private boneList(options: RagdollOptions, minLength: number): RagdollBone[] {
    if (options.bones !== undefined) {
      if (!Array.isArray(options.bones) || !options.bones.length)
        throw new TypeError('Ragdoll bones must be a non-empty array of nodes or {node} objects.');
      return options.bones.map((bone) => {
        const spec = (bone && 'node' in bone ? bone : { node: bone }) as RagdollBone;
        if (!spec.node || typeof spec.node.setQuaternion !== 'function' || !spec.node.engine)
          throw new TypeError('Ragdoll bones must be skeleton nodes (meshes) or {node} objects; pass model.nodes[i].');
        spec.node.check();
        return spec;
      });
    }
    const root = options.root!;
    if (typeof root?.setQuaternion !== 'function' || !root.engine)
      throw new TypeError('Ragdoll root must be a skeleton node (a mesh), e.g. the hips: model.nodes[i].');
    root.check();
    root.engine.store.tick(false);
    const children = childMeshes(root.engine),
      list: RagdollBone[] = [];
    const walk = (node: Mesh): void => {
      const kids = children.get(node.id);
      if (!kids?.length) return;
      // A bone reaches as far as its farthest child: the centre of a chest's shoulders and neck is close to the chest,
      // and measuring that would drop both arms and the head with it.
      const m = node.matrix,
        reach = Math.max(
          ...kids.map((kid) => Math.hypot(kid.matrix[12] - m[12], kid.matrix[13] - m[13], kid.matrix[14] - m[14])),
        );
      if (reach < minLength && list.length) return;
      list.push({ node });
      for (const kid of kids) walk(kid);
    };
    walk(root);
    if (!list.length)
      throw new TypeError('Ragdoll root has no child bones; pass the hips of a skeleton, or list bones with lengths.');
    return list;
  }

  private join(
    parent: PhysicsBody,
    child: PhysicsBody,
    spec: RagdollJoint,
    anchor: number[],
    rest: Float64Array,
  ): { joint: PhysicsJoint; cone: Cone | null; spec: RagdollJoint } {
    const physics = this.physics,
      anchorA = anchor as unknown as Vec3;
    if (spec?.type === 'free' || spec?.type === 'cone') {
      let cone: Cone | null = null;
      if (spec.type === 'cone') {
        const swing = spec.swing ?? Math.PI / 4,
          [min, max] = spec.twist ?? [-Math.PI / 6, Math.PI / 6];
        if (!(swing >= 0 && swing <= Math.PI) || !(min <= max && min >= -Math.PI && max <= Math.PI))
          throw new RangeError(
            'Ragdoll cone limits need a swing from 0 to π and a twist [min, max] within -π to π; pass radians.',
          );
        cone = { swing, min, max };
      }
      return {
        joint: physics.addJoint(parent, child, { type: 'spherical', anchorA, anchorB: [0, 0, 0] }),
        cone,
        spec: cone ? { type: 'cone', swing: cone.swing, twist: [cone.min, cone.max] } : { type: 'free' },
      };
    }
    if (spec?.type !== 'hinge') throw new TypeError("Unknown ragdoll joint type; use 'cone', 'hinge' or 'free'.");
    const axis = spec.axis,
      length = Array.isArray(axis) && axis.length === 3 ? Math.hypot(axis[0], axis[1], axis[2]) : NaN;
    if (!(length > 0) || length === Infinity)
      throw new RangeError('Ragdoll hinge axis must be a nonzero finite [x, y, z] in the bone frame; e.g. [1, 0, 0].');
    const [min, max] = spec.limits ?? [-Math.PI * 0.75, 0];
    if (!(min <= max && min >= -Math.PI && max <= Math.PI))
      throw new RangeError('Ragdoll hinge limits need [min, max] within -π to π; pass radians.');
    const joint = physics.addJoint(parent, child, {
      type: 'revolute',
      axis: [1, 0, 0],
      anchorA,
      anchorB: [0, 0, 0],
    });
    // Rapier's revolute joint turns about each frame's x axis: align both frames with the hinge at rest, so the rest
    // pose measures angle 0 and the limits read from it.
    const raw = joint.raw as unknown as {
      setLocalFrame1?(anchor: object, rotation: object): void;
      setLocalFrame2?(anchor: object, rotation: object): void;
    };
    if (typeof raw.setLocalFrame1 !== 'function' || typeof raw.setLocalFrame2 !== 'function') {
      joint.remove();
      throw new MargoError(
        'unsupported',
        "Ragdoll hinges need Rapier's ImpulseJoint.setLocalFrame1; upgrade @dimforge/rapier3d-compat to 0.21 or later.",
      );
    }
    const unit = [axis[0] / length, axis[1] / length, axis[2] / length],
      frameB = arc([1, 0, 0], unit, new Float64Array(4)),
      frameA = mul(rest, frameB, new Float64Array(4));
    const rotation = (q: Float64Array) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
    raw.setLocalFrame1({ x: anchor[0], y: anchor[1], z: anchor[2] }, rotation(frameA));
    raw.setLocalFrame2({ x: 0, y: 0, z: 0 }, rotation(frameB));
    joint.setLimits(min, max);
    return { joint, cone: null, spec: { type: 'hinge', axis: [unit[0], unit[1], unit[2]], limits: [min, max] } };
  }

  /** True while physics drives any bone (after `activate()`, until `deactivate()`). */
  get active(): boolean {
    return this.loose > 0;
  }
  /**
   * How much of the drawn pose is the ragdoll's, 0 (the animation) to 1 (physics): the largest of any bone's.
   * `activate()` sets 1 and `deactivate(seconds)` fades it to 0; set it yourself for a partial blend of the limp bones.
   */
  get weight(): number {
    let most = 0;
    for (const bone of this.parts) most = Math.max(most, bone.weight);
    return most;
  }
  set weight(value: number) {
    if (!(value >= 0 && value <= 1)) throw new RangeError('Ragdoll weight must be from 0 to 1.');
    for (const bone of this.parts)
      if (bone.limp || !this.loose) {
        bone.weight = value;
        bone.fade = 0;
      }
  }
  /** World position of the root bone's body (the hips) at the last physics step: where to put a character that gets up. */
  get rootPosition(): [number, number, number] {
    const cur = this.live().parts[0].cur;
    return [cur[0], cur[1], cur[2]];
  }

  /** The bones `limb` names and every bone under them; every bone without a `limb`. */
  private limbBones(limb: RagdollLimb | undefined): Bone[] {
    if (limb === undefined) return this.parts;
    const picked = new Set<Bone>();
    for (const item of Array.isArray(limb) ? (limb as readonly (Mesh | RagdollPart)[]) : [limb as Mesh | RagdollPart]) {
      const node = item && 'body' in item ? item.node : item,
        top = this.parts.find((bone) => bone.node === node);
      if (!top) throw new RangeError('That node is not a bone of this ragdoll; pass nodes or parts of ragdoll.bones.');
      picked.add(top);
    }
    // Parents come first, so one pass reaches every bone under the ones picked.
    for (const bone of this.parts) if (bone.parent !== -1 && picked.has(this.parts[bone.parent])) picked.add(bone);
    return [...picked];
  }

  /**
   * Goes limp: each body becomes dynamic, keeps the velocity the animation gave it, and drives its bone. Bones that are
   * limp already stay as they are.
   * @param limb With a bone or a list of bones, only they and the bones under them go limp, hanging from the bones that
   * keep animating: one arm for a hit, the spine for the whole upper body. Without it, every bone.
   * @throws RangeError for a node that is not a bone of this ragdoll.
   */
  activate(limb?: RagdollLimb): this {
    this.live();
    const dt = this.physics.fixedTimestep,
      moved = this.stepped >= 2;
    for (const bone of this.limbBones(limb)) {
      if (bone.limp) continue;
      bone.limp = true;
      bone.weight = 1;
      bone.fade = 0;
      this.loose++;
      bone.body.setType('dynamic');
      const { prev, cur } = bone;
      if (!moved) continue;
      // Velocity of the last kinematic step: the animation's momentum carries into the fall.
      bone.body.setLinearVelocity([(cur[0] - prev[0]) / dt, (cur[1] - prev[1]) / dt, (cur[2] - prev[2]) / dt]);
      mul(cur.subarray(3, 7), conjugateQuaternion(prev.subarray(3, 7), this.q), this.r);
      if (this.r[3] < 0) for (let k = 0; k < 4; k++) this.r[k] = -this.r[k];
      const sin = Math.hypot(this.r[0], this.r[1], this.r[2]),
        angle = 2 * Math.atan2(sin, this.r[3]),
        scale = sin > 1e-9 ? angle / sin / dt : 0;
      bone.body.setAngularVelocity([this.r[0] * scale, this.r[1] * scale, this.r[2] * scale]);
    }
    return this;
  }

  /**
   * Hands bones back to the animation: the bodies become kinematic again (following the animation), and the drawn
   * pose blends from the ragdoll's last pose to the animation over `duration` seconds (default 0.3; 0 snaps). Bones that
   * are not limp stay as they are.
   * @param limb With a bone or a list of bones, only they and the bones under them. Without it, every bone.
   * @throws RangeError for a node that is not a bone of this ragdoll.
   */
  deactivate(duration = 0.3, limb?: RagdollLimb): this {
    this.live();
    if (!(duration >= 0) || duration === Infinity)
      throw new RangeError('Ragdoll blend duration must be a finite number of seconds, 0 or more.');
    const bones = this.limbBones(limb);
    if (!this.loose) return this;
    this.physicsLocals();
    for (const bone of bones) {
      if (!bone.limp) continue;
      bone.body.setType('kinematicPosition');
      bone.limp = false;
      bone.jump = true;
      bone.fade = duration > 0 ? bone.weight / duration : 0;
      if (!duration) bone.weight = 0;
      this.loose--;
    }
    return this;
  }

  /** The part whose bone is `node`, or undefined. */
  part(node: Mesh): RagdollPart | undefined {
    return this.parts.find((bone) => bone.node === node);
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'Ragdoll is disposed; create a new Ragdoll.');
    if (engine !== this.engine)
      throw new MargoError('attached', "Ragdoll belongs to its bones' engine; attach it to that engine.");
    this.attached = engine;
  }

  /**
   * Runs each frame after the animation: reads the animated pose, sets the kinematic targets, and writes the blended
   * ragdoll pose into the bones. The engine calls it; call it yourself only for a ragdoll that is not attached.
   */
  onPreUpdate(delta: number): void {
    if (this.disposed) return;
    if (this.physics.isDisposed || !this.parts[0].body.valid) {
      this.dispose();
      return;
    }
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid ragdoll delta; pass a finite delta of 0 or more seconds.');
    const store = this.engine.store;
    store.tick(false);
    for (const bone of this.parts) {
      this.track(bone);
      if (bone.limp) continue;
      // Kinematic: the animated world pose is the next target.
      const m = bone.node.matrix,
        sx = Math.hypot(m[0], m[1], m[2]),
        t = bone.target;
      rotationToQuaternion(m, this.q, sx, sx, sx);
      normalizeQuaternion(this.q, this.q);
      t[0] = m[12];
      t[1] = m[13];
      t[2] = m[14];
      t[3] = this.q[0];
      t[4] = this.q[1];
      t[5] = this.q[2];
      t[6] = this.q[3];
      if (bone.fade > 0) {
        bone.weight = Math.max(0, bone.weight - bone.fade * delta);
        if (!bone.weight) bone.fade = 0;
      }
    }
    if (this.loose) this.physicsLocals();
    this.write();
  }

  /** Reads `node`'s local transform into `out`, xyz then xyzw. */
  private readLocal(node: Mesh, out: Float64Array): Float64Array {
    const t = node.engine.store.transforms,
      id = node.id;
    out[0] = t.x[id];
    out[1] = t.y[id];
    out[2] = t.z[id];
    out[3] = t.qx[id];
    out[4] = t.qy[id];
    out[5] = t.qz[id];
    out[6] = t.qw[id];
    return out;
  }
  /**
   * Takes the bone's local transform as its animated base pose, unless it is exactly what the ragdoll wrote last
   * frame: then nothing animated it since, and the base it had stays.
   */
  private track(bone: Bone): void {
    const pose = this.readLocal(bone.node, this.pose),
      written = bone.written;
    for (let k = 0; k < 7; k++)
      if (pose[k] !== written[k]) {
        bone.animated.set(pose);
        return;
      }
  }

  /**
   * The physics pose of every bone, interpolated to the frame, as world poses, and of every limp bone as a local
   * transform. A bone blending back keeps the local transform it left physics with.
   */
  private physicsLocals(): void {
    const alpha = this.physics.alpha;
    for (const bone of this.parts) {
      const { prev, cur, world, local } = bone;
      for (let k = 0; k < 3; k++) world[k] = prev[k] + (cur[k] - prev[k]) * alpha;
      slerp(prev, 3, cur, 3, alpha, world, 3);
      if (!bone.limp) continue;
      local[0] = bone.animated[0];
      local[1] = bone.animated[1];
      local[2] = bone.animated[2];
      if (bone.parent !== -1) {
        const up = this.parts[bone.parent].world;
        conjugateQuaternion(up.subarray(3, 7), this.q);
        mul(this.q, world.subarray(3, 7), local, 3);
        continue;
      }
      // The root bone: relative to its parent node's world transform (the model), position included.
      const parentId = this.engine.store.parents[bone.node.id];
      if (parentId === -1) {
        local.set(world);
        continue;
      }
      const m = this.engine.meshes.get(parentId)!.matrix,
        sx = Math.hypot(m[0], m[1], m[2]),
        sy = Math.hypot(m[4], m[5], m[6]),
        sz = Math.hypot(m[8], m[9], m[10]);
      rotationToQuaternion(m, this.q, sx, sy, sz);
      normalizeQuaternion(this.q, this.q);
      conjugateQuaternion(this.q, this.q);
      mul(this.q, world.subarray(3, 7), local, 3);
      this.v[0] = world[0] - m[12];
      this.v[1] = world[1] - m[13];
      this.v[2] = world[2] - m[14];
      rotateByQuaternion(this.v, this.q, this.v);
      local[0] = this.v[0] / sx;
      local[1] = this.v[1] / sy;
      local[2] = this.v[2] / sz;
    }
  }

  /** Writes the animated pose blended toward the physics pose by its `weight` into every bone that has one. */
  private write(): void {
    for (const bone of this.parts) {
      const { animated, local, written, node, weight } = bone;
      if (!weight) continue;
      slerp(animated, 3, local, 3, weight, written, 3);
      if (bone.parent === -1) for (let k = 0; k < 3; k++) written[k] = animated[k] + (local[k] - animated[k]) * weight;
      else for (let k = 0; k < 3; k++) written[k] = animated[k];
      node.setPosition([written[0], written[1], written[2]]);
      node.setQuaternion([written[3], written[4], written[5], written[6]]);
      // What the store holds after the write (setQuaternion normalizes), so the next frame can tell it from an animation.
      const t = node.engine.store.transforms,
        id = node.id;
      written[0] = t.x[id];
      written[1] = t.y[id];
      written[2] = t.z[id];
      written[3] = t.qx[id];
      written[4] = t.qy[id];
      written[5] = t.qz[id];
      written[6] = t.qw[id];
    }
  }

  private beforeStep(): void {
    if (this.disposed || !this.parts[0].body.valid) return;
    for (const bone of this.parts) {
      if (bone.limp) continue;
      const t = bone.target,
        position: Vec3 = [t[0], t[1], t[2]],
        rotation: [number, number, number, number] = [t[3], t[4], t[5], t[6]];
      if (bone.jump) {
        bone.jump = false;
        bone.body.setPosition(position);
        bone.body.setRotation(rotation);
        bone.cur.set(t);
      }
      bone.body.setNextPosition(position);
      bone.body.setNextRotation(rotation);
    }
    if (this.loose) this.limits();
  }

  /**
   * Swing and twist limits. Each cone joint's swing and twist are measured from its rest pose (swing-twist
   * decomposition about the bone axis); where one is past its limit, an impulse between the two bodies stops the
   * relative spin that drives it further out (an inelastic velocity constraint, E. Catto, "Iterative Dynamics with
   * Temporal Coherence", GDC 2005), and the child turns back about its own origin, which is the joint, by a share of the
   * error (constraint projection, T. Jakobsen, "Advanced Character Physics", GDC 2001). Turning about the joint keeps
   * the joint together, and projecting the position adds no velocity, so a limit does not bounce.
   */
  private limits(): void {
    const parts = this.parts,
      omega = this.omega,
      share = this.stiffness,
      { q, r, s, v, w } = this;
    let any = false;
    for (let i = 0; i < parts.length; i++) {
      const spin = parts[i].body.angularVelocity;
      omega[i * 3] = spin[0];
      omega[i * 3 + 1] = spin[1];
      omega[i * 3 + 2] = spin[2];
    }
    for (let i = 1; i < parts.length; i++) {
      const bone = parts[i],
        cone = bone.cone;
      if (!cone || !bone.limp) continue;
      const up = parts[bone.parent],
        upRotation = up.body.rotation,
        rotation = bone.body.rotation;
      // Rest-attached frame R = parent * rest; deviation d = conj(R) * child.
      mul(upRotation, bone.rest, s);
      conjugateQuaternion(s, q);
      mul(q, rotation, r);
      if (r[3] < 0) for (let k = 0; k < 4; k++) r[k] = -r[k];
      const u = bone.axis,
        projection = r[0] * u[0] + r[1] * u[1] + r[2] * u[2];
      // Twist about the bone axis, then swing = d * conj(twist).
      let twist = 2 * Math.atan2(projection, r[3]);
      if (twist > Math.PI) twist -= 2 * Math.PI;
      const tl = Math.hypot(projection, r[3]);
      if (tl > 1e-9) {
        q[0] = (-u[0] * projection) / tl;
        q[1] = (-u[1] * projection) / tl;
        q[2] = (-u[2] * projection) / tl;
        q[3] = r[3] / tl;
      } else q.set([0, 0, 0, 1]);
      mul(r, q, r);
      const sl = Math.hypot(r[0], r[1], r[2]),
        swing = 2 * Math.atan2(sl, Math.abs(r[3]));
      const parentInverse = up.limp;
      if (swing > cone.swing && sl > 1e-9) {
        // World swing axis: the local swing axis turned by R.
        const sign = r[3] < 0 ? -1 : 1;
        v[0] = (r[0] / sl) * sign;
        v[1] = (r[1] / sl) * sign;
        v[2] = (r[2] / sl) * sign;
        rotateByQuaternion(v, s, v);
        any = this.push(i, bone.parent, v, parentInverse) || any;
        this.turn(bone, v, -(swing - cone.swing) * share);
      }
      if (twist > cone.max || twist < cone.min) {
        // World twist axis: the bone axis turned by the child's rotation.
        rotateByQuaternion(u, rotation, w);
        let error = twist - cone.max;
        if (twist < cone.min) {
          error = cone.min - twist;
          w[0] = -w[0];
          w[1] = -w[1];
          w[2] = -w[2];
        }
        any = this.push(i, bone.parent, w, parentInverse) || any;
        this.turn(bone, w, -error * share);
      }
    }
    if (!any) return;
    for (let i = 0; i < parts.length; i++)
      if (parts[i].limp)
        parts[i].body.setAngularVelocity([omega[i * 3], omega[i * 3 + 1], omega[i * 3 + 2]]);
  }

  /** Turns `bone`'s body by `angle` radians about the world `axis` through its origin (its joint). */
  private turn(bone: Bone, axis: Float64Array, angle: number): void {
    const half = angle / 2,
      sin = Math.sin(half),
      turn = this.turnBy;
    turn[0] = axis[0] * sin;
    turn[1] = axis[1] * sin;
    turn[2] = axis[2] * sin;
    turn[3] = Math.cos(half);
    const turned = mul(turn, bone.body.rotation, this.turned);
    bone.body.setRotation([turned[0], turned[1], turned[2], turned[3]]);
  }

  /**
   * One limit impulse about world `axis` (the direction that grows the error) between bone `i` and its parent `p`:
   * it removes their relative spin along the axis when that spin drives the error up. Returns whether it acted.
   */
  private push(i: number, p: number, axis: Float64Array, parent: boolean): boolean {
    const omega = this.omega,
      a = i * 3,
      b = p * 3,
      relative =
        (omega[a] - omega[b]) * axis[0] +
        (omega[a + 1] - omega[b + 1]) * axis[1] +
        (omega[a + 2] - omega[b + 2]) * axis[2],
      target = 0;
    if (relative <= target) return false;
    const inverseChild = this.inverseInertia(this.parts[i], axis),
      inverseParent = parent ? this.inverseInertia(this.parts[p], axis) : 0,
      total = inverseChild + inverseParent;
    if (!(total > 0)) return false;
    const impulse = (target - relative) / total;
    for (let k = 0; k < 3; k++) {
      omega[a + k] += impulse * inverseChild * axis[k];
      omega[b + k] -= impulse * inverseParent * axis[k];
    }
    return true;
  }
  private inverseInertia(bone: Bone, axis: Float64Array): number {
    // Capsule inertia about `axis`: the bone axis in the world, from the body's rotation at the last step.
    const c = this.c,
      rotation = bone.cur.subarray(3, 7);
    rotateByQuaternion(bone.axis, rotation, c);
    const along = c[0] * axis[0] + c[1] * axis[1] + c[2] * axis[2],
      squared = along * along;
    return 1 / (squared / bone.inertia[0] + (1 - squared) / bone.inertia[1]);
  }

  private afterStep(): void {
    if (this.disposed || !this.parts[0].body.valid) return;
    this.stepped++;
    for (const bone of this.parts) {
      bone.prev.set(bone.cur);
      const position = bone.body.position,
        rotation = bone.body.rotation;
      bone.cur[0] = position[0];
      bone.cur[1] = position[1];
      bone.cur[2] = position[2];
      bone.cur[3] = rotation[0];
      bone.cur[4] = rotation[1];
      bone.cur[5] = rotation[2];
      bone.cur[6] = rotation[3];
    }
  }

  private live(): this {
    if (this.disposed) throw new MargoError('disposed', 'Ragdoll is disposed; create a new Ragdoll.');
    return this;
  }

  /** Removes every body and joint and leaves the bones in their last pose. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    if (!this.physics.isDisposed)
      for (const bone of this.parts) {
        bone.joint?.remove();
        bone.body.remove();
      }
    const engine = this.attached;
    this.attached = undefined;
    if (engine?.plugins.get(this.name) === this) engine.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
