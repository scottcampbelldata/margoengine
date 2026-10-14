import {DracoDecoder} from '../../packages/decoders/dist/index.js';
import {fetchBytes} from '../../packages/loaders/dist/index.js';
import {assetWorkload, displayGeometry} from './asset-scene.js';

export async function createWorkload(count = 4, options = {}) {
  const [json, binary] = await Promise.all([
    fetchBytes(new URL('../../packages/decoders/tests/fixtures/Avocado.gltf', import.meta.url), {...options, maxBytes: 100000}),
    fetchBytes(new URL('../../packages/decoders/tests/fixtures/Avocado.bin', import.meta.url), {...options, maxBytes: 100000})
  ]);
  const document = JSON.parse(new TextDecoder().decode(json)), primitive = document.meshes[0].primitives[0], extension = primitive.extensions.KHR_draco_mesh_compression, view = document.bufferViews[extension.bufferView];
  const source = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength), decoder = new DracoDecoder({workerLimit: 2});
  let decodeElapsedMilliseconds = 0, buildCpuMilliseconds = 0, vertexCount = 0, triangles = 0;
  try {
    return await assetWorkload(count, async (_, signal) => {
      const started = performance.now(), decoded = await decoder.decode(source, {attributeIds: extension.attributes, signal});
      decodeElapsedMilliseconds = performance.now() - started; signal.throwIfAborted();
      if (decoded.vertexCount !== document.accessors[primitive.attributes.POSITION].count || decoded.indices?.length !== document.accessors[primitive.indices].count) throw new Error('Decoded fixture accessor count mismatch');
      const built = performance.now(), geometry = displayGeometry({...decoded, kind: 'mesh'}); buildCpuMilliseconds = performance.now() - built;
      vertexCount = decoded.vertexCount; triangles = decoded.indices.length / 3; return geometry;
    }, 'Actual Draco Avocado geometry decoded in a two-worker package pool and drawn from transferred positions, normals and indices. Run launches one bounded decode batch per simulation second. This is geometry decoding, without the source textures or KTX2 transcode coverage.',
    {...options, cleanup: () => decoder.dispose(), details: () => ({sourceBytes: source.length, workerLimit: decoder.workerLimit, verticesPerModel: vertexCount, trianglesPerModel: triangles, lastDecodeElapsedMilliseconds: decodeElapsedMilliseconds, lastBuildCpuMilliseconds: buildCpuMilliseconds})});
  } catch (error) {decoder.dispose(); throw error;}
}
