// The `urdf` entry: reads a URDF robot description into a Robot. Written clean room from the public URDF specification
// (the ROS wiki pages on the robot, link and joint XML elements). No ROS, MoveIt, Pinocchio or other library's source was
// read. Links are the Robot's joint frames: a URDF joint's origin is in its parent link's frame, and its child link's
// frame is the joint's own, which is exactly how Robot chains its joints.
import { readXMLTree, type XMLElement } from '@margoengine/loaders/xml';
import { rangeError, typeError } from '../../shared/errors.js';
import { Robot, type RobotJointOptions, type RobotShapeOptions } from './robot.js';

/** The shape of a visual or collision element. */
export type URDFGeometry =
  | { type: 'box'; size: [number, number, number] }
  | { type: 'cylinder'; radius: number; length: number }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; length: number }
  | { type: 'mesh'; filename: string; scale: [number, number, number] };

/** A `<visual>` or `<collision>` of a link. */
export interface URDFPart {
  name: string | null;
  /** Column-major matrix of 16 values, in the link's frame. */
  origin: Float64Array;
  geometry: URDFGeometry;
}

/** The `<inertial>` of a link. */
export interface URDFInertial {
  mass: number;
  /** Column-major matrix of 16 values, in the link's frame. */
  origin: Float64Array;
  /** `ixx, ixy, ixz, iyy, iyz, izz`. */
  inertia: [number, number, number, number, number, number];
}

/** A `<link>`. */
export interface URDFLink {
  name: string;
  /** The Robot joint whose frame this link rides on; -1 is the root link, which is the robot's base. */
  joint: number;
  visuals: URDFPart[];
  collisions: URDFPart[];
  inertial: URDFInertial | null;
}

/** A `<joint>`, with what `Robot` does not hold. */
export interface URDFJoint {
  name: string;
  type: 'revolute' | 'continuous' | 'prismatic' | 'fixed' | 'floating' | 'planar';
  parent: string;
  child: string;
  /** Largest speed and effort of `<limit>`; null when it has none. */
  velocity: number | null;
  effort: number | null;
  /** `<dynamics>`. */
  damping: number;
  friction: number;
}

/** A parsed description. */
export interface URDFModel {
  name: string;
  /** The joints, ranges and collision shapes. `robot.frameMatrix(link.joint)` places every link but the root. */
  robot: Robot;
  links: URDFLink[];
  joints: URDFJoint[];
  /** The joint position nearest zero within every range: a pose to start from. */
  home: Float64Array;
  /** The root link: the one no joint moves. */
  root: string;
  /** Mesh files the collision elements need, as written in the file. */
  meshes: string[];
  /** Those of `meshes` that were not given: their collision elements have no shape. Empty after {@link loadURDF}. */
  missingMeshes: string[];
}

/** Options of {@link parseURDF}. */
export interface URDFOptions {
  /** Vertices of each collision mesh, flat `x, y, z`, by the filename in the document. */
  meshes?: Record<string, ArrayLike<number>>;
  /** Sides of the prism that stands in for a cylinder, drawn round it so it holds the cylinder. Default 16. */
  cylinderSides?: number;
}

/** Options of {@link loadURDF}. */
export interface URDFLoadOptions extends Omit<URDFOptions, 'meshes'> {
  /** Base URL of each `package://name/`. A package not listed resolves against the folder above the document. */
  packages?: Record<string, string>;
  /** Defaults to the global `fetch`. */
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** Aborts every request and the mesh parsing. */
  signal?: AbortSignal;
}

function numbers(text: string | undefined, count: number, what: string): number[] {
  const parts = (text ?? '').trim().split(/\s+/).map(Number);
  if (parts.length !== count || parts.some((value) => !Number.isFinite(value)))
    throw rangeError(`URDF ${what} must be ${count} numbers; got "${text}"`, 'kinematics');
  return parts;
}

function number(text: string | undefined, what: string, fallback?: number): number {
  if (text === undefined && fallback !== undefined) return fallback;
  const value = Number(text);
  if (text === undefined || text.trim() === '' || !Number.isFinite(value))
    throw rangeError(`URDF ${what} must be a number; got "${text}"`, 'kinematics');
  return value;
}

const child = (element: XMLElement, name: string): XMLElement | undefined =>
  element.children.find((item) => item.name === name);
const children = (element: XMLElement, name: string): XMLElement[] =>
  element.children.filter((item) => item.name === name);

