// Committed Wasm blueprints: every Rust crate that ships as Wasm is built once, by whoever changes it, and the .wasm is
// committed, so installing, building (`npm run build:packages`) and testing need no Rust toolchain. Rust is only needed
// to change a crate. Each blueprint has a record beside it (`<blueprint>.json`, or the crate's own record where it had
// one first) holding a hash of everything that decides its bytes: the crate's sources (and the crates it reaches by a
// `path =` dependency), rust-toolchain.toml and the build script that sets its flags. `npm run hygiene` fails when a
// record no longer matches, so a crate change without a rebuild cannot land. Every build runs in the environment of
// scripts/rust-wasm-env.mjs (also hashed), so the same sources give the same bytes on every system; hygiene refuses a
// blueprint holding a host-specific path.
//   node scripts/wasm-blueprints.mjs                       check every record (what hygiene runs)
//   node scripts/wasm-blueprints.mjs --rebuild             rebuild every blueprint from source and write its record
//   node scripts/wasm-blueprints.mjs --rebuild --only=avif,poisson   just those
//   node scripts/wasm-blueprints.mjs --rebuild --compare   rebuild and fail when any bytes differ from the committed ones
//                                                          (proves the committed blueprints are current and reproducible;
//                                                          a differing file is put back as committed)
//   npm run check:wasm-repro                               the same over every blueprint, where the pinned toolchain is
//                                                          installed (local CI runs it when cargo is there)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { margoError } from '../packages/shared/errors.js';
import { hostSourcePath } from './rust-wasm-env.mjs';

const repository = resolve(import.meta.dirname, '..');

/** Every shipped Wasm crate. `crate` is the crate folder, `blueprint` the committed file, `script` (+ `args`) the build
 * that writes it; `deflated` marks a TypeScript module holding the raw-deflate base64 blueprint (`'gzip'`: gzip, and
 * `exportName` names the constant when it is not `wasmBase64`); `own` names the crate's
 * own record check, older than this list, which then stays the one check of that crate. */
