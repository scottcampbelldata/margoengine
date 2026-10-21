// Per-frame evaluation of .vox scene graphs: every shape instance with its held keys, visibility, names, layers and a
// placement matrix under an explicit, versioned box-centering convention.
import type { MutableVec3 } from '@margoengine/math';
import type { VoxNode, VoxScene } from '@margoengine/voxel/vox';

/**
 * Where a model's box lands on its transform's translation `t` (all in .vox's Z-up cells, after the composed rotation
 * R, a signed axis permutation). For each world axis, let `s` be the model's size along the source axis R maps onto it.
 *
 * - `'box-v1'`: the turned box spans `t - floor(s / 2)` to `t - floor(s / 2) + s` on every axis, whichever way R
 *   points; a flip mirrors the cells inside that span. This is `@margoengine/voxel/vox` `pasteVoxModel`'s placement
 *   and Margo Voxel Studio's saved placement.
 * - `'pivot-v1'`: the model turns about its own corner `floor(size / 2)`, which lands on `t`, so a flipped axis of odd
 *   size spans one cell lower than under `'box-v1'`. This is `@margoengine/voxel-pathtracer` `magicaVoxelMatrix`.
 *
 * Both agree whenever every flipped axis has an even size. A new convention gets a new name; these never change.
 */
export type VoxCentering = 'box-v1' | 'pivot-v1';

/** Options of {@link resolveVoxScene}. */
export interface VoxResolveOptions {
  /** The frame whose keys are in force, a whole number from 0. Default 0. */
  frame?: number;
  /** The box-centering convention of {@link VoxInstance.matrix}; required, so saved placements never move silently. */
  centering: VoxCentering;
}

/** One shape node placed at a frame ({@link resolveVoxScene}). */
export interface VoxInstance {
  /** Id of the shape node. */
  shapeId: number;
  /** Index into `scene.models` of the model the shape shows at the frame. */
  model: number;
  /** The shape's own name, else the nearest named node above it; undefined when none is named. */
  name?: string;
  /** False when the shape, a node above it or the layer of a transform above it is hidden. */
  visible: boolean;
  /** Ids of the transforms above the shape, root first. */
  transformIds: number[];
  /** Layer ids of those transforms, root first, each once; -1 (no layer) left out. */
  layerIds: number[];
  /** The composed rotation in .vox's Z-up axes: row-major 3 x 3 signed axis permutation. */
  rotation: number[];
  /** The composed translation in .vox's Z-up cells. */
  translation: MutableVec3;
  /**
   * Column-major 4 x 4 placement under {@link VoxResolveOptions.centering}: corner coordinates of the model's
   * `gridFromVox` grid (cells, Y up) to world cells, Y up (.vox z becomes y and .vox y becomes -z). For a mesh whose
   * vertices are grid corners minus a pivot, multiply by a translation by that pivot on the right.
   */
  matrix: number[];
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function keyFrame(key: { frame?: number }): number {
  const frame = key.frame ?? 0;
  if (!Number.isSafeInteger(frame) || frame < 0)
    throw new RangeError('A .vox key frame is not a whole number from 0; fix the key');
  return frame;
}

/** The key in force at `frame`: the latest at or before it, else the earliest; among equal frames the first listed. */
function held<T extends { frame?: number }>(keys: readonly T[], frame: number): T {
  let first = keys[0],
    selected: T | undefined;
  for (const key of keys) {
    const time = keyFrame(key);
    if (time < keyFrame(first)) first = key;
    if (time <= frame && (!selected || time > keyFrame(selected))) selected = key;
  }
  return selected ?? first;
}

function checkRotation(value: readonly number[] = IDENTITY): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 9 ||
    value.some((v) => v !== 0 && v !== 1 && v !== -1) ||
    [0, 1, 2].some(
      (i) =>
        Math.abs(value[i * 3]) + Math.abs(value[i * 3 + 1]) + Math.abs(value[i * 3 + 2]) !== 1 ||
        Math.abs(value[i]) + Math.abs(value[3 + i]) + Math.abs(value[6 + i]) !== 1,
    )
  )
    throw new RangeError('A .vox rotation is not a row-major signed axis permutation; fix the key');
  return value;
}

const childrenOf = (node: VoxNode): number[] =>
  node.type === 'transform' ? [node.child] : node.type === 'group' ? node.children : [];