/** The matrix of an `<origin xyz rpy>`: rotation Rz(yaw) Ry(pitch) Rx(roll), as the format defines it. */
function originMatrix(element: XMLElement | undefined): Float64Array {
  const xyz = element?.attributes.xyz !== undefined ? numbers(element.attributes.xyz, 3, 'origin xyz') : [0, 0, 0],
    rpy = element?.attributes.rpy !== undefined ? numbers(element.attributes.rpy, 3, 'origin rpy') : [0, 0, 0],
    cr = Math.cos(rpy[0]),
    sr = Math.sin(rpy[0]),
    cp = Math.cos(rpy[1]),
    sp = Math.sin(rpy[1]),
    cy = Math.cos(rpy[2]),
    sy = Math.sin(rpy[2]);
  return Float64Array.of(
    cy * cp,
    sy * cp,
    -sp,
    0,
    cy * sp * sr - sy * cr,
    sy * sp * sr + cy * cr,
    cp * sr,
    0,
    cy * sp * cr + sy * sr,
    sy * sp * cr - cy * sr,
    cp * cr,
    0,
    xyz[0],
    xyz[1],
    xyz[2],
    1,
  );
}

function geometryOf(element: XMLElement | undefined, where: string): URDFGeometry {
  const shape = element?.children[0];
  if (!shape) throw rangeError(`URDF ${where} has no geometry`, 'kinematics');
  const a = shape.attributes;
  switch (shape.name) {
    case 'box': {
      const [x, y, z] = numbers(a.size, 3, 'box size');
      return { type: 'box', size: [x, y, z] };
    }
    case 'cylinder':
      return { type: 'cylinder', radius: number(a.radius, 'cylinder radius'), length: number(a.length, 'cylinder length') };
    case 'capsule':
      return { type: 'capsule', radius: number(a.radius, 'capsule radius'), length: number(a.length, 'capsule length') };
    case 'sphere':
      return { type: 'sphere', radius: number(a.radius, 'sphere radius') };
    case 'mesh': {
      if (!a.filename) throw rangeError(`URDF ${where} has a mesh with no filename`, 'kinematics');
      const [x, y, z] = a.scale !== undefined ? numbers(a.scale, 3, 'mesh scale') : [1, 1, 1];
      return { type: 'mesh', filename: a.filename, scale: [x, y, z] };
    }
    default:
      throw rangeError(`URDF ${where} has unknown geometry <${shape.name}>`, 'kinematics');
  }
}

function part(element: XMLElement, where: string): URDFPart {
  return {
    name: element.attributes.name ?? null,
    origin: originMatrix(child(element, 'origin')),
    geometry: geometryOf(child(element, 'geometry'), where),
  };
}

function linkOf(element: XMLElement): URDFLink {
  const name = element.attributes.name;
  if (!name) throw rangeError('A URDF link has no name', 'kinematics');
  const inertial = child(element, 'inertial');
  let inertia: URDFInertial | null = null;
  if (inertial) {
    const i = child(inertial, 'inertia')?.attributes;
    inertia = {
      mass: number(child(inertial, 'mass')?.attributes.value, `link ${name} mass`),
      origin: originMatrix(child(inertial, 'origin')),
      inertia: [
        number(i?.ixx, 'ixx', 0),
        number(i?.ixy, 'ixy', 0),
        number(i?.ixz, 'ixz', 0),
        number(i?.iyy, 'iyy', 0),
        number(i?.iyz, 'iyz', 0),
        number(i?.izz, 'izz', 0),
      ],
    };
  }
  return {
    name,
    joint: -1,
    visuals: children(element, 'visual').map((item) => part(item, `link ${name} visual`)),
    collisions: children(element, 'collision').map((item) => part(item, `link ${name} collision`)),
    inertial: inertia,
  };
}

interface RawJoint {
  element: XMLElement;
  data: URDFJoint;
  mimic: string | null;
}

