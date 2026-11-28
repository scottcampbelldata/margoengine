// USDZ with motion: a clip's node transforms as time samples and its skins as UsdSkel, so a character plays in AR Quick Look.
// USD has one timeline, so one clip goes in a file. Tracks are sampled at a fixed rate, which is how USD stores them anyway:
// it holds values at time codes and blends between them.
import { sampleTrackInto, type Interpolation } from '@margoengine/animation/sampling';
import { composeMatrix, invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { splitGLB } from './glb.js';
import { sceneOfParts } from './glb-scene.js';
import {
  collect,
  decompose,
  determinant3,
  normalizeMaterial,
  num,
  polylines,
  type ExportNode,
  type ExportScene,
  type Geo,
  type Mat,
  type Node,
  type SkinData,
} from './scene.js';
import {
  boxSize,
  checkPlacement,
  curvesPrim,
  primWidth,
  emptyBox,
  growBox,
  growBoxWith,
  listedVertices,
  meshPrim,
  placedBox,
  placementOf,
  reflected,
  rootTransform,
  shapeOf,
  storedZIP,
  tuple,
  tuples,
  USDMaterials,
  type Shape,
  type USDZBox,
  type USDZOptions,
} from './usdz-write.js';

export type { USDZBox } from './usdz-write.js';

/** Past this many frames a file stops being practical to open; a longer clip wants a lower rate or a cut. */
const MAX_FRAMES = 100_000;

/** Options for {@link exportAnimatedUSDZ}. */
export interface AnimatedUSDZOptions extends USDZOptions {
  /** Which animation of the scene: its index or its name. USD holds one timeline, so a file holds one clip. Default 0. */
  clip?: number | string;
  /** Samples per second, and the file's `timeCodesPerSecond`. Default 30. */
  fps?: number;
  /** Stops between frames. */
  signal?: AbortSignal;
}

/** What {@link exportAnimatedUSDZ} left out of the file. */
export interface AnimatedUSDZSkip {
  /**
   * `'morph-weights'`: a channel of morph target weights on a node that draws no triangle mesh with morph targets (points
   * and lines have no blend shapes in UsdSkel). `'not-exported'`: a channel of a
   * node the scene did not collect. `'primitive'`, `'texture'`, `'colors'` and `'channel'`, for GLB input: a primitive that
   * is not triangles, a texture not PNG or JPEG, vertex colours under a base colour texture, a channel with no node, such as
   * one of KHR_animation_pointer.
   */
  kind: 'morph-weights' | 'not-exported' | 'primitive' | 'texture' | 'colors' | 'channel';
  /** The node's name for a channel; the mesh, material or animation index for the rest. */
  target?: string | number;
}

/** What {@link exportAnimatedUSDZ} returns. */
export interface AnimatedUSDZResult {
  usdz: Uint8Array;
  /** The clip's name, when it has one. */
  clip?: string;
  /** Time samples per animated attribute: `frames - 1` over `fps` covers the clip. */
  frames: number;
  /**
   * Width, height and depth of the rest pose in metres, as written: what AR Quick Look shows, as it draws a file at real
   * size. Fox.glb reads about 25 by 79 by 155 without `height`, so check this before sending a file to a phone.
   */
  size: [number, number, number];
  /** Everywhere the clip reaches in metres, as written, with skinning applied at every frame. */
  bounds: USDZBox;
  /** The even scale `height` asked for; 1 without it. */
  scale: number;
  skipped: AnimatedUSDZSkip[];
}

interface Track {
  times: Float32Array;
  values: Float32Array;
  interpolation: Interpolation;
}
/** A node's tracks, by the part of its transform they drive. */
type Tracks = Partial<Record<'t' | 'r' | 's', Track>>;

/** A joint of a skeleton: its place, its USD path, and the joint it hangs from. */
interface Joint {
  node: Node;
  path: string;
  parent: number;
}

/** USD's text form takes attribute metadata one per line; a comma between them does not parse. */
const jointPrimvar = (size: number) => `(\n        elementSize = ${size}\n        interpolation = "vertex"\n    )`;

/**
 * A skinned geometry's influences, four or eight a vertex, in one run each: UsdSkel's `elementSize` is any count of
 * influences a point (UsdSkel BindingAPI, jointIndices), so the second glTF set follows the first in each vertex.
 */
function influences(geometry: Geo): { size: number; joints: Uint16Array; weights: Float32Array } {
  const first = geometry.joints!,
    second = geometry.joints1;
  if (!second) return { size: 4, joints: first, weights: geometry.weights! };
  const count = first.length / 4,
    joints = new Uint16Array(count * 8),
    weights = new Float32Array(count * 8);
  for (let v = 0; v < count; v++)
    for (let k = 0; k < 4; k++) {
      joints[v * 8 + k] = first[v * 4 + k];
      joints[v * 8 + 4 + k] = second[v * 4 + k];
      weights[v * 8 + k] = geometry.weights![v * 4 + k];
      weights[v * 8 + 4 + k] = geometry.weights1![v * 4 + k];
    }
  return { size: 8, joints, weights };
}

const PATHS = { translation: 't', rotation: 'r', scale: 's' } as const;
const WIDTHS = { t: 3, r: 4, s: 3 } as const;

/** A name USD takes for a prim or a joint: letters, digits and underscores, not starting with a digit. */
const primName = (name: string | undefined, fallback: string): string => {
  const clean = (name ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  return !clean ? fallback : /^[0-9]/.test(clean) ? `_${clean}` : clean;
};

/** Three or four numbers of glTF's [x, y, z, w] as USD's (w, x, y, z). */
const quaternion = ([x, y, z, w]: number[]): string => tuple([w, x, y, z]);

/** `lines` as one attribute: a plain value when every frame holds the same one, else time samples. */
function attribute(type: string, name: string, frames: readonly string[]): string[] {
  if (frames.every((value) => value === frames[0])) return [`    ${type} ${name} = ${frames[0]}`];
  return [
    `    ${type} ${name}.timeSamples = {`,
    ...frames.map((value, frame) => `        ${frame}: ${value},`),
    '    }',
  ];
}

/** A column-major matrix as USD's rows, which are its columns in order. */
const matrix = (m: ArrayLike<number>): string => {
  const row = (at: number): string => tuple([m[at], m[at + 1], m[at + 2], m[at + 3]]);
  return `(${row(0)}, ${row(4)}, ${row(8)}, ${row(12)})`;
};

/** Where a clip puts every node, frame by frame. */
class Poses {
  private readonly scratch = { t: new Float32Array(3), r: new Float32Array(4), s: new Float32Array(3) };
  private readonly worlds = new Map<Node, Float64Array>();
  frame = 0;
  constructor(
    private readonly tracks: Map<Node, Tracks>,
    private readonly parents: Map<Node, Node | undefined>,
    private readonly seconds: (frame: number) => number,
  ) {}
  /** Moves to `frame`. */
  at(frame: number): void {
    this.frame = frame;
    this.worlds.clear();
  }
  /** One part of the node's transform at this frame. */
  part(node: Node, key: 't' | 'r' | 's'): Float32Array | number[] {
    const track = this.tracks.get(node)?.[key];
    if (!track) return node[key];
    return sampleTrackInto(
      track.times,
      track.values,
      WIDTHS[key],
      this.seconds(this.frame),
      track.interpolation,
      key === 'r',
      this.scratch[key],
    );
  }
  /** The node's own matrix at this frame. */
  local(node: Node): Float64Array {
    const tracks = this.tracks.get(node);
    if (!tracks) return node.local;
    const t = this.part(node, 't'),
      r = this.part(node, 'r'),
      s = this.part(node, 's'),
      length = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    return composeMatrix(t, [r[0] / length, r[1] / length, r[2] / length, r[3] / length], s, new Float64Array(16));
  }
  /** The node's world matrix at this frame. */
  world(node: Node): Float64Array {
    let world = this.worlds.get(node);
    if (world) return world;
    const parent = this.parents.get(node),
      local = this.local(node);
    world = parent ? multiplyMatrices(this.world(parent), local) : local;
    this.worlds.set(node, world);
    return world;
  }
}

/** Every node, parents before children, with each one's parent. */
function walked(roots: readonly Node[]): { order: Node[]; parents: Map<Node, Node | undefined> } {
  const order: Node[] = [],
    parents = new Map<Node, Node | undefined>(),
    visit = (node: Node, parent?: Node): void => {
      order.push(node);
      parents.set(node, parent);
      for (const child of node.children) visit(child, node);
    };
  for (const root of roots) visit(root);
  return { order, parents };
}

/** Primitives a node draws. */
const drawn = (node: Node): { geometry: Geo; material?: Mat }[] => [
  ...(node.primitives ?? (node.geometry ? [{ geometry: node.geometry, material: node.material }] : [])),
  ...(node.lines ?? []),
];

/**
 * True for a primitive its skin moves: the skin needs the joints on the vertices. Points and lines are written at their
 * node, unskinned: UsdSkel binds meshes (and the joints they carry), so they follow the node's own animation only.
 */
const skinned = (node: Node, geometry: Geo): boolean =>
  !!node.skin && !!geometry.joints && !!geometry.weights && !geometry.topology;

/** True for a triangle primitive that carries morph targets but no skin: it gets a skeleton of one still joint. */
const morphOnly = (node: Node, geometry: Geo): boolean =>
  !geometry.topology && !!geometry.morphs?.length && !skinned(node, geometry);

/**
 * True for a node that draws a triangle primitive with morph targets: the ones UsdSkel's blend shapes can drive. A skinned
 * one has its skin's skeleton; one with no skin is given a skeleton of one joint that never moves.
 */
const morphed = (node: Node): boolean =>
  drawn(node).some(({ geometry }) => !geometry.topology && !!geometry.morphs?.length);

/** A 4x4 identity as USD writes a matrix. */
const IDENTITY_MATRIX = '((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))';
/** The reflection {@link reflected} applies, as a matrix. */
const MIRROR_X = new Float64Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * A SkelRoot that drives the blend shapes of a node's unskinned meshes. UsdSkel applies blend shapes only to a mesh bound to
 * a skeleton, so the meshes bind rigidly (one constant influence of weight 1) to a single joint whose bind, rest and animated
 * transforms are all the identity: skinning leaves the points where they rest, in the node's own space, and the node's Xform
 * above still moves them. A mirrored mesh, written reflected, is turned back by its `geomBindTransform`, which UsdSkel applies
 * after the blend shapes (OpenUSD UsdSkel, "Schemas In-Depth": BlendShape, SkelBindingAPI, geomBindTransform).
 */
function morphRoot(
  path: string,
  name: string,
  meshes: readonly string[],
  tokens: readonly string[],
  frames: readonly string[],
): string[] {
  return [
    `def SkelRoot "${name}" {`,
    '    def Skeleton "Skeleton" (',
    '        prepend apiSchemas = ["SkelBindingAPI"]',
    '    ) {',
    '        uniform token[] joints = ["Root"]',
    `        uniform matrix4d[] bindTransforms = [${IDENTITY_MATRIX}]`,
    `        uniform matrix4d[] restTransforms = [${IDENTITY_MATRIX}]`,
    `        rel skel:animationSource = <${path}/Motion>`,
    '    }',
    '    def SkelAnimation "Motion" {',
    '        uniform token[] joints = ["Root"]',
    '        float3[] translations = [(0, 0, 0)]',
    '        quatf[] rotations = [(1, 0, 0, 0)]',
    '        half3[] scales = [(1, 1, 1)]',
    `        uniform token[] blendShapes = [${tokens.map((token) => JSON.stringify(token)).join(', ')}]`,
    ...attribute('float[]', 'blendShapeWeights', frames).map((line) => `    ${line}`),
    '    }',
    ...meshes,
    '}',
  ];
}

/**
 * The weights of a node's morph targets at each frame: its `weights` channel sampled as glTF 2.0 section 3.11 says (STEP,
 * LINEAR, CUBICSPLINE), else the node's own `morphWeights`, else zero. `count` is the number of targets.
 */
function weightsOf(node: Node, count: number, track: Track | undefined, fps: number): (frame: number) => number[] {
  const out = new Float32Array(count);
  if (track) {
    const per = track.interpolation === 'CUBICSPLINE' ? 3 : 1;
    if (track.values.length !== track.times.length * count * per)
      throw new RangeError(
        `The weights channel of ${node.name ?? 'a node'} holds ${track.values.length} values for ${track.times.length} keys of ${count} targets; give the channel keys x targets values`,
      );
  }
  return (frame) => {
    if (!track) return Array.from({ length: count }, (_, k) => node.morphWeights?.[k] ?? 0);
    sampleTrackInto(track.times, track.values, count, frame / fps, track.interpolation, false, out);
    return Array.from(out);
  };
}

/**
 * A morph target as a `BlendShape` prim (OpenUSD UsdSkel, "BlendShape": `offsets`, `normalOffsets` and `pointIndices`), with
 * `space` applied to the deltas as it is to the points: its linear part to the offsets, its inverse transpose to the normal
 * offsets. A target that moves fewer points than the mesh has lists them in `pointIndices`.
 */
function blendShape(
  name: string,
  morph: NonNullable<Geo['morphs']>[number],
  space: Float64Array | undefined,
): string[] {
  const { positions, normals } = morph,
    count = positions.length / 3,
    moved: number[] = [];
  for (let v = 0; v < count; v++)
    if (
      positions[v * 3] ||
      positions[v * 3 + 1] ||
      positions[v * 3 + 2] ||
      (normals && (normals[v * 3] || normals[v * 3 + 1] || normals[v * 3 + 2]))
    )
      moved.push(v);
  const sparse = moved.length < count,
    list = sparse ? moved : Array.from({ length: count }, (_, v) => v),
    inverse = space ? invertMatrix(space) : undefined,
    through = (values: Float32Array, v: number, normal: boolean): number[] => {
      const x = values[v * 3],
        y = values[v * 3 + 1],
        z = values[v * 3 + 2];
      if (!space) return [x, y, z];
      if (!normal || !inverse) return [0, 1, 2].map((r) => space[r] * x + space[4 + r] * y + space[8 + r] * z);
      return [0, 1, 2].map((r) => inverse[r * 4] * x + inverse[r * 4 + 1] * y + inverse[r * 4 + 2] * z);
    };
  return [
    `    def BlendShape "${name}" {`,
    `        uniform vector3f[] offsets = ${tuples(
      list.flatMap((v) => through(positions as Float32Array, v, false)),
      3,
    )}`,
    ...(normals
      ? [
          `        uniform vector3f[] normalOffsets = ${tuples(
            list.flatMap((v) => through(normals as Float32Array, v, true)),
            3,
          )}`,
        ]
      : []),
    ...(sparse ? [`        uniform int[] pointIndices = [${list.join(', ')}]`] : []),
    '    }',
  ];
}

/** A skin's joints in tree order, parents first, each with a unique path, and how the skin's indices map to that order. */
function skeleton(
  skin: SkinData,
  order: readonly Node[],
  byExport: Map<ExportNode, Node>,
  parents: Map<Node, Node | undefined>,
) {
  const wanted = new Map<Node, number>();
  skin.joints.forEach((joint, index) => {
    const node = byExport.get(joint);
    if (!node) throw new RangeError('A skin joint is not in the scene; add the joint nodes to the scene');
    // glTF 2.0 5.28.3: skin.joints holds unique items; a repeat would bind its first index to another joint.
    if (wanted.has(node)) throw new TypeError('Skin joints must be distinct scene nodes');
    wanted.set(node, index);
  });
  const joints: Joint[] = [],
    place = new Map<Node, number>(),
    names = new Set<string>(),
    remap = new Uint32Array(skin.joints.length);
  for (const node of order) {
    const index = wanted.get(node);
    if (index === undefined) continue;
    let above = parents.get(node);
    while (above && !place.has(above)) above = parents.get(above);
    const parent = above ? place.get(above)! : -1,
      prefix = parent < 0 ? '' : `${joints[parent].path}/`,
      base = primName(node.name, `Joint_${index}`);
    let path = `${prefix}${base}`;
    for (let n = 1; names.has(path); n++) path = `${prefix}${base}_${n}`;
    names.add(path);
    place.set(node, joints.length);
    remap[index] = joints.length;
    joints.push({ node, path, parent });
  }
  return { joints, remap };
}

/** A skin's inverse bind matrix for joint `index`. */
const inverseBind = ({ inverseBindMatrices }: SkinData, index: number): number[] =>
  Array.from({ length: 16 }, (_, k) => inverseBindMatrices[index * 16 + k]);

/**
 * The matrix from a skin's mesh space to the world in the rest pose, or undefined when they are one space. A glTF skin ignores
 * the mesh's node, so its vertices can sit in any space: RiggedFigure's lie along Z and robot-expressive's are millimetres.
 * USD's meshes hold points in the place they rest, and Apple's loader sizes a model from those points without its skeleton.
 */
function restSpace(skin: SkinData, byExport: Map<ExportNode, Node>, rest: Poses): Float64Array | undefined {
  rest.at(0);
  for (const [index, joint] of skin.joints.entries()) {
    const node = byExport.get(joint);
    if (!node) return undefined;
    const space = multiplyMatrices(rest.world(node), inverseBind(skin, index));
    if (!invertMatrix(space)) continue;
    return space.every((v, i) => Math.abs(v - (i % 5 ? 0 : 1)) <= 1e-6) ? undefined : space;
  }
  return undefined;
}

/** The shape of a skinned geometry with `space` applied, which the skeleton's bind transforms take back out. */
function shapeIn(space: Float64Array | undefined, { positions, normals, indices }: Geo): Shape {
  if (!space) return shapeOf(positions, normals, indices);
  const inverse = invertMatrix(space)!,
    points = new Float32Array(positions.length),
    turned = new Float32Array(normals.length);
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v],
      y = positions[v + 1],
      z = positions[v + 2],
      a = normals[v],
      b = normals[v + 1],
      c = normals[v + 2];
    // Normals go through the inverse transpose: column r of the transpose is row r of the inverse.
    const n = [0, 1, 2].map((r) => inverse[r * 4] * a + inverse[r * 4 + 1] * b + inverse[r * 4 + 2] * c),
      length = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let r = 0; r < 3; r++) {
      points[v + r] = space[r] * x + space[4 + r] * y + space[8 + r] * z + space[12 + r];
      turned[v + r] = n[r] / length;
    }
  }
  return shapeOf(points, turned, indices);
}

