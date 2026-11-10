import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
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
    lib: {
      entry: {
        index: resolve(root, 'src/index.ts'),
        fit: resolve(root, 'src/fit.ts'),
        selection: resolve(root, 'src/selection.ts'),
        rich: resolve(root, 'src/rich.ts'),
        msdf: resolve(root, 'src/msdf.ts'),
        animate: resolve(root, 'src/animate.ts'),
        extrude: resolve(root, 'src/extrude.ts'),
      },
      formats: ['es'],
    },
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
