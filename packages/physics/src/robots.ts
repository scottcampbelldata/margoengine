// Robot descriptions onto bodies and joints: URDF (links, inertials, joints with limits) and MJCF (nested bodies with hinge, slide, ball
// and free joints), read from the public format descriptions, built as bodies of a `Physics` joined by impulse joints or as one
// multibody. Both formats are z up by convention; the loaders turn the robot to the engine's y up unless `upAxis: 'y'` says it is.
// It runs off the step path, so it may use `Math`.
import { MargoError } from '@margoengine/math/errors';
import type { PhysicsBody } from './body.js';
import type { JointOptions, PhysicsJoint } from './joints.js';
import { type Quat, type Vec3, multiplyQuat, rotateVec } from './math.js';
import type { Multibody } from './multibody.js';
import type { Physics } from './physics.js';
import type { ColliderOptions } from './shapes.js';
import { type XmlNode, child, numbers, parseXml } from './xml.js';

/** What a loader built: the bodies and joints by the names the file gave them. */
export interface PhysicsRobot {
  /** The root link's body. */
  root: PhysicsBody;
  /** Every link or body of the file, by name. */
  bodies: Map<string, PhysicsBody>;
  /** Every joint of the file that made a joint here, by name (a free joint, a floating one and a welded one make none of their own). */
  joints: Map<string, PhysicsJoint>;
  /** The tree, when `joints` was `'multibody'`. */
  multibody: Multibody | null;
  /** What was left out and why, such as a mesh the loader was not given. */
  skipped: string[];
}

/** Options of {@link addURDF} and {@link addMJCF}. */
export interface RobotOptions {
  /** Where the robot's root frame goes in the world (default the origin). */
  position?: Vec3;
  /** How the robot's root frame is turned in the world, applied after the z-up to y-up turn (default none). */
  rotation?: Quat;
  /** `'z'` (default): the file is z up and the robot is turned to y up. `'y'`: the file is y up already. */
  upAxis?: 'y' | 'z';
  /** `'multibody'` (default) holds the tree to reduced coordinates; `'impulse'` makes an ordinary joint of each. */
  joints?: 'multibody' | 'impulse';
  /** Make the root body fixed (default false: it is free). */
  fixBase?: boolean;
  /** Multiplies every length of the file, for a file in other units than metres (default 1). */
  scale?: number;
  /** Friction of the colliders (default 0.5). */
  friction?: number;
  /** The collision groups of every collider. */
  collisionGroups?: number;
  /**
   * Turns a mesh file's name into collider options, for the `mesh` geometries of a file: return the options (`meshFileCollider` of
   * the file's bytes, say) or undefined to leave the geometry out. Without it a mesh geometry is left out and listed in `skipped`.
   */
  loadMesh?: (filename: string, scale: Vec3) => ColliderOptions | undefined;
}

const DEGREE = Math.PI / 180;
/** The turn from z up to y up: about x by a quarter turn back, which takes z to y. */
const UP: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const IDENTITY: Quat = [0, 0, 0, 1];