export const BLUEPRINTS = [
  {
    name: 'core-kernel',
    crate: 'packages/kernel',
    blueprint: 'packages/core/src/wasm.ts',
    record: 'packages/kernel/wasm.json',
    script: 'scripts/build-core-kernel.mjs',
    deflated: true,
  },
  {
    name: 'physics-kernel',
    crate: 'packages/physics/kernel',
    blueprint: 'packages/physics/src/wasm.ts',
    script: 'packages/physics/scripts/build-kernel.mjs',
    args: ['simd'],
    deflated: true,
    own: 'packages/physics/tests/kernel-blueprint.test.js',
  },
  {
    name: 'physics-kernel-scalar',
    crate: 'packages/physics/kernel',
    blueprint: 'packages/physics/src/wasm-scalar.ts',
    script: 'packages/physics/scripts/build-kernel.mjs',
    args: ['scalar'],
    deflated: true,
    own: 'packages/physics/tests/kernel-blueprint.test.js',
  },
  {
    name: 'soft-kernel',
    crate: 'packages/physics/soft-kernel',
    blueprint: 'packages/physics/src/soft-wasm.ts',
    script: 'packages/physics/scripts/build-soft-kernel.mjs',
    deflated: true,
  },
  {
    name: 'celestial-kernel',
    crate: 'packages/physics/celestial-kernel',
    blueprint: 'packages/physics/src/space/celestial-kernel.wasm',
    script: 'packages/physics/scripts/build-celestial-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'celestial-kernel-shared',
    crate: 'packages/physics/celestial-kernel',
    blueprint: 'packages/physics/src/space/celestial-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-celestial-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'ageing-kernel',
    crate: 'packages/physics/ageing-kernel',
    blueprint: 'packages/physics/src/ageing/ageing-kernel.wasm',
    script: 'packages/physics/scripts/build-ageing-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'ageing-kernel-shared',
    crate: 'packages/physics/ageing-kernel',
    blueprint: 'packages/physics/src/ageing/ageing-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-ageing-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'ice-thermal-kernel',
    crate: 'packages/physics/ice-thermal-kernel',
    blueprint: 'packages/physics/src/ice/ice-thermal-kernel.wasm',
    script: 'packages/physics/scripts/build-ice-thermal-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'ice-thermal-kernel-shared',
    crate: 'packages/physics/ice-thermal-kernel',
    blueprint: 'packages/physics/src/ice/ice-thermal-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-ice-thermal-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'iceberg-kernel',
    crate: 'packages/physics/iceberg-kernel',
    blueprint: 'packages/physics/src/iceberg/iceberg-kernel.wasm',
    script: 'packages/physics/scripts/build-iceberg-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'iceberg-kernel-shared',
    crate: 'packages/physics/iceberg-kernel',
    blueprint: 'packages/physics/src/iceberg/iceberg-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-iceberg-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'pack-ice-kernel',
    crate: 'packages/physics/pack-ice-kernel',
    blueprint: 'packages/physics/src/pack-ice/pack-ice-kernel.wasm',
    script: 'packages/physics/scripts/build-pack-ice-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'wake-fft',
    crate: 'packages/physics/wake-fft',
    blueprint: 'packages/physics/src/sea/wake-fft.wasm',
    script: 'packages/physics/scripts/build-wake-fft.mjs',
  },
  {
    name: 'wake-fft-shared',
    crate: 'packages/physics/wake-fft',
    blueprint: 'packages/physics/src/sea/wake-fft-shared.wasm',
    script: 'packages/physics/scripts/build-wake-fft.mjs',
    args: ['shared'],
  },
  {
    name: 'mann-fft',
    crate: 'packages/weather/mann-fft',
    blueprint: 'packages/weather/src/mann-fft.wasm',
    script: 'packages/weather/scripts/build-mann-fft.mjs',
  },
  {
    name: 'surface-energy-kernel',
    crate: 'packages/weather/surface-energy-kernel',
    blueprint: 'packages/weather/src/surface-energy-kernel.wasm',
    script: 'packages/weather/scripts/build-surface-energy-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'surface-energy-kernel-shared',
    crate: 'packages/weather/surface-energy-kernel',
    blueprint: 'packages/weather/src/surface-energy-kernel-shared.wasm',
    script: 'packages/weather/scripts/build-surface-energy-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'hull-panel-kernel',
    crate: 'packages/physics/hull-panel-kernel',
    blueprint: 'packages/physics/src/seakeeping/hull-panel-kernel.wasm',
    script: 'packages/physics/scripts/build-hull-panel-kernel.mjs',
  },
  {
    name: 'hull-slamming-kernel',
    crate: 'packages/physics/hull-slamming-kernel',
    blueprint: 'packages/physics/src/seakeeping/hull-slamming-kernel.wasm',
    script: 'packages/physics/scripts/build-hull-slamming-kernel.mjs',
  },
  {
    name: 'flood-volume-kernel',
    crate: 'packages/physics/flood-volume-kernel',
    blueprint: 'packages/physics/src/seakeeping/flood-volume-kernel.wasm',
    script: 'packages/physics/scripts/build-flood-volume-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'flood-volume-kernel-shared',
    crate: 'packages/physics/flood-volume-kernel',
    blueprint: 'packages/physics/src/seakeeping/flood-volume-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-flood-volume-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'tracer-random-kernel',
    crate: 'packages/physics/tracer-random-kernel',
    blueprint: 'packages/physics/src/tracer-random-kernel.wasm',
    script: 'packages/physics/scripts/build-tracer-random-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'tracer-random-kernel-shared',
    crate: 'packages/physics/tracer-random-kernel',
    blueprint: 'packages/physics/src/tracer-random-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-tracer-random-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'loads-kernel',
    crate: 'packages/physics/loads-kernel',
    blueprint: 'packages/physics/src/loads/loads-kernel.wasm',
    script: 'packages/physics/scripts/build-loads-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'loads-kernel-shared',
    crate: 'packages/physics/loads-kernel',
    blueprint: 'packages/physics/src/loads/loads-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-loads-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'pbf-kernel',
    crate: 'packages/physics/pbf-kernel',
    blueprint: 'packages/physics/src/pbf/pbf-kernel.wasm',
    script: 'packages/physics/scripts/build-pbf-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'pbf-kernel-shared',
    crate: 'packages/physics/pbf-kernel',
    blueprint: 'packages/physics/src/pbf/pbf-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-pbf-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'dfsph-kernel',
    crate: 'packages/physics/pbf-kernel',
    blueprint: 'packages/physics/src/dfsph/dfsph-kernel.wasm',
    script: 'packages/physics/scripts/build-pbf-kernel.mjs',
    args: ['plain', 'dfsph'],
  },
  {
    name: 'dfsph-kernel-shared',
    crate: 'packages/physics/pbf-kernel',
    blueprint: 'packages/physics/src/dfsph/dfsph-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-pbf-kernel.mjs',
    args: ['shared', 'dfsph'],
  },
  {
    name: 'cloth-kernel',
    crate: 'packages/physics/cloth-kernel',
    blueprint: 'packages/physics/src/cloth/cloth-kernel.wasm',
    script: 'packages/physics/scripts/build-cloth-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'cloth-kernel-shared',
    crate: 'packages/physics/cloth-kernel',
    blueprint: 'packages/physics/src/cloth/cloth-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-cloth-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'rail-kernel',
    crate: 'packages/physics/rail-kernel',
    blueprint: 'packages/physics/src/rail/rail-kernel.wasm',
    script: 'packages/physics/scripts/build-rail-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'rail-kernel-shared',
    crate: 'packages/physics/rail-kernel',
    blueprint: 'packages/physics/src/rail/rail-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-rail-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'seismic-kernel',
    crate: 'packages/physics/seismic-kernel',
    blueprint: 'packages/physics/src/seismic/seismic-kernel.wasm',
    script: 'packages/physics/scripts/build-seismic-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'lightning-kernel',
    crate: 'packages/physics/lightning-kernel',
    blueprint: 'packages/physics/src/lightning/lightning-kernel.wasm',
    script: 'packages/physics/scripts/build-lightning-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'explosive-kernel',
    crate: 'packages/physics/explosive-kernel',
    blueprint: 'packages/physics/src/explosive/explosive-kernel.wasm',
    script: 'packages/physics/scripts/build-explosive-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'explosive-kernel-shared',
    crate: 'packages/physics/explosive-kernel',
    blueprint: 'packages/physics/src/explosive/explosive-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-explosive-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'lightning-kernel-shared',
    crate: 'packages/physics/lightning-kernel',
    blueprint: 'packages/physics/src/lightning/lightning-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-lightning-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'seismic-kernel-shared',
    crate: 'packages/physics/seismic-kernel',
    blueprint: 'packages/physics/src/seismic/seismic-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-seismic-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'strand-kernel',
    crate: 'packages/physics/strand-kernel',
    blueprint: 'packages/physics/src/strands/strand-kernel.wasm',
    script: 'packages/physics/scripts/build-strand-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'strand-kernel-shared',
    crate: 'packages/physics/strand-kernel',
    blueprint: 'packages/physics/src/strands/strand-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-strand-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'granular-mpm-kernel',
    crate: 'packages/physics/granular-mpm-kernel',
    blueprint: 'packages/physics/src/granular-mpm/granular-mpm-kernel.wasm',
    script: 'packages/physics/scripts/build-granular-mpm-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'granular-mpm-kernel-shared',
    crate: 'packages/physics/granular-mpm-kernel',
    blueprint: 'packages/physics/src/granular-mpm/granular-mpm-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-granular-mpm-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'synoptic-kernel',
    crate: 'packages/physics/synoptic-kernel',
    blueprint: 'packages/physics/src/synoptic/synoptic-kernel.wasm',
    script: 'packages/physics/scripts/build-synoptic-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'synoptic-kernel-shared',
    crate: 'packages/physics/synoptic-kernel',
    blueprint: 'packages/physics/src/synoptic/synoptic-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-synoptic-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'pack-ice-kernel-shared',
    crate: 'packages/physics/pack-ice-kernel',
    blueprint: 'packages/physics/src/pack-ice/pack-ice-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-pack-ice-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'thin-film-kernel',
    crate: 'packages/physics/thin-film-kernel',
    blueprint: 'packages/physics/src/thin-film/thin-film-kernel.wasm',
    script: 'packages/physics/scripts/build-thin-film-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'thin-film-kernel-shared',
    crate: 'packages/physics/thin-film-kernel',
    blueprint: 'packages/physics/src/thin-film/thin-film-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-thin-film-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'thin-film-kernel-threaded',
    crate: 'packages/physics/thin-film-kernel',
    blueprint: 'packages/physics/src/thin-film/thin-film-kernel-threaded.wasm',
    script: 'packages/physics/scripts/build-thin-film-kernel.mjs',
    args: ['threaded'],
  },
  {
    name: 'crush-shell-kernel',
    crate: 'packages/physics/crush-shell-kernel',
    blueprint: 'packages/physics/src/crush/crush-shell-kernel.wasm',
    script: 'packages/physics/scripts/build-crush-shell-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'crush-shell-kernel-shared',
    crate: 'packages/physics/crush-shell-kernel',
    blueprint: 'packages/physics/src/crush/crush-shell-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-crush-shell-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'crush-shell-kernel-threaded',
    crate: 'packages/physics/crush-shell-kernel',
    blueprint: 'packages/physics/src/crush/crush-shell-kernel-threaded.wasm',
    script: 'packages/physics/scripts/build-crush-shell-kernel.mjs',
    args: ['threaded'],
  },
  {
    name: 'rogue-pair-kernel',
    crate: 'packages/physics/rogue-pair-kernel',
    blueprint: 'packages/physics/src/rogue/rogue-pair-kernel.wasm',
    script: 'packages/physics/scripts/build-rogue-pair-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'rogue-pair-kernel-shared',
    crate: 'packages/physics/rogue-pair-kernel',
    blueprint: 'packages/physics/src/rogue/rogue-pair-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-rogue-pair-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'wave-transport-kernel',
    crate: 'packages/physics/wave-transport-kernel',
    blueprint: 'packages/physics/src/waves/wave-transport-kernel.wasm',
    script: 'packages/physics/scripts/build-wave-transport-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'wave-transport-kernel-shared',
    crate: 'packages/physics/wave-transport-kernel',
    blueprint: 'packages/physics/src/waves/wave-transport-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-wave-transport-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'surf-force-kernel',
    crate: 'packages/physics/surf-force-kernel',
    blueprint: 'packages/physics/src/surf/surf-force-kernel.wasm',
    script: 'packages/physics/scripts/build-surf-force-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'surf-force-kernel-shared',
    crate: 'packages/physics/surf-force-kernel',
    blueprint: 'packages/physics/src/surf/surf-force-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-surf-force-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'surge-potential-kernel',
    crate: 'packages/physics/surge-potential-kernel',
    blueprint: 'packages/physics/src/surge/surge-potential-kernel.wasm',
    script: 'packages/physics/scripts/build-surge-potential-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'surge-potential-kernel-shared',
    crate: 'packages/physics/surge-potential-kernel',
    blueprint: 'packages/physics/src/surge/surge-potential-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-surge-potential-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'vortex-water-kernel',
    crate: 'packages/physics/vortex-water-kernel',
    blueprint: 'packages/physics/src/vortices/vortex-water-kernel.wasm',
    script: 'packages/physics/scripts/build-vortex-water-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'vortex-water-kernel-shared',
    crate: 'packages/physics/vortex-water-kernel',
    blueprint: 'packages/physics/src/vortices/vortex-water-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-vortex-water-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'viscoplastic-kernel',
    crate: 'packages/physics/viscoplastic-kernel',
    blueprint: 'packages/physics/src/viscoplastic/viscoplastic-kernel.wasm',
    script: 'packages/physics/scripts/build-viscoplastic-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'viscoplastic-kernel-shared',
    crate: 'packages/physics/viscoplastic-kernel',
    blueprint: 'packages/physics/src/viscoplastic/viscoplastic-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-viscoplastic-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'underwater-kernel',
    crate: 'packages/physics/underwater-kernel',
    blueprint: 'packages/physics/src/underwater/underwater-kernel.wasm',
    script: 'packages/physics/scripts/build-underwater-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'underwater-kernel-shared',
    crate: 'packages/physics/underwater-kernel',
    blueprint: 'packages/physics/src/underwater/underwater-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-underwater-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'tsunami-kernel',
    crate: 'packages/physics/tsunami-kernel',
    blueprint: 'packages/physics/src/tsunami/tsunami-kernel.wasm',
    script: 'packages/physics/scripts/build-tsunami-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'tsunami-kernel-shared',
    crate: 'packages/physics/tsunami-kernel',
    blueprint: 'packages/physics/src/tsunami/tsunami-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-tsunami-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'terramechanics-kernel',
    crate: 'packages/physics/terramechanics-kernel',
    blueprint: 'packages/physics/src/terramechanics/terramechanics-kernel.wasm',
    script: 'packages/physics/scripts/build-terramechanics-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'terramechanics-kernel-shared',
    crate: 'packages/physics/terramechanics-kernel',
    blueprint: 'packages/physics/src/terramechanics/terramechanics-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-terramechanics-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'lava-kernel',
    crate: 'packages/physics/lava-kernel',
    blueprint: 'packages/physics/src/lava/lava-kernel.wasm',
    script: 'packages/physics/scripts/build-lava-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'lava-kernel-shared',
    crate: 'packages/physics/lava-kernel',
    blueprint: 'packages/physics/src/lava/lava-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-lava-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'granular-flow-kernel',
    crate: 'packages/physics/granular-flow-kernel',
    blueprint: 'packages/physics/src/granular-flow/granular-flow-kernel.wasm',
    script: 'packages/physics/scripts/build-granular-flow-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'granular-flow-kernel-shared',
    crate: 'packages/physics/granular-flow-kernel',
    blueprint: 'packages/physics/src/granular-flow/granular-flow-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-granular-flow-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'glacier-kernel',
    crate: 'packages/physics/glacier-kernel',
    blueprint: 'packages/physics/src/glacier/glacier-kernel.wasm',
    script: 'packages/physics/scripts/build-glacier-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'glacier-kernel-shared',
    crate: 'packages/physics/glacier-kernel',
    blueprint: 'packages/physics/src/glacier/glacier-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-glacier-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'drainage-fog-kernel',
    crate: 'packages/physics/drainage-fog-kernel',
    blueprint: 'packages/physics/src/drainage-fog/drainage-fog-kernel.wasm',
    script: 'packages/physics/scripts/build-drainage-fog-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'drainage-fog-kernel-shared',
    crate: 'packages/physics/drainage-fog-kernel',
    blueprint: 'packages/physics/src/drainage-fog/drainage-fog-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-drainage-fog-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'snowpack-kernel',
    crate: 'packages/physics/snowpack-kernel',
    blueprint: 'packages/physics/src/snowpack/snowpack-kernel.wasm',
    script: 'packages/physics/scripts/build-snowpack-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'snowpack-kernel-shared',
    crate: 'packages/physics/snowpack-kernel',
    blueprint: 'packages/physics/src/snowpack/snowpack-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-snowpack-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'airborne-kernel',
    crate: 'packages/physics/airborne-kernel',
    blueprint: 'packages/physics/src/airborne/airborne-kernel.wasm',
    script: 'packages/physics/scripts/build-airborne-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'airborne-kernel-shared',
    crate: 'packages/physics/airborne-kernel',
    blueprint: 'packages/physics/src/airborne/airborne-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-airborne-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'aeolian-kernel',
    crate: 'packages/physics/aeolian-kernel',
    blueprint: 'packages/physics/src/aeolian/aeolian-kernel.wasm',
    script: 'packages/physics/scripts/build-aeolian-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'aeolian-kernel-shared',
    crate: 'packages/physics/aeolian-kernel',
    blueprint: 'packages/physics/src/aeolian/aeolian-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-aeolian-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'groundwater-kernel',
    crate: 'packages/physics/groundwater-kernel',
    blueprint: 'packages/physics/src/groundwater/groundwater-kernel.wasm',
    script: 'packages/physics/scripts/build-groundwater-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'groundwater-kernel-shared',
    crate: 'packages/physics/groundwater-kernel',
    blueprint: 'packages/physics/src/groundwater/groundwater-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-groundwater-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'landscape-kernel',
    crate: 'packages/physics/landscape-kernel',
    blueprint: 'packages/physics/src/landscape/landscape-kernel.wasm',
    script: 'packages/physics/scripts/build-landscape-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'landscape-kernel-shared',
    crate: 'packages/physics/landscape-kernel',
    blueprint: 'packages/physics/src/landscape/landscape-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-landscape-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'sediment-kernel',
    crate: 'packages/physics/sediment-kernel',
    blueprint: 'packages/physics/src/sediment/sediment-kernel.wasm',
    script: 'packages/physics/scripts/build-sediment-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'sediment-kernel-shared',
    crate: 'packages/physics/sediment-kernel',
    blueprint: 'packages/physics/src/sediment/sediment-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-sediment-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'boundary-layer-kernel',
    crate: 'packages/physics/boundary-layer-kernel',
    blueprint: 'packages/physics/src/boundary-layer/boundary-layer-kernel.wasm',
    script: 'packages/physics/scripts/build-boundary-layer-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'boundary-layer-kernel-shared',
    crate: 'packages/physics/boundary-layer-kernel',
    blueprint: 'packages/physics/src/boundary-layer/boundary-layer-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-boundary-layer-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'cloud-projection-kernel',
    crate: 'packages/physics/cloud-projection-kernel',
    blueprint: 'packages/physics/src/clouds/cloud-projection-kernel.wasm',
    script: 'packages/physics/scripts/build-cloud-projection-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'cloud-projection-kernel-shared',
    crate: 'packages/physics/cloud-projection-kernel',
    blueprint: 'packages/physics/src/clouds/cloud-projection-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-cloud-projection-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'runoff-kernel',
    crate: 'packages/physics/runoff-kernel',
    blueprint: 'packages/physics/src/runoff/runoff-kernel.wasm',
    script: 'packages/physics/scripts/build-runoff-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'runoff-kernel-shared',
    crate: 'packages/physics/runoff-kernel',
    blueprint: 'packages/physics/src/runoff/runoff-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-runoff-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'orbit-kernel',
    crate: 'packages/physics/orbit-kernel',
    blueprint: 'packages/physics/src/orbit/orbit-kernel.wasm',
    script: 'packages/physics/scripts/build-orbit-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'orbit-kernel-shared',
    crate: 'packages/physics/orbit-kernel',
    blueprint: 'packages/physics/src/orbit/orbit-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-orbit-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'thermal-kernel',
    crate: 'packages/physics/thermal-kernel',
    blueprint: 'packages/physics/src/thermal/thermal-kernel.wasm',
    script: 'packages/physics/scripts/build-thermal-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'thermal-kernel-shared',
    crate: 'packages/physics/thermal-kernel',
    blueprint: 'packages/physics/src/thermal/thermal-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-thermal-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'locomotion-kernel',
    crate: 'packages/physics/locomotion-kernel',
    blueprint: 'packages/physics/src/locomotion/locomotion-kernel.wasm',
    script: 'packages/physics/scripts/build-locomotion-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'locomotion-kernel-shared',
    crate: 'packages/physics/locomotion-kernel',
    blueprint: 'packages/physics/src/locomotion/locomotion-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-locomotion-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'pedestrian-kernel',
    crate: 'packages/physics/pedestrian-kernel',
    blueprint: 'packages/physics/src/pedestrians/pedestrian-kernel.wasm',
    script: 'packages/physics/scripts/build-pedestrian-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'pedestrian-kernel-shared',
    crate: 'packages/physics/pedestrian-kernel',
    blueprint: 'packages/physics/src/pedestrians/pedestrian-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-pedestrian-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'swim-kernel',
    crate: 'packages/physics/swim-kernel',
    blueprint: 'packages/physics/src/life/swim-kernel.wasm',
    script: 'packages/physics/scripts/build-swim-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'swim-kernel-shared',
    crate: 'packages/physics/swim-kernel',
    blueprint: 'packages/physics/src/life/swim-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-swim-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'accretion-kernel',
    crate: 'packages/physics/accretion-kernel',
    blueprint: 'packages/physics/src/accretion/accretion-kernel.wasm',
    script: 'packages/physics/scripts/build-accretion-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'accretion-kernel-shared',
    crate: 'packages/physics/accretion-kernel',
    blueprint: 'packages/physics/src/accretion/accretion-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-accretion-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'room-sound-kernel',
    crate: 'packages/physics/room-sound-kernel',
    blueprint: 'packages/physics/src/room-sound/room-sound-kernel.wasm',
    script: 'packages/physics/scripts/build-room-sound-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'outdoor-sound-kernel',
    crate: 'packages/physics/outdoor-sound-kernel',
    blueprint: 'packages/physics/src/outdoor-sound/outdoor-sound-kernel.wasm',
    script: 'packages/physics/scripts/build-outdoor-sound-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'foam-transport-kernel',
    crate: 'packages/physics/foam-transport-kernel',
    blueprint: 'packages/physics/src/foam/foam-transport-kernel.wasm',
    script: 'packages/physics/scripts/build-foam-transport-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'entry-profile-kernel',
    crate: 'packages/physics/entry-profile-kernel',
    blueprint: 'packages/physics/src/entry/entry-profile-kernel.wasm',
    script: 'packages/physics/scripts/build-entry-profile-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'entry-profile-kernel-shared',
    crate: 'packages/physics/entry-profile-kernel',
    blueprint: 'packages/physics/src/entry/entry-profile-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-entry-profile-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'foam-transport-kernel-shared',
    crate: 'packages/physics/foam-transport-kernel',
    blueprint: 'packages/physics/src/foam/foam-transport-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-foam-transport-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'outdoor-sound-kernel-shared',
    crate: 'packages/physics/outdoor-sound-kernel',
    blueprint: 'packages/physics/src/outdoor-sound/outdoor-sound-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-outdoor-sound-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'wing-lattice-kernel',
    crate: 'packages/physics/wing-lattice-kernel',
    blueprint: 'packages/physics/src/flight/wing-lattice-kernel.wasm',
    script: 'packages/physics/scripts/build-wing-lattice-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'wing-lattice-kernel-shared',
    crate: 'packages/physics/wing-lattice-kernel',
    blueprint: 'packages/physics/src/flight/wing-lattice-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-wing-lattice-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'room-sound-kernel-shared',
    crate: 'packages/physics/room-sound-kernel',
    blueprint: 'packages/physics/src/room-sound/room-sound-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-room-sound-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'modal-sound-kernel',
    crate: 'packages/physics/modal-sound-kernel',
    blueprint: 'packages/physics/src/modal-sound/modal-sound-kernel.wasm',
    script: 'packages/physics/scripts/build-modal-sound-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'modal-sound-kernel-shared',
    crate: 'packages/physics/modal-sound-kernel',
    blueprint: 'packages/physics/src/modal-sound/modal-sound-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-modal-sound-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'falling-kernel',
    crate: 'packages/physics/falling-kernel',
    blueprint: 'packages/physics/src/falling/falling-kernel.wasm',
    script: 'packages/physics/scripts/build-falling-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'falling-kernel-shared',
    crate: 'packages/physics/falling-kernel',
    blueprint: 'packages/physics/src/falling/falling-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-falling-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'school-kernel',
    crate: 'packages/physics/school-kernel',
    blueprint: 'packages/physics/src/schooling/school-kernel.wasm',
    script: 'packages/physics/scripts/build-school-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'school-kernel-shared',
    crate: 'packages/physics/school-kernel',
    blueprint: 'packages/physics/src/schooling/school-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-school-kernel.mjs',
  },
  {
    name: 'vegetation-kernel',
    crate: 'packages/physics/vegetation-kernel',
    blueprint: 'packages/physics/src/vegetation-kernel.wasm',
    script: 'packages/physics/scripts/build-vegetation-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'wind-traction-kernel',
    crate: 'packages/physics/wind-traction-kernel',
    blueprint: 'packages/physics/src/aero/wind-traction-kernel.wasm',
    script: 'packages/physics/scripts/build-wind-traction-kernel.mjs',
    args: ['plain'],
  },
  {
    name: 'wind-traction-kernel-shared',
    crate: 'packages/physics/wind-traction-kernel',
    blueprint: 'packages/physics/src/aero/wind-traction-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-wind-traction-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'vegetation-kernel-shared',
    crate: 'packages/physics/vegetation-kernel',
    blueprint: 'packages/physics/src/vegetation-kernel-shared.wasm',
    script: 'packages/physics/scripts/build-vegetation-kernel.mjs',
    args: ['shared'],
  },
  {
    name: 'physics2d-kernel',
    crate: 'packages/physics2d/kernel',
    blueprint: 'packages/physics2d/src/physics2d-kernel.wasm',
    script: 'packages/physics2d/scripts/build-kernel.mjs',
    args: ['simd'],
  },
  {
    name: 'physics2d-kernel-scalar',
    crate: 'packages/physics2d/kernel',
    blueprint: 'packages/physics2d/src/physics2d-kernel-scalar.wasm',
    script: 'packages/physics2d/scripts/build-kernel.mjs',
    args: ['scalar'],
  },
  {
    name: 'erosion',
    crate: 'packages/biomes/kernel',
    blueprint: 'packages/biomes/src/erosion.wasm',
    script: 'packages/biomes/scripts/build-erosion.mjs',
  },
  {
    name: 'growth-kernel',
    crate: 'packages/biomes/growth-kernel',
    blueprint: 'packages/biomes/src/growth-kernel.wasm',
    script: 'packages/biomes/scripts/build-growth.mjs',
    args: ['plain'],
  },
  {
    name: 'growth-kernel-shared',
    crate: 'packages/biomes/growth-kernel',
    blueprint: 'packages/biomes/src/growth-kernel-shared.wasm',
    script: 'packages/biomes/scripts/build-growth.mjs',
    args: ['shared'],
  },
  {
    name: 'forest-kernel',
    crate: 'packages/biomes/forest-kernel',
    blueprint: 'packages/biomes/src/forest-kernel.wasm',
    script: 'packages/biomes/scripts/build-forest.mjs',
    args: ['plain'],
  },
  {
    name: 'forest-kernel-shared',
    crate: 'packages/biomes/forest-kernel',
    blueprint: 'packages/biomes/src/forest-kernel-shared.wasm',
    script: 'packages/biomes/scripts/build-forest.mjs',
    args: ['shared'],
  },
  {
    name: 'compute-cpu',
    crate: 'packages/compute/cpu-kernel',
    blueprint: 'packages/compute/src/cpu-kernel.wasm',
    script: 'packages/compute/scripts/build-cpu.mjs',
  },
  {
    name: 'compute-decomp',
    crate: 'packages/compute/decomp-kernel',
    blueprint: 'packages/compute/src/decomp-kernel.wasm',
    script: 'packages/compute/scripts/build-decomp.mjs',
  },
  {
    name: 'compute-onnx',
    crate: 'packages/compute/onnx-kernel',
    blueprint: 'packages/compute/src/onnx-kernel.wasm',
    script: 'packages/compute/scripts/build-onnx.mjs',
  },
  {
    name: 'draco',
    crate: 'packages/decoders/native/draco',
    blueprint: 'packages/decoders/src/draco-native.wasm',
    script: 'packages/decoders/scripts/build-native.mjs',
    args: ['draco'],
  },
  {
    name: 'hdr6',
    crate: 'packages/decoders/native/hdr6',
    blueprint: 'packages/decoders/src/hdr6.wasm',
    script: 'packages/decoders/scripts/build-native.mjs',
    args: ['hdr6'],
  },
  {
    name: 'avif',
    crate: 'packages/decoders/native/avif',
    blueprint: 'packages/decoders/src/avif.wasm',
    script: 'packages/decoders/scripts/build-native.mjs',
    args: ['avif'],
  },
  {
    name: 'jpeg2000',
    crate: 'packages/decoders/jpeg2000-kernel',
    blueprint: 'packages/decoders/src/jpeg2000.wasm',
    script: 'packages/decoders/scripts/build-native.mjs',
    args: ['jpeg2000'],
  },
  {
    name: 'meshopt-simd',
    crate: 'packages/decoders/native/meshopt-simd',
    blueprint: 'packages/decoders/src/meshopt-simd-wasm.ts',
    script: 'packages/decoders/scripts/meshopt-simd-build.mjs',
    own: 'packages/decoders/tests/meshopt-simd.test.js',
  },
  {
    name: 'draco-encoder',
    crate: 'packages/exporters/draco-kernel',
    blueprint: 'packages/exporters/src/draco-native-encoder.wasm',
    script: 'packages/exporters/scripts/build-draco.mjs',
  },
  {
    name: 'basis-encoder',
    crate: 'packages/exporters/native/basis',
    blueprint: 'packages/exporters/native/basis/margo_basis_encoder.wasm',
    script: 'packages/exporters/scripts/build-basis.mjs',
  },
  {
    name: 'navmesh-raster',
    crate: 'packages/navmesh/native/raster',
    blueprint: 'packages/navmesh/src/navmesh-raster.wasm',
    script: 'packages/navmesh/scripts/build-raster.mjs',
    own: 'packages/navmesh/scripts/copy-raster.mjs',
  },
  {
    name: 'buildings',
    crate: 'packages/procedural/buildings-kernel',
    blueprint: 'packages/procedural/src/buildings.wasm',
    script: 'packages/procedural/scripts/build-buildings.mjs',
  },
  {
    name: 'caves',
    crate: 'packages/procedural/caves-kernel',
    blueprint: 'packages/procedural/src/caves.wasm',
    script: 'packages/procedural/scripts/build-caves.mjs',
  },
  {
    name: 'dungeon',
    crate: 'packages/procedural/dungeon-kernel',
    blueprint: 'packages/procedural/src/dungeon.wasm',
    script: 'packages/procedural/scripts/build-dungeon.mjs',
  },
  {
    name: 'poisson',
    crate: 'packages/procedural/poisson-kernel',
    blueprint: 'packages/procedural/src/poisson.wasm',
    script: 'packages/procedural/scripts/build-poisson.mjs',
  },
  {
    name: 'sdf',
    crate: 'packages/procedural/sdf-kernel',
    blueprint: 'packages/procedural/src/sdf.wasm',
    script: 'packages/procedural/scripts/build-sdf.mjs',
  },
  {
    name: 'trees',
    crate: 'packages/procedural/trees-kernel',
    blueprint: 'packages/procedural/src/trees.wasm',
    script: 'packages/procedural/scripts/build-trees.mjs',
  },
  {
    name: 'sciviz-fallback',
    crate: 'packages/sciviz/kernel',
    blueprint: 'packages/sciviz/src/fallback.wasm',
    script: 'packages/sciviz/scripts/build-fallback.mjs',
  },
  {
    name: 'sciviz-flow',
    crate: 'packages/sciviz/flow-kernel',
    blueprint: 'packages/sciviz/src/flow.wasm',
    script: 'packages/sciviz/scripts/build-flow.mjs',
  },
  {
    name: 'machinery-kernel',
    crate: 'packages/machinery/kernel',
    blueprint: 'packages/machinery/src/wasm.ts',
    script: 'packages/machinery/scripts/build-kernel.mjs',
    deflated: 'gzip',
    exportName: 'machineryWasm',
  },
  {
    name: 'trace-mesh',
    crate: 'packages/voxel-pathtracer/mesh-kernel',
    blueprint: 'packages/voxel-pathtracer/src/mesh.wasm',
    script: 'packages/voxel-pathtracer/scripts/build-mesh.mjs',
  },
  {
    name: 'wfc',
    crate: 'packages/wfc/native/solver',
    blueprint: 'packages/wfc/src/wfc.wasm',
    script: 'packages/wfc/scripts/build-wasm.mjs',
    own: 'packages/wfc/test/chunks.test.js',
  },
];

