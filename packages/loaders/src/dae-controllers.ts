// COLLADA <controller> reading: <skin> (bind shape, joints, inverse bind matrices, vertex weights) and <morph>
// (NORMALIZED and RELATIVE targets with default weights). Written from the COLLADA 1.4.1 and 1.5 specifications.
import { LoaderError } from './types.js';
import {
  block,
  F,
  fromRows,
  integer,
  kid,
  kids,
  numbers,
  ref,
  sourcesOf,
  type Matrix,
  type Source,
} from './dae-common.js';
import type { XMLElement } from './xml.js';

/** Most influences kept per vertex, as the engine's skinning takes them. */
const MAX_INFLUENCES = 4;

/**
 * A `<skin>` controller in Y-up meters. Influences are per `<vertices>` position (the geometry's
 * `positionIndices` values), four each: the strongest four of the file's, renormalised to sum 1.
 */
export interface DAESkin {
  id: string;
  name?: string;
  /** Index into `LoadedDAE.geometries` of the skinned mesh (the morph's base mesh when it skins a morph). */
  geometry: number;
  /** Index into `LoadedDAE.morphs` when the skin's source is a morph controller. */
  morph?: number;
  /** `bind_shape_matrix`, column-major, converted to Y-up meters; applied to the mesh before skinning. */
  bindShapeMatrix: number[];
  /** Joint names as written: sids (`Name_array`) or node ids (`IDREF_array`). */
  joints: string[];
  /** 16 column-major numbers per joint, converted to Y-up meters. */
  inverseBindMatrices: Float64Array;
  /** Four joint indices per position, into `joints`; -1 is the bind shape itself (the mesh unmoved by joints). */
  vertexJoints: Int32Array;
  /** Four weights per position matching `vertexJoints`, summing to 1; all zero for a position without weights. */
  vertexWeights: Float32Array;
}

/**
 * A `<morph>` controller: `NORMALIZED` gives (1 - sum w) base + sum w target, `RELATIVE` gives base + sum w target,
 * position by position (targets share the base mesh's `<vertices>` numbering).
 */
export interface DAEMorph {
  id: string;
  name?: string;
  method: 'NORMALIZED' | 'RELATIVE';
  /** Index into `LoadedDAE.geometries` of the base mesh. */
  base: number;
  /** Index into `LoadedDAE.geometries` of each target mesh. */
  targets: number[];
  /** Default weight of each target (`MORPH_WEIGHT`). */
  weights: number[];
  /** Id of the `MORPH_WEIGHT` source, which animation channels may address instead of the controller. */
  weightsSource?: string;
}

/** What an `<instance_controller>` resolves to. */
export interface ControllerRef {
  geometry: number;
  skin?: number;
  morph?: number;
  /** The skin's joints are node ids (`IDREF_array`), not sids. */
  idref?: boolean;
}

/** Highest position index a geometry uses, plus one. */
export function positionCount(indices: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i] >= count) count = indices[i] + 1;
  return count;
}

function readMorph(
  controller: XMLElement,
  morph: XMLElement,
  ids: Map<string, XMLElement>,
  geometryIndex: Map<string, number>,
  positions: (geometry: number) => number,
  warn: (message: string) => void,
): DAEMorph | undefined {
  const id = controller.attributes.id ?? '',
    what = `morph "${id}"`,
    base = geometryIndex.get(ref(morph.attributes.source));
  if (base === undefined) {
    warn(`${what} is not imported: its source "${morph.attributes.source}" is not an imported mesh`);
    return;
  }
  const method = morph.attributes.method ?? 'NORMALIZED';
  if (method !== 'NORMALIZED' && method !== 'RELATIVE')
    throw new LoaderError(F, 'syntax', `${what} method "${method.slice(0, 32)}" is not NORMALIZED or RELATIVE`);
  const source = sourcesOf(morph, ids, what),
    inputs = kids(kid(morph, 'targets'), 'input'),
    targetInput = inputs.find((i) => i.attributes.semantic === 'MORPH_TARGET'),
    weightInput = inputs.find((i) => i.attributes.semantic === 'MORPH_WEIGHT');
  if (!targetInput || !weightInput)
    throw new LoaderError(F, 'syntax', `${what} <targets> needs MORPH_TARGET and MORPH_WEIGHT inputs`);
  const names = source(targetInput.attributes.source).names ?? [],
    weightSource = source(weightInput.attributes.source),
    weights = weightSource.data.slice(weightSource.offset, weightSource.offset + names.length);
  if (weights.length !== names.length || !weights.every(Number.isFinite))
    throw new LoaderError(F, 'syntax', `${what} has ${names.length} targets but ${weights.length} finite weights`);
  const targets: number[] = [];
  for (const name of names) {
    const target = geometryIndex.get(ref(name));
    if (target === undefined) {
      warn(`${what} is not imported: target "${name}" is not an imported mesh`);
      return;
    }
    if (positions(target) > positions(base)) {
      warn(`${what} is not imported: target "${name}" has more positions than the base mesh`);
      return;
    }
    targets.push(target);
  }
  const result: DAEMorph = { id, method, base, targets, weights };
  if (controller.attributes.name !== undefined) result.name = controller.attributes.name;
  if (weightSource.id) result.weightsSource = weightSource.id;
  return result;
}

