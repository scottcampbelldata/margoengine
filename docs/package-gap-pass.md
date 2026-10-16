# Package bug and gap pass

Date: 2026-10-16. Commit under test: `63ed896`. Working tree was clean. This machine ran Node v26.12.0. CI pins Node 24.

## What ran

| Check | Result |
| --- | --- |
| `npm run typecheck` | Strict checks passed for all 63 packages |
| `npm run test:all` | Build succeeded. 1,321 tests: 1,316 pass, 1 fail, 4 todo |
| Core plus stage gzip in that build | 19,999 bytes |
| `packages/kernel` Rust tests | Not run. `cargo` is not on this machine |

`test:all` is `npm run build:packages` followed by the Node runner over `tests/*.test.js`, `packages/*/tests/*.test.js`, and `packages/*/test/*.test.js`.

The browser and GPU jobs in `.github/workflows/ci.yml` were not part of this pass. That includes the Box and Avocado hardware gate, XR, USDZ, physics, selection, extensions, and the stress run.

## The failure

`tests/deep-ingestion-cad-initialization.test.js` throws while the file is loading:

```text
TypeError [ERR_INVALID_ARG_VALUE]: The property 'options.mode' must be one of: 'strip'. Received 'transform'
```

Line 8 calls `stripTypeScriptTypes` on `packages/core/src/controls.ts` with `{mode: 'transform'}`. Node 26 accepts only `mode: 'strip'`. The file exits before either test body runs:

- Core CAD initialization releases every partially installed listener and restores touch action.
- Core CAD controls retain ordinary navigation and complete listener and pointer cleanup.

`packages/core/src/controls.ts` declares `constructor(readonly camera: Camera, readonly element: HTMLCanvasElement)`. That parameter property needs a transform step. `mode: 'strip'` only erases types, so it is not a drop-in replacement. This is the only `{mode: 'transform'}` call in the repo.

`package.json` allows `node: ">=22.12.0"`, so Node 26 is inside the stated range. CI's Node 24 job can still be green while this machine fails.

## The four todos

`tests/modern-silent-facade-drops.test.js` still has two `todo` tests, each run for glTF and FBX. They count as todo, not as the failure above. This run reproduced the documented numbers.

| Todo | Actual | Expected |
| --- | --- | --- |
| glTF Box, mixed `Stage.fit` | camera target `[12, 0, 0]` | `[6, 0, 0]` |
| FBX rig, mixed `Stage.fit` | camera target `[12, 0, 0]` | `[5.304, 0, -0.361]` |
| glTF Box, facade `raw` | `raw.length === 0` | nonempty |
| FBX rig, facade `raw` | `raw.length === 0` | nonempty |

`Stage.fit` and the internal `loadedModel` adapter read `mesh.geometry` only. The passing alternatives in that file remain `model.bounds`, `model.raw`, and `camera.fitToBoundingBox`.

## Packages with no test file of their own

These ten directories have no `test/*.test.js` or `tests/*.test.js`:

`animator`, `core`, `gltf`, `kernel`, `machinery`, `margoengine`, `scenery`, `shared`, `splats`, `taa`.

Root tests cover the behavior of all of those except the kernel. `tests/modern-game.test.js` exercises `@margoengine/animator`. TAA, splats, scenery, shared math, core, the minimal glTF loader, machinery, and the stage facade are covered from `tests/`.

`packages/kernel/src/lib.rs` contains four `#[test]` functions. `npm run test:all` does not invoke them. The CI workflow does not invoke them either. `npm run build:packages` uses the precompiled wasm path, so a machine without `cargo` can still build.

Thirteen packages have tests on disk and no `"test"` script in `package.json`: `animation`, `animator`, `clustered`, `core`, `gltf`, `gltf-pro`, `machinery`, `margoengine`, `post`, `scenery`, `shadows`, `splats`, `taa`. The ones with test files are still included by the `test:all` glob.

## Left as recorded

The CAD initialization file is the one product-suite failure on Node 26. The four facade todos stay todos. The kernel unit tests stay outside the Node suite until `cargo test --manifest-path packages/kernel/Cargo.toml` is added to a machine and a CI job that have Rust.

