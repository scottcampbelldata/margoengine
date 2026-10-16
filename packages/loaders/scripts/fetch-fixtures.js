// Downloads the small real-world fixtures used by tests/loaders.test.js. Files that 404 are skipped
// (the tests skip their checks when a fixture is missing). Run with `npm run fixtures`.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const three = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models';
const sources = {
  'dolphins.ply': `${three}/ply/ascii/dolphins.ply`,
  'dolphins_be.ply': `${three}/ply/binary/dolphins_be.ply`,
  'dolphins_colored.ply': `${three}/ply/ascii/dolphins_colored.ply`,
  'cube_gears.3mf': `${three}/3mf/cube_gears.3mf`,
  'facecolors.3mf': `${three}/3mf/facecolors.3mf`,
  'vertexcolors.3mf': `${three}/3mf/vertexcolors.3mf`,
  'simple.pcd': `${three}/pcd/ascii/simple.pcd`,
  'pcl_logo.pcd': `${three}/pcd/binary_compressed/pcl_logo.pcd`,
  'helix_201.xyz': `${three}/xyz/helix_201.xyz`,
  'bunny.pcd': 'https://raw.githubusercontent.com/PointCloudLibrary/pcl/master/test/bunny.pcd',
  'cube.off': 'https://raw.githubusercontent.com/libigl/libigl-tutorial-data/master/cube.off',
  'decimated-knight.off': 'https://raw.githubusercontent.com/libigl/libigl-tutorial-data/master/decimated-knight.off',
  'fran_cut.vtk': 'https://raw.githubusercontent.com/pyvista/vtk-data/master/Data/fran_cut.vtk',
  'polyEx.vtk': 'https://raw.githubusercontent.com/pyvista/vtk-data/master/Data/polyEx.vtk',
};
const folder = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
await mkdir(folder, { recursive: true });
for (const [name, url] of Object.entries(sources)) {
  const response = await fetch(url);
  if (!response.ok) {
    console.warn(`skip ${name}: HTTP ${response.status}`);
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 1 << 20) {
    console.warn(`skip ${name}: ${bytes.length} bytes is over 1 MB`);
    continue;
  }
  await writeFile(resolve(folder, name), bytes);
  console.log(`${name} ${bytes.length} bytes`);
}
