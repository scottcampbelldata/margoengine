import { execFileSync } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { buildWorkers } from '../../../scripts/build-workers.js';

// Plain TypeScript emit: one ES module per loader, so a bundler keeps only the parsers an app imports.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await copyFile(resolve(repository, 'LICENSE'), resolve(root, 'LICENSE'));
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);
// The worker client is the one module that imports packages/shared: bundle that in, keep the sibling loaders as imports.
await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    lib: { entry: resolve(root, 'src/worker.ts'), formats: ['es'], fileName: () => 'worker.js' },
    rollupOptions: { external: (id) => /^\.\/[\w-]+\.js$/.test(id) },
  },
});
await rm(resolve(root, 'dist/usd.worker.js'));
await buildWorkers(root);
