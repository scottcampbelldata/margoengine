import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pinnedFiles } from './pinned-files.mjs';
import { cachedProductionAssets, sampleAssetBase, sampleAssetCommit } from './gltf-production-assets.js';

export { sampleAssetBase, sampleAssetCommit };
export const lobeProductionAssets = [
  {
    name: 'SheenChair',
    path: 'SheenChair/glTF-Binary/SheenChair.glb',
    lobe: 'sheen',
    camera: [2, 1.5, 3],
    attribution: 'Eric Chadwick / Wayfair, LLC, 2020, CC0 1.0',
  },
  {
    name: 'SpecularTest',
    path: 'SpecularTest/glTF-Binary/SpecularTest.glb',
    lobe: 'specular',
    camera: [0, 0, 5],
    ambient: 2,
    attribution: 'Ed Mackey / Analytical Graphics, Inc., 2021, CC BY 4.0',
  },
  {
    name: 'CompareIridescence',
    path: 'CompareIridescence/glTF-Binary/CompareIridescence.glb',
    lobe: 'iridescence',
    camera: [0, 0, 5],
    ambient: 1,
    attribution: 'Eric Chadwick and DGG / Public, 2024, CC0 1.0; glTF mark / Khronos Group, 2017',
  },
  {
    name: 'AnisotropyBarnLamp',
    path: 'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp.gltf',
    lobe: 'anisotropy',
    camera: [2, 1.2, 3],
    attribution: 'Eric Chadwick / Wayfair, LLC, 2023, CC BY 4.0',
  },
].map((value) => ({ ...value, readme: sampleAssetBase + value.name + '/README.md' }));
const pins = [
  [
    'SheenChair/glTF-Binary/SheenChair.glb',
    4125648,
    'f0af2a2b102d28d540236306ae19f8fb36842df76bd38cf76f063f9bd2853399',
  ],
  [
    'SpecularTest/glTF-Binary/SpecularTest.glb',
    223376,
    'cf789c68c3ab4b74877da3c5992c612c213f9c901ed4fafbf9be362f434e48d9',
  ],
  [
    'CompareIridescence/glTF-Binary/CompareIridescence.glb',
    214756,
    'abda6e8bcb13ad04534c90bc4ce9b21e80f2d8b74ac4d911800269f0009ff073',
  ],
];

/**
 * Complete, unmodified upstream assets, pinned by both source commit and bytes. Absent or changed files are fetched
 * only with `download` (the check's --download flag); otherwise this fails and names them. The barn lamp's files live
 * in the production assets' cache.
 */
export async function cachedLobeAssets({
  download = false,
  root = resolve('test-results/materials-lobe-assets'),
  productionRoot,
  command = 'node scripts/material-extension-tests.js',
} = {}) {
  const rows = pins.map(([file, size, sha256]) => ({
    file,
    path: resolve(root, ...file.split('/')),
    url: sampleAssetBase + file,
    size,
    sha256,
  }));
  const read = await pinnedFiles(rows, { command, download });
  const files = rows.map(({ file, url, size, sha256 }, i) => ({
    path: file,
    url,
    bytes: size,
    sha256,
    data: read[i],
  }));
  files.push(
    ...(await cachedProductionAssets({
      download,
      command,
      root: productionRoot,
      only: (file) => file.startsWith('AnisotropyBarnLamp/'),
    })),
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    resolve(root, 'source-manifest.json'),
    JSON.stringify(
      { commit: sampleAssetCommit, models: lobeProductionAssets, files: files.map(({ data, ...entry }) => entry) },
      null,
      2,
    ) + '\n',
  );
  return files;
}
