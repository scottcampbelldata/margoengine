import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { stripPackageShaderComments } from '../../../scripts/shader-comments.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { restoreWorkerUrls } from '../../../scripts/build-workers.js';
import { distDir, tsconfigFor } from '../../../scripts/support/dist-dir.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(root);
await copyLegal(root);
// One self-contained build per entry, so the optional entries share no chunk with (and never change) the root; the
// image decoders alone are one file every entry imports (dist/loaders.js), which re-exports each decoder from its own
// file (dist/hdr.js, exr.js, ultrahdr.js, parse-image.js, load.js) so none is bundled twice. dist/load.js is
// loadEnvironmentImage alone, importing a decoder on first use (through dist/load-hdr.js and load-exr.js, re-exports
// of the parsers, so no import() names a file parse-image.js imports), so an app that loads one format downloads one decoder;
// loaders.js re-exports it and so keeps every decoder in its graph.
for (const [entry, emptyOutDir] of [
  ['index', true],
  ['volumetric', false],
  ['probes', false],
  ['reflector', false],
  ['refractor', false],
  ['cube-camera', false],
  ['exr-write', false],
  ['exr-tiled', false],
  ['main', false],
  ['loaders', false],
  ['load', false],
  ['load-hdr', false],
  ['load-exr', false],
  ['parse-image', false],
  ['hdr', false],
  ['exr', false],
  ['ultrahdr', false],
  ['blend', false],
  ['ground', false],
  ['gi', false],
  ['fog-volumes', false],
  ['density-volume', false],
  ['settings', false],
  ['studio', false],
  ['prefiltered', false],
  ['reflector-pbr', false],
  ['lightformer', false],
  ['exr-codecs', false],
  ['exr-codecs-worker', false],
])
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: dist,
      emptyOutDir,
      target: 'es2022',
      lib: {
        entry: resolve(root, `src/${entry}.ts`),
        formats: ['es'],
        fileName: entry === 'exr-codecs-worker' ? 'workers/exr-codecs' : entry,
      },
      // index.js only re-exports dist/main.js and dist/loaders.js (src/main.ts), and every entry reaches the image
      // decoders through dist/loaders.js, which EnvironmentLighting.load imports on its first URL.
      rollupOptions: {
        external: (id) =>
          id === '@margoengine/core' ||
          id.startsWith('node:') ||
          id === '@margoengine/core/extension' ||
          id === '@margoengine/environment' ||
          id.startsWith('@margoengine/environment/') ||
          (id === './loaders.js' && entry !== 'loaders') ||
          // EnvironmentLighting.load imports dist/load.js itself; bundled into main.js it brought its own copy of
          // every decoder as hashed chunks, one of them both imported and import()ed (KB-ENV-LOADCHUNK2).
          (id === './load.js' && entry !== 'load') ||
          (['load', 'loaders'].includes(entry) && ['./hdr.js', './exr.js', './ultrahdr.js'].includes(id)) ||
          (entry === 'load' && ['./load-hdr.js', './load-exr.js'].includes(id)) ||
          (entry === 'load-hdr' && id === './hdr.js') ||
          (entry === 'load-exr' && id === './exr.js') ||
          (entry === 'parse-image' && ['./hdr.js', './exr.js'].includes(id)) ||
          (entry === 'loaders' && id === './parse-image.js') ||
          (id === './main.js' && entry === 'index'),
      },
    },
  });
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', tsconfigFor(root, dist)],
  { stdio: 'inherit' },
);
// Copy the shared declarations the emitted .d.ts files reference into dist, so the packed package type-checks.
await packageDeclarations(root);

await declarePackageCore(root);
await stripPackageShaderComments(root);
await mkdir(resolve(dist, 'vendor/exr-codecs'), { recursive: true });
for (const name of ['exrview.js', 'exrview.wasm', 'LICENSE.txt', 'ThirdPartyNotices.txt'])
  await copyFile(resolve(root, 'vendor/exr-codecs', name), resolve(dist, 'vendor/exr-codecs', name));
await copyFile(resolve(root, 'vendor/exr-codecs/exrview.js'), resolve(dist, 'vendor/exr-codecs/exrview.cjs'));
// ESM export adapter around unchanged prebuilt decoder glue for module workers.
await writeFile(
  resolve(dist, 'vendor/exr-codecs/exrview.mjs'),
  (await readFile(resolve(root, 'vendor/exr-codecs/exrview.js'), 'utf8')) + '\nexport default createExrViewModule;\n',
);
await restoreWorkerUrls(dist);
