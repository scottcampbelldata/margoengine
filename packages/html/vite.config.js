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
      { find: /^@margoengine\/labels$/, replacement: resolve(repository, 'packages/labels/dist/index.js') },
      { find: /^@margoengine\/webgl2-compat\/preview$/, replacement: resolve(repository, 'packages/webgl2-compat/dist/preview.js') },
      { find: /^@margoengine\/html\/texture$/, replacement: resolve(root, 'dist/texture.js') },
      { find: /^@margoengine\/html\/texture-gl$/, replacement: resolve(root, 'dist/texture-gl.js') },
      { find: /^@margoengine\/html\/blend$/, replacement: resolve(root, 'dist/blend.js') },
      { find: /^@margoengine\/html\/inline$/, replacement: resolve(root, 'dist/inline.js') },
      { find: /^@margoengine\/html$/, replacement: resolve(root, 'dist/index.js') },
    ],
  },
  server: { host: '127.0.0.1', fs: { allow: [repository] } },
});
