import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { stripPackageShaderComments } from '../../../scripts/shader-comments.mjs';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';
import { distDir, tsconfigFor } from '../../../scripts/support/dist-dir.mjs';
import { packageExternal, sharedHelpers } from '../../../scripts/support/math-external.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(root);
await copyLegal(root);
// One entry per package.json export: ./dist/<name>.js is built from src/<name>.ts.
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const entry = Object.fromEntries(
  Object.values(manifest.exports).map(({ import: target }) => {
    const name = target.slice('./dist/'.length, -'.js'.length);
    return [name, resolve(root, 'src', name + '.ts')];
  }),
);
await build({
  root,
  configFile: false,
  // The shared error and hypot helpers come from @margoengine/math/helpers, not a copy (KB-INL1).
  plugins: [sharedHelpers(manifest)],
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: dist,
    emptyOutDir: true,
    target: 'es2022',
    // Modules several entries use (Controls, OrbitControls) become shared chunks.
    lib: {
      entry,
      formats: ['es'],
      fileName: (_, name) => `${name}.js`,
    },
    rollupOptions: {
      external: packageExternal(root, [
        '@margoengine/core',
        '@margoengine/core/extension',
        '@margoengine/bvh',
        '@margoengine/tween',
      ]),
    },
  },
});
// The packed EGM96 grid of the geoid entry ships beside it when it has been made (scripts/geoid/pack-egm96.mjs).
const geoidGrid = resolve(root, 'data/egm96-15.bin');
if (existsSync(geoidGrid)) await copyFile(geoidGrid, resolve(dist, 'egm96-15.bin'));
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', tsconfigFor(root, dist)],
  { stdio: 'inherit' },
);
// Copy the shared declarations the emitted .d.ts files reference into dist, so the packed package type-checks.
await packageDeclarations(root);

await declarePackageCore(root);
await stripPackageShaderComments(root);
