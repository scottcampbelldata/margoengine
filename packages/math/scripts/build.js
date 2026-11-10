import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
// One entry per export (like packages/creative) so `@margoengine/math/vector3` ships only Vector3.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
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
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry, formats: ['es'], fileName: (_, name) => name + '.js' },
    rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'] },
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
