// Editing .vox scene graphs (@margoengine/voxel/vox VoxScene): layers, names, keys, groups, instances, moves, deletes.
// Every function returns a new scene that shares everything it did not change, models and unknown chunks included;
// unknown dictionary keys are kept. A call that changes nothing returns the scene it was given.
import { Matrix4, MargoError, type Vec3 } from '@margoengine/math';
import type { VoxNode, VoxScene } from '@margoengine/voxel/vox';

/** Name and visibility of a layer or node. */
export interface VoxNodePatch {
  /** 1 to 200 characters (trimmed). */
  name?: string;
  hidden?: boolean;
}

/** One transform key, in .vox's Z-up local cells. */
export interface VoxTransformPatch {
  /** Whole-cell translation, each within int32. */
  translation?: Vec3;
  /** Row-major 3 x 3 signed axis permutation (each row and column one +1 or -1). */
  rotation?: readonly number[];
}

type Transform = Extract<VoxNode, { type: 'transform' }>;
type Group = Extract<VoxNode, { type: 'group' }>;
interface Graph {
  nodes: Map<number, VoxNode>;
  parents: Map<number, number>;
}

const INT32_MIN = -2_147_483_648,
  INT32_MAX = 2_147_483_647,
  MAX_NODES = 16_384,
  MAX_KEYS = 16_384,
  MAX_TRACK = 4_096,
  MAX_LAYERS = 4_096,
  MAX_DEPTH = 1_024,
  IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const frameOf = (key: { frame?: number }) => key.frame ?? 0;
const byFrame = (a: { frame?: number }, b: { frame?: number }) => frameOf(a) - frameOf(b);

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200)
    throw new RangeError('A .vox name must have 1 to 200 characters; pass a shorter or nonempty name');
  return name.trim();
}

function checkId(id: unknown, subject: string): asserts id is number {
  if (!Number.isInteger(id) || (id as number) < 0 || (id as number) > INT32_MAX)
    throw new RangeError(`${subject} is not a .vox id; pass an integer from 0 to ${INT32_MAX}`);
}

function checkPatch(patch: VoxNodePatch): VoxNodePatch {
  if (typeof patch !== 'object' || patch === null || Object.keys(patch).some((k) => k !== 'name' && k !== 'hidden'))
    throw new TypeError('A .vox node patch holds only name and hidden; pass {name?, hidden?}');
  if (patch.hidden !== undefined && typeof patch.hidden !== 'boolean')
    throw new TypeError('A .vox node patch hidden is not a boolean; pass true or false');
  return {
    ...(patch.name === undefined ? {} : { name: checkName(patch.name) }),
    ...(patch.hidden === undefined ? {} : { hidden: patch.hidden }),
  };
}

function differs(current: VoxNodePatch, patch: VoxNodePatch): boolean {
  return (
    (patch.name !== undefined && patch.name !== current.name) ||
    (patch.hidden !== undefined && patch.hidden !== (current.hidden ?? false))
  );
}

/** Applies a patch to the typed fields and to the `_name` / `_hidden` dictionary entries, keeping the rest. */
function patched<T extends VoxNodePatch & { attributes?: Map<string, string> }>(item: T, patch: VoxNodePatch): T {
  const attributes = new Map(item.attributes);
  if (patch.name !== undefined) attributes.set('_name', patch.name);
  if (patch.hidden !== undefined) attributes.set('_hidden', patch.hidden ? '1' : '0');
  return { ...item, ...patch, attributes };
}

