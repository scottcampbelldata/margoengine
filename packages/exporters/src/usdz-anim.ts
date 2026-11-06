// USDZ with motion: a clip's node transforms as time samples and its skins as UsdSkel, so a character plays in AR Quick Look.
// USD has one timeline, so one clip goes in a file. Tracks are sampled at a fixed rate, which is how USD stores them anyway:
// it holds values at time codes and blends between them.
import { sampleTrackInto, type Interpolation } from '@margoengine/animation/sampling';
import { composeMatrix, invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { sceneOfGLB } from './glb-scene.js';
import {
  collect,
  decompose,
  determinant3,
  normalizeMaterial,
  num,
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
  emptyBox,
  growBox,
  growBoxWith,
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
   * `'morph-weights'`: a channel of morph target weights, which this entry does not write. `'not-exported'`: a channel of a
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
const JOINT_PRIMVAR = '(\n        elementSize = 4\n        interpolation = "vertex"\n    )';

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
const drawn = (node: Node): { geometry: Geo; material?: Mat }[] =>
  node.primitives ?? (node.geometry ? [{ geometry: node.geometry, material: node.material }] : []);

/** True for a primitive its skin moves: the skin needs the joints on the vertices. */
const skinned = (node: Node, geometry: Geo): boolean => !!node.skin && !!geometry.joints && !!geometry.weights;

/** The skin's joints in tree order, parents first, each with a unique path, and how the skin's indices map to that order. */
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
    joints = geometry.joints!,
    weights = geometry.weights!,
    m = new Float64Array(12);
  for (let v = 0; v < positions.length / 3; v++) {
    m.fill(0);
    for (let k = 0; k < 4; k++) {
      const weight = weights[v * 4 + k];
      if (!weight) continue;
      const joint = palette[joints[v * 4 + k]];
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
 * @throws TypeError for bytes that are not a GLB or that need decompressing, or a bad option; RangeError for a scene with no
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
  signal?.throwIfAborted();
  const read = source instanceof Uint8Array ? sceneOfGLB(source) : { scene: source, skipped: [] },
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
  const roots = collect(scene, options),
    { order, parents } = walked(roots),
    byExport = new Map(order.flatMap((node) => (node.source ? [[node.source, node] as const] : []))),
    tracks = new Map<Node, Tracks>();
  let duration = 0;
  for (const { node: target, path, times, values, interpolation = 'LINEAR' } of animation.channels) {
    const node = byExport.get(target);
    if (path === 'weights' || !node) {
      skipped.push({ kind: node ? 'morph-weights' : 'not-exported', target: target.name });
      continue;
    }
    const data = Float32Array.from(times);
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

  const materials = new USDMaterials(options.texturePrefix),
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
  const placed = new Map<Node, { geometry: Geo; material: Mat; shape: Shape; flipped: boolean }[]>();
  for (const node of order) {
    const list = drawn(node)
      .filter(({ geometry }) => !skinned(node, geometry))
      .map(({ geometry, material = fallback }) => {
        const { shape, flipped } = shapeFor(node, geometry);
        shape.users++;
        materials.note(shape, material);
        return { geometry, material, shape, flipped };
      });
    if (list.length) placed.set(node, list);
  }

  const tree = (node: Node, out: string[]): void => {
    if (!needed.has(node)) return;
    const own = tracks.get(node);
    signal?.throwIfAborted();
    out.push(`def Xform "Node_${ids.get(node)}" {`);
    if (node.name) out.push(`    string displayName = ${JSON.stringify(node.name)}`);
    out.push(...xformOps(node, own, frames, poses));
    for (const { geometry, material, shape, flipped } of placed.get(node) ?? []) {
      const i = meshes++,
        bound = materials.bind(i, geometry, material);
      meshPrim(out, tail, i, node.name, geometry, shape, bound, {
        transform: flipped
          ? ['    float3 xformOp:scale = (-1, 1, 1)', '    uniform token[] xformOpOrder = ["xformOp:scale"]']
          : [],
      });
    }
    for (const child of node.children) tree(child, out);
    out.push('}');
  };
  const body: string[] = [];
  for (const root of roots) tree(root, body);

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
    for (const node of users)
      for (const { geometry, material = fallback } of drawn(node)) {
        if (!skinned(node, geometry)) continue;
        const i = meshes++,
          geometryShape = shapeIn(space, geometry);
        geometryShape.users = 1;
        materials.note(geometryShape, material);
        const bound = materials.bind(i, geometry, material),
          joints = Array.from(geometry.joints!, (joint) => shape.remap[joint]);
        meshPrim(lines, tail, i, node.name, geometry, geometryShape, bound, {
          transform: [],
          schemas: '"MaterialBindingAPI", "SkelBindingAPI"',
          extra: [
            `    int[] primvars:skel:jointIndices = [${joints.join(', ')}] ${JOINT_PRIMVAR}`,
            `    float[] primvars:skel:jointWeights = [${Array.from(geometry.weights!, num).join(', ')}] ${JOINT_PRIMVAR}`,
            `    rel skel:skeleton = </Margo/Skin_${index}/Skeleton>`,
          ],
        });
      }
    body.push(
      ...skelRoot(index, shape, skin, frames, poses, rest, parents, lines, space, reach.extents.get(skin)!, signal),
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
