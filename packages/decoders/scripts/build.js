import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { staticEmbind } from '../../../scripts/static-embind.js';
import { packageDeclarations, packageRuntime } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';
import { NATIVE_FEATURES, buildNative } from './build-native.mjs';

// Plain TypeScript emit keeps every `new URL('./…', import.meta.url)` literal intact, so the consuming app's
// bundler (Vite, webpack 5, Next.js) emits the worker and the Wasm decoders as its own assets.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await copyLegal(root);
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);
// Copy the shared declarations the emitted .d.ts files reference into dist, so the packed package type-checks.
await packageDeclarations(root);
// The clean-room native decoders ship as committed blueprints (scripts/build-native.mjs builds them from native/), so
// building the package needs no Rust toolchain. A from-source root build (`node scripts/build-modern.js` without
// --precompiled) sets MARGOENGINE_WASM_FROM_SOURCE=1 and rebuilds them first, as does `--from-source` here.
if (process.env.MARGOENGINE_WASM_FROM_SOURCE === '1' || process.argv.includes('--from-source'))
  for (const feature of Object.keys(NATIVE_FEATURES)) await buildNative(feature);
for (const { file } of Object.values(NATIVE_FEATURES)) await copyFile(resolve(root, 'src', file), resolve(dist, file));
for (const worker of ['draco-native', 'hdr6', 'avif']) {
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: dist,
      emptyOutDir: false,
      minify: true,
      target: 'es2022',
      lib: {
        entry: resolve(root, `src/${worker}.worker.ts`),
        name: 'MargoNativeWorker',
        formats: ['iife'],
        fileName: () => `${worker}.worker.js`,
      },
    },
  });
}
// The worker replaces tsc's module emit with one self-contained classic script, so it can importScripts the wrappers.
await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: dist,
    emptyOutDir: false,
    minify: true,
    target: 'es2022',
    lib: {
      entry: resolve(root, 'src/decoder.worker.ts'),
      name: 'MargoDecoderWorker',
      formats: ['iife'],
      fileName: () => 'decoder.worker.js',
    },
  },
});
for (const folder of ['draco', 'draco-full', 'basis', 'jxl']) {
  await mkdir(resolve(dist, folder), { recursive: true });
  for (const file of await readdir(resolve(root, 'vendor', folder)))
    await copyFile(resolve(root, 'vendor', folder, file), resolve(dist, folder, file));
}
// The Basis transcoder's embind wrappers would need 'unsafe-eval'; ship the closure form instead (scripts/static-embind.js).
// Node loads the Emscripten wrapper with require, so its folder is CommonJS.
await writeFile(resolve(dist, 'basis/package.json'), '{ "type": "commonjs" }\n');
const basis = resolve(dist, 'basis/basis_transcoder.js');
await writeFile(basis, staticEmbind(await readFile(basis, 'utf8'), 'basis_transcoder.js'));
await copyFile(resolve(root, 'vendor/NOTICE.md'), resolve(dist, 'THIRD-PARTY-NOTICE.md'));
// The PNG reader's shared helpers ship in dist/shared (dist/errors.js is the package's own).
await mkdir(resolve(dist, 'shared'), { recursive: true });
for (const name of ['crc32', 'errors', 'inflate', 'png', 'zstd'])
  await copyFile(resolve(repository, `packages/shared/${name}.js`), resolve(dist, `shared/${name}.js`));
// The TIFF reader shares the zlib inflater for its Deflate strips.
for (const name of ['brotli', 'png', 'tiff', 'ktx2-file', 'ktx2-inflate', 'xz']) {
  const file = resolve(dist, `${name}.js`);
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('../../shared/', './shared/'));
}
await copyFile(resolve(root, 'vendor/LICENSE-Apache-2.0.txt'), resolve(dist, 'LICENSE-Apache-2.0.txt'));

// Bundle shared runtime helpers into the packed package, including Wasm policy errors.
await packageRuntime(root);

await declarePackageCore(root);
