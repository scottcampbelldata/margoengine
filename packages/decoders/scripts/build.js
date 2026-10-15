import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {build} from 'vite';
import {staticEmbind} from '../../../scripts/static-embind.js';

// Plain TypeScript emit keeps every `new URL('./…', import.meta.url)` literal intact, so the consuming app's
// bundler (Vite, webpack 5, Next.js) emits the worker and the Wasm decoders as its own assets.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
const dist = resolve(root, 'dist');
await rm(dist, {recursive: true, force: true});
await copyFile(resolve(repository, 'LICENSE'), resolve(root, 'LICENSE'));
execFileSync(process.execPath, [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')], {stdio: 'inherit'});
// The worker replaces tsc's module emit with one self-contained classic script, so it can importScripts the wrappers.
await build({configFile: false, publicDir: false, logLevel: 'warn', build: {outDir: dist, emptyOutDir: false, minify: true, target: 'es2022',
  lib: {entry: resolve(root, 'src/decoder.worker.ts'), name: 'MargoDecoderWorker', formats: ['iife'], fileName: () => 'decoder.worker.js'}}});
for (const folder of ['draco', 'basis']) {
  await mkdir(resolve(dist, folder), {recursive: true});
  for (const file of await readdir(resolve(root, 'vendor', folder))) await copyFile(resolve(root, 'vendor', folder, file), resolve(dist, folder, file));
}
// The Basis transcoder's embind wrappers would need 'unsafe-eval'; ship the closure form instead (scripts/static-embind.js).
const basis = resolve(dist, 'basis/basis_transcoder.js');
await writeFile(basis, staticEmbind(await readFile(basis, 'utf8'), 'basis_transcoder.js'));
await copyFile(resolve(root, 'vendor/NOTICE.md'), resolve(dist, 'THIRD-PARTY-NOTICE.md'));
