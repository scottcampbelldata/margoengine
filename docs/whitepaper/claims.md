# Claims inventory

Every claim the public docs make or imply, with its evidence and a status. Audited at `f4c6196` (perf/auto-quality,
2026-10-14); core-size and CAD rows updated for `0ed56b9` (core speed-ups merged, quiet-machine CAD results).

The exporter rows (PKG-094, PKG-095) were added for `3e1433a`. Not yet audited: `590278e` (point and spot shadows,
`@margoengine/clustered/shadows`) and anything after it. Re-run the audit on the release commit. Commands: [reproduce.md](reproduce.md). Outline: [outline.md](outline.md).

Status:

- **PROVEN**: a committed script and a committed result support the exact wording, and no later code change invalidates it.
- **STALE** (proven but stale): evidence exists, but the code changed since or the doc's number differs from the latest
  measurement.
- **UNPROVEN**: no committed script or result. The number appears only in prose, or the results sit only in the
  git-ignored `test-results/` folder ("raw captures remain local").
- **OVERCLAIM**: the wording is stronger than the evidence. A corrected wording is proposed.

Unless stated otherwise, "Arc" means the only machine with committed real-GPU results:

- ASUS Zenbook S 14, Intel Core Ultra 7 258V with an Intel Arc 140V iGPU (driver 32.0.101.8860), Windows 11.
- Headless Edge 155, vsync and the frame-rate cap off.
- AC power checked before and after, GPU lock held.

"Core speed-ups" means the approved core steps s1, s2, s3 and s5 (prototype branch `worktree-agent-a46261c57b837ecd0`):

- s1: skip unchanged entities.
- s2: reuse instances.
- s3: partial uploads.
- s5: fast removal.

Another worker is merging them now. Every core-path CAD number goes stale when they land.

## Summary

| Source | PROVEN | STALE | UNPROVEN | OVERCLAIM | Total |
| --- | --- | --- | --- | --- | --- |
| Root README (R) | 4 | 3 | 1 | 2 | 10 |
| Website (S) | 5 | 2 | 1 | 3 | 11 |
| HANDOFF (H) | 14 | 5 | 5 | 0 | 24 |
| Engine docs (DOC) | 16 | 19 | 24 | 2 | 61 |
| Package READMEs (PKG) | 38 | 14 | 27 | 16 | 95 |
| **All** | **77** | **43** | **58** | **23** | **201** |

Counted from the status column of the tables below.

- Some H rows repeat DOC rows (the CAD numbers), so 199 overcounts the distinct claims slightly.
- The core speed-ups merged at 0ed56b9, so every pre-merge core CAD number (DOC-022 to DOC-028, H-10) is now STALE.
- Those rows are superseded by the quiet-machine before/after table (DOC-059), the first publication-grade real-GPU result in the repo.

### Worst items for a Hacker News reader

1. **No same-machine, same-scene speed comparison with three.js is committed.** The two committed comparisons can't support "faster":
   - DOC-035: vsync on, three not instanced.
   - DOC-036: not reproducible, MSAA mismatched, and three.js won orbit FPS and load time.

   The harness is new (see the vs-three.js section). Make no speed claim until it has run on a quiet machine.
2. **The install commands don't work.** `npm install @margoengine/core@0.1.0` is printed in the README, the core README and MODERN-ENGINE.md (R-05, DOC-001), but none of the 71 packages is published. DOC-002 says the libraries were published, which is only true of the pre-rename names.
3. **The site says "both backends included" in the 20 kB** (S-02). The WebGL2 backend left core at 1356787. Docs give six different core sizes (18,681; 19,874; 20,053; 19,975; 19,988; 19,999), and one of them would fail today's 20,000 gate (DOC-006, DOC-010 to DOC-012).
4. **The three.js size comparison has no committed output** (DOC-004, H-01). It says 138 vs 139 kB in two places, and the Margo figure is WebGPU only while three's WebGLRenderer figure includes WebGL.
5. **CAD scale.**
   - Core caps at 100,000 entities, so "100k parts" is impossible (DOC-021).
   - The quiet-machine table after the merged core steps (DOC-059) shows 50k parts orbiting at 92 FPS, but 90k orbiting is unchanged at 33 FPS (GPU-bound). This is on one integrated GPU.
   - The culling package's 52-98 FPS drops picking, hierarchy, edges, caps and shadows (H-12).
   - The older pre-merge numbers (45 FPS at 50k, 25 FPS at 90k) are still printed at the top of cad-performance.md, from a busier session. Readers will see two different sets of numbers for the same scene.
6. **Quality-tier promises** (PKG-066, DOC-019): "Slow PCs never show a slow phase", "holds about 60 FPS". These are absolute claims with no measurement, and a known 3-5 FPS Android case exists.
7. **"Replaces X" parity lines contradicted by the package's own Limits**: troika text (PKG-079), EXRLoader (PKG-025), Havok/react-three-rapier (PKG-060), Raycaster (PKG-010). The "84 of 156 covered" tally is accurate but mostly API-only (DOC-053).
8. **Mock-GPU CPU numbers presented without the word "mock"** (PKG-055). The materials instancing README numbers (36 → 0.4 ms) disagree with the HEAD run (55 → 0.7 ms) (PKG-056).
9. **"Byte-identical" proofs whose default command no longer passes**: post (PKG-065), materials (PKG-054), gltf-pro (PKG-035), selection (PKG-068). The claim was true at the time; it isn't reproducible as written.
10. **Hardware and verification claims with local-only data**:
    - The RTX A6000, AMD and Night Citadel "60.03 FPS" claims (DOC-039 to DOC-049).
    - The iPhone 1M particles (H-03).
    - "Verified in Chrome" (S-10).
    - Test counts that disagree with each other (DOC-014 to DOC-016).
    - A missing npm script (`modern:bench:sky`, DOC-045).

### Fastest fixes (docs only, no new measurements)

- Replace "both backends" on the site and in MODERN-ENGINE.md with "WebGPU backend; WebGL2 via `@margoengine/webgl`".
- Use 19,543 B (core speed-ups merged) everywhere: README, from-threejs.md, MODERN-ENGINE.md, benchmarks/.
- In cad-performance.md, mark the top tables "before the merged core steps".
- Label the install lines "after publication".
- Use 71 packages everywhere.
- Delete or mark "historical, raw data local" every DOC-039 to DOC-051 number.
- Add "mock GPU" to mock-only numbers.
- Replace "Replaces X" with "Covers the common cases of X (see Limits)".
- Fix the garbled reproduce command in `docs/cad-performance.md:58-59` and the missing `modern:bench:sky`.
- Commit the outputs of `measure:threejs`, `measure:demos --json` and an extended `proofs/size.js` (subpath and worker entries).

## Head-to-head with three.js (the most important gap)

Before this task, no committed same-machine, same-scene result supported "faster than three.js":

- **`benchmarks/results.md`** (`scripts/benchmark-three-vs-margo.js`): stale and not like-for-like.
  - Scene: a 12,014-node conveyor on NVIDIA, 2026-10-11, commit 7908ad3.
  - Vsync was on, so both engines report 16.67 ms (the 60 Hz cap). The table carries no speed information.
  - three drew plain `Mesh` objects (9,012 draws) while Margo drew 2. three ran WebGL2, Margo WebGPU. Neither used MSAA then.
  - Only the payload (19,207 vs 131,858 B) and GC counts mean anything.
- **`benchmarks/conveyor-simulator.md`**: not reproducible and not like-for-like.
  - Its input pages are single-file HTML files that are not in the repo.
  - three ran at 4x MSAA, Margo at 1x.
  - three won orbit FPS (1586 vs 1446) and load-to-ready (609 vs 816 ms). Margo won explode (1219 vs 786 FPS) and click-to-select (5.8 vs 11.4 ms).
- **`examples/conveyor-simulator/{margo,three}-conveyor.html`** is the closest to fair: instancing on both sides, 4x MSAA, WebGPU mode for three. It has never had results committed (HANDOFF: "Not yet run since the WebGPU option was added").