const rpy = (r: number, p: number, y: number): Quat => {
  const half = (a: number): [number, number] => [Math.sin(a / 2), Math.cos(a / 2)],
    [sx, cx] = half(r),
    [sy, cy] = half(p),
    [sz, cz] = half(y);
  return multiplyQuat([0, 0, sz, cz], multiplyQuat([0, sy, 0, cy], [sx, 0, 0, cx]));
};
const axisAngle = (axis: readonly number[], angle: number): Quat => {
  const l = Math.hypot(axis[0]!, axis[1]!, axis[2]!) || 1,
    s = Math.sin(angle / 2) / l;
  return [axis[0]! * s, axis[1]! * s, axis[2]! * s, Math.cos(angle / 2)];
};
/** The turn that takes +X to `axis`. */
const alignX = (axis: readonly number[]): Quat => {
  const l = Math.hypot(axis[0]!, axis[1]!, axis[2]!);
  if (!(l > 0)) throw new RangeError('A joint axis needs a direction; pass three numbers that are not all zero.');
  const [x, y, z] = [axis[0]! / l, axis[1]! / l, axis[2]! / l];
  if (x < -0.999999) return [0, 0, 1, 0];
  const w = 1 + x,
    n = Math.hypot(0, -z, y, w);
  return [0, -z / n, y / n, w / n];
};
const vec = (text: string | undefined, fallback: Vec3 = [0, 0, 0]): Vec3 => {
  const v = numbers(text ?? '');
  return v.length >= 3 && v.every(Number.isFinite) ? [v[0]!, v[1]!, v[2]!] : fallback;
};
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const times = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** The principal moments and axes of a symmetric 3 x 3 tensor (Jacobi's method, Golub and Van Loan 2013, 8.5). */
function principal(t: number[][]): { moments: Vec3; frame: Quat } {
  const a = t.map((row) => row.slice()),
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += Math.abs(a[p]![q]!);
    if (off < 1e-18) break;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p]![q]!) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!),
          s = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(s * s + 1),
          sn = s * c;
        for (let k = 0; k < 3; k++) {
          const x = a[k]![p]!,
            y = a[k]![q]!;
          a[k]![p] = c * x - sn * y;
          a[k]![q] = sn * x + c * y;
        }
        for (let k = 0; k < 3; k++) {
          const x = a[p]![k]!,
            y = a[q]![k]!;
          a[p]![k] = c * x - sn * y;
          a[q]![k] = sn * x + c * y;
        }
        for (let k = 0; k < 3; k++) {
          const x = v[k]![p]!,
            y = v[k]![q]!;
          v[k]![p] = c * x - sn * y;
          v[k]![q] = sn * x + c * y;
        }
      }
  }
  // The columns of v are the axes; make them a right-handed frame and turn it to a quaternion.
  const x = [v[0]![0]!, v[1]![0]!, v[2]![0]!],
    y = [v[0]![1]!, v[1]![1]!, v[2]![1]!],
    z = [x[1]! * y[2]! - x[2]! * y[1]!, x[2]! * y[0]! - x[0]! * y[2]!, x[0]! * y[1]! - x[1]! * y[0]!],
    m = [
      [x[0]!, y[0]!, z[0]!],
      [x[1]!, y[1]!, z[1]!],
      [x[2]!, y[2]!, z[2]!],
    ],
    trace = m[0]![0]! + m[1]![1]! + m[2]![2]!;
  let q: [number, number, number, number];
  if (trace > 0) {
    const w = Math.sqrt(1 + trace) / 2;
    q = [(m[2]![1]! - m[1]![2]!) / (4 * w), (m[0]![2]! - m[2]![0]!) / (4 * w), (m[1]![0]! - m[0]![1]!) / (4 * w), w];
  } else if (m[0]![0]! >= m[1]![1]! && m[0]![0]! >= m[2]![2]!) {
    const s = Math.sqrt(1 + m[0]![0]! - m[1]![1]! - m[2]![2]!) / 2;
    q = [s, (m[0]![1]! + m[1]![0]!) / (4 * s), (m[0]![2]! + m[2]![0]!) / (4 * s), (m[2]![1]! - m[1]![2]!) / (4 * s)];
  } else if (m[1]![1]! >= m[2]![2]!) {
    const s = Math.sqrt(1 + m[1]![1]! - m[0]![0]! - m[2]![2]!) / 2;
    q = [(m[0]![1]! + m[1]![0]!) / (4 * s), s, (m[1]![2]! + m[2]![1]!) / (4 * s), (m[0]![2]! - m[2]![0]!) / (4 * s)];
  } else {
    const s = Math.sqrt(1 + m[2]![2]! - m[0]![0]! - m[1]![1]!) / 2;
    q = [(m[0]![2]! + m[2]![0]!) / (4 * s), (m[1]![2]! + m[2]![1]!) / (4 * s), s, (m[1]![0]! - m[0]![1]!) / (4 * s)];
  }
  return { moments: [a[0]![0]!, a[1]![1]!, a[2]![2]!], frame: q };
}

/** A body of a file, before it is a body of the world: its pose in the robot's frame and what hangs from it. */
interface Link {
  name: string;
  position: Vec3;
  rotation: Quat;
  colliders: ColliderOptions[];
  mass?: { mass: number; centerOfMass: Vec3; inertia: Vec3; inertiaFrame: Quat };
  /** The joint to the parent: its name, the options between the two bodies, and the pose of the link in the parent. */
  joint?: { name: string; options: JointOptions | null };
  parent?: string;
  /** Fixed to the world whatever the options say (a body of an MJCF worldbody with no free joint). */
  fixed?: boolean;
  children: string[];
}