/** Crates that are Rust but ship no Wasm of their own: a library others reach by path, a test-only kernel, a check. */
// The shared-memory prototype modules are test fixtures: scripts/physics-modules.mjs builds them and checks their committed
// builds (packages/physics/tests/modules/built.json) against their sources and slots, in packages/physics/tests/world-modules.test.js.
export const NOT_SHIPPED = [
  'packages/physics/kernel-common',
  'packages/physics2d/kernel/wasm-check',
  'packages/physics/tests/modules/source',
  'packages/physics/tests/modules/reader',
];

/** The repo path of an entry's record. */
export const recordPath = (entry) => entry.record ?? `${entry.blueprint}.json`;

const SKIP_DIRS = new Set(['target', 'tests', 'benches', 'examples', 'wasm-check', 'node_modules']);

/** Repo paths of the files that decide a crate's bytes: its manifest, lock, build.rs, .cargo config and everything under
 * src, plus the same of every crate it reaches by a `path =` dependency. */
export function crateFiles(crate, root = repository, seen = new Set()) {
  if (seen.has(crate)) return [];
  seen.add(crate);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else files.push(path);
    }
  };
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs', '.cargo/config.toml', '.cargo/config'])
    if (existsSync(join(root, crate, name))) files.push(posix.join(crate, name));
  if (existsSync(join(root, crate, 'src'))) walk(posix.join(crate, 'src'));
  const manifest = readFileSync(join(root, crate, 'Cargo.toml'), 'utf8');
  for (const [, path] of manifest.matchAll(/\bpath\s*=\s*"([^"]+)"/g)) {
    const dependency = posix.normalize(posix.join(crate, path));
    if (dependency !== crate && !dependency.startsWith(`${crate}/`)) files.push(...crateFiles(dependency, root, seen));
  }
  return files;
}

