// EXT_mesh_gpu_instancing for the light loader. Core already draws every mesh of one geometry as one instanced draw, so
// each instance becomes a node on the shared mesh and the file needs no draw path of its own.
import { MargoError } from '@margoengine/math/errors';
import { countLimit } from '../../shared/limits.js';
import type { GLTFAccessor, GLTFNode } from '../../shared/gltf.js';
import { readAccessor } from './accessor.js';
import type { GLTFExtension, GLTFFile } from './index.js';

const NAME = 'EXT_mesh_gpu_instancing',
  invalid = (what: string) =>
    new TypeError(`Invalid glTF ${what}; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator`);

// TRANSLATION and SCALE may be float or, under KHR_mesh_quantization, any integer form; ROTATION float or normalized signed.
const scalar = (a: GLTFAccessor) => a.type === 'VEC3' && [5126, 5120, 5121, 5122, 5123].includes(a.componentType),
  turn = (a: GLTFAccessor) =>
    a.type === 'VEC4' && (a.componentType === 5126 || (a.normalized === true && [5120, 5122].includes(a.componentType)));
function column(
  file: GLTFFile,
  id: number | undefined,
  size: number,
  accepts: (accessor: GLTFAccessor) => boolean,
): Float32Array | undefined {
  if (id === undefined) return undefined;
  const values = readAccessor(file, id, size, accepts) as Float32Array;
  if (!values.every(Number.isFinite)) throw invalid('instance attributes');
  return values;
}
/** The instance nodes of `node`, and that node without its mesh and extension. */
function expand(file: GLTFFile, node: GLTFNode, first: number, limit: number): { node: GLTFNode; instances: GLTFNode[] } {
  const { attributes } = node.extensions![NAME] as { attributes?: Record<string, number> };
  if (node.mesh === undefined || !attributes) throw invalid('instanced node');
  const translation = column(file, attributes.TRANSLATION, 3, scalar),
    rotation = column(file, attributes.ROTATION, 4, turn),
    scale = column(file, attributes.SCALE, 3, scalar),
    count = translation ? translation.length / 3 : rotation ? rotation.length / 4 : scale ? scale.length / 3 : 0;
  if (
    !count ||
    (translation && translation.length !== count * 3) ||
    (rotation && rotation.length !== count * 4) ||
    (scale && scale.length !== count * 3)
  )
    throw invalid('instance attributes');
  if (first + count > limit)
    throw new MargoError(
      'unsupported',
      `Too many glTF nodes (${first + count} > ${limit}; raise the maxNodes option, or load it with @margoengine/gltf-pro, which draws instances without nodes)`,
    );
  const instances: GLTFNode[] = [];
  for (let i = 0; i < count; i++) {
    const instance: GLTFNode = { mesh: node.mesh };
    if (translation) instance.translation = [...translation.subarray(i * 3, i * 3 + 3)];
    if (scale) instance.scale = [...scale.subarray(i * 3, i * 3 + 3)];
    if (rotation) {
      const q = rotation.subarray(i * 4, i * 4 + 4),
        length = Math.hypot(...q);
      if (!(length > 0)) throw invalid('instance rotation');
      // Quantized rotations are close to unit length, not at it.
      instance.rotation = [...q].map((v) => v / length);
    }
    instances.push(instance);
  }
  const { mesh: _mesh, extensions, ...rest } = node,
    { [NAME]: _instancing, ...others } = extensions!,
    kept: GLTFNode = { ...rest, children: [...(node.children ?? []), ...instances.map((_, i) => first + i)] };
  if (Object.keys(others).length) kept.extensions = others;
  return { node: kept, instances };
}

/**
 * Lets the light loader read `EXT_mesh_gpu_instancing`: each instance becomes a child node of the instanced node, on the
 * shared mesh, and core draws all of them as one instanced draw per primitive. TRANSLATION, ROTATION and SCALE are read,
 * in float or quantized form; custom attributes are ignored. An instance costs one core mesh plus one per primitive, and
 * every instance counts toward `maxNodes`. Instances show up in `model.meshes` and `model.nodes` like any node.
 * @example const model = await loadGLTF(engine, '/forest.glb', { extensions: [instancing], maxNodes: 500_000 });
 */
export const instancing: GLTFExtension = {
  handles: [NAME],
  read(file) {
    const nodes = [...(file.doc.nodes ?? [])],
      limit = countLimit('maxNodes', file.maxNodes);
    for (let id = 0, end = nodes.length; id < end; id++) {
      if (!nodes[id]?.extensions?.[NAME]) continue;
      const { node, instances } = expand(file, nodes[id], nodes.length, limit);
      nodes[id] = node;
      for (const instance of instances) nodes.push(instance);
    }
    file.doc = { ...file.doc, nodes };
  },
};
