import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { stripPackageShaderComments } from '../../../scripts/shader-comments.mjs';
import { copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';
import { distDir, tsconfigFor } from '../../../scripts/support/dist-dir.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(root);
const exposeSchoolWasmUrl = {
  name: 'expose-school-wasm-url',
  renderChunk(code) {
    if (!code.includes('school-kernel.wasm?')) return null;
    return {
      code: code.replace(/\/\*\s*@vite-ignore\s*\*\/\s*(?=["']\.\/school-kernel\.wasm\?no-inline["'])/g, ''),
      map: null,
    };
  },
};
await copyLegal(root);
// The solver is Margo's own Rust kernel, shipped as a deflated blueprint inside src/wasm.ts (rebuilt by
// scripts/build-kernel.mjs), so the package has no Wasm file of its own and no third-party code.
await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  plugins: [exposeSchoolWasmUrl],
  build: {
    outDir: dist,
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: {
        index: resolve(root, 'src/index.ts'),
        decomposition: resolve(root, 'src/decomposition.ts'),
        soft: resolve(root, 'src/soft.ts'),
        meshfiles: resolve(root, 'src/meshfiles.ts'),
        robots: resolve(root, 'src/robots.ts'),
        world: resolve(root, 'src/world/index.ts'),
        earth: resolve(root, 'src/earth/index.ts'),
        clouds: resolve(root, 'src/clouds/index.ts'),
        flight: resolve(root, 'src/flight.ts'),
        waves: resolve(root, 'src/waves/index.ts'),
        sea: resolve(root, 'src/sea/index.ts'),
        seakeeping: resolve(root, 'src/seakeeping/index.ts'),
        celestial: resolve(root, 'src/space/index.ts'),
        schooling: resolve(root, 'src/schooling/index.ts'),
        tracers: resolve(root, 'src/tracers.ts'),
        thermal: resolve(root, 'src/thermal.ts'),
        hydro: resolve(root, 'src/hydro/index.ts'),
      },
      formats: ['es'],
      fileName: (_, entry) => `${entry}.js`,
    },
    rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'] },
  },
});
await copyFile(resolve(root, 'src/schooling/school-kernel.wasm'), resolve(dist, 'school-kernel.wasm'));
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', tsconfigFor(root, dist)],
  { stdio: 'inherit' },
);
// Copy the shared declarations the emitted .d.ts files reference into dist, so the packed package type-checks.
await packageDeclarations(root);
await copyFile(resolve(root, 'src/thermal/thermal-kernel.wasm'), resolve(dist, 'thermal-kernel.wasm'));
await copyFile(resolve(root, 'src/thermal/thermal-kernel-shared.wasm'), resolve(dist, 'thermal-kernel-shared.wasm'));

await declarePackageCore(root);
await stripPackageShaderComments(root);
