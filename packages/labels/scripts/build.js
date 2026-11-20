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
        declutter: resolve(root, 'src/declutter.ts'),
        callouts: resolve(root, 'src/callouts.ts'),
        gpu: resolve(root, 'src/gpu.ts'),
        distance: resolve(root, 'src/distance.ts'),
        cluster: resolve(root, 'src/cluster.ts'),
        'callouts-route': resolve(root, 'src/callouts-route.ts'),
      },
      formats: ['es'],
      fileName: (_, name) => name + '.js',
    },
    rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
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
