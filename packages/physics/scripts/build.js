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
import { packageExternal } from '../../../scripts/support/math-external.mjs';

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
        /\/\*\s*@vite-ignore\s*\*\/\s*(?=["']\.\/(?:school|swim|airborne|falling|pedestrian|landscape|accretion|room-sound|modal-sound|groundwater|glacier|locomotion|aeolian|iceberg|snowpack|pack-ice|drainage-fog|thin-film|crush-shell|viscoplastic|seismic|tsunami|lightning|lava|granular-flow|rail|terramechanics|synoptic|strand|pbf|dfsph|hull-panel|cloth)-kernel(?:-shared)?\.wasm\?no-inline["'])/g,
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
        'kernel-thread': resolve(root, 'src/kernel-thread.ts'),
        'explosive-thread': resolve(root, 'src/explosive/thread.ts'),
        decomposition: resolve(root, 'src/decomposition.ts'),
        soft: resolve(root, 'src/soft.ts'),
        tissue: resolve(root, 'src/tissue.ts'),
        meshfiles: resolve(root, 'src/meshfiles.ts'),
        robots: resolve(root, 'src/robots.ts'),
        world: resolve(root, 'src/world/index.ts'),
        earth: resolve(root, 'src/earth/index.ts'),
        terramechanics: resolve(root, 'src/terramechanics/index.ts'),
        rail: resolve(root, 'src/rail/index.ts'),
        seismic: resolve(root, 'src/seismic/index.ts'),
        lightning: resolve(root, 'src/lightning/index.ts'),
        explosive: resolve(root, 'src/explosive/index.ts'),
        strands: resolve(root, 'src/strands/index.ts'),
        'granular-mpm': resolve(root, 'src/granular-mpm/index.ts'),
        synoptic: resolve(root, 'src/synoptic/index.ts'),
        clouds: resolve(root, 'src/clouds/index.ts'),
        falling: resolve(root, 'src/falling.ts'),
        ageing: resolve(root, 'src/ageing.ts'),
        accretion: resolve(root, 'src/accretion/index.ts'),
        'room-sound': resolve(root, 'src/room-sound/index.ts'),
        'modal-sound': resolve(root, 'src/modal-sound.ts'),
        'outdoor-sound': resolve(root, 'src/outdoor-sound/index.ts'),
        flight: resolve(root, 'src/flight.ts'),
        waves: resolve(root, 'src/waves/index.ts'),
        bubbles: resolve(root, 'src/bubbles/index.ts'),
        entry: resolve(root, 'src/entry/index.ts'),
        flip: resolve(root, 'src/flip/index.ts'),
        pbf: resolve(root, 'src/pbf/index.ts'),
        dfsph: resolve(root, 'src/dfsph/index.ts'),
        sea: resolve(root, 'src/sea/index.ts'),
        seakeeping: resolve(root, 'src/seakeeping/index.ts'),
        celestial: resolve(root, 'src/space/index.ts'),
        schooling: resolve(root, 'src/schooling/index.ts'),
        life: resolve(root, 'src/life/index.ts'),
        pedestrians: resolve(root, 'src/pedestrians/index.ts'),
        locomotion: resolve(root, 'src/locomotion/index.ts'),
        crush: resolve(root, 'src/crush/index.ts'),
        legged: resolve(root, 'src/legged/index.ts'),
        tracers: resolve(root, 'src/tracers.ts'),
        thermal: resolve(root, 'src/thermal.ts'),
        hydro: resolve(root, 'src/hydro/index.ts'),
        foam: resolve(root, 'src/foam/index.ts'),
        surf: resolve(root, 'src/surf/index.ts'),
        rogue: resolve(root, 'src/rogue/index.ts'),
        ship: resolve(root, 'src/ship/index.ts'),
        loads: resolve(root, 'src/loads/index.ts'),
        surge: resolve(root, 'src/surge/index.ts'),
        runoff: resolve(root, 'src/runoff/index.ts'),
        sediment: resolve(root, 'src/sediment/index.ts'),
        landscape: resolve(root, 'src/landscape/index.ts'),
        'drainage-fog': resolve(root, 'src/drainage-fog/index.ts'),
        vortices: resolve(root, 'src/vortices/index.ts'),
        snowpack: resolve(root, 'src/snowpack/index.ts'),
        airborne: resolve(root, 'src/airborne/index.ts'),
        aeolian: resolve(root, 'src/aeolian/index.ts'),
        groundwater: resolve(root, 'src/groundwater/index.ts'),
        vegetation: resolve(root, 'src/vegetation.ts'),
        ice: resolve(root, 'src/ice/index.ts'),
        glacier: resolve(root, 'src/glacier/index.ts'),
        iceberg: resolve(root, 'src/iceberg/index.ts'),
        'thin-film': resolve(root, 'src/thin-film/index.ts'),
        viscoplastic: resolve(root, 'src/viscoplastic/index.ts'),
        tsunami: resolve(root, 'src/tsunami/index.ts'),
        'granular-flow': resolve(root, 'src/granular-flow/index.ts'),
        lava: resolve(root, 'src/lava/index.ts'),
        'pack-ice': resolve(root, 'src/pack-ice/index.ts'),
        underwater: resolve(root, 'src/underwater/index.ts'),
        orbit: resolve(root, 'src/orbit/index.ts'),
        rod: resolve(root, 'src/rod/index.ts'),
        'wrapped-rope': resolve(root, 'src/wrapped-rope/index.ts'),
        mooring: resolve(root, 'src/mooring/index.ts'),
        breakable: resolve(root, 'src/breakable/index.ts'),
        'debug-view': resolve(root, 'src/debug-view.ts'),
        'gpu-cloth': resolve(root, 'src/gpu-cloth.ts'),
      },
      formats: ['es'],
      fileName: (_, entry) => `${entry}.js`,
    },
    rollupOptions: {
      external: packageExternal(root, ['@margoengine/core', '@margoengine/core/extension', '@margoengine/lines']),
    },
  },
});
for (const name of ['school-kernel.wasm', 'school-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/schooling', name), resolve(dist, name));
await copyFile(resolve(root, 'src/cloth/cloth-kernel.wasm'), resolve(dist, 'cloth-kernel.wasm'));
for (const name of ['rail-kernel.wasm', 'rail-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/rail', name), resolve(dist, name));
for (const name of ['pbf-kernel.wasm', 'pbf-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/pbf', name), resolve(dist, name));
for (const name of ['dfsph-kernel.wasm', 'dfsph-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/dfsph', name), resolve(dist, name));
for (const name of ['seismic-kernel.wasm', 'seismic-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/seismic', name), resolve(dist, name));
for (const name of ['lightning-kernel.wasm', 'lightning-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/lightning', name), resolve(dist, name));
for (const name of ['explosive-kernel.wasm', 'explosive-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/explosive', name), resolve(dist, name));
for (const name of ['synoptic-kernel.wasm', 'synoptic-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/synoptic', name), resolve(dist, name));
for (const name of ['swim-kernel.wasm', 'swim-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/life', name), resolve(dist, name));
for (const name of ['locomotion-kernel.wasm', 'locomotion-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/locomotion', name), resolve(dist, name));
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
await copyFile(resolve(root, 'src/drainage-fog/drainage-fog-kernel.wasm'), resolve(dist, 'drainage-fog-kernel.wasm'));
await copyFile(
  resolve(root, 'src/drainage-fog/drainage-fog-kernel-shared.wasm'),
  resolve(dist, 'drainage-fog-kernel-shared.wasm'),
);
await copyFile(resolve(root, 'src/snowpack/snowpack-kernel.wasm'), resolve(dist, 'snowpack-kernel.wasm'));
await copyFile(resolve(root, 'src/snowpack/snowpack-kernel-shared.wasm'), resolve(dist, 'snowpack-kernel-shared.wasm'));
await copyFile(resolve(root, 'src/aeolian/aeolian-kernel.wasm'), resolve(dist, 'aeolian-kernel.wasm'));
await copyFile(resolve(root, 'src/aeolian/aeolian-kernel-shared.wasm'), resolve(dist, 'aeolian-kernel-shared.wasm'));
await copyFile(resolve(root, 'src/groundwater/groundwater-kernel.wasm'), resolve(dist, 'groundwater-kernel.wasm'));
await copyFile(
  resolve(root, 'src/groundwater/groundwater-kernel-shared.wasm'),
  resolve(dist, 'groundwater-kernel-shared.wasm'),
);
await copyFile(
  resolve(root, 'src/landscape/landscape-kernel-shared.wasm'),
  resolve(dist, 'landscape-kernel-shared.wasm'),
);
await copyFile(resolve(root, 'src/vegetation-kernel.wasm'), resolve(dist, 'vegetation-kernel.wasm'));
await copyFile(resolve(root, 'src/vegetation-kernel-shared.wasm'), resolve(dist, 'vegetation-kernel-shared.wasm'));