function jointOf(element: XMLElement): RawJoint {
  const name = element.attributes.name,
    type = element.attributes.type,
    parent = child(element, 'parent')?.attributes.link,
    linked = child(element, 'child')?.attributes.link;
  if (!name) throw rangeError('A URDF joint has no name', 'kinematics');
  if (
    type !== 'revolute' &&
    type !== 'continuous' &&
    type !== 'prismatic' &&
    type !== 'fixed' &&
    type !== 'floating' &&
    type !== 'planar'
  )
    throw rangeError(`URDF joint ${name} has unknown type ${String(type)}`, 'kinematics');
  if (!parent || !linked) throw rangeError(`URDF joint ${name} needs a parent and a child link`, 'kinematics');
  const limit = child(element, 'limit')?.attributes,
    dynamics = child(element, 'dynamics')?.attributes;
  return {
    element,
    mimic: child(element, 'mimic')?.attributes.joint ?? null,
    data: {
      name,
      type,
      parent,
      child: linked,
      velocity: limit?.velocity !== undefined ? number(limit.velocity, `joint ${name} velocity`) : null,
      effort: limit?.effort !== undefined ? number(limit.effort, `joint ${name} effort`) : null,
      damping: number(dynamics?.damping, 'damping', 0),
      friction: number(dynamics?.friction, 'friction', 0),
    },
  };
}

/** Every joint after its parent link's joint and after the joint it repeats, file order otherwise. */
function ordered(raw: readonly RawJoint[], root: string): RawJoint[] {
  const placed = new Set<string>([root]),
    names = new Set<string>(),
    out: RawJoint[] = [],
    left = [...raw];
  while (left.length) {
    const next = left.findIndex(
      (joint) => placed.has(joint.data.parent) && (joint.mimic === null || names.has(joint.mimic)),
    );
    if (next < 0)
      throw rangeError(
        `URDF joints cannot be ordered: ${left.map((joint) => joint.data.name).join(', ')} are cut off from ${root} or repeat each other`,
        'kinematics',
      );
    const [joint] = left.splice(next, 1);
    out.push(joint);
    placed.add(joint.data.child);
    names.add(joint.data.name);
  }
  return out;
}

function axisOf(element: XMLElement): [number, number, number] {
  const text = child(element, 'axis')?.attributes.xyz;
  if (text === undefined) return [1, 0, 0];
  const [x, y, z] = numbers(text, 3, 'axis');
  return [x, y, z];
}

/** Joints of Robot for one URDF joint. A floating or planar joint is several in a row; the last carries the link. */
function expand(raw: RawJoint, parent: number | null): RobotJointOptions[] {
  const { element, data, mimic } = raw,
    origin = originMatrix(child(element, 'origin')),
    limit = child(element, 'limit')?.attributes,
    axis = axisOf(element),
    name = data.name;
  if (data.type === 'fixed') return [{ name, type: 'fixed', parent, origin }];
  if (data.type === 'floating' || data.type === 'planar') {
    const free = { lower: -Infinity, upper: Infinity };
    if (data.type === 'floating') {
      const out: RobotJointOptions[] = [];
      const axes: [number, number, number][] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      axes.forEach((direction, i) =>
        out.push({
          name: `${name}_${'xyz'[i]}`,
          type: 'prismatic',
          axis: direction,
          parent: i ? `${name}_${'xyz'[i - 1]}` : parent,
          origin: i ? undefined : origin,
          ...free,
        }),
      );
      axes.forEach((direction, i) =>
        out.push({
          name: i === 2 ? name : `${name}_r${'xyz'[i]}`,
          type: 'continuous',
          axis: direction,
          parent: i ? `${name}_r${'xyz'[i - 1]}` : `${name}_z`,
        }),
      );
      return out;
    }
    // Two axes square to the plane's normal.
    const size = Math.hypot(axis[0], axis[1], axis[2]),
      n = [axis[0] / size, axis[1] / size, axis[2] / size],
      other = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0],
      dot = n[0] * other[0] + n[1] * other[1] + n[2] * other[2],
      u = [other[0] - n[0] * dot, other[1] - n[1] * dot, other[2] - n[2] * dot] as [number, number, number],
      v: [number, number, number] = [
        n[1] * u[2] - n[2] * u[1],
        n[2] * u[0] - n[0] * u[2],
        n[0] * u[1] - n[1] * u[0],
      ];
    return [
      { name: `${name}_u`, type: 'prismatic', axis: u, parent, origin, ...free },
      { name, type: 'prismatic', axis: v, parent: `${name}_u`, ...free },
    ];
  }
  const out: RobotJointOptions = { name, type: data.type, parent, origin, axis };
  if (mimic !== null) {
    const m = child(element, 'mimic')!.attributes;
    out.mimic = {
      joint: mimic,
      multiplier: number(m.multiplier, 'mimic multiplier', 1),
      offset: number(m.offset, 'mimic offset', 0),
    };
  } else if (data.type !== 'continuous') {
    if (!limit) throw rangeError(`URDF joint ${name} is ${data.type} and needs a <limit>`, 'kinematics');
    out.lower = number(limit.lower, 'lower', 0);
    out.upper = number(limit.upper, 'upper', 0);
  }
  return [out];
}

