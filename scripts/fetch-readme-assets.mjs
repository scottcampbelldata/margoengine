// Required public standard samples only; implementations are never downloaded.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchFixture } from './support/fetch-fixture.mjs';
import { externalAssets, externalAssetRoot } from './support/external-test-assets.mjs';

// Shared required assets keep one cache and one source/hash record for verify and README execution.
export const readmeExternalFiles = { '/model.usdz': 'usdz-static/BoxTextured.blender.usdz' };
// Preserve the complete folder and all its relative links, including the JSON named cloud.js.
for (const { file } of externalAssets.filter(({ file }) => file.startsWith('potree-lion/'))) {
  readmeExternalFiles[`/scans/site/${file.slice('potree-lion/'.length)}`] = file;
}

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
  'pcx-pil184',
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
readmeDownloads.push({
  local: 'brotli/alice29.txt.compressed',
  url: 'https://raw.githubusercontent.com/google/brotli/d89c4b1c52e25ddafe047bc78bbee5c1e24b1809/tests/testdata/alice29.txt.compressed',
  sha256: '69e902ef5cd9247302e4f66c313271bcff32eeb38e5eec7ca7744cf98106d5c2',
  size: 50096,
  licence: 'MIT (Brotli test data); Alice in Wonderland text public domain',
});

readmeDownloads.push({
  local: 'e57-room/room-scan-two-stations.e57',
  url: 'https://files.innerscene.com/library/room-scan-two-stations-cfa3398f/44e9f80fab5e8c710ff3/room-scan-two-stations.e57',
  sha256: '5c2d803ad56c83b689d9d9b9801e2f64d5a7ee6c58bad7d5a902337d2d3211fa',
  size: 2069504,
  licence: 'CC0-1.0 (Innerscene authored two-station room sample)',
});

export async function fetchReadmeAssets() {
  for (const file of Object.values(readmeExternalFiles)) {
    const item = externalAssets.find((asset) => asset.file === file);
    if (!item) throw new Error(`Missing required README external source: ${file}`);
    await fetchFixture(item.url, resolve(externalAssetRoot(), file), item.sha256, { maxBytes: item.size });
    console.log(`README shared sample: ${file} (${item.licence})`);
  }
  for (const item of readmeDownloads) {
    await fetchFixture(item.url, resolve(readmeCache(), item.local), item.sha256, { maxBytes: item.size ?? 32 << 20 });
    console.log(`README sample: ${item.local} (${item.licence})`);
  }
}

/** Optional Windows tool; the original GPL archive stays in the external cache and never ships. */
export async function fetchReadmeFFmpeg() {
  if (process.platform !== 'win32')
    throw new Error('This pinned FFmpeg build is Windows-only; install FFmpeg for your platform');
  const folder = resolve(readmeCache(), 'ffmpeg'),
    file = resolve(folder, 'ffmpeg-8.1.2-essentials_build.zip');
  await fetchFixture(
    'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip',
    file,
    'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec',
    { maxBytes: 109728040 },
  );
  const { readZipDirectory, readZipEntry } = await import('../packages/loaders/dist/common.js');
  const bytes = new Uint8Array(readFileSync(file)),
    entries = readZipDirectory(bytes);
  const executable = entries.find((entry) => entry.name.endsWith('/bin/ffmpeg.exe'));
  if (!executable) throw new Error('Pinned FFmpeg archive has no bin/ffmpeg.exe');
  const binary = await readZipEntry(bytes, executable, { maxEntryBytes: 128 << 20 });
  mkdirSync(resolve(folder, 'bin'), { recursive: true });
  writeFileSync(resolve(folder, 'bin/ffmpeg.exe'), binary);
  console.log(
    `FFmpeg GPL-3.0 tool: ${resolve(folder, 'bin/ffmpeg.exe')}; source/licence: https://www.gyan.dev/ffmpeg/builds/`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await fetchReadmeAssets();
  if (process.argv.includes('--ffmpeg')) await fetchReadmeFFmpeg();
}
