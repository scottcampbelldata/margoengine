import { declarePackageCore } from './core-requirements.mjs';
import { stripPackageShaderComments } from './shader-comments.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { packageDeclarations } from './package-declarations.js';
import { copyLegal } from './package-legal.js';
import { distDir, tsconfigFor } from './support/dist-dir.mjs';
import { withMathExternal } from './support/math-external.mjs';

const name = process.argv[2];
assert.ok(['dof', 'tonemap'].includes(name), 'Expected dof or tonemap');
const repository = fileURLToPath(new URL('..', import.meta.url)),
  root = resolve(repository, 'packages', name);
// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(root);
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const entries = Object.fromEntries(
  Object.values(manifest.exports).map((entry) => {
    const module = entry.import.slice('./dist/'.length, -'.js'.length);
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
    lib: { entry: entries, formats: ['es'], fileName: (_format, module) => module + '.js' },
    rollupOptions: { external: withMathExternal(manifest, ['@margoengine/core', '@margoengine/core/extension']) },
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
