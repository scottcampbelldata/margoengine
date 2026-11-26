import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { stripPackageShaderComments } from '../../../scripts/shader-comments.mjs';
import { copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
const exposeOptionalWasmUrl = {
  name: 'expose-optional-wasm-url',
  renderChunk(code) {
    if (!code.includes('-kernel.wasm') && !code.includes('-kernel-shared.wasm')) return null;
    return {
      code: code.replace(
        /\/\*\s*@vite-ignore\s*\*\/\s*(?=["']\.\/(?:school|swim|falling|pedestrian|landscape)-kernel(?:-shared)?\.wasm\?no-inline["'])/g,
        '',
      ),
      map: null,
    };
  },
};
await copyLegal(root);
// The solver is Margo's own Rust kernel, shipped as a deflated blueprint inside src/wasm.ts (rebuilt by
// scripts/build-kernel.mjs). Optional family kernels load their own Wasm only when requested.
await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  plugins: [exposeOptionalWasmUrl],
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
        falling: resolve(root, 'src/falling.ts'),
        flight: resolve(root, 'src/flight.ts'),
        waves: resolve(root, 'src/waves/index.ts'),
        sea: resolve(root, 'src/sea/index.ts'),
        seakeeping: resolve(root, 'src/seakeeping/index.ts'),
        celestial: resolve(root, 'src/space/index.ts'),
        schooling: resolve(root, 'src/schooling/index.ts'),
        life: resolve(root, 'src/life/index.ts'),
        pedestrians: resolve(root, 'src/pedestrians/index.ts'),
        tracers: resolve(root, 'src/tracers.ts'),
        thermal: resolve(root, 'src/thermal.ts'),
        hydro: resolve(root, 'src/hydro/index.ts'),
        foam: resolve(root, 'src/foam/index.ts'),
        runoff: resolve(root, 'src/runoff/index.ts'),
        sediment: resolve(root, 'src/sediment/index.ts'),
        landscape: resolve(root, 'src/landscape/index.ts'),
        vegetation: resolve(root, 'src/vegetation.ts'),
        ice: resolve(root, 'src/ice/index.ts'),
        underwater: resolve(root, 'src/underwater/index.ts'),
        orbit: resolve(root, 'src/orbit/index.ts'),
      },
      formats: ['es'],
      fileName: (_, entry) => `${entry}.js`,
    },
    rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'] },
  },
});
for (const name of ['school-kernel.wasm', 'school-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/schooling', name), resolve(dist, name));
for (const name of ['swim-kernel.wasm', 'swim-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/life', name), resolve(dist, name));
for (const name of ['pedestrian-kernel.wasm', 'pedestrian-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/pedestrians', name), resolve(dist, name));
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', tsconfigFor(root, dist)],
  { stdio: 'inherit' },
);
// Copy the shared declarations the emitted .d.ts files reference into dist, so the packed package type-checks.
await packageDeclarations(root);
await copyFile(resolve(root, 'src/thermal/thermal-kernel.wasm'), resolve(dist, 'thermal-kernel.wasm'));
await copyFile(resolve(root, 'src/thermal/thermal-kernel-shared.wasm'), resolve(dist, 'thermal-kernel-shared.wasm'));
await copyFile(resolve(root, 'src/runoff/runoff-kernel.wasm'), resolve(dist, 'runoff-kernel.wasm'));
await copyFile(resolve(root, 'src/runoff/runoff-kernel-shared.wasm'), resolve(dist, 'runoff-kernel-shared.wasm'));
await copyFile(resolve(root, 'src/sediment/sediment-kernel.wasm'), resolve(dist, 'sediment-kernel.wasm'));
await copyFile(resolve(root, 'src/sediment/sediment-kernel-shared.wasm'), resolve(dist, 'sediment-kernel-shared.wasm'));
await copyFile(resolve(root, 'src/orbit/orbit-kernel.wasm'), resolve(dist, 'orbit-kernel.wasm'));
await copyFile(resolve(root, 'src/orbit/orbit-kernel-shared.wasm'), resolve(dist, 'orbit-kernel-shared.wasm'));
await copyFile(resolve(root, 'src/landscape/landscape-kernel.wasm'), resolve(dist, 'landscape-kernel.wasm'));
await copyFile(
  resolve(root, 'src/landscape/landscape-kernel-shared.wasm'),
  resolve(dist, 'landscape-kernel-shared.wasm'),
);
await copyFile(resolve(root, 'src/vegetation-kernel.wasm'), resolve(dist, 'vegetation-kernel.wasm'));
await copyFile(resolve(root, 'src/vegetation-kernel-shared.wasm'), resolve(dist, 'vegetation-kernel-shared.wasm'));

for (const name of ['falling-kernel.wasm', 'falling-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/falling', name), resolve(dist, name));

await declarePackageCore(root);
await stripPackageShaderComments(root);