/** Corners of a box, a prism round a cylinder, or the scaled vertices of a mesh, as a shape on a joint. */
function shapeOf(
  joint: number | null,
  item: URDFPart,
  sides: number,
  meshes: Record<string, ArrayLike<number>> | undefined,
): RobotShapeOptions | null {
  const { geometry: g, origin } = item;
  if (g.type === 'sphere')
    return { joint, start: [origin[12], origin[13], origin[14]], radius: g.radius };
  if (g.type === 'capsule') {
    const half = g.length / 2,
      at = (sign: number): [number, number, number] => [
        origin[12] + origin[8] * half * sign,
        origin[13] + origin[9] * half * sign,
        origin[14] + origin[10] * half * sign,
      ];
    return { joint, start: at(-1), end: at(1), radius: g.radius };
  }
  const points: number[] = [];
  if (g.type === 'box') {
    const [x, y, z] = g.size;
    for (const a of [-x / 2, x / 2]) for (const b of [-y / 2, y / 2]) for (const c of [-z / 2, z / 2]) points.push(a, b, c);
  } else if (g.type === 'cylinder') {
    const reach = g.radius / Math.cos(Math.PI / sides);
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2,
        x = reach * Math.cos(angle),
        y = reach * Math.sin(angle);
      points.push(x, y, -g.length / 2, x, y, g.length / 2);
    }
  } else {
    const vertices = meshes?.[g.filename];
    if (!vertices) return null;
    for (let i = 0; i + 2 < vertices.length; i += 3)
      points.push(vertices[i] * g.scale[0], vertices[i + 1] * g.scale[1], vertices[i + 2] * g.scale[2]);
  }
  return { joint, points, matrix: origin };
}

/**
 * Reads a URDF document: links, joints with their ranges, mimic joints, collision shapes, and the visuals and inertia
 * as data. A box, sphere or cylinder is a shape at once; a mesh needs its vertices in `options.meshes`, which
 * {@link loadURDF} fetches for you. A cylinder becomes a prism drawn round it, so it holds the true shape, and a mesh
 * becomes the convex hull of its vertices, which holds the whole link.
 *
 * @example
 * ```ts
 * import { parseURDF } from 'margoengine/kinematics-constraints/urdf';
 *
 * const { robot, home } = parseURDF(`
 *   <robot name="pendulum">
 *     <link name="base"/>
 *     <link name="arm"><collision><geometry><box size="0.1 0.1 1"/></geometry></collision></link>
 *     <joint name="swing" type="revolute">
 *       <parent link="base"/><child link="arm"/>
 *       <axis xyz="0 1 0"/><limit lower="-1" upper="1" effort="1" velocity="1"/>
 *     </joint>
 *   </robot>`);
 * robot.forward(home);
 * ```
 */
export function parseURDF(text: string, options?: URDFOptions): URDFModel {
  if (typeof text !== 'string') throw typeError('parseURDF needs the text of a URDF document', 'kinematics');
  const sides = options?.cylinderSides ?? 16;
  if (!Number.isSafeInteger(sides) || sides < 3)
    throw rangeError('URDF cylinderSides must be a whole number of 3 or more', 'kinematics');
  const document = readXMLTree(text, 'URDF').children.find((item) => item.name === 'robot');
  if (!document) throw rangeError('A URDF document has a <robot> root', 'kinematics');
  const links = children(document, 'link').map(linkOf),
    raw = children(document, 'joint').map(jointOf),
    byName = new Map(links.map((link) => [link.name, link]));
  if (byName.size !== links.length) throw rangeError('Two URDF links share a name', 'kinematics');
  if (new Set(raw.map((joint) => joint.data.name)).size !== raw.length)
    throw rangeError('Two URDF joints share a name', 'kinematics');
  const moved = new Set<string>();
  for (const { data } of raw) {
    if (!byName.has(data.parent)) throw rangeError(`URDF joint ${data.name} names no link ${data.parent}`, 'kinematics');
    if (!byName.has(data.child)) throw rangeError(`URDF joint ${data.name} names no link ${data.child}`, 'kinematics');
    if (moved.has(data.child)) throw rangeError(`URDF link ${data.child} has two parents`, 'kinematics');
    moved.add(data.child);
  }
  const roots = links.filter((link) => !moved.has(link.name));
  if (roots.length !== 1)
    throw rangeError(
      `A URDF robot has one root link; found ${roots.map((link) => link.name).join(', ') || 'none'}`,
      'kinematics',
    );
  const root = roots[0].name,
    joints: RobotJointOptions[] = [],
    frameOf = new Map<string, number>([[root, -1]]);
  for (const joint of ordered(raw, root)) {
    const parent = frameOf.get(joint.data.parent)!,
      expanded = expand(joint, parent < 0 ? null : parent);
    joints.push(...expanded);
    frameOf.set(joint.data.child, joints.length - 1);
  }
  const shapes: RobotShapeOptions[] = [],
    meshes = new Set<string>(),
    missing = new Set<string>();
  for (const link of links) {
    link.joint = frameOf.get(link.name)!;
    for (const item of link.collisions) {
      if (item.geometry.type === 'mesh') meshes.add(item.geometry.filename);
      const shape = shapeOf(link.joint < 0 ? null : link.joint, item, sides, options?.meshes);
      if (shape) shapes.push(shape);
      else if (item.geometry.type === 'mesh') missing.add(item.geometry.filename);
    }
  }
  // A robot with no moving part still has a frame for its root's shapes.
  if (joints.length === 0) joints.push({ name: root, type: 'fixed', parent: null });
  const robot = new Robot({ joints, shapes });
  return {
    name: document.attributes.name ?? '',
    robot,
    links,
    joints: raw.map((joint) => joint.data),
    home: robot.clamp(new Float64Array(robot.dof)),
    root,
    meshes: [...meshes],
    missingMeshes: [...missing],
  };
}

