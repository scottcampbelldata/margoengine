// The Rapier-backed `Physics` the comparison tests hold the kernel against. It is test code (tests/oracle/src, the wrapper
// this package had while Rapier was its solver) and is built to tests/oracle/dist, which nothing ships. Rapier itself
// is a root devDependency the tests load; no package source or built file imports it.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: resolve(root, 'tests/oracle/dist'),
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: resolve(root, 'tests/oracle/src/index.ts'), formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: [/^@margoengine\//] },
  },
});
