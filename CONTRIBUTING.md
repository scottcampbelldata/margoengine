# Contributing

Thanks for taking a look. Bug reports, fixes, docs and new examples are all welcome.

## Setup

You need Node.js 24.18+ to work in this repository (its tests use `using` declarations, and the React unit tests rely
on Node 24's node:test mock.module timing) and [Git LFS](https://git-lfs.com). End users: Node 22.12 or newer (tested
on 22.12 and the latest 22.x, 24.18 and 26). CI's node-compat job proves that on 22.12.0, the latest 22.x and 26: the
packages build, pack, install in a clean project, import (every exports entry), type-check their README examples, run
the consumer program and the packed browser test, and build with Vite, webpack, Next.js, Rollup and esbuild. Shipped
code may not use a JavaScript or Node API that Node 22.12 lacks without a feature test (`npm run check:node-apis`).
To run that proof locally, put a Node 22 first on PATH and run `npm run modern:test:packages -- --consumer` and
`npm run modern:test:bundlers`.

The unit tests of the packages that run code in Node also run on Node 22.12.0 and the latest 22.x, with the same
assertions (CI job "node22 unit tests (Node-run packages)", `npm run test:node22` after `npm run build:packages`).
`scripts/node22-packages.json` lists them with one reason each: the command line tools (margo-convert, create-margo,
the mcp server), the netcode and voxel-net servers and what they import, save's Node adapter, the format parsers and
exporters, the WGSL and shader tooling, and the packages of game and geometry logic that use no GPU or DOM. The React
unit tests stay on Node 24.18 (they rely on node:test mock.module timing; React SSR itself runs on Node 22 in the
end-user proof), and the browser-only packages are covered on Node 22 by the end-user proof. Test files that use
`using` declarations run on Node 22 through `scripts/lib/lower-using.mjs`, which lowers them to try/finally only on a
runtime that cannot parse them.

```sh
git clone https://github.com/scottcampbelldata/margoengine.git
cd margoengine
git lfs install
git lfs pull
npm ci
npm test
```

Rust is only needed to change the Wasm crates. Every Rust crate that ships as Wasm (the core kernel in
`packages/kernel` and the feature crates such as the decoders' Draco, HDR and AVIF modules, the physics kernel and the
procedural, sciviz and compute kernels) has its built `.wasm` committed beside its package, so `npm ci`,
`npm run build:packages` and `npm test` work without a Rust toolchain. `scripts/wasm-blueprints.mjs` lists them all.

The toolchain is pinned in `rust-toolchain.toml`; `rustup` picks it up. After changing a crate, rebuild its
blueprint and record with `npm run wasm:rebuild -- --only=<name>` (names in `scripts/wasm-blueprints.mjs`) and run
`npm run check:rust-kernels` (`npm run test:kernel` for the core kernel). Each blueprint has a record of the sources
it was built from; `npm run hygiene` fails when a crate changed without a rebuild. `npm run wasm:rebuild -- --compare`
rebuilds from source and fails if any committed blueprint differs, which proves they are current and reproducible.

## Before you open a pull request

```sh
npm run lint
npm run typecheck
npm run test:all
npm run api:check
npm run measure:size
```

CI runs the same commands on every push and pull request.

- Keep a pull request to one change. Small is easier to review.
- Add or update tests for what you change. Most packages have tests in `packages/<name>/tests/`.
- Run `npm run format -- <files>` on files you touch. Formatting and lint rules are in `biome.json`.
- If you change a public export, `npm run api:check` will tell you. Update the API report with
  `npm run api:update` and say why in the pull request.
- Core and the stage have a size budget (25,000 bytes gzip combined). New features normally go in their own package
  and attach through `@margoengine/core/extension`.
- Browser features need a check that runs in a real browser. The `modern:test:*` and `check:*` scripts show how.

### Testing GPU failure paths

`tests/support/gpu-faults.js` makes one device fail the n-th `createBuffer`, `createTexture` or `mapAsync` call the
way a real device fails: an allocation raises a `GPUOutOfMemoryError` (or a `GPUValidationError` with
`error: 'validation'`) in the innermost matching error scope, or an `uncapturederror` event without one, and returns
a destroyed resource; `createBuffer` with `mappedAtCreation` throws a `RangeError`; `mapAsync` rejects with an
`OperationError`. Calls count from installation, 1-based, and only that device is patched. It has no imports, so a
browser test page can load it as well as Node. Use it to check that a failure is reported, that resources and counters
are as they were before the failing call, and that the next frame or retry works:

```js
import { injectGPUFaults } from '../../../tests/support/gpu-faults.js';

using faults = injectGPUFaults(device, { createBuffer: 2, mapAsync: [1] });
device.pushErrorScope('out-of-memory');
const buffers = [device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST })];
buffers.push(device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST })); // fails
console.log((await device.popErrorScope())?.name, faults.injected); // GPUOutOfMemoryError, [{ method, call: 2, ... }]
```

Leaving the `using` block (or `faults.restore()`) puts the device back. `tests/gpu-faults.test.js` runs the helper on
a mock device. Packages whose allocation, readback or device-restore paths should be tested with it next: culling,
lod, shadows and environment (device restore), and stats, selection, inspector, headless, bvh and sciviz (readback).

## Reporting bugs

Open an issue with the browser and version, the GPU if you know it, what you expected, and the smallest snippet or
file that shows the problem. For a model that fails to load, attach the file if you can share it.

Security problems go to the address in [SECURITY.md](SECURITY.md), not a public issue.

## Where things are

| Path | What |
| --- | --- |
| `packages/core` | Engine, scene, renderer, the Wasm kernel binding |
| `packages/kernel` | Rust source of the kernel |
| `packages/stage` | `createStage` |
| `packages/*` | Everything else, one package per feature |
| `examples/` | Runnable demos |
| `docs/` | Design notes, limits and guides |
| `scripts/` | Build, test and release scripts |

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
