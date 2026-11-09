// Standard test data only. HTTP, size and hash failures fail this command; tests require every fixture.
// Provenance: tests/fixtures/SOURCES.txt and scripts/supply-chain.mjs.
import { fileURLToPath } from 'node:url';
import { fetchFixture } from '../../../scripts/support/fetch-fixture.mjs';
const sources = [
  [
    'sphere.vdb',
    'https://media.githubusercontent.com/media/AcademySoftwareFoundation/openvdb-website/3d8fd4d3f2d670464f4390e2775cfc87274233dc/download/models/sphere.vdb',
    'bb884a9a38354e47191c4ece4a11d1e051594a910fde56501cfc51ff52b171ab',
  ],
  [
    'box.off',
    'https://people.sc.fsu.edu/~jburkardt/data/off/box.off',
    '805a04c722a2ebd82faf28ef000cdd13a2730ef0196598928b4e03c6ed56c894',
  ],
  [
    'mctri.off',
    'https://people.sc.fsu.edu/~jburkardt/data/off/mctri.off',
    '1dae1f3a2c9e49cff68c55ef47cfcdd9c35633c9106543d6041d8b4a5f7fb0aa',
  ],
  [
    'bunny.pcd',
    'https://raw.githubusercontent.com/PointCloudLibrary/pcl/3aac7b68cc8f26428ba9c9192d990c0c21cc5a7d/test/bunny.pcd',
    'f5418a140de7a21adc8a46b83bca8ee05b0ebd5a5fe3ca8a0925bcb6535ed511',
  ],
  [
    'fran_cut.vtk',
    'https://raw.githubusercontent.com/pyvista/vtk-data/5a3de12d34c24aa5dd5e5db1cbc2defebc0d4da3/Data/fran_cut.vtk',
    '499c170dd475725f47de4e436f080bd18d1a2cc315411f9c490ba42b6dffbc6d',
  ],
  [
    'polyEx.vtk',
    'https://raw.githubusercontent.com/pyvista/vtk-data/5a3de12d34c24aa5dd5e5db1cbc2defebc0d4da3/Data/polyEx.vtk',
    'f020ce787fa515d949723b67b9e667dff8eed8d908830dc6e6ae525df87c60bf',
  ],
];
for (const [name, url, hash] of sources)
  await fetchFixture(url, fileURLToPath(new URL('../tests/fixtures/' + name, import.meta.url)), hash);
