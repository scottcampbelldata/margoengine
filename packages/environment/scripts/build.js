import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';

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
  ['main', false],
  ['loaders', false],
  ['blend', false],
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
      lib: { entry: resolve(root, `src/${entry}.ts`), formats: ['es'], fileName: entry },
      // index.js only re-exports dist/main.js and dist/loaders.js (src/main.ts), and every entry reaches the image
      // decoders through dist/loaders.js, which EnvironmentLighting.load imports on its first URL.
      rollupOptions: {
        external: (id) =>
          id === '@margoengine/core' ||
          id === '@margoengine/core/extension' ||
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