/** Checks ids, links, key tracks and limits of the whole graph; returns the node and parent maps. */
function graphOf(scene: VoxScene): Graph {
  if (typeof scene !== 'object' || scene === null || !Array.isArray(scene.nodes) || !Array.isArray(scene.models))
    throw new TypeError('A .vox scene is missing nodes or models; pass parseVox output');
  if (scene.nodes.length > MAX_NODES)
    throw new RangeError(`The .vox scene has over ${MAX_NODES} nodes; edit a smaller scene`);
  const nodes = new Map<number, VoxNode>(),
    parents = new Map<number, number>();
  let keys = 0;
  for (const node of scene.nodes) {
    checkId(node.id, 'A .vox node id');
    if (nodes.has(node.id))
      throw new TypeError(`The .vox scene has node id ${node.id} twice; give each node its own id`);
    nodes.set(node.id, node);
    const track = node.type === 'transform' ? node.frames : node.type === 'shape' ? node.models : undefined;
    if (!track) continue;
    if (!Array.isArray(track) || !track.length || track.length > MAX_TRACK)
      throw new RangeError(`.vox node ${node.id} needs 1 to ${MAX_TRACK} keys; fix its track`);
    keys += track.length;
    const frames = new Set<number>();
    for (const key of track) {
      checkId(frameOf(key), `A key frame of .vox node ${node.id}`);
      if (frames.has(frameOf(key)))
        throw new TypeError(`.vox node ${node.id} has duplicate (ambiguous) keys at frame ${frameOf(key)}; keep one`);
      frames.add(frameOf(key));
    }
    if (node.type === 'shape')
      for (const key of node.models)
        if (!Number.isInteger(key.model) || key.model < 0 || key.model >= scene.models.length)
          throw new RangeError(`.vox shape ${node.id} uses missing model ${key.model}; point it at an existing model`);
  }
  if (keys > MAX_KEYS) throw new RangeError(`The .vox scene has over ${MAX_KEYS} keys; remove some`);
  for (const node of scene.nodes) {
    const children = node.type === 'transform' ? [node.child] : node.type === 'group' ? node.children : [];
    for (const id of children) {
      const child = nodes.get(id);
      if (!child) throw new TypeError(`.vox node ${node.id} links missing node ${id}; fix the link`);
      if ((node.type === 'group') !== (child.type === 'transform'))
        throw new TypeError('.vox groups hold transforms and transforms hold groups or shapes; fix the links');
      if (parents.has(id)) throw new TypeError(`.vox node ${id} has two parents; share models instead of nodes`);
      parents.set(id, node.id);
    }
  }
  for (const node of scene.nodes) {
    const path = new Set<number>();
    for (let id: number | undefined = node.id; id !== undefined; id = parents.get(id)) {
      if (path.has(id)) throw new TypeError('The .vox node links form a cycle; fix the links');
      if (path.size >= MAX_DEPTH)
        throw new RangeError(`The .vox hierarchy is over ${MAX_DEPTH} levels deep; flatten it`);
      path.add(id);
    }
  }
  return { nodes, parents };
}

function nodeOf<T extends VoxNode['type']>(graph: Graph, id: number, type: T): Extract<VoxNode, { type: T }> {
  checkId(id, `A .vox ${type} id`);
  const node = graph.nodes.get(id);
  if (!node || node.type !== type) throw new RangeError(`.vox node ${id} is not a ${type}; pass the id of one`);
  return node as Extract<VoxNode, { type: T }>;
}

function withNode(scene: VoxScene, node: VoxNode): VoxScene {
  return { ...scene, nodes: scene.nodes.map((n) => (n.id === node.id ? node : n)) };
}

function keyCount(scene: VoxScene): number {
  return scene.nodes.reduce(
    (sum, n) => sum + (n.type === 'transform' ? n.frames.length : n.type === 'shape' ? n.models.length : 0),
    0,
  );
}

function checkRoom(scene: VoxScene, added: number): void {
  if (keyCount(scene) + added > MAX_KEYS)
    throw new RangeError(`The .vox scene would pass ${MAX_KEYS} keys; remove some first`);
}

/** The key in force at `frame`: the last at or before it, else the first. */
function heldKey<T extends { frame?: number }>(keys: readonly T[], frame: number): T {
  const sorted = [...keys].sort(byFrame);
  let held = sorted[0];
  for (const key of sorted) if (frameOf(key) <= frame) held = key;
  return held;
}

function newIds(scene: VoxScene, count: number): number[] {
  const first = scene.nodes.reduce((max, n) => Math.max(max, n.id + 1), 0);
  if (scene.nodes.length + count > MAX_NODES || first + count - 1 > INT32_MAX)
    throw new RangeError(`The .vox scene has no room for ${count} more nodes (ids are int32); remove some first`);
  return Array.from({ length: count }, (_, i) => first + i);
}

/** Adds a visible layer named `name` with the next free id. */
export function addVoxLayer(scene: VoxScene, name: string): VoxScene {
  graphOf(scene);
  const checked = checkName(name);
  if (scene.layers.length >= MAX_LAYERS)
    throw new RangeError(`The .vox scene has ${MAX_LAYERS} layers; remove one first`);
  const id = scene.layers.reduce((next, layer) => Math.max(next, layer.id + 1), 0);
  checkId(id, 'The new .vox layer id');
  return {
    ...scene,
    layers: [
      ...scene.layers,
      {
        id,
        name: checked,
        hidden: false,
        attributes: new Map([
          ['_name', checked],
          ['_hidden', '0'],
        ]),
      },
    ],
  };
}

