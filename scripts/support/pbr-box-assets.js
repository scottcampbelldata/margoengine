import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pinnedFiles } from './pinned-files.mjs';

const revision = 'edc7c9e67c639d230715049ee31f9a96a6babbbe';
const source = `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${revision}/Models/Avocado/glTF-Draco/`;
const files = [
  ['Avocado.gltf', 3083, '63ec45999c1df77adc3837857c95d16dde7aee062b4a1d4475ca968514ec8609'],
  ['Avocado.bin', 8724, '535123a66a19c0427298d0bbe81b0ba5efa6d8155b7c659e11c23d8c6d6fe2c6'],
  ['Avocado_baseColor.png', 3158729, '385dce948c3b9e8bc93e1c930d796e72b02cbd474b121a160d577de95ebbb48f'],
  ['Avocado_normal.png', 3271114, '25783c211761b7e32497fdd3e2490f3bac05b738e5e2bc62fc5b78a270bb4e50'],
  ['Avocado_roughnessMetallic.png', 1655059, '33ee80f7ccfd36825acfbd5ef0a51326bea49e33efed852dca44798798bd6901'],
];
/**
 * Complete, unmodified Draco asset; large CC0 textures stay in the ignored test cache. Absent or changed files are
 * fetched only with `download` (the check's --download flag); otherwise this fails and names them.
 */
export async function ensurePBRBoxAssets({
  download = false,
  directory = fileURLToPath(new URL('../../test-results/pbr-box-avocado/', import.meta.url)),
} = {}) {
  await pinnedFiles(
    files.map(([name, size, sha256]) => ({ path: join(directory, name), url: source + name, size, sha256 })),
    { command: 'node scripts/pbr-box-tests.js', download },
  );
  return {
    directory,
    url: '/test-results/pbr-box-avocado/Avocado.gltf',
    revision,
    files: files.map(([name, size, sha256]) => ({ name, size, sha256 })),
  };
}
