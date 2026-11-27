import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pinnedFiles } from './pinned-files.mjs';

export const sampleAssetCommit = 'edc7c9e67c639d230715049ee31f9a96a6babbbe';
export const sampleAssetBase = `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/${sampleAssetCommit}/Models/`;
export const productionAssets = [
  {
    name: 'TextureTransformMultiTest',
    path: 'TextureTransformMultiTest/glTF-Binary/TextureTransformMultiTest.glb',
    kind: 'transform',
    attribution: 'Ed Mackey / Analytical Graphics, Inc., 2020, CC BY 4.0',
    readme: `${sampleAssetBase}TextureTransformMultiTest/README.md`,
  },
  {
    name: 'AnisotropyBarnLamp',
    path: 'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp.gltf',
    kind: 'ktx2',
    attribution: 'Eric Chadwick / Wayfair, LLC, 2023, CC BY 4.0',
    readme: `${sampleAssetBase}AnisotropyBarnLamp/README.md`,
  },
];
const pins = [
  [
    'TextureTransformMultiTest/glTF-Binary/TextureTransformMultiTest.glb',
    388264,
    '569aedb53822d5721e7e06af5983348683d4b2ffb1d469338ad4f02bf6a74911',
  ],
  [
    'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp.gltf',
    6979,
    '71a528dfc329c6df9f3651d2fdbaf4ea5ee5e8dab668596f126bc7c2425c4543',
  ],
  [
    'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp.bin',
    409580,
    '50f196f7613c3cf40886c0058c8f4a51f6118d5654879f41bb2fcdb5ba989871',
  ],
  [
    'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp_anisotropy.ktx2',
    1017986,
    '4f2ee6ad27b50eb1497c73369d42154234c23d06292d4163cb61c0e65a02c68a',
  ],
  [
    'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp_basecolor.ktx2',
    2127072,
    '9887c98d487f2415f9221f37c14f185edfded7c9438e83ce75a753ae27a4ae53',
  ],
  [
    'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp_normalbump.ktx2',
    91214,
    'c04db9be21ca5f2d57c86854b9608c240e13b47e7d7329b696b62a79b262f839',
  ],
  [
    'AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp_occlusionroughnessmetal.ktx2',
    1572895,
    '73a1ba6dfa0fbf1b1edc158b119623acbff894d62ce5ac3edaa20bedfe812383',
  ],
];

/**
 * The complete, unmodified files, read from the cache. Absent or changed files are fetched only with `download` (the
 * check's --download flag); otherwise this fails and names them. `only` picks files by their path.
 */
export async function cachedProductionAssets({
  download = false,
  root = resolve('test-results/gltf-production-assets'),
  command = 'node scripts/gltf-production-assets-tests.js',
  only = () => true,
} = {}) {
  const rows = pins
    .filter(([file]) => only(file))
    .map(([file, size, sha256]) => ({
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
  await mkdir(root, { recursive: true });
  await writeFile(
    resolve(root, 'source-manifest.json'),
    JSON.stringify(
      { commit: sampleAssetCommit, models: productionAssets, files: files.map(({ data, ...entry }) => entry) },
      null,
      2,
    ) + '\n',
  );
  return files;
}