function build(
  physics: Physics,
  links: Map<string, Link>,
  roots: string[],
  options: RobotOptions,
  skipped: string[],
): PhysicsRobot {
  const up = options.upAxis === 'y' ? IDENTITY : UP,
    base = multiplyQuat(options.rotation ?? IDENTITY, up),
    origin = options.position ?? [0, 0, 0],
    bodies = new Map<string, PhysicsBody>(),
    joints = new Map<string, PhysicsJoint>(),
    order: Link[] = [],
    visit = (name: string): void => {
      const link = links.get(name)!;
      order.push(link);
      for (const c of link.children) visit(c);
    };
  for (const root of roots) visit(root);
  for (const link of order) {
    const at = add(origin, rotateVec(base, link.position)),
      body = physics.addBody(null, {
        type: link.fixed || (roots.includes(link.name) && options.fixBase) ? 'fixed' : 'dynamic',
        position: at,
        rotation: multiplyQuat(base, link.rotation),
        colliders: link.colliders.map((c) => (link.mass ? { ...c, massless: true } : c)) as ColliderOptions[],
      });
    if (link.mass) body.setMassProperties(link.mass);
    bodies.set(link.name, body);
  }
  const rootBody = bodies.get(roots[0]!)!;
  let multibody: Multibody | null = null;
  const jointed = order.filter((link) => link.parent && link.joint?.options);
  // One tree of one root can be held as a multibody; a link whose parent is not in it (below a floating joint) gets an impulse joint.
  const inTree = new Set<string>(roots.length === 1 ? roots : []),
    tree: Link[] = [],
    loose: Link[] = [];
  for (const link of jointed) {
    if ((options.joints ?? 'multibody') === 'multibody' && inTree.has(link.parent!)) {
      tree.push(link);
      inTree.add(link.name);
    } else loose.push(link);
  }
  if (tree.length > 0) {
    multibody = physics.addMultibody(
      rootBody,
      tree.map((link) => ({
        body: bodies.get(link.name)!,
        parent: bodies.get(link.parent!)!,
        joint: link.joint!.options!,
      })),
    );
    for (const made of multibody.links) {
      const link = tree.find((l) => bodies.get(l.name) === made.body);
      if (link) joints.set(link.joint!.name, made.joint);
    }
  }
  for (const link of loose)
    joints.set(
      link.joint!.name,
      physics.addJoint(bodies.get(link.parent!)!, bodies.get(link.name)!, link.joint!.options!),
    );
  return { root: rootBody, bodies, joints, multibody, skipped };
}

/** The joint options between a link and its parent: `origin` is the link's frame in the parent's, `axis` the joint's in the link's. */
function jointBetween(
  type: string,
  origin: { position: Vec3; rotation: Quat },
  pivot: Vec3,
  axis: Vec3,
  limits: readonly [number, number] | undefined,
  damping: number,
  name: string,
): JointOptions | null {
  const turn = alignX(axis),
    motor = damping > 0 ? { targetVelocity: 0, damping, model: 'force' as const } : undefined;
  // The joint sits at `pivot` in the link's frame, which is `origin.position + origin.rotation * pivot` in the parent's.
  const anchorA = add(origin.position, rotateVec(origin.rotation, pivot)),
    anchorB = pivot;
  if (type === 'fixed') return { type: 'fixed', anchorA, anchorB, frameA: origin.rotation, frameB: IDENTITY };
  if (type === 'revolute' || type === 'continuous')
    return {
      type: 'revolute',
      anchorA,
      anchorB,
      frameA: multiplyQuat(origin.rotation, turn),
      frameB: turn,
      ...(type === 'revolute' && limits ? { limits } : {}),
      ...(motor ? { motor } : {}),
    };
  if (type === 'prismatic')
    return {
      type: 'prismatic',
      anchorA,
      anchorB,
      frameA: multiplyQuat(origin.rotation, turn),
      frameB: turn,
      ...(limits ? { limits } : {}),
      ...(motor ? { motor } : {}),
    };
  if (type === 'ball') return { type: 'spherical', anchorA, anchorB };
  if (type === 'floating' || type === 'free') return null;
  throw new MargoError(
    'unsupported',
    `The joint "${name}" is of kind "${type}", which has no joint of its own here; give it as revolute, prismatic, fixed or floating.`,
  );
}

