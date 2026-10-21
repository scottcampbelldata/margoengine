// Skin authoring for a mesh and an authored rest skeleton: deterministic four-influence weights from the nearest bone
// segments, translation-only bind matrices, and the joint nodes and SkinData a data scene exports. Optional and
// separate (`@margoengine/exporters/skin`); nothing else in the package imports it.
//
// Coordinate conventions. Joint positions are rest positions in joint space, a right-handed space in the mesh's units
// (any up axis: nothing here depends on it). The mesh's vertices are in mesh space, and `origin` is the joint-space
// point at the mesh's origin: joint space = mesh space + origin (a voxel model's pivot, when the joints are in grid
// coordinates). Matrices are column-major 4x4, as glTF stores them. Joints carry no rest rotation: each local rest
// transform is the translation from its parent joint (the root's from the mesh origin), and each inverse bind matrix
// is the translation by minus the joint's mesh-space rest position, so the rest pose leaves every vertex in place.
import type { Vec3 } from '@margoengine/math';
import type { ExportNode, SkinData } from './scene.js';

/** A joint of an authored rest skeleton. */
export interface SkinJoint {
  /** Unique, nonempty. Becomes the joint node's name. */
  name: string;
  /** Index of the parent joint, or -1 for the one root. */
  parent: number;
  /** Rest position in joint space. */
  position: Vec3;
}

/** Per-vertex skinning: four joint indices and four weights summing to 1 per vertex, as glTF JOINTS_0 / WEIGHTS_0. */
export interface SkinWeights {
  joints: Uint16Array;
  weights: Float32Array;
}

/** Column-major 4x4 rest matrices, sixteen values per joint in joint order. */
export interface SkinBindMatrices {
  /** Each joint's rest transform relative to its parent (the root's relative to the mesh origin). */
  local: Float32Array;
  /** Each joint's rest transform in mesh space. */
  world: Float32Array;
  /** Inverse of `world`: glTF's inverseBindMatrices. */
  inverseBind: Float32Array;
}

const MAX_JOINTS = 1024,
  MAX_VERTICES = 1 << 24,
  MAX_WORK = 1 << 28;

/**
 * Throws unless `joints` is a valid skeleton: 1 to 1024 joints with unique nonempty names, finite positions and
 * parents forming one tree with exactly one root.
 */
export function checkJoints(joints: readonly SkinJoint[]): void {
  if (!Array.isArray(joints) || !joints.length || joints.length > MAX_JOINTS)
    throw new RangeError(`A skeleton needs 1 to ${MAX_JOINTS} joints`);
  const names = new Set<string>();
  let roots = 0;
  joints.forEach((joint, i) => {
    if (!joint || typeof joint.name !== 'string' || !joint.name || names.has(joint.name))
      throw new TypeError(`Joint ${i} needs a unique, nonempty name`);
    names.add(joint.name);
    if (!Number.isInteger(joint.parent) || joint.parent < -1 || joint.parent >= joints.length || joint.parent === i)
      throw new RangeError(`Joint ${joint.name} parent must be another joint's index or -1`);
    if (joint.parent === -1) roots++;
    if (
      !Array.isArray(joint.position) ||
      joint.position.length !== 3 ||
      !(joint.position as readonly unknown[]).every((v) => typeof v === 'number' && Number.isFinite(Math.fround(v)))
    )
      throw new RangeError(`Joint ${joint.name} position must be three finite Float32 numbers`);
  });
  if (roots !== 1) throw new RangeError(`A skeleton needs exactly one root joint (parent -1), not ${roots}`);
  // With one root and every other joint naming a parent, the tree has no cycle iff every joint reaches the root.
  joints.forEach((joint, i) => {
    let at = i;
    for (let steps = 0; at !== -1; steps++) {
      if (steps > joints.length) throw new RangeError(`Joint ${joint.name} is in a parent cycle`);
      at = joints[at].parent;
    }
  });
}

function vec3(value: unknown, label: string): [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((v) => typeof v === 'number' && Number.isFinite(Math.fround(v)))
  )
    throw new RangeError(`${label} must be three finite Float32 numbers`);
  return [value[0], value[1], value[2]];
}

/**
 * Four-influence skin weights for mesh-space `positions` (xyz per vertex): each vertex takes the `influences` (1 to 4,
 * default 4) joints whose bone segments lie nearest (a joint's segment runs from its parent's position to its own;
 * the root's is its point), weighted by inverse distance (distances below 1e-6 count as 1e-6) and normalized to sum
 * to 1. Ties go to the lower joint index, so equal input gives equal output. Unused influences are joint 0, weight 0.
 * @param origin The joint-space point at the mesh origin. Default [0, 0, 0].
 * @throws RangeError for invalid joints or positions, or more than 2^28 vertex-joint pairs.
 */