/** Checks links, keys and models of the whole graph; returns the nodes by id and the roots in file order. */
function graphOf(scene: VoxScene): { nodes: Map<number, VoxNode>; roots: VoxNode[] } {
  if (typeof scene !== 'object' || scene === null || !Array.isArray(scene.nodes) || !Array.isArray(scene.models))
    throw new TypeError('A .vox scene is missing nodes or models; pass parseVox output');
  const nodes = new Map(scene.nodes.map((node) => [node.id, node])),
    parents = new Set<number>();
  if (nodes.size !== scene.nodes.length)
    throw new RangeError('The .vox scene repeats a node id; give each node its own');
  for (const node of scene.nodes) {
    for (const child of childrenOf(node)) {
      if (!nodes.has(child)) throw new RangeError(`.vox node ${node.id} links missing node ${child}; fix the link`);
      if (parents.has(child)) throw new RangeError(`.vox node ${child} has two parents; share models instead`);
      parents.add(child);
    }
    if (node.type === 'transform') {
      if (!Array.isArray(node.frames) || !node.frames.length)
        throw new RangeError(`.vox transform ${node.id} has no keys; give it one`);
      for (const key of node.frames) {
        keyFrame(key);
        checkRotation(key.rotation);
        const t = key.translation;
        if (t && (!Array.isArray(t) || t.length !== 3 || t.some((v) => !Number.isSafeInteger(v))))
          throw new RangeError(`.vox transform ${node.id} has a translation that is not three whole numbers`);
      }
    } else if (node.type === 'shape') {
      if (!Array.isArray(node.models) || !node.models.length)
        throw new RangeError(`.vox shape ${node.id} has no model keys; give it one`);
      for (const key of node.models) {
        keyFrame(key);
        if (!Number.isInteger(key.model) || key.model < 0 || key.model >= scene.models.length)
          throw new RangeError(`.vox shape ${node.id} uses missing model ${key.model}; point it at an existing model`);
      }
    }
  }
  const roots = scene.nodes.filter((node) => !parents.has(node.id)),
    visited = new Set<number>(),
    pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    visited.add(node.id);
    for (const child of childrenOf(node)) pending.push(nodes.get(child)!);
  }
  if (visited.size !== nodes.size) throw new RangeError('The .vox node links form a cycle; fix the links');
  return { nodes, roots };
}

/** The placement matrix of a model of `size` under rotation `r` and translation `t`. */
function placement(size: readonly number[], r: readonly number[], t: readonly number[], centering: VoxCentering) {
  if (!Array.isArray(size) || size.length !== 3 || size.some((v) => !Number.isInteger(v) || v < 1 || v > 256))
    throw new RangeError('A .vox model size is not 1 to 256 cells per axis; fix the model');
  // grid corner g -> .vox corner L g + (0, sy, 0) -> world R (...) + t + offset -> Y up C (...), C(x, y, z) = (x, z, -y).
  const L = [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    C = L.map((_, i) => [0, 1, 2].map((j) => L[j][i])),
    RL = [0, 1, 2].map((i) =>
      [0, 1, 2].map((j) => r[i * 3] * L[0][j] + r[i * 3 + 1] * L[1][j] + r[i * 3 + 2] * L[2][j]),
    ),
    world = [0, 1, 2].map((row) => {
      const axis = [0, 1, 2].find((a) => r[row * 3 + a] !== 0)!,
        sign = r[row * 3 + axis],
        half = Math.floor(size[axis] / 2),
        offset = centering === 'box-v1' ? -half + (sign < 0 ? size[axis] : 0) : -sign * half;
      return r[row * 3 + 1] * size[1] + t[row] + offset;
    }),
    matrix = new Array<number>(16).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++)
      matrix[column * 4 + row] = C[row][0] * RL[0][column] + C[row][1] * RL[1][column] + C[row][2] * RL[2][column];
    matrix[12 + row] = C[row][0] * world[0] + C[row][1] * world[1] + C[row][2] * world[2];
  }
  matrix[15] = 1;
  return matrix.map((v) => v || 0);
}