/** Grows `box` to hold a skinned geometry under `palette`, by glTF's own skinning sum. */
function growBoxSkinned(box: USDZBox, geometry: Geo, palette: readonly Float64Array[]): void {
  const { positions } = geometry,
    { size, joints, weights } = influences(geometry),
    m = new Float64Array(12);
  for (let v = 0; v < positions.length / 3; v++) {
    m.fill(0);
    for (let k = 0; k < size; k++) {
      const weight = weights[v * size + k];
      if (!weight) continue;
      const joint = palette[joints[v * size + k]];
      for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) m[c * 3 + r] += weight * joint[c * 4 + r];
    }
    const x = positions[v * 3],
      y = positions[v * 3 + 1],
      z = positions[v * 3 + 2];
    growBox(
      box,
      m[0] * x + m[3] * y + m[6] * z + m[9],
      m[1] * x + m[4] * y + m[7] * z + m[10],
      m[2] * x + m[5] * y + m[8] * z + m[11],
    );
  }
}

/** Each joint of `skin` from mesh space to the world at the frame `poses` is on. */
const paletteOf = (skin: SkinData, byExport: Map<ExportNode, Node>, poses: Poses): Float64Array[] =>
  skin.joints.map((joint, index) => multiplyMatrices(poses.world(byExport.get(joint)!), inverseBind(skin, index)));

