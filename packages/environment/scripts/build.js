import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { restoreWorkerUrls } from '../../../scripts/build-workers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
await copyLegal(root);
// One self-contained build per entry, so the optional entries share no chunk with (and never change) the root; the
// image decoders alone are one file every entry imports (dist/loaders.js).
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
  ['blend', false],
  ['ground', false],
  ['gi', false],
  ['fog-volumes', false],
  ['studio', false],
  ['prefiltered', false],
  ['reflector-pbr', false],
  ['exr-codecs', false],
  ['exr-codecs-worker', false],
])
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: resolve(root, 'dist'),
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
          (id === './main.js' && entry === 'index'),
      },
    },
  });
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);
// Copy the shared declarations the emitted .d.ts files reference into dist, so the packed package type-checks.
await packageDeclarations(root);

await declarePackageCore(root);
await mkdir(resolve(root, 'dist/vendor/exr-codecs'), { recursive: true });
for (const name of ['exrview.js', 'exrview.wasm', 'LICENSE.txt', 'ThirdPartyNotices.txt'])
  await copyFile(resolve(root, 'vendor/exr-codecs', name), resolve(root, 'dist/vendor/exr-codecs', name));
await copyFile(resolve(root, 'vendor/exr-codecs/exrview.js'), resolve(root, 'dist/vendor/exr-codecs/exrview.cjs'));
// ESM export adapter around unchanged prebuilt decoder glue for module workers.
await writeFile(
  resolve(root, 'dist/vendor/exr-codecs/exrview.mjs'),
  (await readFile(resolve(root, 'vendor/exr-codecs/exrview.js'), 'utf8')) + '\nexport default createExrViewModule;\n',
);
await restoreWorkerUrls(resolve(root, 'dist'));