function resolveMesh(filename: string, base: string, packages: Record<string, string> | undefined): string {
  const match = /^package:\/\/([^/]+)\/(.*)$/.exec(filename);
  if (match) {
    const [, name, rest] = match,
      known = packages?.[name];
    if (known !== undefined) return new URL(rest, known.endsWith('/') ? known : `${known}/`).href;
    return new URL(`../${rest}`, base).href;
  }
  return new URL(filename, base).href;
}

/** The corners of a mesh's convex hull, or its vertices when they span no volume, as a flat sheet does. */
async function hullCorners(url: string, bytes: Uint8Array, signal: AbortSignal | undefined): Promise<ArrayLike<number>> {
  const [loaders, geometry] = await Promise.all([import('@margoengine/loaders'), import('@margoengine/geometry/extras')]);
  signal?.throwIfAborted();
  const kind = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)?.[1]?.toLowerCase();
  let positions: Float32Array;
  if (kind === 'stl') positions = loaders.parseSTL(bytes, { signal }).positions;
  else if (kind === 'dae') positions = loaders.flattenDAE(loaders.parseDAE(bytes)).positions;
  else if (kind === 'obj') positions = (await loaders.parseOBJ(bytes, { signal })).positions;
  else throw rangeError(`URDF mesh ${url} is not .stl, .dae or .obj`, 'kinematics');
  try {
    return geometry.convexGeometry(positions).positions;
  } catch (error) {
    // convexGeometry refuses a flat or tiny point set with a RangeError. Those points are the shape, hull or not.
    if (error instanceof RangeError) return positions;
    throw error;
  }
}

/**
 * Fetches a URDF document and the collision meshes it names, and reads them, so `robot` comes with every shape.
 * `package://name/` paths resolve through `options.packages`. STL, COLLADA and OBJ meshes are read by
 * `@margoengine/loaders`, loaded only when a mesh is met, and reduced to their convex hull with `@margoengine/geometry`.
 */
export async function loadURDF(url: string | URL, options?: URDFLoadOptions): Promise<URDFModel> {
  const fetcher = options?.fetch ?? globalThis.fetch,
    signal = options?.signal,
    base = String(url),
    read = async (target: string): Promise<Response> => {
      const response = await fetcher(target, { signal });
      if (!response.ok) throw rangeError(`URDF could not load ${target}: ${response.status}`, 'kinematics');
      return response;
    };
  const text = await (await read(base)).text(),
    first = parseURDF(text, { cylinderSides: options?.cylinderSides });
  if (first.meshes.length === 0) return first;
  const meshes: Record<string, ArrayLike<number>> = {};
  await Promise.all(
    first.meshes.map(async (filename) => {
      const target = resolveMesh(filename, base, options?.packages),
        bytes = new Uint8Array(await (await read(target)).arrayBuffer());
      meshes[filename] = await hullCorners(target, bytes, signal);
    }),
  );
  return parseURDF(text, { meshes, cylinderSides: options?.cylinderSides });
}
