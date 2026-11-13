// Ships the Blender exports small: merges duplicate data, welds equal vertices and stores the geometry with
// EXT_meshopt_compression with KHR_mesh_quantization (Margo's own encoder, @margoengine/exporters): 8.92 MB to 5.23 MB.
// Quantizing moves each mesh's grid into its node's transform; the Lens node stays on the lamp's vertical axis, so it
// still turns about it. Run after build_scene.py: node examples/storm-light/blender/compress.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { optimizeGLB } from '../../../packages/exporters/dist/optimize.js';
import { compressMeshopt } from '../../../packages/exporters/dist/meshopt.js';

for (const name of ['storm-light.glb', 'boat.glb']) {
  const path = new URL(`../assets/${name}`, import.meta.url),
    source = new Uint8Array(await readFile(path));
  if (new TextDecoder().decode(source.subarray(0, 4096)).includes('EXT_meshopt_compression')) {
    console.log(`${name}: already compressed`);
    continue;
  }
  const { glb: optimized } = await optimizeGLB(source),
    { glb, compressed } = await compressMeshopt(optimized, { quantize: true });
  await writeFile(path, glb);
  console.log(`${name}: ${source.length} -> ${glb.length} bytes, ${compressed} streams`);
}
