import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(root, '../..');
// Keep the external-install override; default to the monorepo test dependency.
const rapier = process.env.MARGOENGINE_RAPIER
  ? resolve(process.env.MARGOENGINE_RAPIER)
  : resolve(repository, 'node_modules/@dimforge/rapier3d-compat');
const rapierEntry =
  rapier && existsSync(resolve(rapier, 'dist/rapier.mjs')) ? resolve(rapier, 'dist/rapier.mjs') : null;
export default defineConfig({
  root,
  cacheDir: resolve(root, 'test-results/.vite'),
  resolve: {
    alias: [
      { find: /^@margoengine\/core\/extension$/, replacement: resolve(repository, 'packages/core/dist/extension.js') },
      { find: /^@margoengine\/core$/, replacement: resolve(repository, 'packages/core/dist/index.js') },
      { find: /^@margoengine\/physics$/, replacement: resolve(root, 'dist/index.js') },
      ...(rapierEntry ? [{ find: /^@dimforge\/rapier3d-compat$/, replacement: rapierEntry }] : []),
    ],
  },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', fs: { allow: [repository, ...(rapier ? [rapier] : [])] } },
});
