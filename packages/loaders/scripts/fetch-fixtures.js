// Downloads the small third-party fixtures used by tests/loaders.test.js (PCL, libigl and PyVista samples). Files
// that 404 are skipped (the tests skip their checks when a fixture is missing). Run with `npm run fixtures`. The
// Margo-made fixtures come from scripts/make-fixtures.js instead.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const sources = {
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
