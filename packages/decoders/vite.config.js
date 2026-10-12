import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {defineConfig} from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(root, '../..');
export default defineConfig({
  root,
  cacheDir: resolve(root, 'test-results/.vite'),
  resolve: {alias: [{find: /^@margoengine\/decoders$/, replacement: resolve(root, 'dist/index.js')}]},
  server: {host: '127.0.0.1', fs: {allow: [repository]}},
});
