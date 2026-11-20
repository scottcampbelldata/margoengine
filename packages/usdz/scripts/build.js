import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { stripPackageShaderComments } from '../../../scripts/shader-comments.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { copyLegal } from '../../../scripts/package-legal.js';
import { distDir, tsconfigFor } from '../../../scripts/support/dist-dir.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)),
  repository = resolve(root, '../..');
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
    lib: { entry: resolve(root, 'src/index.ts'), formats: ['es'], fileName: 'index' },
    rollupOptions: { external: ['@margoengine/core', '@margoengine/gltf/pbr', '@margoengine/loaders'] },
  },
});
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', tsconfigFor(root, dist)],
  { stdio: 'inherit' },
);

await declarePackageCore(root);
await stripPackageShaderComments(root);