function readSkin(
  controller: XMLElement,
  skin: XMLElement,
  ids: Map<string, XMLElement>,
  base: { geometry: number; morph?: number },
  count: number,
  convert: (m: ArrayLike<number>) => Matrix,
): { skin: DAESkin; idref: boolean } {
  const id = controller.attributes.id ?? '',
    what = `skin "${id}"`,
    source = sourcesOf(skin, ids, what),
    matrix = kid(skin, 'bind_shape_matrix'),
    bindShape = matrix ? numbers(matrix.text, `${what} bind_shape_matrix`) : undefined;
  if (bindShape && (bindShape.length !== 16 || !bindShape.every(Number.isFinite)))
    throw new LoaderError(F, 'syntax', `${what} bind_shape_matrix needs 16 finite numbers, got ${bindShape.length}`);
  const jointInputs = kids(kid(skin, 'joints'), 'input'),
    jointInput = jointInputs.find((i) => i.attributes.semantic === 'JOINT'),
    bindInput = jointInputs.find((i) => i.attributes.semantic === 'INV_BIND_MATRIX');
  if (!jointInput || !bindInput)
    throw new LoaderError(F, 'syntax', `${what} <joints> needs JOINT and INV_BIND_MATRIX inputs`);
  const jointSource = source(jointInput.attributes.source),
    names = jointSource.names ?? [],
    joints = names.slice(jointSource.offset, jointSource.offset + (jointSource.count || names.length)),
    idref = jointSource.kind === 'IDREF_array',
    binds = source(bindInput.attributes.source);
  if (!joints.length) throw new LoaderError(F, 'syntax', `${what} has no joints`);
  if (binds.count < joints.length || binds.stride < 16)
    throw new LoaderError(F, 'syntax', `${what} has ${joints.length} joints but ${binds.count} inverse bind matrices`);
  const inverseBindMatrices = new Float64Array(joints.length * 16);
  for (let j = 0; j < joints.length; j++) {
    const rows = block(binds, j, 16);
    if (!rows.every(Number.isFinite))
      throw new LoaderError(F, 'syntax', `${what} inverse bind matrix ${j} is not finite`);
    inverseBindMatrices.set(convert(fromRows(rows)), j * 16);
  }
  const weightsElement = kid(skin, 'vertex_weights');
  if (!weightsElement) throw new LoaderError(F, 'syntax', `${what} has no <vertex_weights>`);
  const inputs = kids(weightsElement, 'input'),
    stride = Math.max(0, ...inputs.map((i) => integer(i.attributes.offset, 0, `${what} input offset`) + 1)),
    jointAt = inputs.find((i) => i.attributes.semantic === 'JOINT'),
    weightAt = inputs.find((i) => i.attributes.semantic === 'WEIGHT');
  if (!jointAt || !weightAt)
    throw new LoaderError(F, 'syntax', `${what} <vertex_weights> needs JOINT and WEIGHT inputs`);
  const jointOffset = integer(jointAt.attributes.offset, 0, `${what} input offset`),
    weightOffset = integer(weightAt.attributes.offset, 0, `${what} input offset`),
    weightSource: Source = source(weightAt.attributes.source),
    vertices = integer(weightsElement.attributes.count, 0, `${what} vertex_weights count`),
    vcount = numbers(kid(weightsElement, 'vcount')?.text ?? '', `${what} <vcount>`),
    v = numbers(kid(weightsElement, 'v')?.text ?? '', `${what} <v>`);
  if (vcount.length !== vertices)
    throw new LoaderError(F, 'syntax', `${what} <vcount> has ${vcount.length} entries for ${vertices} vertices`);
  if (vertices < count)
    throw new LoaderError(F, 'range', `${what} weights ${vertices} vertices but its mesh has ${count} positions`);
  const vertexJoints = new Int32Array(count * MAX_INFLUENCES),
    vertexWeights = new Float32Array(count * MAX_INFLUENCES),
    pairs: [number, number][] = [];
  let at = 0;
  for (let vertex = 0; vertex < vertices; vertex++) {
    const n = vcount[vertex];
    if (!Number.isSafeInteger(n) || n < 0 || (at + n) * stride > v.length)
      throw new LoaderError(F, 'syntax', `${what} <vcount> does not match its <v> indices`);
    pairs.length = 0;
    for (let k = 0; k < n; k++, at++) {
      const joint = v[at * stride + jointOffset],
        index = v[at * stride + weightOffset];
      if (!(Number.isInteger(joint) && joint >= -1 && joint < joints.length))
        throw new LoaderError(F, 'range', `${what} joint index ${joint} is outside -1..${joints.length - 1}`);
      if (!(Number.isInteger(index) && index >= 0 && index < weightSource.count))
        throw new LoaderError(F, 'range', `${what} weight index ${index} is outside 0..${weightSource.count - 1}`);
      const weight = weightSource.data[weightSource.offset + index * weightSource.stride];
      if (Number.isFinite(weight) && weight > 0) pairs.push([joint, weight]);
    }
    if (vertex >= count) continue;
    pairs.sort((a, b) => b[1] - a[1]);
    let sum = 0;
    for (let k = 0; k < MAX_INFLUENCES && k < pairs.length; k++) sum += pairs[k][1];
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      const pair = pairs[k];
      vertexJoints[vertex * MAX_INFLUENCES + k] = pair ? pair[0] : 0;
      vertexWeights[vertex * MAX_INFLUENCES + k] = pair && sum > 0 ? pair[1] / sum : 0;
    }
  }
  const result: DAESkin = {
    id,
    geometry: base.geometry,
    bindShapeMatrix: bindShape
      ? convert(fromRows(bindShape))
      : convert([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    joints,
    inverseBindMatrices,
    vertexJoints,
    vertexWeights,
  };
  if (base.morph !== undefined) result.morph = base.morph;
  if (controller.attributes.name !== undefined) result.name = controller.attributes.name;
  return { skin: result, idref };
}

/** Reads `library_controllers`: morphs first, so a skin may wrap one. */
export function readControllers(
  root: XMLElement,
  ids: Map<string, XMLElement>,
  geometryIndex: Map<string, number>,
  positionIndices: (geometry: number) => Uint32Array,
  convert: (m: ArrayLike<number>) => Matrix,
  warn: (message: string) => void,
): { skins: DAESkin[]; morphs: DAEMorph[]; controllers: Map<string, ControllerRef> } {
  const all = kids(kid(root, 'library_controllers'), 'controller'),
    skins: DAESkin[] = [],
    morphs: DAEMorph[] = [],
    controllers = new Map<string, ControllerRef>(),
    counts = new Map<number, number>(),
    positions = (geometry: number): number => {
      let count = counts.get(geometry);
      if (count === undefined) counts.set(geometry, (count = positionCount(positionIndices(geometry))));
      return count;
    };
  for (const controller of all) {
    const morph = kid(controller, 'morph');
    if (!morph) continue;
    const loaded = readMorph(controller, morph, ids, geometryIndex, positions, warn);
    if (!loaded) continue;
    controllers.set(loaded.id, { geometry: loaded.base, morph: morphs.length });
    morphs.push(loaded);
  }
  for (const controller of all) {
    const skin = kid(controller, 'skin'),
      id = controller.attributes.id ?? '';
    if (!skin) {
      if (!kid(controller, 'morph')) warn(`controller "${id}" is neither a skin nor a morph and is not imported`);
      continue;
    }
    const sourceId = ref(skin.attributes.source),
      geometry = geometryIndex.get(sourceId),
      wrapped = controllers.get(sourceId),
      base = geometry !== undefined ? { geometry } : wrapped?.morph !== undefined ? wrapped : undefined;
    if (!base) {
      warn(`skin "${id}" is not imported: its source "${skin.attributes.source}" is not an imported mesh or morph`);
      continue;
    }
    const { skin: loaded, idref } = readSkin(controller, skin, ids, base, positions(base.geometry), convert);
    const entry: ControllerRef = { geometry: base.geometry, skin: skins.length, idref };
    if (base.morph !== undefined) entry.morph = base.morph;
    controllers.set(id, entry);
    skins.push(loaded);
  }
  return { skins, morphs, controllers };
}