const geomBox = (size: Vec3): ColliderOptions =>
  ({ shape: 'box', halfExtents: [size[0] / 2, size[1] / 2, size[2] / 2] }) as ColliderOptions;

/**
 * Builds the robot of a URDF file in `physics`: a body for each `link` (its `collision` shapes as colliders, its `inertial` as
 * the body's mass, centre and inertia) and a joint for each `joint` (fixed, revolute, continuous, prismatic, floating), held
 * as one multibody or as impulse joints. `limit` gives a joint its range and `dynamics` damping its motor damping; effort and
 * velocity limits, friction, `mimic` and `safety_controller` are not read. A link without an `inertial` weighs what its
 * collision shapes weigh at the density of water.
 * @throws MargoError (`unsupported`) for a joint kind it cannot make, `RangeError` for a file that is not a URDF, names a link
 * it does not have or hangs links in a loop.
 */
export function addURDF(physics: Physics, source: string, options: RobotOptions = {}): PhysicsRobot {
  const robot = child(parseXml(source), 'robot');
  if (!robot) throw new RangeError('This is not a URDF file: it has no robot element; pass the text of a .urdf file.');
  const scale = options.scale ?? 1,
    skipped: string[] = [],
    links = new Map<string, Link>(),
    origin = (node: XmlNode | undefined): { position: Vec3; rotation: Quat } => {
      const o = child(node ?? { name: '', attrs: {}, children: [], text: '' }, 'origin'),
        a = vec(o?.attrs.rpy);
      return { position: times(vec(o?.attrs.xyz), scale), rotation: rpy(a[0], a[1], a[2]) };
    };
  for (const node of robot.children.filter((c) => c.name === 'link')) {
    const name = node.attrs.name ?? '',
      colliders: ColliderOptions[] = [];
    for (const collision of node.children.filter((c) => c.name === 'collision')) {
      const pose = origin(collision),
        geometry = child(collision, 'geometry'),
        shape = geometry?.children[0];
      if (!shape) continue;
      let collider: ColliderOptions | undefined,
        turn = IDENTITY;
      if (shape.name === 'box') collider = geomBox(times(vec(shape.attrs.size, [1, 1, 1]), scale));
      else if (shape.name === 'sphere') collider = { shape: 'sphere', radius: Number(shape.attrs.radius ?? 1) * scale };
      else if (shape.name === 'cylinder' || shape.name === 'capsule') {
        // URDF's cylinder stands on z; ours on y.
        collider = {
          shape: shape.name,
          halfHeight: (Number(shape.attrs.length ?? 1) * scale) / 2,
          radius: Number(shape.attrs.radius ?? 1) * scale,
        } as ColliderOptions;
        turn = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
      } else if (shape.name === 'mesh') {
        const filename = shape.attrs.filename ?? '',
          meshScale = times(vec(shape.attrs.scale, [1, 1, 1]), scale);
        collider = options.loadMesh?.(filename, meshScale);
        if (!collider) skipped.push(`mesh ${filename} of link ${name}: pass loadMesh to read it`);
      }
      if (collider)
        colliders.push({
          ...collider,
          offset: pose.position,
          rotation: multiplyQuat(pose.rotation, turn),
          friction: options.friction ?? 0.5,
          density: 1000,
          ...(options.collisionGroups === undefined ? {} : { collisionGroups: options.collisionGroups }),
        } as ColliderOptions);
    }
    const link: Link = { name, position: [0, 0, 0], rotation: IDENTITY, colliders, children: [] },
      inertial = child(node, 'inertial');
    if (inertial) {
      const pose = origin(inertial),
        mass = Number(child(inertial, 'mass')?.attrs.value ?? 0),
        i = child(inertial, 'inertia')?.attrs ?? {},
        t = [
          [Number(i.ixx ?? 0), Number(i.ixy ?? 0), Number(i.ixz ?? 0)],
          [Number(i.ixy ?? 0), Number(i.iyy ?? 0), Number(i.iyz ?? 0)],
          [Number(i.ixz ?? 0), Number(i.iyz ?? 0), Number(i.izz ?? 0)],
        ],
        p = principal(t.map((row) => row.map((v) => v * scale * scale * scale * scale * scale)));
      if (mass > 0)
        link.mass = {
          mass: mass * scale ** 3,
          centerOfMass: pose.position,
          inertia: p.moments,
          inertiaFrame: multiplyQuat(pose.rotation, p.frame),
        };
    }
    links.set(name, link);
  }
  const hasParent = new Set<string>();
  const poses = new Map<string, { position: Vec3; rotation: Quat }>();
  for (const node of robot.children.filter((c) => c.name === 'joint')) {
    const name = node.attrs.name ?? '',
      parent = child(node, 'parent')?.attrs.link ?? '',
      childName = child(node, 'child')?.attrs.link ?? '',
      p = links.get(parent),
      c = links.get(childName);
    if (!p || !c)
      throw new RangeError(
        `The joint "${name}" names a link the file does not have (${parent}, ${childName}); fix the joint's parent and child.`,
      );
    if (hasParent.has(childName))
      throw new RangeError(`The link "${childName}" has two parents; a URDF robot is a tree, so give it one joint.`);
    hasParent.add(childName);
    const pose = origin(node),
      type = node.attrs.type ?? 'fixed',
      axis = vec(child(node, 'axis')?.attrs.xyz, [1, 0, 0]),
      limit = child(node, 'limit'),
      range =
        limit && limit.attrs.lower !== undefined && limit.attrs.upper !== undefined
          ? ([
              Number(limit.attrs.lower) * (type === 'prismatic' ? scale : 1),
              Number(limit.attrs.upper) * (type === 'prismatic' ? scale : 1),
            ] as const)
          : undefined;
    c.parent = parent;
    c.joint = {
      name,
      options: jointBetween(
        type,
        pose,
        [0, 0, 0],
        axis,
        range,
        Number(child(node, 'dynamics')?.attrs.damping ?? 0),
        name,
      ),
    };
    p.children.push(childName);
    poses.set(childName, pose);
  }
  const rootName = [...links.keys()].find((name) => !hasParent.has(name));
  if (rootName === undefined)
    throw new RangeError('This URDF has no root link: every link has a parent, so the joints make a loop; remove one.');
  // World poses at the joints' zero: each link's frame in the root's.
  const place = (name: string, position: Vec3, rotation: Quat, seen: Set<string>): void => {
    if (seen.has(name)) throw new RangeError('The links of this URDF make a loop; remove the joint that closes it.');
    seen.add(name);
    const link = links.get(name)!;
    link.position = position;
    link.rotation = rotation;
    for (const c of link.children) {
      const pose = poses.get(c)!;
      place(c, add(position, rotateVec(rotation, pose.position)), multiplyQuat(rotation, pose.rotation), seen);
    }
  };
  place(rootName, [0, 0, 0], IDENTITY, new Set());
  if (links.size > 1 && [...links.values()].some((link) => !hasParent.has(link.name) && link.name !== rootName))
    throw new RangeError('This URDF has more than one root link; join the separate pieces with a fixed joint.');
  return build(physics, links, [rootName], options, skipped);
}

