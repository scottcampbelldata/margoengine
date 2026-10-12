import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

// Source aliases make the first launch independent of generated package dist files.
const names = ['sky', 'shadows', 'geometry', 'procedural', 'scatter', 'water', 'vfx', 'input', 'cinematic', 'post', 'stats', 'lines'];
export default defineConfig({
  resolve: {alias: [
    {find: '@margoengine/core/extension', replacement: fileURLToPath(new URL('../../packages/core/src/extension.ts', import.meta.url))},
    {find: '@margoengine/core', replacement: fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url))},
    ...names.map(name => ({find: `@margoengine/${name}`, replacement: fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url))})),
  ]},
  server: {host: '127.0.0.1'},
  build: {target: 'es2022'},
});
