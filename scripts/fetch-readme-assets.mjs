// Required public standard samples only; implementations are never downloaded.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchFixture } from './support/fetch-fixture.mjs';

export const readmeCache = () =>
  resolve(process.env.MARGO_README_SAMPLES ?? resolve(import.meta.dirname, '../../engine-bench/readme-samples'));
const corpus = JSON.parse(
  readFileSync(new URL('../packages/loaders/tests/real-files/manifest.json', import.meta.url), 'utf8'),
).files;
export const readmeDownloads = [
  '3ds-nasa',
  'lwo-nasa',
  'md2-dolphin',
  'amf-rook',
  'pdb-crambin',
  'kmz-macky',
  'lottie-twitterheart',
  'stl-binary-3dsmax',
  'svg-inkscape',
  '3mf-textures',
  'dae-maya-skin',
  'tmx-objects',
  'obj-mtl-doorman',
  'laz-format10',
].flatMap((id) => {
  const item = corpus.find((file) => file.id === id);
  if (!item) throw new Error(`Missing README source record: ${id}`);
  return [item, ...(item.companions ?? [])].map((file) => ({
    ...file,
    licence: item.licence,
    local: `${id}/${file.file}`,
  }));
});
for (const file of JSON.parse(readFileSync(new URL('./support/readme-companions.json', import.meta.url), 'utf8'))) {
  readmeDownloads.push({ ...file, licence: 'Apache-2.0 (PyVista vtk-data)', local: `obj-mtl-doorman/${file.file}` });
}
readmeDownloads.push({
  local: 'smoke.vdb',
  url: 'https://media.githubusercontent.com/media/AcademySoftwareFoundation/openvdb-website/3d8fd4d3f2d670464f4390e2775cfc87274233dc/download/models/smoke.vdb',
  sha256: '735c22eecf8b498aa0c0c7a4098ea4f2c4ad1f63bf601c278094020301093ac9',
  size: 2594500,
  licence: 'CC-BY-4.0 (OpenVDB website LICENSE.txt)',
});

export async function fetchReadmeAssets() {
  for (const item of readmeDownloads) {
    await fetchFixture(item.url, resolve(readmeCache(), item.local), item.sha256, { maxBytes: item.size ?? 32 << 20 });
    console.log(`README sample: ${item.local} (${item.licence})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await fetchReadmeAssets();
