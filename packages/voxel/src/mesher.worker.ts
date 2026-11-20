// Worker script of VoxelMesher (bundled to dist/workers/mesher.js): meshChunk per job, the translucent quads sorted
// back to front from the job's eye when it has one, and the shell's cube faces when the job asks for its border. The
// mesh's arrays move back to the page.
import { serve } from '../../shared/worker.js';
import { meshBorder } from './border.js';
import { type MeshInput, meshChunk, sortQuads } from './mesher.js';

serve(({ input, eye, border }: { input: MeshInput; eye?: [number, number, number]; border?: boolean }) => {
  const mesh = meshChunk(input);
  if (eye) sortQuads(mesh.translucent, eye);
  if (border && (mesh.opaque.length || mesh.cutout.length || mesh.translucent.length)) mesh.border = meshBorder(input);
  return mesh;
});
