// Builds the page into dist/, with the models and JPEG XL files it opens. Run from the repository root after build:packages.
import { build } from 'vite';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = import.meta.dirname,
  repo = resolve(root, '../../..'),
  out = resolve(root, 'dist');
await build({ root, base: './', configFile: false, logLevel: 'warn', publicDir: false, worker: { format: 'es' },
  build: { outDir: out, emptyOutDir: true, target: 'es2022', minify: false, assetsInlineLimit: 0 } });
mkdirSync(out + '/m', { recursive: true });
mkdirSync(out + '/jxl', { recursive: true });
for (const model of ['khronos/Fox/Fox', 'khronos/Lantern/Lantern', 'khronos/ToyCar/ToyCar', 'robot-expressive', 'khronos/MetalRoughSpheres/MetalRoughSpheres'])
  cpSync(`${repo}/examples/assets/${model}.glb`, `${out}/m/${model.split('/').pop()}.glb`);
const jxl = `${repo}/packages/decoders/tests/fixtures/jxl`;
for (const name of readdirSync(jxl)) if (/\.(jxl|json)$/.test(name)) cpSync(`${jxl}/${name}`, `${out}/jxl/${name}`);