export function skinWeights(
  positions: ArrayLike<number>,
  joints: readonly SkinJoint[],
  { origin = [0, 0, 0], influences = 4 }: { origin?: Vec3; influences?: 1 | 2 | 3 | 4 } = {},
): SkinWeights {
  checkJoints(joints);
  const [ox, oy, oz] = vec3(origin, 'Skin origin');
  if (!Number.isInteger(influences) || influences < 1 || influences > 4)
    throw new RangeError('Skin influences must be 1, 2, 3 or 4');
  const length = positions?.length;
  if (typeof length !== 'number' || length % 3 || length / 3 > MAX_VERTICES)
    throw new RangeError(`Skin positions need xyz per vertex, at most ${MAX_VERTICES} vertices`);
  const count = length / 3,
    n = joints.length;
  if (count * n > MAX_WORK) throw new RangeError('Vertices times joints exceed 2^28; skin the mesh in parts');
  // Each bone segment from a (parent) to a + d (joint).
  const a = new Float64Array(n * 3),
    d = new Float64Array(n * 3),
    dd = new Float64Array(n);
  joints.forEach((joint, j) => {
    const from = joint.parent === -1 ? joint.position : joints[joint.parent].position;
    for (let c = 0; c < 3; c++) {
      a[j * 3 + c] = from[c];
      d[j * 3 + c] = joint.position[c] - from[c];
    }
    dd[j] = d[j * 3] ** 2 + d[j * 3 + 1] ** 2 + d[j * 3 + 2] ** 2;
  });
  const out: SkinWeights = { joints: new Uint16Array(count * 4), weights: new Float32Array(count * 4) },
    bestJoint = new Int32Array(4),
    bestDistance = new Float64Array(4);
  for (let v = 0; v < count; v++) {
    const px = positions[v * 3] + ox,
      py = positions[v * 3 + 1] + oy,
      pz = positions[v * 3 + 2] + oz;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz))
      throw new RangeError(`Skin position ${v} is not finite`);
    bestDistance.fill(Infinity);
    bestJoint.fill(-1);
    for (let j = 0; j < n; j++) {
      const rx = px - a[j * 3],
        ry = py - a[j * 3 + 1],
        rz = pz - a[j * 3 + 2],
        t = dd[j] ? Math.min(1, Math.max(0, (rx * d[j * 3] + ry * d[j * 3 + 1] + rz * d[j * 3 + 2]) / dd[j])) : 0,
        distance = Math.hypot(rx - d[j * 3] * t, ry - d[j * 3 + 1] * t, rz - d[j * 3 + 2] * t);
      // Insertion into the sorted best list; a later joint with an equal distance goes after (lower index wins).
      let slot = influences;
      while (slot > 0 && distance < bestDistance[slot - 1]) slot--;
      if (slot === influences) continue;
      for (let k = influences - 1; k > slot; k--) {
        bestDistance[k] = bestDistance[k - 1];
        bestJoint[k] = bestJoint[k - 1];
      }
      bestDistance[slot] = distance;
      bestJoint[slot] = j;
    }
    let total = 0;
    for (let k = 0; k < influences && bestJoint[k] >= 0; k++) total += 1 / Math.max(1e-6, bestDistance[k]);
    for (let k = 0; k < influences && bestJoint[k] >= 0; k++) {
      out.joints[v * 4 + k] = bestJoint[k];
      out.weights[v * 4 + k] = 1 / Math.max(1e-6, bestDistance[k]) / total;
    }
  }
  return out;
}

const translation = (out: Float32Array, at: number, x: number, y: number, z: number): void => {
  out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1], at * 16);
};

/**
 * Rest matrices of `joints`: local (from the parent joint, the root's from the mesh origin), world (mesh space) and
 * inverse bind, all translations (see the module's coordinate conventions).
 * @param origin The joint-space point at the mesh origin. Default [0, 0, 0].
 */
export function skinBindMatrices(joints: readonly SkinJoint[], origin: Vec3 = [0, 0, 0]): SkinBindMatrices {
  checkJoints(joints);
  const o = vec3(origin, 'Skin origin'),
    n = joints.length,
    out: SkinBindMatrices = {
      local: new Float32Array(n * 16),
      world: new Float32Array(n * 16),
      inverseBind: new Float32Array(n * 16),
    };
  joints.forEach((joint, j) => {
    const p = joint.position,
      base = joint.parent === -1 ? o : joints[joint.parent].position;
    translation(out.local, j, p[0] - base[0], p[1] - base[1], p[2] - base[2]);
    translation(out.world, j, p[0] - o[0], p[1] - o[1], p[2] - o[2]);
    translation(out.inverseBind, j, o[0] - p[0], o[1] - p[1], o[2] - p[2]);
  });
  return out;
}

