# Batch 160: audit of the 14 verify skips

All 14 were missing external standard test assets, not unavailable hardware. Downloading the
assets into engine-bench and setting `MARGO_SPLAT_SAMPLES` removes their skip conditions.
No physics or physics2d package is changed. The physics rows below exercise the existing
gltf-pro importer tests only. Sources and licences are already recorded in the fixture notices.

| File | Test | Original skip reason | Remedy |
| --- | --- | --- | --- |
| packages/animation/tests/interactivity.test.js | the whole conformance suite: 1,155 of 1,156 sub-tests and 187 of 187 invalid graphs | MARGO_SPLAT_SAMPLES/interactivity absent (boolean skip, no printed explanation) | Full Khronos conformance assets at f99d9b6, including invalid .gltf graphs |
| packages/gltf-pro/tests/physics.test.js | the real JointTypes builds and simulates without a broken pose | set MARGO_SPLAT_SAMPLES to the samples folder | External JointTypes.gltf and .bin |
| packages/gltf-pro/tests/physics.test.js | the real MotionProperties builds and simulates without a broken pose | set MARGO_SPLAT_SAMPLES to the samples folder | External MotionProperties.gltf and .bin |
| packages/gltf-pro/tests/physics.test.js | the real Filtering builds and simulates without a broken pose | set MARGO_SPLAT_SAMPLES to the samples folder | External Filtering.gltf and .bin |
| packages/gltf-pro/tests/physics.test.js | the real Triggers builds and simulates without a broken pose | set MARGO_SPLAT_SAMPLES to the samples folder | External Triggers.gltf and .bin |
| packages/gltf-pro/tests/physics.test.js | the real ShapeTypes builds and simulates without a broken pose | set MARGO_SPLAT_SAMPLES to the samples folder | External ShapeTypes.gltf and .bin |
| packages/gltf-pro/tests/physics.test.js | the real Materials_Friction builds and simulates without a broken pose | set MARGO_SPLAT_SAMPLES to the samples folder | External Materials_Friction.gltf and .bin |
| packages/gltf-pro/tests/physics.test.js | the real Materials_Restitution builds and simulates without a broken pose | set MARGO_SPLAT_SAMPLES to the samples folder | External Materials_Restitution.gltf and .bin |
| packages/gltf-pro/tests/physics.test.js | the real Materials_Restitution orders its bounces by coefficient | set MARGO_SPLAT_SAMPLES to the samples folder | Same restitution asset |
| packages/gltf-pro/tests/physics.test.js | the real Filtering keeps the pairs its filters refuse apart | set MARGO_SPLAT_SAMPLES to the samples folder | Same filtering asset |
| packages/gltf-pro/tests/physics.test.js | the real JointTypes keeps every closed anchor together while the bodies fall and swing | set MARGO_SPLAT_SAMPLES to the samples folder | Same joint asset |
| packages/gltf-pro/tests/splats.test.js | the real tower capture reads whole when the sample is present | set MARGO_SPLAT_SAMPLES to a folder holding tower.glb (fixtures/splats/NOTICE.md) | Existing outside Cesium tower.glb |
| packages/splats/test/spz-sog.test.js | parseSpz reads the complete racoonfamily.spz sample | set MARGO_SPLAT_SAMPLES to a folder holding racoonfamily.spz to run this | Niantic complete capture at 11312e4ad836ed06e3da2f3d5b633688d17ebebb |
| packages/splats/test/spz-sog.test.js | parseSpz reads the complete hornedlizard.spz sample | set MARGO_SPLAT_SAMPLES to a folder holding hornedlizard.spz to run this | Same Niantic commit |

Physics sample commit: eoineoineoin/glTF_Physics 9dc61cb3474ff9a51f58d3592f79d5c9e572056a.
Those samples state no licence and stay outside the repository. Khronos interactivity is
CC-BY-4.0; Niantic SPZ and samples are MIT. The complete suite retains its existing explicit
one-subtest specification disagreement; downloading data does not change its assertions.

Reproduce with `node scripts/reference-rendering/fetch-skip-assets.mjs`, then set
`MARGO_SPLAT_SAMPLES=C:/Development/Projects/engine-bench/batch-160/gltf-gpu-samples` before verify.
The downloader records a URL and SHA-256 for every outside file. Its per-request timeout is 90 s;
run the whole acquisition with a 15-minute process-tree deadline. Test logs remain in
test-results/batch-160. No test was weakened or changed to pass this audit.

Final job 2 full verify: 13,064 pass, zero failures, zero skipped, 2026-11-09.
The four audited files separately pass all 63 tests with zero skips. Every skip in the original
run is accounted for above; no unavailable hardware is required by any of these 14 tests.

## Cross-worktree enforcement (2026-11-09)

The zero-skip run depended on a shell-local MARGO_SPLAT_SAMPLES export. Without it,
the same commit still skipped exactly these 14 tests, even when the shared files existed.
The result cache did not serve results (shadow mode only); this was environment-dependent
fixture selection. Current origin/main 110b47288 had no subsequent fix at investigation.

The four importer/conformance/capture test files now resolve the same default shared cache
as the downloader, relative to the worktree parent. MARGO_SPLAT_SAMPLES overrides the whole
path; MARGO_ENGINE_BENCH overrides its parent. No physics or physics2d package changes.
All 348 inputs, including conformance indexes and companions, have tracked URL, size and
SHA-256 records in scripts/support/external-test-assets.json. Fetch is incremental and checks
existing bytes; missing/changed files are downloaded with pinned digests and a 15-minute
hard acquisition deadline. Individual tests validate their entire family before enumeration.
Verify validates every input before building. A missing, partial, changed or LFS-only cache
fails with its exact path and node scripts/reference-rendering/fetch-skip-assets.mjs.
No environment export is necessary. The missing-fixture syntax gate now covers these four
files too. A subprocess regression exercises verify with an empty override cache and requires
a failure before build, never a passing or skipped run.
