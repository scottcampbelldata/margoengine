import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { stripPackageShaderComments } from '../../../scripts/shader-comments.mjs';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';
import { distDir, tsconfigFor } from '../../../scripts/support/dist-dir.mjs';
import { withMathExternal } from '../../../scripts/support/math-external.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(root);
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const entry = Object.fromEntries(
  Object.values(manifest.exports).map(({ import: target }) => {
    assert.ok(/^\.\/dist\/[\w-]+\.js$/.test(target), 'Unsupported package entry: ' + target);
    const module = target.slice('./dist/'.length, -'.js'.length);
    return [module, resolve(root, 'src', module + '.ts')];
  }),
);
await copyLegal(root);
await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: dist,
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry, formats: ['es'], fileName: (_, name) => name + '.js' },
    rollupOptions: {
      external: withMathExternal(manifest, [
        '@margoengine/post/stack',
        '@margoengine/sky/planet',
        '@margoengine/scatter/interact',
        '@margoengine/core',
        '@margoengine/core/extension',
        '@margoengine/vfx/base',
        '@margoengine/vfx/obstacles',
        '@margoengine/vfx/wrap',
        '@margoengine/vfx/sort',
        '@margoengine/vfx/texture',
      ]),
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