/**
 * Builds the robot of a MuJoCo MJCF file in `physics`: a body for each `body` of the `worldbody`, nested, with its `geom`s as colliders
 * (box, sphere, capsule, cylinder, plane and mesh through `loadMesh`; `fromto`, `mass` and `density` read) and its `inertial`, and
 * a joint for the body's one `joint` (hinge, slide, ball or free; `axis`, `pos`, `range` and `damping` read). A body without a joint is
 * welded to its parent, and one in the worldbody with none is fixed to the world. Angles follow `compiler angle` (degrees by default)
 * and orientations may be `quat`, `euler` or `axisangle`. Defaults classes, actuators, tendons, contacts and sensors are not read.
 * @throws MargoError (`unsupported`) for a body with more than one joint or a geom kind it cannot make.
 * @throws RangeError for a file that is not an MJCF.
 */
export function addMJCF(physics: Physics, source: string, options: RobotOptions = {}): PhysicsRobot {
  const mujoco = child(parseXml(source), 'mujoco');
  if (!mujoco)
    throw new RangeError('This is not an MJCF file: it has no mujoco element; pass the text of a MuJoCo XML file.');
  const world = child(mujoco, 'worldbody');
  if (!world) throw new RangeError('This MJCF has no worldbody; add the bodies under one.');
  const scale = options.scale ?? 1,
    radians = child(mujoco, 'compiler')?.attrs.angle === 'radian',
    angle = (v: number): number => (radians ? v : v * DEGREE),
    skipped: string[] = [],
    links = new Map<string, Link>(),
    pose = (node: XmlNode): { position: Vec3; rotation: Quat } => {
      let rotation = IDENTITY;
      if (node.attrs.quat) {
        const q = numbers(node.attrs.quat),
          l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
        rotation = [q[1]! / l, q[2]! / l, q[3]! / l, q[0]! / l];
      } else if (node.attrs.axisangle) {
        const a = numbers(node.attrs.axisangle);
        rotation = axisAngle([a[0]!, a[1]!, a[2]!], angle(a[3]!));
      } else if (node.attrs.euler) {
        const e = numbers(node.attrs.euler);
        rotation = multiplyQuat(
          axisAngle([1, 0, 0], angle(e[0]!)),
          multiplyQuat(axisAngle([0, 1, 0], angle(e[1]!)), axisAngle([0, 0, 1], angle(e[2]!))),
        );
      }
      return { position: times(vec(node.attrs.pos), scale), rotation };
    },
    geoms = (body: XmlNode, name: string): ColliderOptions[] => {
      const out: ColliderOptions[] = [];
      for (const g of body.children.filter((c) => c.name === 'geom')) {
        const kind = g.attrs.type ?? 'sphere',
          size = numbers(g.attrs.size ?? '').map((v) => v * scale),
          place = pose(g),
          material = {
            friction: g.attrs.friction ? Number(numbers(g.attrs.friction)[0]) : (options.friction ?? 0.5),
            ...(g.attrs.mass
              ? { mass: Number(g.attrs.mass) * scale ** 3 }
              : { density: Number(g.attrs.density ?? 1000) / scale ** 3 }),
            ...(options.collisionGroups === undefined ? {} : { collisionGroups: options.collisionGroups }),
          };
        let collider: ColliderOptions | undefined,
          turn = IDENTITY,
          offset = place.position,
          rotation = place.rotation;
        if (g.attrs.fromto && (kind === 'capsule' || kind === 'cylinder')) {
          const f = numbers(g.attrs.fromto).map((v) => v * scale),
            a: Vec3 = [f[0]!, f[1]!, f[2]!],
            b: Vec3 = [f[3]!, f[4]!, f[5]!],
            half = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2;
          offset = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
          // The segment's direction takes the shape's y to it.
          const d = [(b[0] - a[0]) / (half * 2 || 1), (b[1] - a[1]) / (half * 2 || 1), (b[2] - a[2]) / (half * 2 || 1)],
            across = alignX(d);
          rotation = multiplyQuat(across, [0, 0, -Math.SQRT1_2, Math.SQRT1_2]);
          collider = { shape: kind, halfHeight: half, radius: size[0] ?? 0.05 } as ColliderOptions;
        } else if (kind === 'box')
          collider = {
            shape: 'box',
            halfExtents: [size[0]!, size[1] ?? size[0]!, size[2] ?? size[0]!],
          } as ColliderOptions;
        else if (kind === 'sphere') collider = { shape: 'sphere', radius: size[0] ?? 0.1 } as ColliderOptions;
        else if (kind === 'capsule' || kind === 'cylinder') {
          collider = { shape: kind, halfHeight: size[1] ?? 0.1, radius: size[0] ?? 0.05 } as ColliderOptions;
          // MJCF's capsule and cylinder stand on z; ours on y.
          turn = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
        } else if (kind === 'plane') {
          collider = { shape: 'halfSpace', normal: [0, 0, 1] } as ColliderOptions;
        } else if (kind === 'mesh') {
          collider = options.loadMesh?.(g.attrs.mesh ?? '', [scale, scale, scale]);
          if (!collider) skipped.push(`mesh ${g.attrs.mesh ?? ''} of body ${name}: pass loadMesh to read it`);
        } else
          throw new MargoError(
            'unsupported',
            `The geom kind "${kind}" of body "${name}" has no shape here; use box, sphere, capsule, cylinder, plane or mesh.`,
          );
        if (collider) {
          const made = {
            ...collider,
            offset,
            rotation: multiplyQuat(rotation, turn),
            ...(kind === 'plane' ? { friction: material.friction } : material),
          } as ColliderOptions;
          out.push(made);
        }
      }
      return out;
    };
  let counter = 0;
  const walk = (node: XmlNode, parent: string | undefined, parentLink: Link | undefined, fixed: boolean): void => {
    for (const b of node.children.filter((c) => c.name === 'body')) {
      const name = b.attrs.name ?? `body${counter++}`,
        local = pose(b),
        joint = b.children.filter((c) => c.name === 'joint');
      if (joint.length > 1)
        throw new MargoError(
          'unsupported',
          `The body "${name}" has ${joint.length} joints; give each body one joint, and put the others on bodies between.`,
        );
      const parentPose = parentLink ?? { position: [0, 0, 0] as Vec3, rotation: IDENTITY },
        link: Link = {
          name,
          position: add(parentPose.position, rotateVec(parentPose.rotation, local.position)),
          rotation: multiplyQuat(parentPose.rotation, local.rotation),
          colliders: geoms(b, name),
          children: [],
        },
        inertial = child(b, 'inertial');
      if (inertial) {
        const place = pose(inertial),
          mass = Number(inertial.attrs.mass ?? 0),
          diag = inertial.attrs.diaginertia ? numbers(inertial.attrs.diaginertia) : null,
          full = inertial.attrs.fullinertia ? numbers(inertial.attrs.fullinertia) : null;
        if (mass > 0 && (diag || full)) {
          const p = full
            ? principal([
                [full[0]!, full[3]!, full[4]!],
                [full[3]!, full[1]!, full[5]!],
                [full[4]!, full[5]!, full[2]!],
              ])
            : { moments: [diag![0]!, diag![1]!, diag![2]!] as Vec3, frame: IDENTITY };
          link.mass = {
            mass: mass * scale ** 3,
            centerOfMass: place.position,
            inertia: times(p.moments, scale ** 5),
            inertiaFrame: multiplyQuat(place.rotation, p.frame),
          };
        }
      }
      links.set(name, link);
      if (parent !== undefined) {
        link.parent = parent;
        links.get(parent)!.children.push(name);
        const j = joint[0],
          kind = j?.attrs.type ?? (j ? 'hinge' : 'fixed'),
          pivot = times(vec(j?.attrs.pos), scale),
          axis = vec(j?.attrs.axis, [0, 0, 1]),
          range = j?.attrs.range && j.attrs.limited !== 'false' ? numbers(j.attrs.range) : null,
          mapped = kind === 'hinge' ? 'revolute' : kind === 'slide' ? 'prismatic' : kind,
          limits = range
            ? ([
                kind === 'slide' ? range[0]! * scale : angle(range[0]!),
                kind === 'slide' ? range[1]! * scale : angle(range[1]!),
              ] as const)
            : undefined;
        link.joint = {
          name: j?.attrs.name ?? `${name}-joint`,
          options: jointBetween(mapped, local, pivot, axis, limits, Number(j?.attrs.damping ?? 0), name),
        };
      } else link.fixed = !joint.some((j) => j.attrs.type === 'free');
      walk(b, name, link, fixed);
    }
  };
  walk(world, undefined, undefined, true);
  // The worldbody's own geoms are static scenery: a fixed body of their own.
  const scenery = geoms(world, 'worldbody');
  const roots = [...links.values()].filter((l) => !l.parent);
  if (roots.length === 0) throw new RangeError('This MJCF has no body under its worldbody; add one.');
  const robot = build(
    physics,
    links,
    roots.map((r) => r.name),
    options,
    skipped,
  );
  if (scenery.length)
    physics.addBody(null, {
      type: 'fixed',
      position: options.position ?? [0, 0, 0],
      rotation: multiplyQuat(options.rotation ?? IDENTITY, options.upAxis === 'y' ? IDENTITY : UP),
      colliders: scenery,
    });
  return robot;
}
