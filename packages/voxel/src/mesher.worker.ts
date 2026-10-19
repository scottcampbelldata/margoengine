// Worker script of VoxelMesher (bundled to dist/workers/mesher.js): meshChunk per job, the translucent quads sorted
// back to front from the job's eye when it has one. The mesh's arrays move back to the page.
import { serve } from '../../shared/worker.js';
import { type MeshInput, meshChunk, sortQuads } from './mesher.js';

serve(({ input, eye }: { input: MeshInput; eye?: [number, number, number] }) => {
  const mesh = meshChunk(input);
  if (eye) sortQuads(mesh.translucent, eye);
  return mesh;
});