/** Renames or shows / hides a layer. */
export function updateVoxLayer(scene: VoxScene, id: number, patch: VoxNodePatch): VoxScene {
  graphOf(scene);
  checkId(id, 'A .vox layer id');
  const change = checkPatch(patch),
    layer = scene.layers.find((l) => l.id === id);
  if (!layer) throw new RangeError(`.vox layer ${id} does not exist; pass an existing layer id`);
  if (!differs(layer, change)) return scene;
  return { ...scene, layers: scene.layers.map((l) => (l.id === id ? patched(layer, change) : l)) };
}

/** Renames or shows / hides one node (and so its subtree); models stay shared. */
export function updateVoxNode(scene: VoxScene, id: number, patch: VoxNodePatch): VoxScene {
  const graph = graphOf(scene);
  checkId(id, 'A .vox node id');
  const change = checkPatch(patch),
    node = graph.nodes.get(id);
  if (!node) throw new RangeError(`.vox node ${id} does not exist; pass an existing node id`);
  return differs(node, change) ? withNode(scene, patched(node, change)) : scene;
}

/** Puts a transform node on layer `layerId`, or on none with -1. */
export function setVoxNodeLayer(scene: VoxScene, transformId: number, layerId: number): VoxScene {
  const node = nodeOf(graphOf(scene), transformId, 'transform');
  if (layerId !== -1) {
    checkId(layerId, 'A .vox layer id');
    if (!scene.layers.some((l) => l.id === layerId))
      throw new RangeError(`.vox layer ${layerId} does not exist; pass an existing layer id or -1`);
  }
  return node.layer === layerId ? scene : withNode(scene, { ...node, layer: layerId });
}

/** Sets or adds the transform key at `frame`; fields left out keep the key in force at that frame. */
export function setVoxTransformKey(
  scene: VoxScene,
  transformId: number,
  frame: number,
  patch: VoxTransformPatch,
): VoxScene {
  const node = nodeOf(graphOf(scene), transformId, 'transform');
  checkId(frame, 'A .vox key frame');
  if (
    typeof patch !== 'object' ||
    patch === null ||
    Object.keys(patch).some((k) => k !== 'translation' && k !== 'rotation') ||
    (patch.translation === undefined && patch.rotation === undefined)
  )
    throw new TypeError('A .vox transform key needs translation or rotation; pass {translation?, rotation?}');
  const t = patch.translation;
  if (
    t !== undefined &&
    (!Array.isArray(t) ||
      t.length !== 3 ||
      !Array.from(t).every((v) => Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX))
  )
    throw new RangeError('A .vox translation must be three int32 integers; round it to whole cells');
  const r = patch.rotation;
  if (r !== undefined && !isPermutation(r))
    throw new RangeError('A .vox rotation must be a row-major signed axis permutation; pass quarter turns only');
  const existing = node.frames.find((k) => frameOf(k) === frame);
  if (!existing) {
    if (node.frames.length >= MAX_TRACK)
      throw new RangeError(`.vox node ${transformId} has ${MAX_TRACK} keys; remove one first`);
    checkRoom(scene, 1);
  }
  const base = existing ?? heldKey(node.frames, frame),
    translation = [...(t ?? base.translation ?? [0, 0, 0])] as unknown as Vec3,
    rotation = [...(r ?? base.rotation ?? IDENTITY)];
  if (
    existing &&
    translation.every((v, i) => v === (existing.translation?.[i] ?? 0)) &&
    rotation.every((v, i) => v === (existing.rotation ?? IDENTITY)[i])
  )
    return scene;
  const key = { ...base, frame, translation, rotation, attributes: new Map(base.attributes) };
  return withNode(scene, { ...node, frames: [...node.frames.filter((k) => frameOf(k) !== frame), key].sort(byFrame) });
}

/** Deletes the transform key at `frame` (nothing when there is none); the last key cannot go. */
export function deleteVoxTransformKey(scene: VoxScene, transformId: number, frame: number): VoxScene {
  const node = nodeOf(graphOf(scene), transformId, 'transform');
  checkId(frame, 'A .vox key frame');
  if (!node.frames.some((k) => frameOf(k) === frame)) return scene;
  if (node.frames.length === 1)
    throw new MargoError(
      'state',
      `.vox node ${transformId} keeps at least one pose; set that key instead of deleting it`,
    );
  return withNode(scene, { ...node, frames: node.frames.filter((k) => frameOf(k) !== frame) });
}