for (const name of ['falling-kernel.wasm', 'falling-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/falling', name), resolve(dist, name));

for (const name of ['airborne-kernel.wasm', 'airborne-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/airborne', name), resolve(dist, name));
for (const name of ['accretion-kernel.wasm', 'accretion-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/accretion', name), resolve(dist, name));
for (const name of ['room-sound-kernel.wasm', 'room-sound-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/room-sound', name), resolve(dist, name));
for (const name of ['modal-sound-kernel.wasm', 'modal-sound-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/modal-sound', name), resolve(dist, name));

for (const name of ['glacier-kernel.wasm', 'glacier-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/glacier', name), resolve(dist, name));

for (const name of ['iceberg-kernel.wasm', 'iceberg-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/iceberg', name), resolve(dist, name));

for (const name of ['pack-ice-kernel.wasm', 'pack-ice-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/pack-ice', name), resolve(dist, name));

await copyFile(resolve(root, 'src/seakeeping/hull-panel-kernel.wasm'), resolve(dist, 'hull-panel-kernel.wasm'));
for (const name of ['loads-kernel.wasm', 'loads-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/loads', name), resolve(dist, name));

for (const name of ['thin-film-kernel.wasm', 'thin-film-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/thin-film', name), resolve(dist, name));
for (const name of ['crush-shell-kernel.wasm', 'crush-shell-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/crush', name), resolve(dist, name));

for (const name of ['viscoplastic-kernel.wasm', 'viscoplastic-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/viscoplastic', name), resolve(dist, name));

for (const name of ['tsunami-kernel.wasm', 'tsunami-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/tsunami', name), resolve(dist, name));

for (const name of ['granular-flow-kernel.wasm', 'granular-flow-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/granular-flow', name), resolve(dist, name));

for (const name of ['lava-kernel.wasm', 'lava-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/lava', name), resolve(dist, name));

for (const name of ['terramechanics-kernel.wasm', 'terramechanics-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/terramechanics', name), resolve(dist, name));

await declarePackageCore(root);
await stripPackageShaderComments(root);

for (const name of ['strand-kernel.wasm', 'strand-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/strands', name), resolve(dist, name));
for (const name of ['granular-mpm-kernel.wasm', 'granular-mpm-kernel-shared.wasm'])
  await copyFile(resolve(root, 'src/granular-mpm', name), resolve(dist, name));