/** True for a scale the same on every axis, to the tolerance {@link decompose} reads a matrix with. */
const even = ([x, y, z]: readonly number[]): boolean =>
  Math.abs(x - y) <= 1e-6 * Math.abs(x) && Math.abs(x - z) <= 1e-6 * Math.abs(x);

/** The joint's transform in its parent joint's space at this frame, as translation, rotation and scale. */
function jointPose(
  joint: Joint,
  joints: readonly Joint[],
  poses: Poses,
  parents: Map<Node, Node | undefined>,
): { t: number[]; r: number[]; s: number[] } {
  const { node, parent } = joint,
    above = parent < 0 ? undefined : joints[parent].node,
    sheared = (): RangeError =>
      new RangeError(
        `Joint ${joint.path} has a shear USD cannot hold; move the non-uniform scale below it or into the mesh`,
      ),
    parts = (matrix: Float64Array): { t: number[]; r: number[]; s: number[] } => {
      const split = decompose(matrix);
      if (!split) throw sheared();
      return split;
    };
  // Nodes that are not joints, between this joint and the last one or above a root joint: their motion joins this joint's.
  let between: Float64Array | undefined;
  for (let up = parents.get(node); up && up !== above; up = parents.get(up))
    between = between ? multiplyMatrices(poses.local(up), between) : poses.local(up);
  const own = node.matrix
    ? parts(node.local)
    : { t: [...poses.part(node, 't')], r: [...poses.part(node, 'r')], s: [...poses.part(node, 's')] };
  if (!between) return own;
  // The parts multiply when what lies above scales evenly, and that also holds a joint scaled to zero, as a clip that makes
  // a character appear does: the matrix of such a joint has no rotation left to read.
  const outer = decompose(between);
  if (!outer || !even(outer.s))
    return parts(multiplyMatrices(between, composeMatrix(own.t, own.r, own.s, new Float64Array(16))));
  const [x, y, z] = own.t;
  return {
    t: [0, 1, 2].map((r) => between[r] * x + between[4 + r] * y + between[8 + r] * z + between[12 + r]),
    r: multiplyQuaternions(outer.r, own.r),
    s: own.s.map((v, axis) => v * outer.s[axis]),
  };
}