/** Sets or adds the shape key at `frame` to show model `model` (an index into `scene.models`). */
export function setVoxShapeKey(scene: VoxScene, shapeId: number, frame: number, model: number): VoxScene {
  const node = nodeOf(graphOf(scene), shapeId, 'shape');
  checkId(frame, 'A .vox key frame');
  if (!Number.isInteger(model) || model < 0 || model >= scene.models.length)
    throw new RangeError(`.vox model ${model} does not exist; pass 0 to ${scene.models.length - 1}`);
  const existing = node.models.find((k) => frameOf(k) === frame);
  if (existing?.model === model) return scene;
  if (!existing) {
    if (node.models.length >= MAX_TRACK)
      throw new RangeError(`.vox shape ${shapeId} has ${MAX_TRACK} keys; remove one first`);
    checkRoom(scene, 1);
  }
  const base = existing ?? heldKey(node.models, frame),
    key = { ...base, frame, model, attributes: new Map(base.attributes) };
  return withNode(scene, { ...node, models: [...node.models.filter((k) => frameOf(k) !== frame), key].sort(byFrame) });
}

/** Deletes the shape key at `frame` (nothing when there is none); the model itself stays. The last key cannot go. */
export function deleteVoxShapeKey(scene: VoxScene, shapeId: number, frame: number): VoxScene {
  const node = nodeOf(graphOf(scene), shapeId, 'shape');
  checkId(frame, 'A .vox key frame');
  if (!node.models.some((k) => frameOf(k) === frame)) return scene;
  if (node.models.length === 1)
    throw new MargoError('state', `.vox shape ${shapeId} keeps at least one key; point it at another model instead`);
  return withNode(scene, { ...node, models: node.models.filter((k) => frameOf(k) !== frame) });
}

function identityTransform(id: number, child: number, name: string): Transform {
  return {
    id,
    type: 'transform',
    name,
    hidden: false,
    layer: -1,
    child,
    frames: [{ frame: 0, translation: [0, 0, 0], rotation: [...IDENTITY] }],
    attributes: new Map([['_name', name]]),
  };
}

function appendChild(scene: VoxScene, parent: Group, child: number, added: VoxNode[]): VoxScene {
  const next = {
    ...scene,
    nodes: [
      ...scene.nodes.map((n) => (n.id === parent.id ? { ...parent, children: [...parent.children, child] } : n)),
      ...added,
    ],
  };
  graphOf(next);
  return next;
}

/** Adds an empty group (under a new identity transform) to group `parentId`; returns the scene and both new ids. */
export function addVoxGroup(
  scene: VoxScene,
  parentId: number,
  name: string,
): { scene: VoxScene; transformId: number; groupId: number } {
  const parent = nodeOf(graphOf(scene), parentId, 'group'),
    checked = checkName(name);
  checkRoom(scene, 1);
  const [transformId, groupId] = newIds(scene, 2);
  return {
    scene: appendChild(scene, parent, transformId, [
      identityTransform(transformId, groupId, checked),
      { id: groupId, type: 'group', children: [] },
    ]),
    transformId,
    groupId,
  };
}

/** Adds a placed copy of model `model` to group `parentId`; the voxels are shared, not copied. */
export function addVoxInstance(
  scene: VoxScene,
  parentId: number,
  model: number,
  name: string,
): { scene: VoxScene; transformId: number; shapeId: number } {
  const parent = nodeOf(graphOf(scene), parentId, 'group'),
    checked = checkName(name);
  if (!Number.isInteger(model) || model < 0 || model >= scene.models.length)
    throw new RangeError(`.vox model ${model} does not exist; pass 0 to ${scene.models.length - 1}`);
  checkRoom(scene, 2);
  const [transformId, shapeId] = newIds(scene, 2);
  return {
    scene: appendChild(scene, parent, transformId, [
      identityTransform(transformId, shapeId, checked),
      { id: shapeId, type: 'shape', models: [{ frame: 0, model }] },
    ]),
    transformId,
    shapeId,
  };
}

function isPermutation(r: unknown): boolean {
  if (!Array.isArray(r) || r.length !== 9 || !Array.from(r).every((v) => v === 0 || v === 1 || v === -1)) return false;
  for (let i = 0; i < 3; i++)
    if (
      Math.abs(r[i * 3]) + Math.abs(r[i * 3 + 1]) + Math.abs(r[i * 3 + 2]) !== 1 ||
      Math.abs(r[i]) + Math.abs(r[3 + i]) + Math.abs(r[6 + i]) !== 1
    )
      return false;
  return true;
}

function pathTo(graph: Graph, id: number): VoxNode[] {
  const path: VoxNode[] = [];
  for (let next: number | undefined = id; next !== undefined; next = graph.parents.get(next))
    path.push(graph.nodes.get(next)!);
  return path.reverse();
}