/** Text files hash without their line endings, so a CRLF checkout hashes as an LF one. */
const content = (bytes) =>
  bytes.includes(0) ? bytes : Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');

/**
 * Which of `files` git ignores in `root`: build leftovers such as the `Cargo.lock` a local `cargo test` writes into a library
 * crate, which never reach the repository and so cannot decide a committed blueprint. Tracked files are never ignored.
 * @throws when `root` is not in a git repository.
 */
function ignoredFiles(root, files) {
  const result = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd: root,
    input: files.join('\0'),
    encoding: 'utf8',
  });
  // 0: some are ignored, 1: none are; anything else is a failure of git itself.
  if (result.status !== 0 && result.status !== 1)
    throw margoError(
      'WASM_BLUEPRINT_GIT',
      `git check-ignore failed in ${root}: ${result.stderr || result.error?.message}`,
    );
  return new Set(result.stdout.split('\0').filter(Boolean));
}

/** Hash of everything that decides an entry's blueprint bytes. */
export function sourceHash(entry, root = repository) {
  const files = [
    ...new Set([...crateFiles(entry.crate, root), entry.script, 'rust-toolchain.toml', 'scripts/rust-wasm-env.mjs']),
  ]
    .filter((file) => existsSync(join(root, file)))
    .sort();
  const skip = ignoredFiles(root, files),
    hash = createHash('sha256');
  for (const file of files)
    if (!skip.has(file)) hash.update(`\0${file}\0`).update(content(readFileSync(join(root, file))));
  return hash.digest('hex');
}

