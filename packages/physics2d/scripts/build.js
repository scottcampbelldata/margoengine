import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { stripPackageShaderComments } from '../../../scripts/shader-comments.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';
import { distDir, tsconfigFor } from '../../../scripts/support/dist-dir.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(root);
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const peers = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
await copyLegal(root);
// The kernel's Wasm is the committed blueprint src/physics2d-kernel.wasm (scripts/build-kernel.mjs builds it from
// kernel/, so this build needs no Rust toolchain). It is copied beside the lazy chunk as dist/physics2d.wasm, and the
// chunk learns its interface version and a hash of its exports and imports, so it can tell it from any other Wasm.
const kernelFile = resolve(root, 'src/physics2d-kernel.wasm');
// The scalar build, for engines without Wasm SIMD, is a file of its own beside it (dist/physics2d-scalar.wasm).
const scalarFile = resolve(root, 'src/physics2d-kernel-scalar.wasm');
const kernelBytes = readFileSync(kernelFile);
const kernelModule = new WebAssembly.Module(kernelBytes);
// The same hash src/wasm-load.ts takes of a Wasm it is given: FNV-1a over the module's exports and imports.
const kernelInterface = (() => {
  const text =
    WebAssembly.Module.exports(kernelModule).map((entry) => `${entry.kind}:${entry.name}`).join(',') +
    '|' +
    WebAssembly.Module.imports(kernelModule).map((entry) => `${entry.kind}:${entry.module}:${entry.name}`).join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
})();
const scalarModule = new WebAssembly.Module(readFileSync(scalarFile));
const interfaceOf = (module) => {
  const text =
    WebAssembly.Module.exports(module).map((entry) => `${entry.kind}:${entry.name}`).join(',') +
    '|' +
    WebAssembly.Module.imports(module).map((entry) => `${entry.kind}:${entry.module}:${entry.name}`).join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
};
if (interfaceOf(scalarModule) !== kernelInterface)
  throw new Error('The scalar kernel has other exports or imports than the SIMD one; rebuild both with node packages/physics2d/scripts/build-kernel.mjs.');
const kernelVersion = String(new WebAssembly.Instance(kernelModule, { env: { hook_filter: () => 1, hook_contact: () => 0 } }).exports.api_version());
// The source marks the Wasm URL @vite-ignore so this build leaves it alone; the app's bundler must see it.
const exposeWasmUrl = {
  name: 'expose-wasm-url',
  renderChunk(code) {
    if (!code.includes('physics2d.wasm?') && !code.includes('physics2d-scalar.wasm?')) return null;
    return { code: code.replace(/\/\*\s*@vite-ignore\s*\*\/\s*(?=["']\.\/physics2d(?:-scalar)?\.wasm\?no-inline["'])/g, ''), map: null };
  },
};
await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  plugins: [exposeWasmUrl],
  define: { __KERNEL_VERSION__: JSON.stringify(kernelVersion), __KERNEL_INTERFACE__: String(kernelInterface) },
  build: {
    outDir: dist,
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: {
        index: resolve(root, 'src/index.ts'),
        outline: resolve(root, 'src/outline.ts'),
      },
      formats: ['es'],
      fileName: (_, entry) => `${entry}.js`,
    },
    // Peers and dependencies (core, geometry) stay imports.
    rollupOptions: {
      external: (id) => peers.some((peer) => id === peer || id.startsWith(peer + '/')),
    },
  },
});
await copyFile(kernelFile, resolve(dist, 'physics2d.wasm'));
await copyFile(scalarFile, resolve(dist, 'physics2d-scalar.wasm'));
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', tsconfigFor(root, dist)],
  { stdio: 'inherit' },
);
// Copy the shared declarations the emitted .d.ts files reference into dist, so the packed package type-checks.
await packageDeclarations(root);

await declarePackageCore(root);
await stripPackageShaderComments(root);
