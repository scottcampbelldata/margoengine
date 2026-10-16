// Production consumer: a bundler must emit bvh.worker.js as its own asset for buildAsync to work.
import { MeshBVH, buildAsync, terminateBVHWorker } from '@margoengine/bvh';

window.runConsumer = async () => {
  const positions = new Float32Array(3000 * 9).map((_, i) => Math.sin(i * 12.9898) * 2);
  const bvh = await buildAsync({ positions });
  const sync = MeshBVH.build({ positions });
  const same = new Uint8Array(bvh.nodes).every((v, i) => v === new Uint8Array(sync.nodes)[i]);
  terminateBVHWorker();
  return { triangles: bvh.triangleCount, nodes: bvh.nodeCount, sameAsSync: same };
};