## Follow-up fixes

Date: 2026-10-16. The original results above are retained as the baseline. This follow-up supersedes the failure, todo, and test-command status. The user approved the updated strict **25,000-byte** core plus stage ceiling during this pass; the feature freeze remains in place.

- The CAD initialization regression now compiles parameter properties with the existing TypeScript CLI into a temporary directory. It retains the baseline-source override and cleans up after successful or failed compilation. Both CAD tests pass on Node 24.22.0 and Node 26.12.0. CI adds compatibility checks on Node 22.12.0 and Node 26, alongside the existing Node 24 suite.
- The stage reads the existing shared mesh-source registry for PBR/FBX positions and draw records. Core retains its stride-6 geometry path; registered PBR positions use stride 20 and each primitive's world matrix. Hidden parts remain excluded from fitting and included in model bounds/raw. Empty grouping nodes are skipped, and disposed handles still reject.
- The four facade todos now assert successful mixed fitting and nonempty borrowed raw buffers. Additional regressions cover pure PBR fitting, hidden ancestors, grouping, duplicate handles, multiple primitives sharing buffers, deformation/device-restoration buffer replacement, and disposal/slot reuse. CPU bounds use bind-pose positions; no deformation or rendering work is added to the stage.
- Raw records retain their existing GPU buffers. Core records include `instance`; loader records need only `vertex` and `index`. WebGL2 still returns `null`. No core renderer code, optional shaders, animation math, or loader format branches changed.
- The stage build embeds only `shared/mesh-source.js`, so installed tarballs do not import outside their package. Public declarations use core buffer types and do not reference unshipped shared declarations.
- All 13 manifests listed above now expose focused workspace test commands. Run `npm run build:packages` once before `npm test --workspace packages/<name>`. Existing root suites stay in place; no tests were moved merely to give a package its own test directory.
- `npm run test:kernel` runs the four native Rust tests. A separate CI job installs the toolchain pinned by `rust-toolchain.toml` and runs those tests with the lockfile enforced. The precompiled Node build continues to work without a Rust installation.

| Follow-up check | Result |
| --- | --- |
| `npm run test:all`, Node 26.12.0 | 1,326 passed; 0 failed; 0 todo |
| `npm run typecheck` | Strict checks passed for all 63 packages |
| `npm run test:modules:packages` | All 63 tarballs imported; strict Bundler and NodeNext consumers compiled |
| Affected CAD, facade, Box, and size regressions, Node 24.22.0 | 28 passed; 0 failed; 0 todo |
| `npm test --workspace packages/margoengine` | 29 passed; 0 failed; 0 todo |
| Native kernel tests, cached Rust/Cargo 1.99.1 | 4 passed |
| `npm run measure:size`, Node 24 and Node 26 | 48,638 bytes raw; **20,215 bytes gzip**; limit 25,000 |

The other 12 new workspace commands also passed against the build available before the facade adapter was updated. The final full-suite run includes all their tests. Browser/GPU jobs were not rerun as part of this follow-up; CI changes are configured but have not run on GitHub in this checkout.

## Browser and GPU follow-up

Date: 2026-10-16. The gap-pass implementation was pushed to `origin/main` as `d28587289a716423088fe7af2abab78db1d7088d` before this campaign. Tests used that product build plus the browser-harness changes described below. This supersedes the earlier browser/GPU omission; it is local evidence, not a result from GitHub Actions.

All **20 top-level browser/GPU command groups passed**, including the headed hardware check. Runs were serialized on Windows with Node 26.12.0, Edge 155.0.4283.60, and the physical NVIDIA RTX A6000 (Ampere). Shared browser helpers verified `vendor: nvidia` and `fallback: false`; no SwiftShader launch flags were used. The main environment was `BROWSER_CHANNEL=msedge`, `GPU_VENDOR=nvidia`, `GPU_POWER=high-performance`, and `BROWSER_ARGS=[]`. Citadel supplies its own frame-rate flags for its first phase, then repeats with the native clock.

