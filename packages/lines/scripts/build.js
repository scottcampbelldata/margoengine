import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { stripPackageShaderComments } from '../../../scripts/shader-comments.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';
import { distDir, tsconfigFor } from '../../../scripts/support/dist-dir.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(root);
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
    lib: {
      entry: {
        index: resolve(root, 'src/index.ts'),
        tiles: resolve(root, 'src/tiles.ts'),
        edges: resolve(root, 'src/edges.ts'),
        pick: resolve(root, 'src/pick.ts'),
        trail: resolve(root, 'src/trail.ts'),
        flow: resolve(root, 'src/flow.ts'),
        'infinite-grid': resolve(root, 'src/infinite-grid.ts'),
        'tree-helpers': resolve(root, 'src/tree-helpers.ts'),
        batch: resolve(root, 'src/batch.ts'),
        hidden: resolve(root, 'src/hidden.ts'),
        stroke: resolve(root, 'src/stroke.ts'),
        texture: resolve(root, 'src/texture.ts'),
        debug: resolve(root, 'src/debug.ts'),
      },
      formats: ['es'],
      fileName: (_, name) => name + '.js',
    },
    rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'] },
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