/** The joint nodes and skin of a skeleton: {@link skinHierarchy}'s result. */
export interface SkinHierarchy {
  /** The root joint's node, holding the others as descendants. Place it beside the skinned mesh node. */
  root: ExportNode;
  /** One node per joint, in joint order. */
  nodes: ExportNode[];
  /** The skin for the mesh node: these joints, their inverse bind matrices and the root as skeleton. */
  skin: SkinData;
}

/**
 * Joint nodes (named as the joints, translated by their local rest transforms) and the {@link SkinData} for a mesh
 * whose vertices are in mesh space. Put `root` under the same parent as the mesh node (the mesh node and the skeleton
 * share the parent's transform), and give the mesh node `skin` and the geometry {@link skinWeights}'s joints and
 * weights.
 * @param options.origin The joint-space point at the mesh origin. Default [0, 0, 0].
 * @param options.name The skin's name.
 */
export function skinHierarchy(
  joints: readonly SkinJoint[],
  { origin = [0, 0, 0], name }: { origin?: Vec3; name?: string } = {},
): SkinHierarchy {
  const { local, inverseBind } = skinBindMatrices(joints, origin);
  if (name !== undefined && typeof name !== 'string') throw new TypeError('Skin name must be a string');
  const children: ExportNode[][] = joints.map(() => []),
    nodes = joints.map((joint, j) => {
      const node: ExportNode = {
        name: joint.name,
        translation: [local[j * 16 + 12], local[j * 16 + 13], local[j * 16 + 14]],
        children: children[j],
      };
      return node;
    });
  joints.forEach((joint, j) => {
    if (joint.parent !== -1) children[joint.parent].push(nodes[j]);
  });
  for (const [j, node] of nodes.entries()) if (!children[j].length) delete (node as { children?: unknown }).children;
  const root = nodes[joints.findIndex((joint) => joint.parent === -1)],
    skin: SkinData = { joints: nodes, inverseBindMatrices: inverseBind, skeleton: root };
  if (name) skin.name = name;
  return { root, nodes, skin };
}

/**
 * An upright humanoid rest skeleton fitted to the box `min`..`max` (y up, the figure facing +z): root, hips, spine,
 * chest, neck and head on the centre line, shoulders, elbows and wrists, hips, knees and ankles on each side; 18
 * joints, a starting point for manual refinement.
 * @throws RangeError unless every `max` component is >= its `min`.
 */
export function humanoidJoints(min: Vec3, max: Vec3): SkinJoint[] {
  const lo = vec3(min, 'Humanoid min'),
    hi = vec3(max, 'Humanoid max');
  if (hi.some((v, axis) => v < lo[axis])) throw new RangeError('Humanoid max must be >= min on every axis');
  const [width, height, depth] = [0, 1, 2].map((axis) => hi[axis] - lo[axis]),
    cx = (lo[0] + hi[0]) / 2,
    cz = (lo[2] + hi[2]) / 2,
    at = (x: number, y: number, z = 0): Vec3 => [cx + width * x, lo[1] + height * y, cz + depth * z];
  const layout: [string, number, number, number, number?][] = [
    ['root', -1, 0, 0],
    ['hips', 0, 0, 0.48],
    ['spine', 1, 0, 0.61],
    ['chest', 2, 0, 0.74],
    ['neck', 3, 0, 0.86],
    ['head', 4, 0, 0.95],
    ['leftShoulder', 3, -0.2, 0.78],
    ['leftElbow', 6, -0.34, 0.65],
    ['leftWrist', 7, -0.46, 0.51],
    ['rightShoulder', 3, 0.2, 0.78],
    ['rightElbow', 9, 0.34, 0.65],
    ['rightWrist', 10, 0.46, 0.51],
    ['leftHip', 1, -0.12, 0.47],
    ['leftKnee', 12, -0.13, 0.25],
    ['leftAnkle', 13, -0.14, 0.03, 0.05],
    ['rightHip', 1, 0.12, 0.47],
    ['rightKnee', 15, 0.13, 0.25],
    ['rightAnkle', 16, 0.14, 0.03, 0.05],
  ];
  return layout.map(([name, parent, x, y, z]) => ({ name, parent, position: at(x, y, z) }));
}