| Command | Result |
| --- | --- |
| `npm run modern:test:wrapper` | Passed |
| `npm run modern:test:domains` | Passed |
| `npm run modern:test:sky` | Passed |
| `npm run modern:test:browser` | Passed, including production Vite and Next starters |
| `npm run modern:test:citadel` | Passed, including desktop/mobile viewport and native-clock checks |
| `npm run modern:test:xr:browser` | Passed; simulated sessions with real WebGPU stereo rendering |
| `npm run modern:test:usdz:browser` | Passed |
| `npm run modern:test:extensions` | Passed, including all 11 nested report groups |
| `npm run modern:test:gltf-compression` | Passed, including production worker/Wasm assets |
| `npm run modern:test:blender` | Passed for both checked-in browser fixtures |
| `npm run modern:test:game` | Passed, including the chained temporal suite |
| `npm run test:browser --workspace @margoengine/kinematics-constraints` | Passed |
| `npm run modern:test:postfx:browser` | Passed |
| `npm run test:modules:browser` | Passed, including required FBX playback/seek and supported GPU timestamp queries |
| `npm run test:browser --workspace @margoengine/selection` | Passed, eight checks each at 1x and 4x MSAA |
| `node tests/nature.browser.mjs` | Passed, 13 named checks |
| `node packages/physics/scripts/test-browser.js` | Passed, six checks with Rapier 0.21.0 |
| `npm run modern:test:stress -- --sessions=22 --frames=24 --cycles=3` | Passed, 22/22 sessions; all 11 scenarios twice |
| `node scripts/demo-subject-tests.js --audit-only` | Passed, visible-frame timing fixture |
| `npm run modern:test:hardware` | Passed, headed WebGPU/WebGL2 parity, lifecycle, and frame/heap captures |

Production prerequisites `npm run modern:build:starters` and `node scripts/build-site.js` passed first. The 19-command serial campaign produced fresh copies of all 18 expected reports; the production timing audit is log-based. All 11 nested extension reports were fresh: materials, real material-lobe assets, glTF textures, production KTX2, animation influences, production glTF assets, local shadows, deformed picking, silent geometry, PBR Box, and scene helpers. No suite-level skip notices occurred. The CI-sized stress workload recorded 432 completed frames; intentional failure/loss scenarios complete fewer frames, and their expected recovery/rollback contracts passed. Both three-cycle soak samples stayed below the existing 8 MiB retained-heap budget.

`scripts/pbr-box-tests.js` had one obsolete assertion expecting facade PBR bounds to fail. It now verifies the actual world bounds and confirms all model nodes retain null core geometry. The existing scene-helper GPU harness now also verifies eight facade groups against native GPU buffers: mixed/default/pure fits, core batch deduplication, hidden parts, current deformation without advancing animation, device-restoration buffer replacement, stale handles, reused empty handles, and WebGL2 behavior. Queries recorded **zero GPU activity**, retained three borrowed raw records, and preserved loader buffer identity. No product code changed during this browser pass.

The headed hardware captures recorded about **60 FPS** for both backends: WebGPU 1,809 callbacks and WebGL2 1,805 callbacks across their respective 30-second windows. Both recorded zero callback gaps above 25 ms, zero hidden frames, and zero tasks above 50 ms. WebGPU recorded four GC sweeps and 964,012 bytes of heap variation; WebGL2 recorded three sweeps and 879,380 bytes. These observations do not establish zero allocation, flat heap, zero GC, or compositor presentation timing.

Local evidence is retained under `test-results/browser-gpu-gap-pass/`: `serial-suite-summary.json` contains exact commands, exit codes, timestamps and logs; `serial-aggregate.json`, `nested-report-summary.json`, and `final-verification.json` summarize fresh reports. Copied reports are under `reports/`; headed traces remain in `test-results/hardware-nvidia/`.

Scope: this campaign did not repeat AMD, other browser engines, the 500-session release workload, or the optional three-million-splat branch (the ordinary 66,049-splat path passed). XR used no physical headset. Native Blender export/install round-trip was not configured; its checked-in browser fixtures ran. The production audit used `--audit-only`, not the full production-subject loop. The local Edge/NVIDIA campaign does not substitute for CI's Chromium/SwiftShader environment.