/** The packed bytes a deflated TypeScript blueprint holds: the string its constant is assigned, wherever the formatter
 * wraps that statement. The one reader of those modules, for the checks and the tests. */
export function packedBlueprint(entry, root = repository) {
  const name = entry.exportName ?? 'wasmBase64';
  const assigned = new RegExp(`\\b${name}\\s*(?::\\s*string\\s*)?=\\s*'([^']+)'`);
  const base64 = assigned.exec(readFileSync(join(root, entry.blueprint), 'utf8'))?.[1];
  if (!base64) throw margoError('WASM_BLUEPRINT_UNREADABLE', `${entry.blueprint} holds no ${name} blueprint`);
  return Buffer.from(base64, 'base64');
}

/** The blueprint's Wasm bytes (a deflated TypeScript blueprint is read back to its module). */
export function blueprintBytes(entry, root = repository) {
  if (!entry.deflated) return readFileSync(join(root, entry.blueprint));
  const packed = packedBlueprint(entry, root);
  return entry.deflated === 'gzip' ? gunzipSync(packed) : inflateRawSync(packed);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Writes an entry's record from its current sources and blueprint. A blueprint holding a build path is refused. */
export function writeRecord(entry, root = repository) {
  const wasm = blueprintBytes(entry, root);
  if (!WebAssembly.validate(wasm)) throw margoError('WASM_BLUEPRINT_INVALID', `${entry.blueprint} is not valid Wasm`);
  const text = wasm.toString('latin1');
  for (const leak of ['Users', 'Development', '.cargo', '.rustup'])
    if (text.includes(leak))
      throw margoError('WASM_BLUEPRINT_PATH', `${entry.blueprint} holds a build path (${leak}); strip or remap it`);
  const host = hostSourcePath(wasm);
  if (host)
    throw margoError(
      'WASM_BLUEPRINT_HOST_PATH',
      `${entry.blueprint} holds the host path ${host}; build it through scripts/rust-wasm-env.mjs`,
    );
  const record = { sourceHash: sourceHash(entry, root), wasmHash: sha256(wasm), bytes: wasm.length };
  writeFileSync(join(root, recordPath(entry)), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Problems with the committed records, one line each; empty when every blueprint matches its sources. */
export function staleBlueprints(root = repository, entries = BLUEPRINTS) {
  const problems = [];
  for (const entry of entries) {
    const host = existsSync(join(root, entry.blueprint)) ? hostSourcePath(blueprintBytes(entry, root)) : null;
    if (host)
      problems.push(
        `${entry.name}: ${entry.blueprint} holds the host path ${host}, so its bytes differ by system; run node scripts/wasm-blueprints.mjs --rebuild --only=${entry.name}`,
      );
    if (entry.own) {
      if (!existsSync(join(root, entry.own))) problems.push(`${entry.name}: its own check ${entry.own} is missing`);
      continue;
    }
    const rebuild = `node scripts/wasm-blueprints.mjs --rebuild --only=${entry.name}`;
    if (!existsSync(join(root, entry.blueprint))) {
      problems.push(`${entry.name}: ${entry.blueprint} is missing; run ${rebuild}`);
      continue;
    }
    if (!existsSync(join(root, recordPath(entry)))) {
      problems.push(`${entry.name}: ${recordPath(entry)} is missing; run ${rebuild}`);
      continue;
    }
    const record = JSON.parse(readFileSync(join(root, recordPath(entry)), 'utf8'));
    if (record.sourceHash !== sourceHash(entry, root))
      problems.push(`${entry.name}: ${entry.crate} changed since ${entry.blueprint} was built; run ${rebuild}`);
    else if (record.wasmHash !== sha256(blueprintBytes(entry, root)))
      problems.push(`${entry.name}: ${entry.blueprint} differs from the build its record names; run ${rebuild}`);
  }
  return problems;
}

/** Repo folders of every tracked Cargo.toml under packages/ that the lists above do not name. */
export function unlistedCrates(root = repository) {
  const listed = new Set([...BLUEPRINTS.map((entry) => entry.crate), ...NOT_SHIPPED]);
  const out = spawnSync('git', ['ls-files', '-z', '--', 'packages/*Cargo.toml'], {
    maxBuffer: 2 ** 28,
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (out.status !== 0) throw margoError('WASM_BLUEPRINT_GIT', `git ls-files failed: ${out.stderr}`);
  return out.stdout
    .split('\0')
    .filter((file) => file.endsWith('/Cargo.toml'))
    .map((file) => posix.dirname(file))
    .filter((crate) => !listed.has(crate));
}

/** Hygiene's check: every crate listed, every record current. */
export function assertWasmBlueprintsCurrent(root = repository) {
  const problems = [
    ...unlistedCrates(root).map((crate) => `${crate}: a Rust crate missing from scripts/wasm-blueprints.mjs`),
    ...staleBlueprints(root),
  ];
  if (problems.length)
    throw margoError('WASM_BLUEPRINT_STALE', `Wasm blueprints out of date:\n  ${problems.join('\n  ')}`);
}

/** The pinned channel of rust-toolchain.toml when the rustc on PATH is that version, else null with the reason. */
export function pinnedToolchain(root = repository) {
  const channel = /channel\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, 'rust-toolchain.toml'), 'utf8'))?.[1];
  const run = spawnSync('rustc', ['--version'], { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const version = run.status === 0 ? run.stdout.trim() : null;
  if (!version) return { channel: null, reason: `no rustc on PATH (rust-toolchain.toml pins ${channel})` };
  if (!version.startsWith(`rustc ${channel} `))
    return { channel: null, reason: `${version} is not the pinned ${channel}` };
  return { channel, reason: version };
}

function rebuild(entries, compare) {
  const differ = [];
  for (const entry of entries) {
    const committed = [entry.blueprint, recordPath(entry)].map((file) => [
      file,
      existsSync(join(repository, file)) ? readFileSync(join(repository, file)) : null,
    ]);
    const before = committed[0][1];
    console.log(`wasm blueprint ${entry.name}: building ${entry.crate}`);
    const run = spawnSync(process.execPath, [entry.script, ...(entry.args ?? [])], {
      cwd: repository,
      stdio: 'inherit',
      timeout: 15 * 60_000,
      windowsHide: true,
    });
    if (run.status !== 0)
      throw margoError(
        'WASM_BLUEPRINT_BUILD',
        `${entry.script} failed (${run.error?.message ?? `exit ${run.status}`})`,
      );
    // The committed file is compared, not only the module inside it: a deflated or gzip blueprint is what git holds. A
    // TypeScript blueprint is compared without its line endings, which are the checkout's, not the build's.
    const after = readFileSync(join(repository, entry.blueprint));
    const same = before ? content(before).equals(content(after)) : false;
    if (same && !before.equals(after)) writeFileSync(join(repository, entry.blueprint), before);
    console.log(
      `wasm blueprint ${entry.name}: ${blueprintBytes(entry).length} B, ${same ? 'identical to' : 'differs from'} the committed one`,
    );
    if (!same) differ.push(entry.name);
    if (compare && !same) {
      for (const [file, bytes] of committed) if (bytes) writeFileSync(join(repository, file), bytes);
    } else if (!entry.own) writeRecord(entry);
  }
  if (compare && differ.length)
    throw margoError(
      'WASM_BLUEPRINT_DIFFERS',
      `Rebuilt blueprints differ from the committed ones: ${differ.join(', ')}`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = process.argv
    .find((arg) => arg.startsWith('--only='))
    ?.slice('--only='.length)
    .split(',');
  const entries = only ? BLUEPRINTS.filter((entry) => only.includes(entry.name)) : BLUEPRINTS;
  if (only && entries.length !== only.length)
    throw margoError('WASM_BLUEPRINT_UNKNOWN', `Unknown blueprint in --only=${only.join(',')}`);
  if (process.argv.includes('--where-toolchain')) {
    const { channel, reason } = pinnedToolchain();
    if (!channel) console.log(`wasm blueprints: not rebuilt here, ${reason}; a machine with it installed proves them`);
    else rebuild(entries, true);
  } else if (process.argv.includes('--rebuild')) rebuild(entries, process.argv.includes('--compare'));
  else {
    assertWasmBlueprintsCurrent();
    console.log(
      `${BLUEPRINTS.length} Wasm blueprints match their sources (${relative(repository, dirname(fileURLToPath(import.meta.url)))}/wasm-blueprints.mjs)`,
    );
  }
}