function worldAt(path: readonly VoxNode[], frame: number): Matrix4 {
  const world = new Matrix4();
  for (const node of path) {
    if (node.type !== 'transform') continue;
    const key = heldKey(node.frames, frame),
      r = key.rotation ?? IDENTITY,
      t = key.translation ?? [0, 0, 0];
    world.multiply(
      new Matrix4().set(r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2], 0, 0, 0, 1),
    );
  }
  return world;
}

function hiddenOn(scene: VoxScene, path: readonly VoxNode[]): boolean {
  return path.some(
    (n) => n.hidden || (n.type === 'transform' && scene.layers.some((l) => l.id === n.layer && l.hidden)),
  );
}

/**
 * Moves transform `transformId` (and its subtree) into group `parentId`, rewriting its keys so it stays where it was
 * in the world at every key frame of its old and new ancestors. Refused when that needs a non-axis rotation or a
 * fractional translation, when it would hide a visible node, or when the target is inside the moved subtree.
 */
export function moveVoxNode(scene: VoxScene, transformId: number, parentId: number): VoxScene {
  const graph = graphOf(scene),
    node = nodeOf(graph, transformId, 'transform'),
    target = nodeOf(graph, parentId, 'group'),
    oldParentId = graph.parents.get(transformId);
  if (oldParentId === parentId) return scene;
  if (oldParentId === undefined)
    throw new MargoError('state', 'The .vox root transform cannot move; move one of its children');
  const oldParent = graph.nodes.get(oldParentId) as Group,
    oldPath = pathTo(graph, transformId),
    newPath = pathTo(graph, parentId);
  if (newPath.some((n) => n.id === transformId))
    throw new MargoError(
      'state',
      `.vox group ${parentId} is inside node ${transformId}; moving there would make a cycle`,
    );
  const wasHidden = hiddenOn(scene, oldPath);
  if (!wasHidden && hiddenOn(scene, newPath))
    throw new MargoError(
      'state',
      `.vox group ${parentId} is hidden; show it before moving visible node ${transformId} into it`,
    );
  const frames = [
    ...new Set([0, ...[...oldPath, ...newPath].flatMap((n) => (n.type === 'transform' ? n.frames.map(frameOf) : []))]),
  ].sort((a, b) => a - b);
  if (frames.length > MAX_TRACK)
    throw new RangeError(`Keeping .vox node ${transformId} in place needs over ${MAX_TRACK} keys`);
  checkRoom(scene, frames.length - node.frames.length);
  const keys = frames.map((frame) => {
    const e = worldAt(newPath, frame).invert().multiply(worldAt(oldPath, frame)).elements,
      rotation = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]].map((v) => (v === 0 ? 0 : v)),
      translation = [e[12], e[13], e[14]];
    if (!isPermutation(rotation) || !translation.every((v) => Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX))
      throw new RangeError(`Keeping .vox node ${transformId} in place needs a non-axis rotation or fractional move`);
    const held = heldKey(node.frames, frame);
    return {
      ...held,
      frame,
      rotation,
      translation: translation as unknown as Vec3,
      attributes: new Map(held.attributes),
    };
  });
  // A node hidden only by its old ancestors stays hidden after the move.
  const moved = { ...(wasHidden && !hiddenOn(scene, newPath) ? patched(node, { hidden: true }) : node), frames: keys };
  return {
    ...scene,
    nodes: scene.nodes.map((n) =>
      n.id === transformId
        ? moved
        : n.id === oldParentId
          ? { ...oldParent, children: oldParent.children.filter((c) => c !== transformId) }
          : n.id === parentId
            ? { ...target, children: [...target.children, transformId] }
            : n,
    ),
  };
}

/** Deletes transform `transformId` and its subtree; models, palettes and everything else stay. The root cannot go. */
export function deleteVoxNode(scene: VoxScene, transformId: number): VoxScene {
  const graph = graphOf(scene),
    node = nodeOf(graph, transformId, 'transform'),
    parentId = graph.parents.get(transformId);
  if (parentId === undefined)
    throw new MargoError('state', 'The .vox root transform cannot be deleted; delete a child');
  const parent = graph.nodes.get(parentId) as Group,
    removed = new Set<number>(),
    pending = [node.id];
  while (pending.length) {
    const id = pending.pop()!,
      child = graph.nodes.get(id)!;
    removed.add(id);
    if (child.type === 'group') pending.push(...child.children);
    else if (child.type === 'transform') pending.push(child.child);
  }
  return {
    ...scene,
    nodes: scene.nodes
      .filter((n) => !removed.has(n.id))
      .map((n) => (n.id === parentId ? { ...parent, children: parent.children.filter((c) => c !== transformId) } : n)),
  };
}