/**
 * Every shape instance of a .vox scene at one frame, in depth-first order (roots in file order, group children in
 * order): the model shown, its composed rotation and translation, visibility, name, transforms and layers, and its
 * placement matrix under the chosen centering. Each transform and shape uses the key in force at the frame (the
 * latest at or before it, else its earliest; among keys of the same frame the first listed). The scene is read,
 * never changed; a scene without nodes (version 150) has no instances. Untrusted input is fine: links, keys and model
 * sizes are checked first.
 * @throws TypeError when the scene is not parseVox-shaped or the centering is unknown.
 * @throws RangeError for a bad frame, a missing or shared node, a cycle, an empty or malformed key, or a model size
 * outside 1 to 256.
 */
export function resolveVoxScene(scene: VoxScene, options: VoxResolveOptions): VoxInstance[] {
  if (typeof options !== 'object' || options === null)
    throw new TypeError("resolveVoxScene options are missing; pass {centering: 'box-v1' | 'pivot-v1', frame?}");
  const frame = options.frame ?? 0,
    centering = options.centering;
  if (centering !== 'box-v1' && centering !== 'pivot-v1')
    throw new TypeError("resolveVoxScene centering is unknown; pass 'box-v1' or 'pivot-v1'");
  if (!Number.isSafeInteger(frame) || frame < 0)
    throw new RangeError('resolveVoxScene frame is not a whole number from 0; pass one');
  const { nodes, roots } = graphOf(scene),
    layers = new Map((scene.layers ?? []).map((layer) => [layer.id, layer])),
    result: VoxInstance[] = [];
  type State = {
    node: VoxNode;
    rotation: readonly number[];
    translation: readonly number[];
    visible: boolean;
    name?: string;
    transforms: number[];
    layers: number[];
  };
  const pending: State[] = roots
    .map((node) => ({ node, rotation: IDENTITY, translation: [0, 0, 0], visible: true, transforms: [], layers: [] }))
    .reverse();
  while (pending.length) {
    const state = pending.pop()!,
      node = state.node,
      next = { ...state, visible: state.visible && !node.hidden, name: node.name ?? state.name };
    if (node.type === 'transform') {
      const key = held(node.frames, frame),
        r = checkRotation(key.rotation),
        t = key.translation ?? [0, 0, 0],
        p = state.rotation;
      next.rotation = [0, 1, 2].flatMap((i) =>
        [0, 1, 2].map((j) => p[i * 3] * r[j] + p[i * 3 + 1] * r[3 + j] + p[i * 3 + 2] * r[6 + j]),
      );
      next.translation = [0, 1, 2].map(
        (i) => p[i * 3] * t[0] + p[i * 3 + 1] * t[1] + p[i * 3 + 2] * t[2] + state.translation[i],
      );
      next.transforms = [...state.transforms, node.id];
      if (node.layer >= 0 && !state.layers.includes(node.layer)) next.layers = [...state.layers, node.layer];
      next.visible &&= !layers.get(node.layer)?.hidden;
      pending.push({ ...next, node: nodes.get(node.child)! });
    } else if (node.type === 'group') {
      for (let i = node.children.length - 1; i >= 0; i--) pending.push({ ...next, node: nodes.get(node.children[i])! });
    } else {
      const model = held(node.models, frame).model;
      result.push({
        shapeId: node.id,
        model,
        ...(next.name === undefined ? {} : { name: next.name }),
        visible: next.visible,
        transformIds: next.transforms,
        layerIds: next.layers,
        rotation: next.rotation.map((v) => v || 0),
        translation: next.translation.map((v) => v || 0) as MutableVec3,
        matrix: placement(scene.models[model].size, next.rotation, next.translation, centering),
      });
    }
  }
  return result;
}

/** The first and last key frame of any transform or shape in the scene, or undefined when it has no keys. */
export function voxFrameRange(scene: VoxScene): { startFrame: number; endFrame: number } | undefined {
  if (typeof scene !== 'object' || scene === null || !Array.isArray(scene.nodes))
    throw new TypeError('A .vox scene is missing nodes; pass parseVox output');
  let startFrame = Infinity,
    endFrame = -Infinity;
  for (const node of scene.nodes)
    for (const key of node.type === 'transform' ? node.frames : node.type === 'shape' ? node.models : []) {
      const frame = keyFrame(key);
      startFrame = Math.min(startFrame, frame);
      endFrame = Math.max(endFrame, frame);
    }
  return Number.isFinite(startFrame) ? { startFrame, endFrame } : undefined;
}