/** The lines of a SkelRoot: the skeleton, its animation and the meshes `items` it moves. */
function skelRoot(
  index: number,
  { joints, remap }: { joints: Joint[]; remap: Uint32Array },
  skin: SkinData,
  frames: number,
  poses: Poses,
  rest: Poses,
  parents: Map<Node, Node | undefined>,
  meshes: readonly string[],
  space: Float64Array | undefined,
  extents: readonly string[],
  blends: { tokens: string[]; frames: string[] },
  signal: AbortSignal | undefined,
): string[] {
  const root = `/Margo/Skin_${index}`,
    tokens = `[${joints.map(({ path }) => JSON.stringify(path)).join(', ')}]`,
    binds: string[] = new Array(joints.length),
    rests: string[] = [];
  skin.joints.forEach((_, source) => {
    const bind = invertMatrix(inverseBind(skin, source));
    if (!bind) throw new RangeError('A skin inverse bind matrix has no inverse; give the joint a nonzero scale');
    binds[remap[source]] = matrix(space ? multiplyMatrices(space, bind) : bind);
  });
  const translations: string[] = [],
    rotations: string[] = [],
    scales: string[] = [],
    last = new Array<number[] | undefined>(joints.length);
  for (let frame = 0; frame < frames; frame++) {
    signal?.throwIfAborted();
    poses.at(frame);
    const t: number[] = [],
      r: number[] = [],
      s: number[] = [];
    joints.forEach((joint, at) => {
      const pose = jointPose(joint, joints, poses, parents),
        before = last[at];
      // q and -q are one rotation, but a blend between them takes the long way round.
      const q =
        before && before[0] * pose.r[0] + before[1] * pose.r[1] + before[2] * pose.r[2] + before[3] * pose.r[3] < 0
          ? pose.r.map((v) => -v)
          : pose.r;
      last[at] = q;
      t.push(...pose.t);
      r.push(q[3], q[0], q[1], q[2]);
      s.push(...pose.s);
    });
    translations.push(tuples(t, 3));
    rotations.push(tuples(r, 4));
    scales.push(tuples(s, 3));
  }
  for (const joint of joints) {
    const { t, r, s } = jointPose(joint, joints, rest, parents),
      length = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    rests.push(
      matrix(
        composeMatrix(
          t,
          r.map((v) => v / length),
          s,
          new Float64Array(16),
        ),
      ),
    );
  }
  return [
    `def SkelRoot "Skin_${index}" {`,
    // A mesh's own extent holds its rest pose, so what a skin reaches frame by frame is said here, where UsdSkel looks for it.
    ...attribute('float3[]', 'extent', extents),
    '    def Skeleton "Skeleton" (',
    '        prepend apiSchemas = ["SkelBindingAPI"]',
    '    ) {',
    `        uniform token[] joints = ${tokens}`,
    `        uniform matrix4d[] bindTransforms = [${binds.join(', ')}]`,
    `        uniform matrix4d[] restTransforms = [${rests.join(', ')}]`,
    `        rel skel:animationSource = <${root}/Motion>`,
    '    }',
    '    def SkelAnimation "Motion" {',
    `        uniform token[] joints = ${tokens}`,
    ...attribute('float3[]', 'translations', translations).map((line) => `    ${line}`),
    ...attribute('quatf[]', 'rotations', rotations).map((line) => `    ${line}`),
    ...attribute('half3[]', 'scales', scales).map((line) => `    ${line}`),
    ...(blends.tokens.length
      ? [
          `        uniform token[] blendShapes = [${blends.tokens.map((token) => JSON.stringify(token)).join(', ')}]`,
          ...attribute('float[]', 'blendShapeWeights', blends.frames).map((line) => `    ${line}`),
        ]
      : []),
    '    }',
    ...meshes,
    '}',
  ];
}