New in this task: `examples/package-benchmarks/vs-threejs/` (`npm run bench:threejs`). Results are in the section
[vs-three.js results](#vs-threejs-results) below.

## Root README (`README.md`)

| ID | Claim (exact, trimmed) | Location | Evidence | One command? | Status | Corrected wording / note |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | "Core plus the stage facade measures **18,681 bytes gzip**, including embedded Wasm and the WebGPU backend" | README.md:108 | `scripts/measure-size.js`: **19,543** at 0ed56b9 after the merged core steps (docs/cad-performance.md table). | `npm run build:packages && npm run measure:size` | STALE | "19,543 bytes gzip" (or "under 20 kB"). Same fix in docs/from-threejs.md (DOC-003). |
| R-02 | "every push and pull request runs a CI build that rejects a combined size of 20,000 bytes gzip or above" | README.md:108 | `scripts/core-budget.js` (`CORE_STAGE_GZIP_LIMIT = 20_000`), run by `build:packages`. `.github/workflows` runs it. HANDOFF: Actions minutes are spent until next month, so CI is not running now. | `npm run build:packages` | OVERCLAIM | "The build fails at 20,000 bytes gzip or above (locally and in CI)." The mechanism is proven; "every push" is not true this month. |
| R-03 | "The build also retains the 30 KiB combined core/static-glTF budget and 30 KiB raw Wasm budget" | README.md:108 | `scripts/build-modern.js:24,79` | `npm run build:packages` | PROVEN | – |
| R-04 | "The release contains 61 packages" | README.md:79,145 | 71 `packages/*/package.json` files, all in the root workspaces. `docs/catalog.json` says 71. | `ls packages/*/package.json` | STALE | "71 packages". |
| R-05 | `npm install @margoengine/core@0.1.0` (and the other install lines) | README.md:27-43 | `docs/catalog.json`: `published: false` for all 71 packages. Line 7 says to build from source "until the renamed packages are published". | – | OVERCLAIM | Label the install lines "after publication", or move them below "Run from source". |
| R-06 | "Thirty-one JavaScript tests, four Rust checks and 32 browser check groups passed after the modern-only cleanup" | README.md:131 | Rust: 4 `#[test]` (correct). JS and browser counts: no committed output. Current run: `results/gates-browser-tests.json` has 39 of 41 browser scripts passing. | `npm run verify`; `node examples/package-benchmarks/gates/run-browser-tests.mjs` | STALE | Quote the counts from the release commit's `verify` and `gates-browser-tests.json`. |
| R-07 | "AMD Radeon integrated graphics and NVIDIA baseline measurements are recorded in the benchmark summary. Raw captures and recovery archives remain local." | README.md:131 | `benchmarks/README.md` prose. The raw data is in `test-results/` only. | no | UNPROVEN | Drop it, or commit the JSON from a re-run (see DOC-039 to DOC-047). |
| R-08 | "Firefox/Safari and mobile GPU hardware remain unverified" | README.md:131 | HANDOFF records one manual iPhone capture (1M particles, 58-60 FPS) and a Galaxy S23 at 3-5 FPS. Neither is committed. | – | PROVEN | An honest limitation. Keep it. |
| R-09 | "basic scenes can fall back to WebGL2 when an app passes `fallback: webglRenderer` from `@margoengine/webgl`" | README.md:133 | `gates-browser-tests.json` (WebGL2 paths pass with the fallback). | gates runner | PROVEN | – |
| R-10 | "Million-particle, three-million-splat and 1,024-light execution tests validate correctness separately from FPS claims" | README.md:110 | `scripts/modern-game-tests.js`. Splats at 3M only with `SPLAT_STRESS=1`. | `npm run modern:test:game` | PROVEN | The README itself says these are correctness tests, not FPS. Keep that distinction everywhere (see the package table). |

## Website (`site/index.html`, margoengine.com)

| ID | Claim (exact, trimmed) | Location | Evidence | One command? | Status | Corrected wording / note |
| --- | --- | --- | --- | --- | --- | --- |
| S-01 | "A 3D engine for the web that starts under 20 KB." | site/index.html (hero) | As R-01: 19,543 B gzip at 0ed56b9. | `npm run measure:size` | PROVEN | "KB" is gzip of core + stage, WebGPU only. Say "under 20 kB gzip". |
| S-02 | "Under 20 KB gzip: Core plus the stage facade, embedded Wasm and both backends included." | site/index.html (features) | The WebGL2 backend moved to `@margoengine/webgl` in 1356787. The 18,681 B figure is WebGPU only. The webgl dist file is 2,283 B gzip (level 9, unminified dist). | `npm run measure:size` | OVERCLAIM | "Under 20 kB gzip: core plus the stage facade with the embedded Wasm kernel and the WebGPU backend. The WebGL2 fallback is the optional `@margoengine/webgl` (about 2.3 kB gzip)." |
| S-03 | "CI rejects any build at 20,000 bytes gzip or above." | site/index.html | As R-02. | `npm run build:packages` | OVERCLAIM | "The build rejects..." (CI is paused this month). |
| S-04 | "An engine holds 1,024 entities by default, configurable up to 100,000." | site/index.html | `packages/core/src/kernel.ts` capacity cap. | unit tests | PROVEN | – |
| S-05 | "Visible meshes sharing a geometry instance render in one instanced draw call per scene pass, with per-instance material values." | site/index.html | `cad/results-*.json` (`drawCalls`). The vs-three.js run reports Margo's draw counts. | `cad/run.mjs` | PROVEN | – |
| S-06 | "WebGPU first, WebGL2 fallback ... Basic scenes still render on WebGL2." | site/index.html | True only with the optional `@margoengine/webgl` passed as `fallback`. | – | STALE | "...on WebGL2 with the optional `@margoengine/webgl` package (core meshes, flat PBR, one light)." |
| S-07 | "automatic device-loss recovery on WebGPU" | site/index.html | `scripts/modern-domain-tests.js` passes in `results/gates-browser-tests.json` (Arc, AC). | gates runner | PROVEN | – |
| S-08 | "The release includes 60 packages under @margoengine and the margoengine stage facade." | site/index.html | 70 + facade = 71. | – | STALE | "70 packages under @margoengine plus the margoengine facade." |
| S-09 | "Each pack is a separate, tree-shakable package. Your app loads only the ones it imports." | site/index.html | `npm run measure:demos` (eager versus lazy chunks per demo); sky/vfx feature entries (HANDOFF 1h.i). Output not committed. | `npm run measure:demos` | UNPROVEN | Commit `measure:demos --json` output on the release commit. |
| S-10 | "It has been verified in Chrome and Edge on desktop. Firefox, Safari and mobile GPUs are not yet verified." | site/index.html | Edge: `gates-browser-tests.json`. Chrome 155: `results/workers.json` (OffscreenCanvas page) only. Every other suite ran on Edge. | gates runner with `BROWSER_CHANNEL=chrome` | OVERCLAIM | Chrome evidence is one page. Run the browser suite with `BROWSER_CHANNEL=chrome` and commit it, or say "Edge (Chromium)". |
| S-11 | "Install from npm, once published" | site/index.html | Honest. | – | PROVEN | – |

## HANDOFF (`docs/HANDOFF.md`): numbers that will be quoted

Only HANDOFF items likely to reach the pitch are listed. The CAD rows overlap DOC-020 to DOC-034.

| ID | Claim (exact, trimmed) | Location | Evidence | One command? | Status | Corrected wording / note |
| --- | --- | --- | --- | --- | --- | --- |
| H-01 | "Margo core + stage 48 kB / 20 kB; three WebGL 621 kB / 139 kB; three WebGPU 959 kB / 229 kB. Script: `test-results/three-size.mjs` (ignored folder)" | HANDOFF:47-48 | The script is now `npm run measure:threejs` (committed). It prints only, with no committed output. Core + stage is now 18,681. | `npm run measure:threejs` | STALE | Re-run on the release commit and commit the output (see the vs-three.js section for bundle numbers from this task). |
| H-02 | "100k particles locked at 60 FPS; 1M particles a steady 45. Not re-measured since the water restore." | HANDOFF:44-45 | Not committed. | no | STALE | Superseded by `vfx-island-final.json` (1M on the light tier: 56.7 → 60 FPS paced). |
| H-03 | "iPhone ... really draws 1,000,000 particles at 880x1526 and 58-60 FPS" | HANDOFF:31-32 | A bookmarklet capture. No committed file. | no | UNPROVEN | Needs a scripted phone run (outline: what Scott must provide). |
| H-04 | "Kept, with proofs that all pass when re-run alone (slowest case 1.07x, most 1.5-6x)" | HANDOFF:54-56 | `proofs/*.proof.js` + `proofs/results/*.json` | `node examples/package-benchmarks/proofs/<name>.proof.js` | STALE | Many packages changed after f47ff3f (math consolidation, lighting hooks, instancing). Some default baseline refs no longer build (`post-ssao-perspective` default `12bf774`; `materials-uv-transform` default `1970fda` already differed). Re-run all of them on the release commit (`npm run bench:all -- --only=proofs`). |
| H-05 | "LOD 2,500 instances: GPU median 23.2 ms LOD vs 226.9 ms full detail (9.8x)" | HANDOFF:115-116 | `results/gates-lod-2500.json` (Arc, AC) | gates runner (lod browser-check) | PROVEN | HANDOFF 1c says "7-20x less GPU time". Quote 9.8x with the scene. |
| H-06 | "DOF made 2-5x cheaper" (4.91 → 1.45 ms ...) | HANDOFF:130-149 | `gates/dof.mjs`, `results/gates-dof.json` (Arc, AC) | `node examples/package-benchmarks/gates/dof.mjs` | PROVEN | – |
| H-07 | Post stack per effect: "SSAO 2.34 ms, DOF 4.49, Bloom 0.28 ... post total 7.7 ms" | HANDOFF:122-128 | `results/gates-post-stack.json` | `node examples/package-benchmarks/gates/post-stack.mjs` | STALE | DOF became 2-5x cheaper after this run. Re-run for the whitepaper. |
| H-08 | "20 cycles of load -> render -> unload ... zero growth in count or bytes" | HANDOFF:167-172 | `results/gates-memory.json` | `node examples/package-benchmarks/gates/memory.mjs` | PROVEN | – |
| H-09 | VFX 1M "simulate+draw: 5.00 -> 2.46 ms (1x)"; island "56.7 -> 60 FPS" | HANDOFF:181-204 | `results/vfx-gpu-*.json`, `results/vfx-island-final.json` | `vfx-gpu.mjs` / `vfx-island.mjs` (need a baseline build) | PROVEN | Not one command (a baseline dist snapshot is needed). One integrated GPU. |
| H-10 | "at 50k parts the frame is 20.9 ms CPU (45 FPS), at 90k 39.1 ms (25 FPS)" | HANDOFF:293-294 | Pre-merge session. | `cad/run.mjs` | STALE | Superseded by DOC-059 (quiet machine): 50k orbit 49 → 92 FPS, 90k orbit 34 → 33 FPS. |
| H-11 | Prototype: "90k tick 16.5 -> 4.4 ms", "50k 1% moving: 45 -> 103 FPS", "dispose 90k 48 s -> 20 ms" | HANDOFF; docs/cad-performance.md prototype table | `cad/results-s0..s5-{orbit,still,move}.json` now committed (AC, GPU lock; not the quiet session) | `node examples/package-benchmarks/cad/summary.mjs s0 s1 s2 s3 s4 s5` | PROVEN | Prototype numbers (step 4 not merged). For the paper quote the quiet-machine merged table (DOC-059). |
| H-12 | Culling "90k parts: CPU 23.4 -> 0.4-0.6 ms per frame; FPS orbit 36 -> 52 ... grazing 48 -> 98" | HANDOFF:307-315 | `cad/results-culling.json` (Arc, AC; 0 differing pixels) | `node examples/package-benchmarks/cad/culling.mjs --check` | PROVEN | Always state the limits: culled parts get no `engine.pick`, hierarchy, ExplodedView, edges, caps or shadows. The "core" column goes stale with the speed-ups. |
| H-13 | "full-screen DamagedHelmet 0.852 -> 0.524 ms GPU" | HANDOFF:282-283 | `results/pipeline-toggles.json` | `node examples/package-benchmarks/pipeline-toggles/toggle.mjs override` | PROVEN | – |
| H-14 | "adding the plugin when wanted spikes the frame +178 ms (sections) / +121 ms (fog)" | HANDOFF:233-236 | `results/pipeline-toggles.json` | `toggle.mjs stall` | PROVEN | – |
| H-15 | Textured instancing "1k-10k boxes CPU 15-127 ms -> 0.6-0.8 ms, frame 74-659 ms -> 4-5 ms" | HANDOFF:601-603 | `results/textured-instancing-gpu.json` (Arc, AC, f4c6196) | `node examples/package-benchmarks/textured-instancing-gpu.mjs` | PROVEN | – |
| H-16 | VAT "1,000 walking robots 1 draw and <0.01 ms CPU vs 465 ms CPU / 19,000 draws" | HANDOFF:215-216 | `proofs/animation-vat.proof.js` (mock GPU) | `node examples/package-benchmarks/proofs/animation-vat.proof.js` | PROVEN | Mock-GPU CPU only. Say so. |
| H-17 | VAT real GPU "1,024 walking robots in 1 draw at 0.7-0.9 ms CPU and 11-16 ms GPU per frame (machine busy)" | HANDOFF:217-219 | `atlas-vat/check.mjs` writes `test-results/atlas-vat-check.json` (ignored). "Machine busy". | `node examples/package-benchmarks/atlas-vat/check.mjs` | UNPROVEN | Re-run on a quiet machine and commit the JSON (bench:all keeps it). |
| H-18 | Workers: "FBX 160k-quad grid ... 1162 / 1112 / 1167 ms -> 0 / 0 / 217 ms" | HANDOFF:388-398 | `results/workers.json` (Edge 155, Arc, AC) | `node examples/package-benchmarks/workers/run.mjs` | PROVEN | – |
| H-19 | create-margo "Production bundle 36,180 bytes gzip (one JS file)" | HANDOFF:427-428 | `tests/create-margo.test.js` builds it but does not record or assert the size. | no | UNPROVEN | Print the size in the test or in measure:demos. |
| H-20 | ContactShadows "texture update 0.05/0.25/0.9-1.1 ms at 256/512/1024" | HANDOFF:328-331 | `results/staging-contact.json` | `node packages/staging/test/browser-check.mjs` | PROVEN | – |
| H-21 | "Laptop result (Arc 140V, busy machine): stored 'low', light tier 53-61 FPS with 100k particles" | HANDOFF:756 | Prose only, on a busy machine. | no | UNPROVEN | Do not quote. |
| H-22 | "Night Citadel 65,309 -> 60,704 ..." eager gzip per demo | HANDOFF:522-526 | `npm run measure:demos`. Output not committed. | `npm run measure:demos` | UNPROVEN | Commit the JSON from the release commit. |
| H-23 | "1,263 exports in 129 entries", "92 `any`" | HANDOFF:661 | `api/*.api.md`, `docs/api-surface.md` | `npm run api:update` | PROVEN | – |
| H-24 | Browser gate "39/41 pass" | HANDOFF:100 | `results/gates-browser-tests.json` | gates runner | PROVEN | Changes with every merge. Re-run on the release commit. |

## Engine docs (MODERN-ENGINE.md, MODULE-AUDIT.md, benchmarks/, docs/from-threejs.md, docs/threejs-parity.md, docs/cad-performance.md, docs/demo-loading.md, docs/desktop-frame-rate.md, conveyor README, core and margoengine READMEs)

Facts used below:

- 71 `packages/*/package.json` files, all in the root workspaces.
- Core + stage is 18,681 B gzip at f4c6196 and 19,543 B at 0ed56b9 (core speed-ups merged).
- The embedded Wasm (decoded from `packages/core/src/wasm.ts`) is 12,009 B raw and 5,053 B gzip, SHA-256 `5140c355…`, built with `-Oz` + raw deflate.

| ID | Claim (exact, trimmed) | Location | Evidence | One command? | Status | Corrected wording / note |
| --- | --- | --- | --- | --- | --- | --- |
| DOC-001 | "npm install @margoengine/core@0.1.0" (and the five-package install line) | packages/core/README.md:12; MODERN-ENGINE.md:24 | `docs/catalog.json`: `published:false` for all 71. MODERN-ENGINE.md:21 says "until the renamed packages are published". | – | OVERCLAIM | "Not on npm yet. Build from source: `npm ci && npm run build:packages`." |
| DOC-002 | "The five libraries were published publicly as version `0.1.0` on 11 October 2026" | benchmarks/README.md:15 | Nothing committed. These were the pre-rename names. | no | UNPROVEN | "Pre-rename packages were published 2026-10-11; `@margoengine/*` is not yet published." |
| DOC-003 | "under 20 kB gzip (18,681 bytes today" | docs/from-threejs.md:41 | `measure:size` is 19,543 at 0ed56b9 | `npm run measure:size` | STALE | "19,543 bytes today". |
| DOC-004 | "three.js is about 138 kB for WebGL and 229 kB for WebGPU" | docs/from-threejs.md:42 | `scripts/compare-threejs-size.js` prints to the console only. HANDOFF says 139 kB. | `npm run measure:threejs` | UNPROVEN | Commit the output. The Margo figure is WebGPU only. 138 vs 139 kB mismatch. |
| DOC-005 | "strictly below 20,000 bytes gzip" | packages/margoengine/README.md:9 | `core-budget.js`, run by build:packages. | `npm run measure:size` | PROVEN | – |
| DOC-006 | "Rust Wasm kernel… 12,046 \| 5,064"; "Core, including embedded Wasm and both backends \| 53,073 \| 19,874" | MODERN-ENGINE.md:249-250 | WebGL left core at 1356787. Now 12,009 / 5,053 and 18,681. | `npm run measure:size` | STALE | "Core + stage (WebGPU only) 18,681 B gzip; kernel 12,009 B raw." |
| DOC-007 | "glTF… 4,993", "Machinery… 14,527", "Creative… 9,563", "Core plus glTF sums to 24,867", "Vite starter… 90.2 KiB", "606 gzip bytes of headroom" | MODERN-ENGINE.md:251-257 | An Oct 11 measurement, test-results only. Contradicts cad-performance.md:147 (machinery root 33,849). | not committed | UNPROVEN | Regenerate with `proofs/size.js` and commit. |
| DOC-008 | "`wasm-opt -O3`… reproduced both raw and optimized Wasm byte-for-byte" | MODERN-ENGINE.md:59,259 | The build is now `-Oz` + raw deflate (c82e119). | no | STALE | Describe `-Oz` and give the current SHA. |
| DOC-009 | "0.169 ms median versus 0.052 ms… 21,110 gzip bytes" | MODERN-ENGINE.md:261 | Nothing committed. Superseded by `-Oz`. | no | UNPROVEN | Remove. |
| DOC-010 | "locked core measures 19,874 bytes gzip… 12,046 bytes raw, SHA-256 c9fade…" | benchmarks/README.md:11 | 18,681 / 12,009 / `5140c355…` at f4c6196; core + stage 19,543 and a rebuilt kernel (step 1) at 0ed56b9: re-measure the Wasm size and SHA. | `npm run measure:size` | STALE | Update, or label historical. |
| DOC-011 | "Core + stage gzip is 20,053 bytes, below the 20,480-byte ceiling" (and "20,480-byte… gate") | MODULE-AUDIT.md:81-83; MODERN-ENGINE.md:285; benchmarks/stress-results.md:20; stress-testing.md:3 | The gate is 20,000. 20,053 would fail it today. | `npm run measure:size` | STALE | 18,681 and a 20,000 gate. |
| DOC-012 | "19,988", "19,997", "19,999… / 47,983 raw", "19,975 bytes" | desktop-frame-rate.md:63,129,159,172; demo-loading.md:11 | Historical builds. | – | STALE | Mark as historical or delete. |
| DOC-013 | "`machinery/edges` 4,299 B… spatial 14,937… root 33,849"; culling "7,015 B min+gzip" | cad-performance.md:144-148,197 | Measured at c9d6d61 / 037d098, test-results only. Machinery changed since (803aa19). | not committed | UNPROVEN | Commit `proofs/results/sizes.json` from the release commit. |
| DOC-014 | "`npm test` # … runs 40 focused unit checks" | MODERN-ENGINE.md:36 | `npm test` = tests/modern*.test.js: 25 files, about 121 `test()` calls. | `npm test` | STALE | Quote the count from a run. |
| DOC-015 | "Twenty-seven JavaScript tests and four Rust checks", "Thirty-two shared math/camera checks", "31 JavaScript tests" | MODERN-ENGINE.md:265-266,305; benchmarks/README.md:13 | Rust 4 (correct). JS counts not committed. | no | UNPROVEN | One current count. |
| DOC-016 | "434 passed", "447 Node tests", "543", "581", "627", "754 unit tests" | MODULE-AUDIT.md:63; stress-results.md:20; desktop-frame-rate.md:48,130,159,173 | test-results only. The six numbers disagree. About 890 `test()`/`it()` sites in 165 files. | `npm run test:all` | UNPROVEN | One number from the release commit, log committed. |
| DOC-017 | "core, glTF, React, machinery, creative and scenery packages", "all seven libraries", "All 37", "61 packages" | MODERN-ENGINE.md:11,37,39,61; MODULE-AUDIT.md:8; desktop-frame-rate.md:131,169,174; stress-results.md:20 | 71 packages. | `ls packages/*/package.json` | STALE | "71 packages". |
| DOC-018 | "on an integrated laptop GPU roughly halves GPU time compared with 4× MSAA" | packages/core/README.md:5 | `results/vfx-island-final.json` (Arc): island with particles off, light tier about 10.1 ms vs high tier about 20.6 ms. | no (needs variant builds) | PROVEN | Name it: "halved GPU time in the island demo on an Intel Arc 140V". |
| DOC-019 | "the light tier holds about 60 FPS instead of swinging on 120 Hz panels" | docs/from-threejs.md:821 | `paceEngine` is a cap. HANDOFF: 53-61 FPS measured. | no | OVERCLAIM | "caps the light tier at about 60 FPS so it does not swing between 120 and 40 on 120 Hz panels". |
| DOC-020 | "Intel Arc 140V… 4x MSAA… vsync and the frame-rate limit off… AC power" | cad-performance.md:3-9 | `cad/results-*.json` record AC, host and adapter. | – | PROVEN | – |
| DOC-021 | "the largest case is 89,883 parts in 99,976 entities" | cad-performance.md:16,22 | kernel cap 100,000; `results-after-max.json`. | `cad/run.mjs --sizes=max` | PROVEN | 100,000 parts do not fit in core today. Never pitch "100k parts". |
| DOC-022 | "Frame interval / FPS 6.7 ms / 150 | 22.0 ms / 45 | 40.3 ms / 25" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | STALE | Superseded by the quiet-machine before/after table (DOC-059): orbit FPS 168 → 247 / 49 → 92 / 34 → 33 (10k/50k/90k). Quote that table with its core commit. |
| DOC-023 | "Kernel tick… 1.69 / 7.74 / 16.4 ms… Whole-frame CPU 39.1 ms" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | STALE | Superseded by the quiet-machine before/after table (DOC-059): kernel in frame 0.65 / 2.66 / 4.09 ms (orbit). Quote that table with its core commit. |
| DOC-024 | "`engine.pick` median… 12.1 / 30.3 / 63.5 ms" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | STALE | Superseded by the quiet-machine before/after table (DOC-059): pick 7.6 / 19.5 / 30.9 ms. Quote that table with its core commit. |
| DOC-025 | AssemblyBVH "create 1,465 → 18.9 ms", "rebuild 1,400 → 3.5 ms" | cad-performance.md:41,129-135 | `proofs/results/machinery-cad.json` (Node, AC, identical outputs) | `node examples/package-benchmarks/proofs/machinery-cad.proof.js` | PROVEN | – |
| DOC-026 | ExplodedView "0 ms at rest" | cad-performance.md:42,114-118 | `machinery-cad.json`, `results-after-*.json` | same | PROVEN | – |
| DOC-027 | "Load to first frame 592 ms, JS heap 75 MB, Instance storage 10.1 MB, removing one mesh 3.0 ms" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | STALE | Superseded by the quiet-machine before/after table (DOC-059): re-run run.mjs on the tip for load, heap and removal (step 5 changed removal). Quote that table with its core commit. |
| DOC-028 | "90k parts with 1x MSAA… 30.9 ms CPU, 24.7 ms GPU, 32 FPS" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | STALE | Superseded by the quiet-machine before/after table (DOC-059): re-run `--low` on the tip. Quote that table with its core commit. |
| DOC-029 | "Node measures 11.4 ms… and 15.7 ms" | cad-performance.md:56-61 | `results-kernel-node.json` | `node examples/package-benchmarks/cad/kernel-node.mjs` | PROVEN | The reproduce command at lines 58-59 is garbled (the culling command is pasted into it). Fix the doc. |
| DOC-030 | "disposing a 90k-part assembly mesh by mesh is O(n²), minutes" | cad-performance.md:76 | Step 5 merged: disposing a 90k engine 48 s → 20 ms (`cad/results-s0-*`, `results-s5-*.json`). | `cad/run.mjs` | STALE | The hot-spot list is now labelled "as measured before"; quote "48 s before step 5, 20 ms after". |
| DOC-031 | Edges "GPU 2.23 / 4.65 / 5.83 ms" | cad-performance.md:97-104 | `results-edges.json` | `cad/run.mjs --edges` | STALE | Machinery changed since (803aa19). Re-run. |
| DOC-032 | Culling at 90k "Orbit \| 36.4 / 24.7 \| … \| 51.8 / 18.3", grazing "97.7" | cad-performance.md:161-170 | `results-culling.json` (Arc). Another worker's GPU timing shared the machine between runs. | `node examples/package-benchmarks/cad/culling.mjs --check --views=orbit,still,grazing --layouts=sheet,stack --label=culling` | PROVEN | The "core" column goes stale with the speed-ups. State the culling limits (H-12). |
| DOC-033 | "0 differing pixels in all 640 frames" | cad-performance.md:190-195 | `results-culling.json` `checks` | same | PROVEN | – |
| DOC-034 | OCCT "7,604,031 bytes, 3,110,912 gzip"; STEP "1,403-1,715 ms" | cad-performance.md:202-208 | `node_modules/occt-import-js` wasm; `results-step.json` | `cad/run.mjs --sizes=1000 --step` | PROVEN | – |
| DOC-035 | three vs Margo table: Margo "16.67 \| 2 draws \| 19207", three "16.67 \| 9012 \| 131858"; GC "1 / 0" vs "196 / 8" | benchmarks/results.md:9-10 | `scripts/benchmark-three-vs-margo.js` (NVIDIA, 2026-10-11, 7908ad3). Vsync on, three not instanced, both 1x MSAA at the time. The script has changed since. | `npm run benchmark:three-vs-margo` | STALE | No speed signal (60 Hz cap). Valid only for payload and GC, and three without instancing inflates its draws and GC. Replace with vs-threejs. |
| DOC-036 | Conveyor: orbit "1586… \| 1446", explode "786 \| 1219", click "11.4 \| 5.8 ms", ready "609 \| 816 ms", script "172.6 / 54.3 KiB" | benchmarks/conveyor-simulator.md:9-36 | `scripts/benchmark-conveyor-simulator.js` (NVIDIA, 2026-10-12, 4aab554) on two HTML files that are not in the repo. MSAA: three 4x vs Margo 1x. | no | UNPROVEN | Not reproducible or like-for-like. Note that three won orbit and load. Do not cite. |
| DOC-037 | "`?renderer=webgpu`… the like-for-like comparison"; "Both desktop scenes use explicit 4× MSAA" | examples/conveyor-simulator/README.md:12,14 | The pages match the description. No results committed. | no (Git LFS, server, manual flags) | UNPROVEN | Run and commit, or point to vs-threejs. |
| DOC-038 | "Verify both pages on the dedicated NVIDIA GPU with `node …/benchmark.test.mjs`" | examples/conveyor-simulator/README.md:20 | Writes to test-results. Asserts `vendor === 'nvidia'`. | no (NVIDIA only) | UNPROVEN | – |
| DOC-039 | "Eight real-browser check groups on… RTX A6000", "CPU median 2.0 ms / p95 3.2 ms", "4.2–4.6 ms warm asynchronous completion" | MODERN-ENGINE.md:269-275 | test-results only. Oct 11, pre-rename. | partly | UNPROVEN | – |
| DOC-040 | "0.050 ms mean / 0.060 ms… 0.211 ms"; AMD "CPU median/p95 2.2/3.0 ms… 15.9/17.7 ms" | MODERN-ENGINE.md:279-281 | Local only. | no | UNPROVEN | – |
| DOC-041 | SwiftShader "CPU median 4.7 ms / p95 7.0 ms"; "tick mean was 0.108 to 0.120 ms" | MODERN-ENGINE.md:303-311 | `benchmarks/swiftshader/*.json` (b3987dd, Linux VM, software GPU) | no | STALE | Core has changed a lot since. CPU-only meaning. |
| DOC-042 | "500 queued parts… 0.0135/0.0137 ms" (Ryzen 9 9950X) | benchmarks/README.md:34 | test-results only. | `npm run modern:bench:machinery` | UNPROVEN | – |
| DOC-043 | "100,000-triangle STL import kept animation frames running"; "51 check groups per browser" | benchmarks/README.md:36,38 | test-results only. | no | UNPROVEN | – |
| DOC-044 | "sustained **60.03 FPS**… 118.68 FPS"; "643 instances and 15 draw calls… no minor/major GC" | benchmarks/README.md:40-44 | Local only. | no | UNPROVEN | – |
| DOC-045 | "SkyMoonPass… 0.0195 ms median"; "`npm run modern:bench:sky`" | benchmarks/README.md:46 | The pass was merged away. **`modern:bench:sky` does not exist in package.json.** | broken command | UNPROVEN | Delete. |
| DOC-046 | "500 / 500", "131,877 tracked GPU buffers/textures", "181.4 / 210.9 ms" | benchmarks/stress-results.md:7-18 | Dirty workspace on 9b98d25. test-results only. | `npm run modern:test:stress -- --sessions=500 --frames=120` | UNPROVEN | The doc disclaims it already. |
| DOC-047 | "actual WebGPU on NVIDIA RTX A6000 in Edge 155", "six real browser checks pass" | MODULE-AUDIT.md:68-80 | test-results only. | `npm run test:modules:browser` | UNPROVEN | – |
| DOC-048 | "GPU work… 1.638 ms → 0.655 ms… 60%/67%/67%/63%" | desktop-frame-rate.md:35-40 | `test-results/gpu-diagnosis.json` (RTX A6000) | no | UNPROVEN | – |
| DOC-049 | "about 59.5 FPS at the 60 target and 120.3 FPS"; "3.21–7.41 ms" | desktop-frame-rate.md:53,198-200 | Local only, over RDP. | no | UNPROVEN | – |
| DOC-050 | Historical cold-load table ("615 ms… 1,858 ms") | demo-loading.md:48-56 | NVIDIA, Oct 12, local. Labelled historical. | – | UNPROVEN | Delete, or keep marked historical. |
| DOC-051 | "Afterlight 2,305 ms / 4,497 ms Fail…"; "DOF… 1553 ms… Tonemap… 902 ms" | demo-loading.md:164-168,193-195 | Arc, test-results only. | `npm run benchmark:demo-loads` (after build:site) | UNPROVEN | Honest negative result. Commit it. |
| DOC-052 | "Phones use 1024 × 512 Earth WebP maps: 381,276 bytes"; helmet "600,948 bytes versus 3,773,916" | demo-loading.md:85,89 | `wc -c` on the committed assets matches. | `wc -c` | PROVEN | – |
| DOC-053 | "156 three.js features in 19 areas… COVERED 84, PARTIAL 40, MISSING 32" | docs/threejs-parity.md:7-13 | The recount matches exactly. But 50 of the 84 COVERED rows are † (exports and README only), and the doc says no row was run. Most need WebGPU. | script recount | PROVEN | The tally is right and the doc says how it was made. It becomes an overclaim if quoted as "covers 84 three.js features". Quote it as "84 of 156 covered by API, 34 of them checked in tests; none were run against three.js." Never shorten it to "parity with three.js". |
| DOC-054 | "Real GPU: the instanced frame equals N meshes" | docs/threejs-parity.md:252 | `results/textured-instancing-gpu.json` | `textured-instancing-gpu.mjs` | PROVEN | – |
| DOC-055 | "texel-locked (no shimmer) under orthographic pan and zoom" | docs/threejs-parity.md:64 | `results/shadow-shimmer.json` | `shadow-shimmer.mjs` | PROVEN | The JSON shows 0.57 of 14,423 edge pixels per frame. "No measurable shimmer" is the precise wording. |
| DOC-056 | "removed 6,017 bytes of gzip… about 7.5 kB and 3.3 kB more gzip" | docs/threejs-parity.md:385 | test-results/dedupe only. | no | UNPROVEN | – |
| DOC-057 | "8 check groups for both backends", "automatic fallback", "keep the base WebGL2 fallback" | benchmarks/README.md:27; MODERN-ENGINE.md:231,269,281,307 | True only before 1356787. | – | STALE | "…with the optional `@margoengine/webgl` fallback". |
| DOC-058 | "285 bytes total per slot" | MODERN-ENGINE.md:83 | Step 1 added 66 B per slot (docs/cad-performance.md). | `cad/run.mjs` | STALE | About 351 B per slot. |
| DOC-059 | Quiet-machine before/after table, e.g. "orbit 50,004 … 49 → 92" FPS, "still 89,883 … 33 → 52", "move 50,004 … 54 → 133"; "the kernel is 3-4x cheaper in every case"; "orbit at 90k is unchanged (34 → 33 FPS)"; "`move` at 10k got slower" | docs/cad-performance.md (merged fast paths section) | `cad/results-{before,after}{1,2}-{orbit,still,move,orbitmove}.json` (quiet machine, Arc, AC, GPU lock, 2026-10-14 19:08-19:21 local; `node examples/package-benchmarks/cad/summary.mjs before1 before2 after1 after2`) | `node examples/package-benchmarks/cad/run.mjs` per case (doc lists them), on a quiet machine | PROVEN | Publication-grade: quiet machine recorded in each JSON (`conditions`), AC before and after, alternating rounds, regressions reported. One integrated GPU, two rounds per cell: state the spread. |
| DOC-060 | Fast paths bit-exact: "0 differing pixels over 25 comparisons plus 4 unchanged redraws"; "`npm run verify`: 1,051 tests pass" | docs/cad-performance.md | `tests/core-dirty-transforms.test.js` (in verify); `cad/pixels-check.mjs` (real GPU, output not committed); the test count is from an uncommitted run log | `npm run verify`; `node examples/package-benchmarks/cad/pixels-check.mjs` | PROVEN | Commit the pixel-check JSON; the test count changes with every merge. |
| DOC-061 | Back-face culling by `cullMode`: "about 2 ms (12%) of GPU per frame on the 50k CAD scene and up to 2.5x on heavy overdraw" | docs/cad-performance.md | `cull-bench.mjs` and `results-cull-*.json` are on branch `scratch/core-backface-cull`, not this branch | not on this branch | UNPROVEN | Not shipped: fine as a measured proposal, never as an engine property. |
| PKG-094 | glTF export round trip: RobotExpressive goes from 752 Khronos glTF-Validator errors in the source (unnormalized skin weights) to 0 in the exported file (weights normalized) | exporters (`exportModel`, b45fec0/3e1433a); HANDOFF | `packages/exporters/tests/model.test.js` (in `verify`); `examples/package-benchmarks/exporters-model.mjs` → `results/exporters-model.json` (validator `gltf-validator` from node_modules, Node 24, 2026-10-14) | `node examples/package-benchmarks/exporters-model.mjs` | PROVEN | Deterministic (validator counts), not a timing. Say "the source file has 752 validator errors". |
| PKG-095 | "DamagedHelmet exports in 7.7 ms" (Node 24, median of 7) | HANDOFF; `results/exporters-model.json` | Same script and JSON (`exportMs` 7.73, min 5.83). Measured while other agents ran. | same | STALE | A Node CPU timing from a busy machine. Re-measure in the quiet-PC run (bench:all includes it, see reproduce.md) before quoting. |
| PKG-093 | "Static scenes cost little per frame: the kernel recomputes only entities whose … changed" | packages/core/README.md | DOC-059 (`still`, `move`), `tests/core-dirty-transforms.test.js` | as DOC-059 | PROVEN | Add the numbers and the caveat that an orbiting camera still re-collects every frame (90k orbit unchanged). |

## Package READMEs (`packages/*/README.md`)

Abbreviations:

- "pkb/" means `examples/package-benchmarks/`.
- "Gate run" means `pkb/results/gates-browser-tests.json` (7c90b73, 39 of 41 scripts pass).
- `kernel` and `shared` have no README.

Packages with no checkable claims: animator, ecs, fsm, gizmo, gltf, html, ifc, input, inspector, navigation, navmesh,
net, react, road, scatter, splines, taa, terrain, tonemap, toon, transitions, usdz-export, water, wfc, xr.

Two fixes would clear most rows:

- Most UNPROVEN size rows: extend `pkb/proofs/size.js` to measure subpath and worker entries, and commit the result.
- PKG-092: add the per-package `test:browser` scripts to `gates/run-browser-tests.mjs`.

| ID | Claim (exact, trimmed) | Location | Evidence | One command? | Status | Corrected wording / note |
| --- | --- | --- | --- | --- | --- | --- |
| PKG-001 | "A separate entry (6.1 kB gzip…)" | animation/README.md:28 | HANDOFF 1c prose only. `proofs/size.js` measures root entries only. | no | UNPROVEN | Add `/vat` to a committed size record. |
| PKG-002 | "per-frame CPU work is one 160-byte uniform write whatever the crowd size" | animation:28 | `proofs/animation-vat.proof.js` → `proofs/results/animation-vat.json` (uploadBytes 160, 1 draw at 100 and at 1,000); mock GPU; 700838e | `node pkb/proofs/animation-vat.proof.js` | PROVEN | Measured at 100 and 1,000 copies only. |
| PKG-003 | "1,000 skinned models 30.5 ms update + 434 ms draw recording (19,000 draws…27.8 MB)… under 0.01 ms… 120-180 ms and 6.9 MB" | animation:43 | Same JSON | same | PROVEN | Mock GPU. The bake was measured once at 118 ms: say "about 120 ms". |
| PKG-004 | "Real GPU (Intel Arc 140V…): silhouette IoU 0.98… 1,024 walking robots… 0.7-0.9 ms CPU and 11-16 ms GPU" | animation:43 | `pkb/atlas-vat/check.mjs`. No committed JSON. HANDOFF: "machine busy". | no | UNPROVEN | Re-run on a quiet machine and commit the JSON. |
| PKG-005 | "installation/export are exercised in Blender 5.3 Beta" | blender:42 | Needs `MARGO_BLENDER`. The gate run of `modern-blender-tests.js` (7.1 s) did not use Blender. | no | UNPROVEN | Record a run with Blender. |
| PKG-006 | Benchmark table "Terrain… 1.54 s… 187,620… Bumpy sphere… 2.03 s…" ("Node 22, one core of a shared 2-core container") | bvh:73-78 | `packages/bvh/scripts/bench.js` prints only. Date unknown. bvh src changed since. | partly | UNPROVEN | Re-run on named hardware and commit the JSON. |
| PKG-007 | "`'center'` builds about 3x faster" | bvh:60 | Same table (2.5x and 3.6x) | no | UNPROVEN | "2.5-3.6x faster", once committed. |
| PKG-008 | "roughly 3,000 to 4,200 times the brute-force ray rate… about 26 MB for 1M triangles" | bvh:80 | Same table | no | UNPROVEN | – |
| PKG-009 | Models table "0.94 ms per part… 84 µs… 1.8 s… 7.6 µs" | bvh:82-89 | `scripts/bench-models.js` → `test-results/bench-models.json` (ignored) | no | UNPROVEN | Commit the JSON outside test-results. |
| PKG-010 | "It covers what three-mesh-bvh (…) and `THREE.Raycaster` do" | bvh:3 | Parity doc: lines are never hit, points use a separate pick, skinned meshes are hit in bind pose. | n/a | OVERCLAIM | "…the triangle-mesh queries of three-mesh-bvh and `THREE.Raycaster` (not lines, points or sprites)". |
| PKG-011 | "about 1.9 kB min+gzip" | cameras:54 | HANDOFF prose (1,931 B) | no | UNPROVEN | Commit a size record. |
| PKG-012 | "Cascades stay texel-locked under orthographic pan and zoom (no shimmer…)" | cameras:50-51 | `pkb/shadow-shimmer.mjs` → `results/shadow-shimmer.json` (Arc, 43052ce). Zoom bit-identical; pan 0.57 of 14,423 edge px per frame vs 194 for real shimmer. | `node pkb/shadow-shimmer.mjs` | OVERCLAIM | Minor. "No visible shimmer: ortho zoom is bit-identical; a slow pan changes about 0.6 of 14k shadow-edge pixels per frame (vs 194 for a 0.01° light turn)". |
| PKG-013 | "for up to 1,024 point/spot lights" | clustered:3 | `scripts/modern-game-tests.js` asserts no truncation at 1,024; gate pass | `node scripts/modern-game-tests.js` | PROVEN | Functional only. No FPS is claimed. |
| PKG-014 | "The default grid uses 13.5 MiB for indices" | clustered:31 | 16×9×24×1,024×4 B (`src/index.ts:47`) | n/a | PROVEN | – |
| PKG-015 | "30 and 60 fps settle identically" | controls:80 | `tests/controls.test.js` | `npm test -w @margoengine/controls` | PROVEN | – |
| PKG-016 | "on an integrated laptop GPU roughly halves GPU time compared with 4× MSAA" | core:5 | `results/vfx-island-final.json` (Arc, one demo) | `node pkb/vfx-island.mjs` (variants) | OVERCLAIM | "On an Intel Arc 140V laptop the island demo's GPU frame fell from about 20 to 10 ms (particles off)". DOC-018 counts the same line as PROVEN with that note; this table is stricter. |
| PKG-017 | "[measured baselines](…/benchmarks/README.md)" | core:29 | Captured 11 Oct before the rename, at core 19,874 B. Core has changed a lot since. | no | STALE | Re-measure and date. |
| PKG-018 | "Use `VFX` directly for… up to 1,000,000 particles" | creative:43 | `modern-game-tests.js` asserts the 1M indirect count; VFX GPU runs at 1M | yes | PROVEN | – |
| PKG-019 | 89,883-part culling table (CPU 23.4 / 0.48 / 0.41 / 0.55 ms; FPS / GPU ms) | culling:66-81 | `pkb/cad/culling.mjs` → `cad/results-culling.json` (Arc, 037d098). No src change since. | `node pkb/cad/culling.mjs --check --views=orbit,still,grazing --layouts=sheet,stack` | PROVEN | GPU ms ±15% by the README's own note. |
| PKG-020 | "0 differing pixels in all 640 compared frames" | culling:83-87 | Same JSON | same | PROVEN | – |
| PKG-021 | "Output matches the meshoptimizer reference decoder bit for bit" | decoders:27 | `tests/decoders.test.js` (meshoptimizer 1.1.1 vectors) | `npm test -w @margoengine/decoders` | PROVEN | – |
| PKG-022 | DOF cost table ("4.91 → 1.45 ms" …) | dof:22-31 | `pkb/gates/dof.mjs` → `results/gates-dof.json` (Arc, 3371f5c) | `node pkb/gates/dof.mjs` | PROVEN | – |
| PKG-023 | "differ by a mean of 0.00–0.11 levels (at most 0.3% of pixels by more than 6 levels)" | dof:33 | Same | same | PROVEN | – |
| PKG-024 | "creates no JS arrays, typed arrays, descriptors or shader strings in steady-state frames" | dof:35 | `tests/dof.test.js` counts typed arrays and GPU objects only, on a mock | test | OVERCLAIM | "Steady frames construct no typed arrays and no GPU objects (mock-GPU test)". |
| PKG-025 | "Replaces Three.js `RGBELoader`, `EXRLoader`, …, `PMREMGenerator`" | environment:7 | The package rejects PXR24/B44/DWAA/DWAB, tiled and multipart EXR (its own README:129). three reads PXR24 and DWAA/DWAB. | n/a | OVERCLAIM | "Covers the common cases …: single-part scanline EXR with NONE/RLE/ZIPS/ZIP/PIZ". |
| PKG-026 | "All three allocate nothing in steady frames" | environment:43 | Only the backgrounds are tested | partly | OVERCLAIM | Minor. Scope the claim, or add tests for EnvironmentLighting and Fog. |
| PKG-027 | "off renders the same pixels as no fog (checked on the real GPU)" | environment:41 | `results/pipeline-toggles.json` (0 of 3.7M channels; Arc) | `node pkb/pipeline-toggles/toggle.mjs pixels` | PROVEN | – |
| PKG-028 | "20 EXR fixtures… decoding bit-exactly" | environment:135 | `tests/environment.test.js` | `npm test -w` | PROVEN | – |
| PKG-029 | "`dist/workers/fbx.js`, 16.7 kB gzip" | fbx:14 | HANDOFF prose only | no | UNPROVEN | Commit worker sizes. |
| PKG-030 | "Same model as `loadFBX` / `parseFBX`, byte for byte" | fbx:14 | `test/worker.test.js` | yes | PROVEN | – |
| PKG-031 | "85.8 kB with three.js before, 12.0 kB now (13.9 kB…)" | fbx:29 | Commit 95132e9 message only, no method. fbx src changed since. | no | UNPROVEN | Pin the before ref, name the method, commit the JSON. High HN interest. |
| PKG-032 | "compares 20 primitives… against a fixture generated from Three.js r180… to 1e-5" | geometry:55,89 | `tests/fixtures/three-reference.json` + `geometry.test.js` | yes | PROVEN | The fixture is r180; the parity doc targets r186. |
| PKG-033 | "`boxGeometry` plus `toGeometry` is under 1 KiB gzip" | geometry:60 | The test asserts < 1,500 B only | test | OVERCLAIM | "about 1 kB (test enforces < 1.5 kB)", or commit the figure. |
| PKG-034 | "GPU time fell from 0.85 to 0.52 ms, with identical pixels for every material kind" | gltf-pro:29 | `results/pipeline-toggles.json` (Arc, 7f1c9c6) | `toggle.mjs override` | PROVEN | – |
| PKG-035 | "`gltf-pro-lighting-hooks.proof.js` shows the GPU calls equal the text patches they replaced" | gltf-pro:41 | Default ref 15c87f1, no result file. Later passes recorded vs 114130c only. | default command probably fails | STALE | State the ref used, or re-baseline the default. |
| PKG-036 | "`@margoengine/gltf-pro/instancing` (about 2.5 kB gzip)" | gltf-pro:51 | HANDOFF prose (2,466) | no | UNPROVEN | – |
| PKG-037 | "The non-instanced draw makes the same GPU calls as before" | gltf-pro:71 | Proofs vs 114130c: 4,556 and 1,277 identical calls | `node pkb/proofs/gltf-pro-lighting-hooks.proof.js 114130c` | PROVEN | The default refs differ. Document the ref. |
| PKG-038 | "`dist/workers/gltf.js` (5.5 kB gzip)" | gltf-pro:88 | Later HANDOFF records 6,408 B | no | STALE | "about 6.3 kB gzip". |
| PKG-039 | "equals `loadGLTF`… byte for byte" | gltf-pro:88 | `tests/worker.test.js` | yes | PROVEN | – |
| PKG-040 | "Main-thread blocking measured in a real browser" | gltf-pro:88 | `pkb/workers/run.mjs` → `results/workers.json` (Edge 155, Arc) | `node pkb/workers/run.mjs` | PROVEN | – |
| PKG-041 | "perspective GPU calls and buffer writes are byte-identical to `96edc75`" | lines:90 | `proofs/lines-perspective.proof.js`. Later changes are math only. | yes | PROVEN | – |
| PKG-042 | "importing `parsePLY` pulls in about 3.8 KB gzip" | loaders:42 | No record | no | UNPROVEN | – |
| PKG-043 | "`dist/workers/usd.js`, 6.6 kB gzip" | loaders:83 | HANDOFF prose only | no | UNPROVEN | – |
| PKG-044 | "nothing is allocated per frame (tested with 3,000 objects…)" | lod:36-37 | `lod.test.js` asserts heap growth < 64 KB over 1,000 frames | yes | OVERCLAIM | Minor. "no measurable heap growth (< 64 KB over 1,000 frames)". |
| PKG-045 | LOD table (CPU 1.1 ms; GPU 160-232 vs 11-25 ms), rerun "writes `test-results/lod-benchmark.json`" | lod:64-77 | The cited file is ignored. Committed gate `results/gates-lod-2500.json`: CPU 0.5/0.8/0.7 ms, GPU 3.6/23.2/226.9 ms. | `node packages/lod/test/browser-check.mjs` | STALE | The CPU column differs. Cite the gate JSON. |
| PKG-046 | "differs… by 1.7/255 on average and covers 99%" | lod:74 | Gate: 1.72 and 0.99 | yes | PROVEN | – |
| PKG-047 | Atlas-seam "before" figures and "+2 ms… (20.5-20.9 → 22.6-22.9 ms)" | lod:79-97 | The "after" values are in `results/gates-lod-imposter-check.json`. "Before" and the timing are prose only. | partly | UNPROVEN | – |
| PKG-048 | "about 10.8 kB min+gzip" | lod:111 | No record (commit 0fff93c said about 9.0 kB) | no | UNPROVEN | – |
| PKG-049 | "Entry size about 4.0 kB min+gzip" (dimensions) | machinery:77 | Prose 3,973 B. Machinery changed after. | no | UNPROVEN | – |
| PKG-050 | "(160-230 ms measured on an Arc 140V, versus about 8 ms…)" | machinery:83 | `results/pipeline-toggles.json`: +178 ms (146-228) vs +8.6 ms | yes | STALE | "about 180 ms (146-228 ms over 5 runs) vs about 9 ms". |
| PKG-051 | "These assets add about 7.7 MB" | machinery:91 | OCCT 7,604,031 + 96,871 B | n/a | PROVEN | Also give 3.1 MB gzip. |
| PKG-052 | "an exploded view at rest costs nothing per frame" | machinery:79 | `cad/results-after-*.json` | `node pkb/cad/run.mjs` | PROVEN | – |
| PKG-053 | "combined core and stage facade… strictly below 20,000 bytes gzip" | margoengine:9 | `core-budget.js` via build-modern/measure-size; 19,543 B at 0ed56b9 | `npm run measure:size` | PROVEN | CI is paused this month; the gate runs locally. |
| PKG-054 | "Without a transform the GPU calls are byte-identical to before (`materials-uv-transform.proof.js`)" | materials:25 | Default ref 1970fda already differed. Passes vs 114130c. | default fails | STALE | State the ref. |
| PKG-055 | "256 textured boxes go from 256 draws and 8.3 ms CPU per frame to 1 draw and 0.05 ms" | materials:27 | `proofs/results/materials-atlas.json` is labelled "recording mock GPU"; the draw path changed since | yes | OVERCLAIM | Add "on the mock GPU (CPU encoding only)". |
| PKG-056 | "5,000 textured boxes: 5,000 draws and 36 ms… 1 draw and 0.4 ms… equals… pixel for pixel" | materials:46 | HEAD run `results/textured-instancing-gpu.json` (f4c6196): 55 → 0.7 ms, maxDiff 1 | `node pkb/textured-instancing-gpu.mjs` | OVERCLAIM | Also stale. "5,000 draws / 55 ms → 1 draw / 0.7 ms CPU; instanced frame within 1/255 per channel". |
| PKG-057 | "ships about 1.3 kB gzip. The whole package is about 10.4 kB gzip" | math:13 | The test asserts Vector3 < 1,500 B; the whole-package size is not recorded | partly | UNPROVEN | – |
| PKG-058 | "nothing allocates except `clone()` and `toArray()`" | math:3 | No test | no | UNPROVEN | – |
| PKG-059 | "kept bit-for-bit identical to the package copies they replaced" | math:15 | `proofs/math-consolidation.proof.js` (~2.0M checks) | yes | PROVEN | – |
| PKG-060 | "Covers what Babylon.js offers with its Havok plugin… and what `@react-three/rapier` gives" | physics:7 | No matrix. The README's own Limits list many missing features. | n/a | OVERCLAIM | "Covers the common rigid-body subset… (see Limits)". |
| PKG-061 | "the 1.6 MB (gzip) Rapier bundle" | physics:48 | No record | no | UNPROVEN | – |
| PKG-062 | "a given sequence of inputs replays bit for bit" | physics:49 | `tests/physics.test.js` | yes | PROVEN | Same build and platform only. |
| PKG-063 | "built for millions of points" | points:3 | Browser test draws 2M under a 500k budget (output ignored). CPU pick on 500k is about 130 ms. No FPS. | partly | OVERCLAIM | "Tested with a 2,000,000-point cloud drawn under a 500,000-point budget". |
| PKG-064 | "2,000,000 points chunk in about 0.4 to 0.8 s" | points:39 | No record | no | UNPROVEN | – |
| PKG-065 | "Used alone, every effect makes exactly the GPU calls it made before the stack existed" | post:36-37 | `proofs/post-stack.proof.js`. DOF and SSAO were rewritten after it, so it cannot hold at HEAD. | no | STALE | "When PostStack landed (5b1fe66), each effect alone made the same GPU calls as before". |
| PKG-066 | "held to about 60 FPS… Slow PCs never show a slow phase or a reload" | quality:3-5 | Unit tests only. Prose: 53-61 FPS on a busy laptop. | no | OVERCLAIM | "Desktops start on the light tier, so no PC is first shown the 4x tier or reloaded by the probe; the light tier's own FPS depends on the GPU". |
| PKG-067 | "6.1 kB min+gzip with Sky's base, against 10.2 kB for the full Sky" | scenery:27-28 | 10.2 matches `docs/api-surface.md`. 6.1 is not recorded. | no | UNPROVEN | – |
| PKG-068 | "With `xray` off… byte-identical… (10,586 recorded calls)" | selection:20 | `proofs/selection-xray-off.proof.js` (ref 46f9484). Selection changed after; not re-run. | probably | STALE | Re-run and record. |
| PKG-069 | "`Picking.attach(engine)` enables faster `engine.pick`" | selection:22 | No timing of Picking vs `engine.pick` | no | UNPROVEN | Measure pick latency with and without it. |
| PKG-070 | "A 600-pixel grid agrees with the bvh Raycaster within one pixel…; about 99% agree exactly" | selection:51 | `test/models.browser.mjs` passes in the gate run. Selection changed after. | yes | STALE | Re-run. |
| PKG-071 | "whole package 11.8 kB…; `NodeMaterial`… 5.8 kB" | shader:100 | `shader.test.js` asserts < 12,500 / < 6,500 B and prints the values | yes | PROVEN | Commit the exact values. |
| PKG-072 | "a slow pan… and an orthographic zoom leave shadow edges unchanged" | shadows:7 | `shadow-shimmer.json` (pan changes 0.57-9.7 px per frame; zoom bit-identical) | yes | OVERCLAIM | Minor. Use the PKG-012 wording. |
| PKG-073 | Sky entry table (base 5.1, +0.6…; "Night Citadel… 7.2 kB, `stage.sky()`… 6.1 kB") | sky:23-35 | Root 10,173 B in api-surface. Entries not recorded; `stage.sky()` fetch recorded as 6,720 B. | no | UNPROVEN | – |
| PKG-074 | "With every feature the WGSL is byte-identical… rendered pixels are the same" | sky:35-37 | `test/split.test.js`, `test/browser-check.mjs` (gate pass) | yes | PROVEN | – |
| PKG-075 | "for 1–3,000,000 world-space splats" | splats:7 | 3M is an input cap. One 3M run on an AMD iGPU at 181.4 ms (2026-10-11, raw data local). Splats changed since. | yes | STALE | "Accepts up to 3M splats; a 3M cloud ran at about 181 ms per frame on an AMD iGPU". |
| PKG-076 | "update… 0.05 ms at 256, 0.25 ms at 512 and 0.9-1.1 ms at 1024; the plane 0.02-0.04 ms" | staging:28-31 | `results/staging-contact.json` (Arc, 43052ce) | `node packages/staging/test/browser-check.mjs` | PROVEN | – |
| PKG-077 | "about 5.0 kB min+gzip" | staging:46 | Later HANDOFF records 5,362 B | no | STALE | "about 5.4 kB". |
| PKG-078 | "Zero runtime dependencies" | stats:3 | `package.json` | n/a | PROVEN | – |
| PKG-079 | "Replaces troika-three-text's `Text`" | text:7 | Its own Limits: no Arabic/Indic shaping and no ligatures | n/a | OVERCLAIM | "Covers troika's `Text` for Latin, Greek, Cyrillic, CJK, Hebrew and emoji (no Arabic/Indic shaping or ligatures)". |
| PKG-080 | "no per-track allocations in update"; "without allocations"; "without allocating a new vector" | tween:3; procedural:28; cinematic:3-4 | No allocation tests | no | UNPROVEN | Add heap or constructor-count tests. |
| PKG-081 | "`dist/workers/usdz.js`, 25.9 kB gzip" | usdz:18 | HANDOFF prose only | no | UNPROVEN | – |
| PKG-082 | "13.7 kB… before, 8.7 kB now; 16.1 kB before and 12.6 kB now including… loaders" | usdz:30 | Commit message only. `docs/api-surface.md` has the usdz root at 11,371 B (another method). Src changed since. | no | STALE | Re-measure with one stated method. |
| PKG-083 | "capacity up to 1,000,000"; "64 MB for state plus 4 MB for the draw list" | vfx:3,24 | `modern-game-tests.js`; arithmetic; `scripts/measure-vfx-memory.js` | yes | PROVEN | – |
| PKG-084 | "Intel Arc 140V (Edge 154…)… 1,000,000 1x 5.00 ms → 2.46 ms… all 16 rounds faster" | vfx:46-57 | `pkb/vfx-gpu.mjs` → `results/vfx-gpu-final-fill.json` (68771a2) | `node pkb/vfx-gpu.mjs` (A/B builds) | PROVEN | The JSON user agent is Edg/155, so "Edge 154" is wrong. |
| PKG-085 | "particle passes went from 5.7 to 2.6 ms and the frame's GPU span from 15.7 to 13.5 ms" | vfx:59-61 | `results/vfx-island-final.json` | `pkb/vfx-island.mjs` | PROVEN | – |
| PKG-086 | "`VFX`… (7.7 kB min+gzip)… `base` (5.7 kB)… +0.8 / +0.1 / +0.7 / +0.4 kB" | vfx:65-68 | `pkb/vfx-size.mjs` → `results/vfx-size.json` | `node pkb/vfx-size.mjs` | PROVEN | `api-surface.md` uses another method (7,009 B). Pick one method for the whitepaper. |
| PKG-087 | "the WGSL, uploads and GPU calls are byte-identical for every feature combination" | vfx:78 | `test/split.test.js` | yes | PROVEN | – |
| PKG-088 | "Zero-copy WebGPU external video textures" | video:3 | `importExternalTexture`. Whether the browser copies depends on the platform. Mock tests only. | n/a | OVERCLAIM | Minor. "Imports frames with `importExternalTexture` (no JS-side copy)". |
| PKG-089 | "3.1 kB min + gzip (the test enforces under 3.5 kB)" | viewcube:57 | `viewcube.test.js` | yes | PROVEN | – |
| PKG-090 | "saves about 1.4 KB gzip" | webgl:17 | Commit 1356787 message: 19,972 → 18,554 B | `measure:size` at both refs (not recorded) | UNPROVEN | Commit the two measurements. |
| PKG-091 | "`npm test`… runs N Node tests/checks" (26/25/33/15/26/47/29) | audio:81, bvh:104, controls:119, labels:78, loaders:75, geometry:98, physics:119 | Counted `test(` calls: audio 26, bvh 25 and labels 15 match; controls 34, loaders 33, geometry 57 differ. | yes | STALE | Update the counts or drop them. |
| PKG-092 | Package browser-test results ("byte-identical to the synchronous build", "within 2%", "within 1 px", "within 2.5 px", "restores the original frame byte for byte", 2M points…) | bvh:106, audio:81, labels:78, lines:92, text:92, points:112, environment:137, decoders:55, exporters:67, physics:121, controls:121 | The scripts are committed and assert these. None is in the gate run or CI; outputs go to ignored test-results. | per package `npm run test:browser -w …` | UNPROVEN | Add them to the gate runner and commit its JSON. |

## vs-three.js results

**No publishable result yet.** The harness is built, and on 2026-10-14 it was smoke-tested on a busy machine:

- Settings: 1 round, 30-60 frames.
- Scope: every scene except 50k, under the GPU lock, on AC power.
- The JSON is labelled `"SMOKE TEST, NOT FOR PUBLICATION"` and kept in ignored `test-results/`.

The timing run waits for a quiet PC (`docs/whitepaper/reproduce.md`). Until it exists, the whitepaper and launch posts
should make no speed claim against three.js.

What the smoke run established (correctness of the harness, not performance):

- Every variant runs:
  - Margo.
  - three WebGL2 and WebGPU, each with `Mesh` and with `InstancedMesh`.
  - three's WebGPURenderer stayed on its WebGPU backend.
- No page errors once the favicon 404 was silenced.
- MSAA reports 4 samples everywhere.
- GPU timing works on both APIs:
  - WebGPU: timestamp queries injected into every pass, for Margo and three alike.
  - WebGL2: `EXT_disjoint_timer_query_webgl2` is exposed by Edge 155 on ANGLE/D3D11.
- Draw counts match the design: Margo 1 per geometry; three `Mesh` about one per visible object; three `InstancedMesh` 1 per shape.
- The scenes match on screen. Final frames at t = 0 compared with Margo's:
  - CAD differs on about 2-3% of pixels (edges).
  - The helmet differs on about 35%: the floor is tone-mapped with Reinhard in Margo and ACES in three, and the clear colour differs slightly.

  Screenshots: `test-results/vs-threejs/*.png`.

Things to settle before or in the quiet run:

1. In the smoke run Margo's GPU time was not lower than three.js `InstancedMesh` on static boxes, and was higher on the helmet scene.
   - For the helmet this is expected: Margo renders 4 PCSS cascades against three's one PCF map.
   - For the boxes it needs a look first: Margo's 4x HDR target, resolve and tonemap passes versus three's direct-to-canvas MSAA.

   This is exactly the kind of result to state honestly ("three.js wins here"). It must not be hidden.
2. The WebGL2 `TIME_ELAPSED` number includes GPU idle time while a CPU-bound renderer is still submitting (thousands of `Mesh` draws). Report it next to `serialFrameMs`, and do not read it as pure GPU work.
3. Make the clear colour identical (three's background is set in sRGB space; Margo's clear is written as is), and consider an all-ACES floor for the helmet, so the image-diff check means something.
4. Add an A/A run (the same engine twice) to state the noise floor.
5. Add the particles scene (design in the harness README) before claiming anything about particles against three.js.
