import { composeMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { sampleTrack } from '@margoengine/animation/sampling';

export function accessor(asset, id) {
  const a = asset.document.accessors[id], view = asset.document.bufferViews[a.bufferView];
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
  const data = new DataView(asset.buffer.buffer, asset.buffer.byteOffset + view.byteOffset + (a.byteOffset ?? 0));
  return Float32Array.from({ length: a.count * width }, (_, i) => data.getFloat32(Math.floor(i / width) * (view.byteStride ?? width * 4) + (i % width) * 4, true));
}

export function objectWorlds(asset, clip, seconds) {
  const { document } = asset, overrides = new Map(), worlds = new Map();
  for (const channel of clip?.channels ?? []) {
    const sampler = clip.samplers[channel.sampler], path = channel.target.path;
    overrides.set(`${channel.target.node}/${path}`, sampleTrack(accessor(asset, sampler.input), accessor(asset, sampler.output), path === 'rotation' ? 4 : 3, seconds, sampler.interpolation ?? 'LINEAR', path === 'rotation'));
  }
  const visit = (id, parent) => {
    const node = document.nodes[id], get = (path, fallback) => overrides.get(`${id}/${path}`) ?? node[path] ?? fallback;
    const local = composeMatrix(get('translation', [0, 0, 0]), get('rotation', [0, 0, 0, 1]), get('scale', [1, 1, 1]), new Float64Array(16));
    const world = multiplyMatrices(parent, local);
    worlds.set(node.name, Array.from(world));
    for (const child of node.children ?? []) visit(child, world);
  };
  const identity = composeMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1], new Float64Array(16));
  for (const root of document.scenes[0].nodes) visit(root, identity);
  return worlds;
}