/** The transform lines of a node's Xform: one matrix when nothing moves it, else its parts with time samples. */
function xformOps(node: Node, tracks: Tracks | undefined, frames: number, poses: Poses): string[] {
  if (!tracks)
    return [
      `    matrix4d xformOp:transform = ${matrix(node.local)}`,
      '    uniform token[] xformOpOrder = ["xformOp:transform"]',
    ];
  const translate: string[] = [],
    orient: string[] = [],
    scale: string[] = [];
  let last: number[] | undefined;
  for (let frame = 0; frame < frames; frame++) {
    poses.at(frame);
    const r = [...poses.part(node, 'r')],
      q = last && last[0] * r[0] + last[1] * r[1] + last[2] * r[2] + last[3] * r[3] < 0 ? r.map((v) => -v) : r;
    last = q;
    translate.push(tuple([...poses.part(node, 't')]));
    orient.push(quaternion(q));
    scale.push(tuple([...poses.part(node, 's')]));
  }
  return [
    ...attribute('double3', 'xformOp:translate', translate),
    ...attribute('quatf', 'xformOp:orient', orient),
    ...attribute('float3', 'xformOp:scale', scale),
    '    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient", "xformOp:scale"]',
  ];
}

/** What a clip fills: the rest pose, every frame together, and each skin's box frame by frame as USD text. */
function reachOf(
  frames: number,
  poses: Poses,
  rest: Poses,
  placed: Map<Node, { geometry: Geo }[]>,
  skins: Map<SkinData, Node[]>,
  byExport: Map<ExportNode, Node>,
  signal: AbortSignal | undefined,
): { rest: USDZBox; clip: USDZBox; extents: Map<SkinData, string[]> } {
  const fill = (at: Poses, box: USDZBox, each?: (skin: SkinData, skinBox: USDZBox) => void): void => {
    for (const [node, list] of placed)
      for (const { geometry } of list) growBoxWith(box, geometry.positions, at.world(node));
    for (const [skin, users] of skins) {
      const palette = paletteOf(skin, byExport, at),
        skinBox = emptyBox();
      for (const node of users)
        for (const { geometry } of drawn(node)) if (skinned(node, geometry)) growBoxSkinned(skinBox, geometry, palette);
      growBox(box, ...skinBox.min);
      growBox(box, ...skinBox.max);
      each?.(skin, skinBox);
    }
  };
  const restBox = emptyBox(),
    clip = emptyBox(),
    extents = new Map([...skins.keys()].map((skin) => [skin, [] as string[]]));
  rest.at(0);
  fill(rest, restBox);
  for (let frame = 0; frame < frames; frame++) {
    signal?.throwIfAborted();
    poses.at(frame);
    fill(poses, clip, (skin, { min, max }) => extents.get(skin)!.push(tuples([...min, ...max], 3)));
  }
  return { rest: restBox, clip, extents };
}

