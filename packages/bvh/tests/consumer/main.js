// Production consumer: a bundler must emit bvh.worker.js as its own asset for buildAsync to work.
import { MeshBVH, buildAsync, terminateBVHWorker } from '@margoengine/bvh';
import { buildParallel } from '@margoengine/bvh/parallel';

window.runConsumer = async () => {
  const positions = new Float32Array(3000 * 9).map((_, i) => Math.sin(i * 12.9898) * 2);
  const bvh = await buildAsync({ positions });
  const sync = MeshBVH.build({ positions });
  const same = new Uint8Array(bvh.nodes).every((v, i) => v === new Uint8Array(sync.nodes)[i]);
  const parallel = await buildParallel({ positions }, { workers: 3 });
  if (
    parallel.nodes.byteLength !== sync.nodes.byteLength ||
    !new Uint8Array(parallel.nodes).every((v, i) => v === new Uint8Array(sync.nodes)[i]) ||
    !parallel.triangles.every((v, i) => v === sync.triangles[i]) ||
    !parallel.index.every((v, i) => v === sync.index[i])
  )
    throw new Error('Parallel tree differs from serial');
  terminateBVHWorker();
  return { triangles: bvh.triangleCount, nodes: bvh.nodeCount, sameAsSync: same };
};
