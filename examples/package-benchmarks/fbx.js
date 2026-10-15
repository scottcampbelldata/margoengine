import { convertFBX } from '../../packages/fbx/dist/index.js';
import { fetchBytes } from '../../packages/loaders/dist/index.js';
import { assetWorkload, displayGeometry } from './asset-scene.js';

/** Read only this known, single-primitive fixture's converted GLB; not a new general-purpose loader. */
export function fixtureGeometry(buffer) {
  const view = new DataView(buffer),
    jsonLength = view.getUint32(12, true),
    document = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))),
    primitive = document.meshes[0].primitives[0];
  const read = (id, components) => {
    const accessor = document.accessors[id],
      part = document.bufferViews[accessor.bufferView],
      offset = 28 + jsonLength + (part.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
      result = components === 1 ? new Uint32Array(accessor.count) : new Float32Array(accessor.count * components);
    const size = accessor.componentType === 5121 ? 1 : accessor.componentType === 5123 ? 2 : 4;
    for (let i = 0; i < result.length; i++)
      result[i] =
        accessor.componentType === 5126
          ? view.getFloat32(offset + i * size, true)
          : size === 1
            ? view.getUint8(offset + i)
            : size === 2
              ? view.getUint16(offset + i * size, true)
              : view.getUint32(offset + i * size, true);
    return result;
  };
  const positions = read(primitive.attributes.POSITION, 3);
  return {
    kind: 'mesh',
    positions,
    indices:
      primitive.indices === undefined
        ? Uint32Array.from({ length: positions.length / 3 }, (_, index) => index)
        : read(primitive.indices, 1),
    normals: primitive.attributes.NORMAL === undefined ? undefined : read(primitive.attributes.NORMAL, 3),
  };
}

export async function createWorkload(count = 4, options = {}) {
  const source = await fetchBytes(new URL('./fixtures/triangle.fbx', import.meta.url), { ...options, maxBytes: 10000 });
  let conversionElapsedMilliseconds = 0,
    buildCpuMilliseconds = 0,
    glbBytes = 0,
    vertices = 0,
    triangles = 0;
  return assetWorkload(
    count,
    async (_, signal) => {
      const started = performance.now(),
        output = await convertFBX(source, { signal });
      conversionElapsedMilliseconds = performance.now() - started;
      signal.throwIfAborted();
      const built = performance.now(),
        loaded = fixtureGeometry(output),
        geometry = displayGeometry(loaded);
      buildCpuMilliseconds = performance.now() - built;
      glbBytes = output.byteLength;
      vertices = loaded.positions.length / 3;
      triangles = loaded.indices.length / 3;
      return geometry;
    },
    'The existing ASCII triangle test fixture goes through the real FBX→GLB converter, then its converted positions, normals and triangle indices form the displayed surfaces. Run repeats a bounded conversion batch each second. This tiny static fixture does not claim production FBX skins, textures or animation playback acceptance.',
    {
      ...options,
      details: () => ({
        sourceBytes: source.length,
        glbBytes,
        verticesPerModel: vertices,
        trianglesPerModel: triangles,
        lastConversionElapsedMilliseconds: conversionElapsedMilliseconds,
        lastBuildCpuMilliseconds: buildCpuMilliseconds,
      }),
    },
  );
}