/** The scene of a GLB, with Draco and meshopt decoded first for a file that requires them. */
async function readScene(bytes: Uint8Array, signal: AbortSignal | undefined): Promise<ReturnType<typeof sceneOfParts>> {
  const parts = splitGLB(bytes),
    required = (parts.json as { extensionsRequired?: string[] }).extensionsRequired;
  if (!required?.some((name) => /draco|meshopt/i.test(name))) return sceneOfParts(parts);
  const { plainGLBParts } = await import('./glb-plain.js');
  return sceneOfParts(await plainGLBParts(parts, signal));
}

/**
 * Writes one clip of a scene or a GLB as USDZ: skins as UsdSkel with a `SkelAnimation`, and animated nodes as `Xform` prims
 * with time samples, so the model plays in AR Quick Look. Materials and shared meshes are as {@link exportUSDZ} writes them.
 *
 * Quick Look shows a file at real size, and glTF numbers are metres: `size` in the result says what that is, and `height` and
 * `ground` set it. A skin's points are written where they rest in the world and its `SkelRoot` carries an `extent` for every
 * frame, so a tool that sizes a model without running its skeleton reads the right box.
 *
 * @example
 * ```ts
 * import { exportAnimatedUSDZ } from '@margoengine/exporters/usdz-anim';
 *
 * declare const glb: Uint8Array;
 * const { usdz, clip, frames, size, skipped } = await exportAnimatedUSDZ(glb, { clip: 'Walk', height: 0.45, ground: true });
 * ```
 *
 * A GLB that requires Draco or meshopt is decoded first with `@margoengine/decoders` (its clean-room `draco-native` and
 * `meshopt` entries, imported only for such a file), so install that package to write one.
 *
 * @throws TypeError for bytes that are not a GLB, a malformed compressed block, or a bad option; RangeError for a scene with no
 * meshes or animations, an unknown clip, a clip past 100,000 frames, a joint not in the scene or that USD's joint form cannot
 * hold; what {@link exportUSDZ} throws for a material; the signal's reason on an abort.
 */
