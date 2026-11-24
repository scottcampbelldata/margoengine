import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(root, '../..');
export default defineConfig({
  root,
  cacheDir: resolve(root, 'test-results/.vite'),
  resolve: {
    alias: [
      { find: /^@margoengine\/core\/extension$/, replacement: resolve(repository, 'packages/core/dist/extension.js') },
      { find: /^@margoengine\/core$/, replacement: resolve(repository, 'packages/core/dist/index.js') },
      { find: /^@margoengine\/controls$/, replacement: resolve(root, 'dist/index.js') },
      { find: /^@margoengine\/controls\/walk$/, replacement: resolve(root, 'dist/walk.js') },
      { find: /^@margoengine\/controls\/arcball$/, replacement: resolve(root, 'dist/arcball.js') },
      { find: /^@margoengine\/webgl2-compat\/preview$/, replacement: resolve(repository, 'packages/webgl2-compat/dist/preview.js') },
    ],
  },
  server: { host: '127.0.0.1', fs: { allow: [repository] } },
});