export async function exportAnimatedUSDZ(
  source: ExportScene | Uint8Array,
  options: AnimatedUSDZOptions = {},
): Promise<AnimatedUSDZResult> {
  const { clip = 0, fps = 30, signal } = options;
  if (!(typeof fps === 'number' && fps > 0 && Number.isFinite(fps)))
    throw new RangeError(`USDZ fps is ${String(fps)}; pass a rate above 0, such as 30`);
  checkPlacement(options);
  const width = options.lineWidth ?? 0.01;
  if (typeof width !== 'number' || !(width > 0) || !Number.isFinite(width))
    throw new RangeError('lineWidth must be a positive finite number of scene units');
  signal?.throwIfAborted();
  const read = source instanceof Uint8Array ? await readScene(source, signal) : { scene: source, skipped: [] },
    { scene } = read,
    skipped: AnimatedUSDZSkip[] = read.skipped.map(({ kind, index }) => ({ kind, target: index })),
    animations = scene.animations ?? [];
  if (!animations.length)
    throw new RangeError('The scene has no animations; write it with exportUSDZ from @margoengine/exporters/usdz');
  const animation = typeof clip === 'string' ? animations.find(({ name }) => name === clip) : animations[clip];
  if (!animation)
    throw new RangeError(
      `The scene has no clip ${JSON.stringify(clip)}; pass an index below ${animations.length} or one of its names`,
    );
  const roots = collect(scene, options, undefined, 'refuse', ['points', 'lines']),
    { order, parents } = walked(roots),
    byExport = new Map(order.flatMap((node) => (node.source ? [[node.source, node] as const] : []))),
    tracks = new Map<Node, Tracks>(),
    weightTracks = new Map<Node, Track>();
  let duration = 0;
  for (const { node: target, path, times, values, interpolation = 'LINEAR' } of animation.channels) {
    const node = byExport.get(target);
    if (!node || (path === 'weights' && !morphed(node))) {
      skipped.push({ kind: node ? 'morph-weights' : 'not-exported', target: target.name });
      continue;
    }
    const data = Float32Array.from(times);
    // glTF 2.0 3.11: key times are finite and strictly increasing; at least one sets the clip's length.
    if (!data.length || data.some((t, i) => !Number.isFinite(t) || (i > 0 && !(t > data[i - 1]!))))
      throw new RangeError(
        `Animation channel of ${target.name ?? 'a node'} needs finite, strictly increasing key times`,
      );
    if (path === 'weights') {
      weightTracks.set(node, { times: data, values: Float32Array.from(values), interpolation });
      duration = Math.max(duration, data[data.length - 1]);
      continue;
    }
    if (!tracks.has(node)) tracks.set(node, {});
    tracks.get(node)![PATHS[path]] = { times: data, values: Float32Array.from(values), interpolation };
    duration = Math.max(duration, data[data.length - 1]);
  }
  const frames = Math.ceil(duration * fps - 1e-9) + 1;
  if (frames > MAX_FRAMES)
    throw new RangeError(`This clip needs ${frames} frames at ${fps} per second; lower fps or cut the clip`);
  const poses = new Poses(tracks, parents, (frame) => frame / fps),
    rest = new Poses(new Map(), parents, () => 0),
    ids = new Map(order.map((node, id) => [node, id]));

  const materials = new USDMaterials(options.texturePrefix, options.onWarning),
    fallback = normalizeMaterial({}),
    tail: string[] = [],
    plain = new Map<Geo, Shape>(),
    mirrored = new Map<Geo, Shape>();
  let meshes = 0;
  // Which nodes draw something that is not skinned, or hold one that does.
  const needed = new Set<Node>();
  for (const node of [...order].reverse())
    if (
      drawn(node).some(({ geometry }) => !skinned(node, geometry)) ||
      node.children.some((child) => needed.has(child))
    )
      needed.add(node);

  // Shapes know their users before any is written, so a shared one goes out as a class.
  poses.at(0);
  const shapeFor = (node: Node, geometry: Geo): { shape: Shape; flipped: boolean } => {
    const flipped = determinant3(poses.world(node)) < 0,
      known = flipped ? mirrored : plain;
    let shape = known.get(geometry);
    if (!shape) {
      shape = flipped ? reflected(geometry) : shapeOf(geometry.positions, geometry.normals, geometry.indices);
      known.set(geometry, shape);
    }
    return { shape, flipped };
  };
  const placed = new Map<
    Node,
    {
      geometry: Geo;
      material: Mat;
      shape: Shape;
      flipped: boolean;
      counts?: number[];
      listed?: boolean;
      morphs?: boolean;
    }[]
  >();
  for (const node of order) {
    const list = drawn(node)
      .filter(({ geometry }) => !skinned(node, geometry))
      .map(({ geometry, material = fallback }) => {
        if (geometry.topology) {
          // A Points or BasisCurves prim lists its vertices in drawing order; it has no winding to mirror.
          const runs = geometry.topology === 'lines' ? polylines(geometry.indices) : undefined,
            listed = listedVertices(geometry, runs ? runs.flat() : geometry.indices),
            shape = shapeOf(listed.positions, listed.normals, listed.indices);
          shape.users++;
          materials.note(shape, material);
          return {
            geometry: listed,
            material,
            shape,
            flipped: false,
            counts: runs?.map((run) => run.length),
            listed: true,
          };
        }
        if (morphOnly(node, geometry)) {
          // Its BlendShape prims are children of the mesh prim, so the mesh is its own, never a shared class.
          const flipped = determinant3(poses.world(node)) < 0,
            shape = flipped ? reflected(geometry) : shapeOf(geometry.positions, geometry.normals, geometry.indices);
          shape.users = 1;
          materials.note(shape, material);
          return { geometry, material, shape, flipped, morphs: true };
        }
        const { shape, flipped } = shapeFor(node, geometry);
        shape.users++;
        materials.note(shape, material);
        return { geometry, material, shape, flipped };
      });
    if (list.length) placed.set(node, list);
  }

  const tree = (node: Node, out: string[], parent: string): void => {
    if (!needed.has(node)) return;
    const own = tracks.get(node),
      path = `${parent}/Node_${ids.get(node)}`;
    signal?.throwIfAborted();
    out.push(`def Xform "Node_${ids.get(node)}" {`);
    if (node.name) out.push(`    string displayName = ${JSON.stringify(node.name)}`);
    out.push(...xformOps(node, own, frames, poses));
    const list = placed.get(node) ?? [],
      morphing = list.filter(({ morphs }) => morphs);
    if (morphing.length) {
      const name = `Morph_${ids.get(node)}`,
        root = `${path}/${name}`,
        lines: string[] = [],
        tokens: string[] = [];
      for (const { geometry, material, shape, flipped } of morphing) {
        const i = meshes++,
          bound = materials.bind(i, geometry, material),
          morphs = geometry.morphs!;
        meshPrim(lines, tail, i, node.name, geometry, shape, bound, {
          transform: [],
          schemas: '"MaterialBindingAPI", "SkelBindingAPI"',
          extra: [
            '    int[] primvars:skel:jointIndices = [0] (',
            '        elementSize = 1',
            '        interpolation = "constant"',
            '    )',
            '    float[] primvars:skel:jointWeights = [1] (',
            '        elementSize = 1',
            '        interpolation = "constant"',
            '    )',
            ...(flipped ? [`    matrix4d primvars:skel:geomBindTransform = ${matrix(MIRROR_X)}`] : []),
            `    rel skel:skeleton = <${root}/Skeleton>`,
          ],
        });
        const names = morphs.map((_, k) => `Blend_${i}_${k}`),
          closing = lines.pop();
        lines.push(
          // The reflected points take reflected offsets; geomBindTransform turns both back after the shapes apply.
          ...morphs.flatMap((morph, k) => blendShape(names[k], morph, flipped ? MIRROR_X : undefined)),
          `    uniform token[] skel:blendShapes = [${names.map((n) => JSON.stringify(n)).join(', ')}]`,
          `    rel skel:blendShapeTargets = [${names.map((n) => `<${root}/Mesh_${i}/${n}>`).join(', ')}]`,
          closing!,
        );
        tokens.push(...names);
      }
      const weights = morphing.map(({ geometry }) =>
        weightsOf(node, geometry.morphs!.length, weightTracks.get(node), fps),
      );
      out.push(
        ...morphRoot(
          root,
          name,
          lines,
          tokens,
          Array.from(
            { length: frames },
            (_, frame) =>
              `[${weights
                .flatMap((at) => at(frame))
                .map(num)
                .join(', ')}]`,
          ),
        ),
      );
    }
    for (const { geometry, material, shape, flipped, counts, listed, morphs } of list) {
      if (morphs) continue;
      const i = meshes++,
        bound = materials.bind(i, geometry, material);
      if (listed) {
        curvesPrim(out, tail, i, node.name, geometry, counts, primWidth(material, width, node.world), bound, []);
        continue;
      }
      meshPrim(out, tail, i, node.name, geometry, shape, bound, {
        transform: flipped
          ? ['    float3 xformOp:scale = (-1, 1, 1)', '    uniform token[] xformOpOrder = ["xformOp:scale"]']
          : [],
      });
    }
    for (const child of node.children) tree(child, out, path);
    out.push('}');
  };
  const body: string[] = [];
  for (const root of roots) tree(root, body, '/Margo');

  // One SkelRoot for each skin, holding the meshes it moves.
  const skins = new Map<SkinData, Node[]>();
  for (const node of order)
    if (node.skin && drawn(node).some(({ geometry }) => skinned(node, geometry))) {
      if (!skins.has(node.skin)) skins.set(node.skin, []);
      skins.get(node.skin)!.push(node);
    }
  for (const skin of skins.keys()) skeleton(skin, order, byExport, parents);
  const reach = reachOf(frames, poses, rest, placed, skins, byExport, signal);
  let skinIndex = 0;
  for (const [skin, users] of skins) {
    const shape = skeleton(skin, order, byExport, parents),
      space = restSpace(skin, byExport, rest),
      index = skinIndex++,
      lines: string[] = [];
    const blendTokens: string[] = [],
      blendWeights: ((frame: number) => number[])[] = [];
    for (const node of users)
      for (const { geometry, material = fallback } of drawn(node)) {
        if (!skinned(node, geometry)) continue;
        const i = meshes++,
          geometryShape = shapeIn(space, geometry);
        geometryShape.users = 1;
        materials.note(geometryShape, material);
        const bound = materials.bind(i, geometry, material),
          influence = influences(geometry),
          joints = Array.from(influence.joints, (joint) => shape.remap[joint]);
        meshPrim(lines, tail, i, node.name, geometry, geometryShape, bound, {
          transform: [],
          schemas: '"MaterialBindingAPI", "SkelBindingAPI"',
          extra: [
            `    int[] primvars:skel:jointIndices = [${joints.join(', ')}] ${jointPrimvar(influence.size)}`,
            `    float[] primvars:skel:jointWeights = [${Array.from(influence.weights, num).join(', ')}] ${jointPrimvar(influence.size)}`,
            `    rel skel:skeleton = </Margo/Skin_${index}/Skeleton>`,
          ],
        });
        const morphs = geometry.morphs;
        if (!morphs?.length) continue;
        // UsdSkel's blend shapes: BlendShape children of the mesh, named by the mesh's `skel:blendShapes` and driven by the
        // SkelAnimation's `blendShapeWeights`, one weight for each name in the animation's own order.
        const names = morphs.map((_, k) => `Blend_${i}_${k}`),
          closing = lines.pop();
        lines.push(
          ...morphs.flatMap((morph, k) => blendShape(names[k], morph, space)),
          `    uniform token[] skel:blendShapes = [${names.map((n) => JSON.stringify(n)).join(', ')}]`,
          `    rel skel:blendShapeTargets = [${names.map((n) => `</Margo/Skin_${index}/Mesh_${i}/${n}>`).join(', ')}]`,
          closing!,
        );
        blendTokens.push(...names);
        blendWeights.push(weightsOf(node, morphs.length, weightTracks.get(node), fps));
      }
    body.push(
      ...skelRoot(
        index,
        shape,
        skin,
        frames,
        poses,
        rest,
        parents,
        lines,
        space,
        reach.extents.get(skin)!,
        {
          tokens: blendTokens,
          frames: Array.from(
            { length: blendTokens.length ? frames : 0 },
            (_, frame) =>
              `[${blendWeights
                .flatMap((at) => at(frame))
                .map(num)
                .join(', ')}]`,
          ),
        },
        signal,
      ),
    );
  }
  if (!meshes) throw new RangeError('USDZ requires at least one mesh');

  const placement = placementOf(reach.rest, options);
  const lines = [
    '#usda 1.0',
    '(',
    '    defaultPrim = "Margo"',
    '    endTimeCode = ' + (frames - 1),
    '    metersPerUnit = 1',
    '    startTimeCode = 0',
    `    timeCodesPerSecond = ${num(fps)}`,
    '    upAxis = "Y"',
    ')',
    'def Xform "Margo" {',
    ...rootTransform(placement),
    ...body,
    ...tail,
    '}',
  ];
  return {
    usdz: storedZIP([['scene.usda', new TextEncoder().encode(lines.join('\n') + '\n')], ...materials.files]),
    ...(animation.name === undefined ? {} : { clip: animation.name }),
    frames,
    size: boxSize(placedBox(reach.rest, placement)),
    bounds: placedBox(reach.clip, placement),
    scale: placement.scale,
    skipped,
  };
}
