# Claims inventory

Every claim the public docs make or imply, with its evidence and a status. Audited at `f4c6196` (perf/auto-quality,
2026-10-14); core-size and CAD rows updated for `0ed56b9` (core speed-ups merged, quiet-machine CAD results).

**Docs corrected against this inventory (HANDOFF 5d, on `3d845a0` + the 5d commits).** Every OVERCLAIM, STALE and
UNPROVEN row was fixed at its source (root README, `site/index.html`, MODERN-ENGINE.md, docs/, benchmarks/, every package
README): the Status column now gives the state after the fix and the last column says what changed ("Fixed (5d): ...").
Commits `590278e` to `3d845a0` (point and spot shadows, the texture-binding limit, API standardization, visual
regression, the bvh dist fix) were audited in the same pass: rows S-12, H-25 to H-32, DOC-062 to DOC-069 and PKG-096 to
PKG-105. Re-run the audit on the release commit. Commands: [reproduce.md](reproduce.md). Outline: [outline.md](outline.md).

Status:

- **PROVEN**: a committed script and a committed result support the exact wording, and no later code change invalidates it.
  A dated statement ("measured at X, before Y") counts when its committed result supports it.
- **STALE** (proven but stale): evidence exists, but the code changed since or the doc's number differs from the latest
  measurement.
- **UNPROVEN**: no committed script or result. The number appears only in prose, or the results sit only in the
  git-ignored `test-results/` folder ("raw captures remain local").
- **OVERCLAIM**: the wording is stronger than the evidence. A corrected wording is proposed.
- **REMOVED** (5d): the claim was deleted from the public text (or reduced to a statement with no checkable number).
- **HISTORICAL** (5d): kept only inside a document now labelled as a dated record whose raw data was not committed; it
  is not a current claim and must not be quoted.

Unless stated otherwise, "Arc" means the only machine with committed real-GPU results:

- ASUS Zenbook S 14, Intel Core Ultra 7 258V with an Intel Arc 140V iGPU (driver 32.0.101.8860), Windows 11.
- Headless Edge 155, vsync and the frame-rate cap off.
- AC power checked before and after, GPU lock held.

"Core speed-ups" means the approved core steps s1, s2, s3 and s5 (prototype branch `worktree-agent-a46261c57b837ecd0`),
merged at `0ed56b9`:

- s1: skip unchanged entities.
- s2: reuse instances.
- s3: partial uploads.
- s5: fast removal.

## Summary

After 5d (228 rows: the original 201 plus 27 from the post-`590278e` audit):

| Source | PROVEN | STALE | UNPROVEN | OVERCLAIM | REMOVED | HISTORICAL | Total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Root README (R) | 9 | 0 | 0 | 0 | 1 | 0 | 10 |
| Website (S) | 12 | 0 | 0 | 0 | 0 | 0 | 12 |
| HANDOFF (H) | 17 | 6 | 9 | 0 | 0 | 0 | 32 |
| Engine docs (DOC) | 48 | 0 | 1 | 0 | 10 | 10 | 69 |
| Package READMEs (PKG) | 87 | 1 | 5 | 0 | 7 | 5 | 105 |
| **All** | **173** | **7** | **15** | **0** | **18** | **15** | **228** |

The original 201 rows went from 77 PROVEN / 43 STALE / 58 UNPROVEN / 23 OVERCLAIM to 154 PROVEN / 5 STALE /
9 UNPROVEN / 0 OVERCLAIM / 18 REMOVED / 15 HISTORICAL. Before 5d:

| Source | PROVEN | STALE | UNPROVEN | OVERCLAIM | Total |
| --- | --- | --- | --- | --- | --- |
| Root README (R) | 4 | 3 | 1 | 2 | 10 |
| Website (S) | 5 | 2 | 1 | 3 | 11 |
| HANDOFF (H) | 14 | 5 | 5 | 0 | 24 |
| Engine docs (DOC) | 16 | 19 | 24 | 2 | 61 |
| Package READMEs (PKG) | 38 | 14 | 27 | 16 | 95 |
| **All** | **77** | **43** | **58** | **23** | **201** |

Counted from the status column of the tables below (PKG-093 to PKG-095 sit in the engine-docs table).

- What is left: the HANDOFF rows (internal, not published: STALE/UNPROVEN until the release-commit re-runs), PKG-095
  (a busy-machine Node timing in HANDOFF), and UNPROVEN rows whose wording is now honest but whose evidence is a run
  nobody has committed yet: DOC-061 (back-face culling, on a scratch branch), PKG-005 (Blender run), PKG-080 (heap tests
  for tween/procedural/cinematic), PKG-092 (package `test:browser` scripts not in the gate runner), PKG-103/104 (texture
  counts per cell from source, no assertion).
- Some H rows repeat DOC rows (the CAD numbers), so the totals overcount the distinct claims slightly.
- Every pre-merge core CAD number (DOC-022 to DOC-028) is now labelled as such in docs/cad-performance.md, which opens
  with the quiet-machine before/after table (DOC-059), the first publication-grade real-GPU result in the repo.

New committed records from 5d: `examples/package-benchmarks/results/entry-sizes.json` (min+gzip of every exports entry
and worker, build-modern's method; also the Gzip column of `docs/api-surface.md`) and `results/threejs-size.json`
(`npm run measure:threejs`, three.js now built with the same output options as Margo's size gate).

### Worst items for a Hacker News reader

As found before 5d. All ten are fixed in the docs: no speed claim against three.js anywhere (1); install lines say
"not published yet / once published" (2); one core size, "under 20 kB gzip (19,543 B at `3d845a0`)", WebGPU only, WebGL2
as the optional package (3); a committed same-settings three.js size comparison (4); cad-performance.md opens with the
quiet-machine table and labels the old one (5); the quality and pacing wording states what is measured (6); "Covers the
common cases of X (see Limits)" (7); "mock GPU" and the HEAD numbers (8); the four proofs re-baselined and passing (9);
local-only hardware numbers removed or labelled historical, Edge-only verification stated, test counts dropped (10).

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

Done in 5d, except committing `measure:demos --json` (S-09 is proven by the build's isolation asserts instead).

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
| R-01 | "Core plus the stage facade measures **18,681 bytes gzip**, including embedded Wasm and the WebGPU backend" | README.md:108 | `scripts/measure-size.js`: **19,543** at 0ed56b9 after the merged core steps (docs/cad-performance.md table). | `npm run build:packages && npm run measure:size` | PROVEN | Fixed (5d): "under 20 kB gzip (19,543 bytes at `3d845a0`; `npm run measure:size` prints the current figure)", WebGPU backend only. |
| R-02 | "every push and pull request runs a CI build that rejects a combined size of 20,000 bytes gzip or above" | README.md:108 | `scripts/core-budget.js` (`CORE_STAGE_GZIP_LIMIT = 20_000`), run by `build:packages`. `.github/workflows` runs it. HANDOFF: Actions minutes are spent until next month, so CI is not running now. | `npm run build:packages` | PROVEN | Fixed (5d): "the package build, locally and in the CI workflow, fails at ... 20,000 bytes gzip or above" (`.github/workflows/ci.yml` runs `build:packages`). |
| R-03 | "The build also retains the 30 KiB combined core/static-glTF budget and 30 KiB raw Wasm budget" | README.md:108 | `scripts/build-modern.js:24,79` | `npm run build:packages` | PROVEN | – |
| R-04 | "The release contains 61 packages" | README.md:79,145 | 71 `packages/*/package.json` files, all in the root workspaces. `docs/catalog.json` says 71. | `ls packages/*/package.json` | PROVEN | Fixed (5d): "71 packages (70 under `@margoengine` plus the `margoengine` facade)", both places. |
| R-05 | `npm install @margoengine/core@0.1.0` (and the other install lines) | README.md:27-43 | `docs/catalog.json`: `published: false` for all 71 packages. Line 7 says to build from source "until the renamed packages are published". | – | PROVEN | Fixed (5d): the install blocks are introduced with "The packages are not on npm yet (build from source, below). Once published ..."; names and versions match package.json. |
| R-06 | "Thirty-one JavaScript tests, four Rust checks and 32 browser check groups passed after the modern-only cleanup" | README.md:131 | Rust: 4 `#[test]` (correct). JS and browser counts: no committed output. Current run: `results/gates-browser-tests.json` has 39 of 41 browser scripts passing. | `npm run verify`; `node examples/package-benchmarks/gates/run-browser-tests.mjs` | PROVEN | Fixed (5d): counts dropped; "`npm run verify` runs the unit, API-surface and size checks; the real-GPU browser suites record their results in `gates-browser-tests.json`". |
| R-07 | "AMD Radeon integrated graphics and NVIDIA baseline measurements are recorded in the benchmark summary. Raw captures and recovery archives remain local." | README.md:131 | `benchmarks/README.md` prose. The raw data is in `test-results/` only. | no | REMOVED | Fixed (5d): sentence replaced by a pointer to this file (hardware so far: one Intel Arc 140V laptop). |
| R-08 | "Firefox/Safari and mobile GPU hardware remain unverified" | README.md:131 | HANDOFF records one manual iPhone capture (1M particles, 58-60 FPS) and a Galaxy S23 at 3-5 FPS. Neither is committed. | – | PROVEN | An honest limitation. Keep it. |
| R-09 | "basic scenes can fall back to WebGL2 when an app passes `fallback: webglRenderer` from `@margoengine/webgl`" | README.md:133 | `gates-browser-tests.json` (WebGL2 paths pass with the fallback). | gates runner | PROVEN | – |
| R-10 | "Million-particle, three-million-splat and 1,024-light execution tests validate correctness separately from FPS claims" | README.md:110 | `scripts/modern-game-tests.js`. Splats at 3M only with `SPLAT_STRESS=1`. | `npm run modern:test:game` | PROVEN | The README itself says these are correctness tests, not FPS. Keep that distinction everywhere (see the package table). |

## Website (`site/index.html`, margoengine.com)

| ID | Claim (exact, trimmed) | Location | Evidence | One command? | Status | Corrected wording / note |
| --- | --- | --- | --- | --- | --- | --- |
| S-01 | "A 3D engine for the web that starts under 20 KB." | site/index.html (hero) | As R-01: 19,543 B gzip at 0ed56b9. | `npm run measure:size` | PROVEN | Fixed (5d): hero now "starts under 20 kB gzipped". |
| S-02 | "Under 20 KB gzip: Core plus the stage facade, embedded Wasm and both backends included." | site/index.html (features) | The WebGL2 backend moved to `@margoengine/webgl` in 1356787. The 18,681 B figure is WebGPU only. The webgl dist file is 2,283 B gzip (level 9, unminified dist). | `npm run measure:size` | PROVEN | Fixed (5d): "Core plus the stage facade, with the embedded Wasm kernel and the WebGPU backend. The build fails at 20,000 bytes gzip or above; `npm run measure:size` prints the current figure. The WebGL2 fallback is the optional `@margoengine/webgl` (2.1 kB gzip)." (2,088 B, `entry-sizes.json`). |
| S-03 | "CI rejects any build at 20,000 bytes gzip or above." | site/index.html | As R-02. | `npm run build:packages` | PROVEN | Fixed (5d): "The build fails at 20,000 bytes gzip or above". |
| S-04 | "An engine holds 1,024 entities by default, configurable up to 100,000." | site/index.html | `packages/core/src/kernel.ts` capacity cap. | unit tests | PROVEN | – |
| S-05 | "Visible meshes sharing a geometry instance render in one instanced draw call per scene pass, with per-instance material values." | site/index.html | `cad/results-*.json` (`drawCalls`). The vs-three.js run reports Margo's draw counts. | `cad/run.mjs` | PROVEN | – |
| S-06 | "WebGPU first, WebGL2 fallback ... Basic scenes still render on WebGL2." | site/index.html | True only with the optional `@margoengine/webgl` passed as `fallback`. | – | PROVEN | Fixed (5d): "Basic scenes (core meshes, flat PBR, one light) also render on WebGL2 with the optional `@margoengine/webgl` package." Lede and meta descriptions say "optional WebGL2 fallback". |
| S-07 | "automatic device-loss recovery on WebGPU" | site/index.html | `scripts/modern-domain-tests.js` passes in `results/gates-browser-tests.json` (Arc, AC). | gates runner | PROVEN | – |
| S-08 | "The release includes 60 packages under @margoengine and the margoengine stage facade." | site/index.html | 70 + facade = 71. | – | PROVEN | Fixed (5d): "70 packages under `@margoengine` and the `margoengine` stage facade". |
| S-09 | "Each pack is a separate, tree-shakable package. Your app loads only the ones it imports." | site/index.html | `npm run measure:demos` (eager versus lazy chunks per demo); sky/vfx feature entries (HANDOFF 1h.i). Output not committed. | `npm run measure:demos` | PROVEN | Fixed (5d): "Each pack is a separate, side-effect-free package. Your bundle includes only the ones it imports." Evidence: all 71 package.json files declare `sideEffects: false`; `scripts/build-modern.js` (run by `build:packages`) asserts a machinery-only consumer bundles no creative/scenery code and a particle-only consumer no post/toon code. |
| S-10 | "It has been verified in Chrome and Edge on desktop. Firefox, Safari and mobile GPUs are not yet verified." | site/index.html | Edge: `gates-browser-tests.json`. Chrome 155: `results/workers.json` (OffscreenCanvas page) only. Every other suite ran on Edge. | gates runner with `BROWSER_CHANNEL=chrome` | PROVEN | Fixed (5d): "Its real-GPU test suites run in Edge (Chromium) on a Windows laptop with an Intel Arc 140V; Chrome uses the same engine. Firefox, Safari and mobile GPUs are not yet verified." |
| S-11 | "Install from npm, once published" | site/index.html | Honest. | – | PROVEN | – |
| S-12 | "Browse the published packages and their runnable examples" | site/index.html (demos) | `docs/catalog.json`: `published: false` for all 71. | – | PROVEN | Fixed (5d): "Browse the packages and their runnable examples". Note for launch: the catalog's runnable examples load the packages from jsDelivr, so they only work once the packages are published (docs/README.md says so). |

## HANDOFF (`docs/HANDOFF.md`): numbers that will be quoted

Only HANDOFF items likely to reach the pitch are listed. The CAD rows overlap DOC-020 to DOC-034.

| ID | Claim (exact, trimmed) | Location | Evidence | One command? | Status | Corrected wording / note |
| --- | --- | --- | --- | --- | --- | --- |
| H-01 | "Margo core + stage 48 kB / 20 kB; three WebGL 621 kB / 139 kB; three WebGPU 959 kB / 229 kB. Script: `test-results/three-size.mjs` (ignored folder)" | HANDOFF:47-48 | The script is now `npm run measure:threejs` (committed). It prints only, with no committed output. Core + stage is now 18,681. | `npm run measure:threejs` | PROVEN | Fixed (5d): `measure:threejs` now builds three.js with the size gate's output options (`compactOutput`; three was minified less than Margo before) and writes `results/threejs-size.json`: Margo core + stage 19,543 B gzip (WebGPU only), three 0.186.1 lit-box app 129,899 B (WebGLRenderer) and 211,584 B (WebGPURenderer). HANDOFF line updated. |
| H-02 | "100k particles locked at 60 FPS; 1M particles a steady 45. Not re-measured since the water restore." | HANDOFF:44-45 | Not committed. | no | STALE | Superseded by `vfx-island-final.json` (1M on the light tier: 56.7 → 60 FPS paced). |
| H-03 | "iPhone ... really draws 1,000,000 particles at 880x1526 and 58-60 FPS" | HANDOFF:31-32 | A bookmarklet capture. No committed file. | no | UNPROVEN | Needs a scripted phone run (outline: what Scott must provide). |
| H-04 | "Kept, with proofs that all pass when re-run alone (slowest case 1.07x, most 1.5-6x)" | HANDOFF:54-56 | `proofs/*.proof.js` + `proofs/results/*.json` | `node examples/package-benchmarks/proofs/<name>.proof.js` | STALE | Partly fixed (5d): the four proofs whose default failed now pass with no argument (post-stack -> `e12fc9c`, materials-uv-transform -> `7f1c9c6`, gltf-pro-lighting-hooks -> `f8a36ca`; selection-xray-off still passes vs `46f9484`). The other proofs were not re-run here: run `npm run bench:all -- --only=proofs` on the release commit. |
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
| H-25 | Visual suite: 22 views of 8 demos, 1.8 MB, 16/22 bit-identical, Citadel 0.003/0.07/0.43 %, sandbox 5.2/1.3/1.6 % (hot 0.34/0.07/0.04 %), tolerance = worst of 4 launches x3 + 0.05 %/0.02 % | HANDOFF 1h.f (87f843a) | `tests/visual/manifest.json` (22 views, 4 runs, 16 with zero noise, values match); PNGs 1,844,581 B; `scripts/visual-regression.js` (`MARGIN=3`, AC refusal, gpu.lock) | `npm run visual:check` (Arc + Edge baselines only) | PROVEN | – |
| H-26 | "robot light 0.93 -> 0.91 fails all three (22.6 %)"; "two clean 3-run checks"; "0ed56b9 renders every view bit-identical to the pre-merge baselines" | HANDOFF 1h.f | Scratch builds, nothing committed. The manifest baselines were taken at `5d014fe`, which already contains `0ed56b9`. | no | UNPROVEN | Commit the sensitivity run's report JSON or drop the numbers. Internal only. |
| H-27 | 5c: "max channel diff 1/255"; Karis "mean 0.46/255, max 21/255, rough metals 14/255 … 8/255 at rims"; "3,812 identical / 80 modules; 4,556 … 384" | HANDOFF 5c (f8a36ca) | `results/binding-limit-gpu.json` (0.4622 / 21 / 14.21 / 8.09); `binding-limit.proof.js` re-run at HEAD matches exactly | `node examples/package-benchmarks/proofs/binding-limit.proof.js e017d50`; `binding-limit-gpu.mjs` | PROVEN | – |
| H-28 | "test:browser passes (LUT vs quadrature 0.0013, furnace)"; "gltf-pro 16,265 -> 16,495, environment 20,544 -> 20,802" | HANDOFF 5c | test-results only. End state after the API work: 16,504 / 20,919 (`entry-sizes.json`). | no | UNPROVEN | Internal; quote `entry-sizes.json` instead. |
| H-29 | "clustered root 4,651 -> 4,829 (+178 B), the shadows entry 5.9 kB" | HANDOFF gap 4; `590278e` message | `entry-sizes.json`: clustered `.` 4,503, `./shadows` 5,228; api-surface at `590278e`: 4,319 -> 4,486 (+167) | `node examples/package-benchmarks/entry-sizes.mjs` | STALE | "shadows entry 5.2 kB min+gzip; clustered root +167 B". Internal. |
| H-30 | Item 0: "Still failing: the browser stage, because `@margoengine/bvh` dist/raycaster.js imports `../../shared/instances.js`"; "README type-check … (17/17) now pass" | HANDOFF item 0 | `a3801b7` fixed the import and `tests/dts-self-contained.test.js` now covers dist .js. No committed run of the package stage. | `node scripts/modern-package-tests.js` | STALE | Re-run the stage and commit its JSON. |
| H-31 | "material setters TAKEN at +34 B (core+stage 19,577)" | HANDOFF Scott's decisions | A decision; no core src commit after `0ed56b9` on this branch, so 19,543 is today's figure. | `npm run measure:size` after the merge | UNPROVEN | Re-measure when the setters merge; public docs say "under 20 kB" plus a dated figure so they stay true. |
| H-32 | "most packages +15..+65 B, controls +98, environment +124" (API standardization) | HANDOFF Scott's decisions | No before/after record committed. | `entry-sizes.mjs` at both refs | UNPROVEN | Internal only. |

## Engine docs (MODERN-ENGINE.md, MODULE-AUDIT.md, benchmarks/, docs/from-threejs.md, docs/threejs-parity.md, docs/cad-performance.md, docs/demo-loading.md, docs/desktop-frame-rate.md, conveyor README, core and margoengine READMEs)

Facts used below:

- 71 `packages/*/package.json` files, all in the root workspaces.
- Core + stage is 18,681 B gzip at f4c6196 and 19,543 B at 0ed56b9 (core speed-ups merged).
- The embedded Wasm (decoded from `packages/core/src/wasm.ts`) is 12,009 B raw and 5,053 B gzip, SHA-256 `5140c355…`, built with `-Oz` + raw deflate.

| ID | Claim (exact, trimmed) | Location | Evidence | One command? | Status | Corrected wording / note |
| --- | --- | --- | --- | --- | --- | --- |
| DOC-001 | "npm install @margoengine/core@0.1.0" (and the five-package install line) | packages/core/README.md:12; MODERN-ENGINE.md:24 | `docs/catalog.json`: `published:false` for all 71. MODERN-ENGINE.md:21 says "until the renamed packages are published". | – | PROVEN | Fixed (5d): core README says "Build from source ... until the renamed package is published" right above its install line; MODERN-ENGINE.md's heading is "Install from npm (once published)"; from-threejs.md's install block says "not published yet". |
| DOC-002 | "The five libraries were published publicly as version `0.1.0` on 11 October 2026" | benchmarks/README.md:15 | Nothing committed. These were the pre-rename names. | no | HISTORICAL | Fixed (5d): "the then five libraries were published to npm as `0.1.0` under their pre-rename names. The `@margoengine/*` packages are not published yet." (Registry history, not re-checked here.) |
| DOC-003 | "under 20 kB gzip (18,681 bytes today" | docs/from-threejs.md:41 | `measure:size` is 19,543 at 0ed56b9 | `npm run measure:size` | PROVEN | Fixed (5d): "19,543 bytes at `3d845a0`, WebGPU only", next to the committed three.js figures (DOC-004). |
| DOC-004 | "three.js is about 138 kB for WebGL and 229 kB for WebGPU" | docs/from-threejs.md:42 | `scripts/compare-threejs-size.js` prints to the console only. HANDOFF says 139 kB. | `npm run measure:threejs` | PROVEN | Fixed (5d): "about 130 kB gzip with three.js 0.186's WebGLRenderer and 212 kB with its WebGPURenderer, built the same way" from committed `results/threejs-size.json` (H-01). The old 138/229 kB built three without the size gate's minify options. |
| DOC-005 | "strictly below 20,000 bytes gzip" | packages/margoengine/README.md:9 | `core-budget.js`, run by build:packages. | `npm run measure:size` | PROVEN | – |
| DOC-006 | "Rust Wasm kernel… 12,046 \| 5,064"; "Core, including embedded Wasm and both backends \| 53,073 \| 19,874" | MODERN-ENGINE.md:249-250 | WebGL left core at 1356787. Now 12,009 / 5,053 and 18,681. | `npm run measure:size` | PROVEN | Fixed (5d): table regenerated at `3d845a0`: kernel 13,043 B raw (-Oz, 5,350 embedded), core + stage 45,524 / 19,543 (WebGPU only), core 17,783, webgl 2,088, gltf 4,460, react 3,768, machinery 33,418, creative 17,186 (root entries = `entry-sizes.json`). |
| DOC-007 | "glTF… 4,993", "Machinery… 14,527", "Creative… 9,563", "Core plus glTF sums to 24,867", "Vite starter… 90.2 KiB", "606 gzip bytes of headroom" | MODERN-ENGINE.md:251-257 | An Oct 11 measurement, test-results only. Contradicts cad-performance.md:147 (machinery root 33,849). | not committed | PROVEN | Fixed (5d): same regenerated table; Vite starter size, "606 bytes of headroom" and the core + glTF sum removed. The particle-only consumer (8,035 B) is printed by `build:packages` (git-ignored `modern-bundle-sizes.json`). |
| DOC-008 | "`wasm-opt -O3`… reproduced both raw and optimized Wasm byte-for-byte" | MODERN-ENGINE.md:59,259 | The build is now `-Oz` + raw deflate (c82e119). | no | PROVEN | Fixed (5d): describes `wasm-opt -Oz ... --converge`, raw-deflate embedding, last rebuild `c449400` and the SHA-256 of the decoded kernel (`5a0f9310…`); the O3 reproducibility claim is gone. |
| DOC-009 | "0.169 ms median versus 0.052 ms… 21,110 gzip bytes" | MODERN-ENGINE.md:261 | Nothing committed. Superseded by `-Oz`. | no | REMOVED | Fixed (5d): the twelve-candidate comparison paragraph is gone. |
| DOC-010 | "locked core measures 19,874 bytes gzip… 12,046 bytes raw, SHA-256 c9fade…" | benchmarks/README.md:11 | 18,681 / 12,009 / `5140c355…` at f4c6196; core + stage 19,543 and a rebuilt kernel (step 1) at 0ed56b9: re-measure the Wasm size and SHA. | `npm run measure:size` | PROVEN | Fixed (5d): benchmarks/README.md opens with today's figure (19,543 at `3d845a0`, `measure:size`) and keeps 19,874 only as "then, with WebGL2 still inside it". |
| DOC-011 | "Core + stage gzip is 20,053 bytes, below the 20,480-byte ceiling" (and "20,480-byte… gate") | MODULE-AUDIT.md:81-83; MODERN-ENGINE.md:285; benchmarks/stress-results.md:20; stress-testing.md:3 | The gate is 20,000. 20,053 would fail it today. | `npm run measure:size` | PROVEN | Fixed (5d): MODULE-AUDIT.md and stress-results.md say "was 20,053 ... below that day's 20,480-byte ceiling" plus today's 20,000 gate and 19,543 B; stress-testing.md says 20,000; the MODERN-ENGINE.md line is gone. |
| DOC-012 | "19,988", "19,997", "19,999… / 47,983 raw", "19,975 bytes" | desktop-frame-rate.md:63,129,159,172; demo-loading.md:11 | Historical builds. | – | HISTORICAL | Fixed (5d): desktop-frame-rate.md opens with a "dated investigation log" banner (sizes, counts and timings as of 2026-10-12/13, raw reports local, today's size from `measure:size`); demo-loading.md says "measured 19,975 bytes then (19,543 at `3d845a0`)". |
| DOC-013 | "`machinery/edges` 4,299 B… spatial 14,937… root 33,849"; culling "7,015 B min+gzip" | cad-performance.md:144-148,197 | Measured at c9d6d61 / 037d098, test-results only. Machinery changed since (803aa19). | not committed | PROVEN | Fixed (5d): the cad-performance.md size table gains a "Now" column from committed `entry-sizes.json` (edges 3,940, spatial 14,411, exploded 588, root 33,418; core + stage 19,543) and labels before/after as uncommitted; culling is 7,060 B at `3d845a0`. |
| DOC-014 | "`npm test` # … runs 40 focused unit checks" | MODERN-ENGINE.md:36 | `npm test` = tests/modern*.test.js: 25 files, about 121 `test()` calls. | `npm test` | REMOVED | Fixed (5d): "runs the modern unit checks" (no count). |
| DOC-015 | "Twenty-seven JavaScript tests and four Rust checks", "Thirty-two shared math/camera checks", "31 JavaScript tests" | MODERN-ENGINE.md:265-266,305; benchmarks/README.md:13 | Rust 4 (correct). JS counts not committed. | no | REMOVED | Fixed (5d): MODERN-ENGINE.md and benchmarks/README.md counts removed; the committed SwiftShader section keeps its own (historical, b3987dd). |
| DOC-016 | "434 passed", "447 Node tests", "543", "581", "627", "754 unit tests" | MODULE-AUDIT.md:63; stress-results.md:20; desktop-frame-rate.md:48,130,159,173 | test-results only. The six numbers disagree. About 890 `test()`/`it()` sites in 165 files. | `npm run test:all` | HISTORICAL | Fixed (5d): MODULE-AUDIT.md, stress-results.md and desktop-frame-rate.md are labelled as dated records whose reports were not committed; no current test count is claimed anywhere. |
| DOC-017 | "core, glTF, React, machinery, creative and scenery packages", "all seven libraries", "All 37", "61 packages" | MODERN-ENGINE.md:11,37,39,61; MODULE-AUDIT.md:8; desktop-frame-rate.md:131,169,174; stress-results.md:20 | 71 packages. | `ls packages/*/package.json` | PROVEN | Fixed (5d): "71 packages" in MODERN-ENGINE.md (build/pack comments too); the dated docs say "today there are 71 packages". |
| DOC-018 | "on an integrated laptop GPU roughly halves GPU time compared with 4× MSAA" | packages/core/README.md:5 | `results/vfx-island-final.json` (Arc): island with particles off, light tier about 10.1 ms vs high tier about 20.6 ms. | no (needs variant builds) | PROVEN | Fixed (5d): core README now says "on an Intel Arc 140V laptop cut the island demo's GPU frame from about 20 to 10 ms (particles off)" (medians 20.8 / 10.1 ms in `vfx-island-final.json`). |
| DOC-019 | "the light tier holds about 60 FPS instead of swinging on 120 Hz panels" | docs/from-threejs.md:821 | `paceEngine` is a cap. HANDOFF: 53-61 FPS measured. | no | PROVEN | Fixed (5d): comment now "caps the light tier at about 60 FPS so 120 Hz panels don't swing 120/40". |
| DOC-020 | "Intel Arc 140V… 4x MSAA… vsync and the frame-rate limit off… AC power" | cad-performance.md:3-9 | `cad/results-*.json` record AC, host and adapter. | – | PROVEN | – |
| DOC-021 | "the largest case is 89,883 parts in 99,976 entities" | cad-performance.md:16,22 | kernel cap 100,000; `results-after-max.json`. | `cad/run.mjs --sizes=max` | PROVEN | 100,000 parts do not fit in core today. Never pitch "100k parts". |
| DOC-022 | "Frame interval / FPS 6.7 ms / 150 | 22.0 ms / 45 | 40.3 ms / 25" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | PROVEN | Fixed (5d): the table is headed "Results before the merged core fast paths (11:53 session; superseded by the quiet-machine table below)" and the page opens with the DOC-059 headline numbers. True as labelled (`cad/results-after-*.json`, deb4015). |
| DOC-023 | "Kernel tick… 1.69 / 7.74 / 16.4 ms… Whole-frame CPU 39.1 ms" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | PROVEN | Fixed (5d): as DOC-022 (labelled pre-merge). |
| DOC-024 | "`engine.pick` median… 12.1 / 30.3 / 63.5 ms" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | PROVEN | Fixed (5d): as DOC-022 (labelled pre-merge). |
| DOC-025 | AssemblyBVH "create 1,465 → 18.9 ms", "rebuild 1,400 → 3.5 ms" | cad-performance.md:41,129-135 | `proofs/results/machinery-cad.json` (Node, AC, identical outputs) | `node examples/package-benchmarks/proofs/machinery-cad.proof.js` | PROVEN | – |
| DOC-026 | ExplodedView "0 ms at rest" | cad-performance.md:42,114-118 | `machinery-cad.json`, `results-after-*.json` | same | PROVEN | – |
| DOC-027 | "Load to first frame 592 ms, JS heap 75 MB, Instance storage 10.1 MB, removing one mesh 3.0 ms" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | PROVEN | Fixed (5d): as DOC-022 (labelled pre-merge). Re-run `run.mjs` on the tip before quoting load, heap or removal. |
| DOC-028 | "90k parts with 1x MSAA… 30.9 ms CPU, 24.7 ms GPU, 32 FPS" (top table: 11:53 session, core before the merged steps) | docs/cad-performance.md | `cad/results-after-*.json` (deb4015) | `cad/run.mjs` | PROVEN | Fixed (5d): as DOC-022 (labelled pre-merge). |
| DOC-029 | "Node measures 11.4 ms… and 15.7 ms" | cad-performance.md:56-61 | `results-kernel-node.json` | `node examples/package-benchmarks/cad/kernel-node.mjs` | PROVEN | Fixed (5d): the garbled reproduce command is now `node examples/package-benchmarks/cad/kernel-node.mjs`. |
| DOC-030 | "disposing a 90k-part assembly mesh by mesh is O(n²), minutes" | cad-performance.md:76 | Step 5 merged: disposing a 90k engine 48 s → 20 ms (`cad/results-s0-*`, `results-s5-*.json`). | `cad/run.mjs` | PROVEN | The hot-spot list is headed "as measured before the fast paths"; step 5's 48 s -> 20 ms is in the prototype table. True as labelled. |
| DOC-031 | Edges "GPU 2.23 / 4.65 / 5.83 ms" | cad-performance.md:97-104 | `results-edges.json` | `cad/run.mjs --edges` | PROVEN | Fixed (5d): the edges table is labelled "measured in the 11:53 session, before the merged core fast paths and before `803aa19` ...; re-run `run.mjs --edges` before quoting". |
| DOC-032 | Culling at 90k "Orbit \| 36.4 / 24.7 \| … \| 51.8 / 18.3", grazing "97.7" | cad-performance.md:161-170 | `results-culling.json` (Arc). Another worker's GPU timing shared the machine between runs. | `node examples/package-benchmarks/cad/culling.mjs --check --views=orbit,still,grazing --layouts=sheet,stack --label=culling` | PROVEN | Fixed (5d): the culling section now states the limits next to the win and says the `core meshes` column predates the merged core fast paths. |
| DOC-033 | "0 differing pixels in all 640 frames" | cad-performance.md:190-195 | `results-culling.json` `checks` | same | PROVEN | – |
| DOC-034 | OCCT "7,604,031 bytes, 3,110,912 gzip"; STEP "1,403-1,715 ms" | cad-performance.md:202-208 | `node_modules/occt-import-js` wasm; `results-step.json` | `cad/run.mjs --sizes=1000 --step` | PROVEN | – |
| DOC-035 | three vs Margo table: Margo "16.67 \| 2 draws \| 19207", three "16.67 \| 9012 \| 131858"; GC "1 / 0" vs "196 / 8" | benchmarks/results.md:9-10 | `scripts/benchmark-three-vs-margo.js` (NVIDIA, 2026-10-11, 7908ad3). Vsync on, three not instanced, both 1x MSAA at the time. The script has changed since. | `npm run benchmark:three-vs-margo` | PROVEN | Fixed (5d): results.md opens with "Read this as payload and GC counts only" (vsync on, three without InstancedMesh, 7908ad3, NVIDIA; no speed comparison published). |
| DOC-036 | Conveyor: orbit "1586… \| 1446", explode "786 \| 1219", click "11.4 \| 5.8 ms", ready "609 \| 816 ms", script "172.6 / 54.3 KiB" | benchmarks/conveyor-simulator.md:9-36 | `scripts/benchmark-conveyor-simulator.js` (NVIDIA, 2026-10-12, 4aab554) on two HTML files that are not in the repo. MSAA: three 4x vs Margo 1x. | no | HISTORICAL | Fixed (5d): conveyor-simulator.md opens with "Historical log, not a comparison to cite" (pages not in the repo, MSAA 4x vs 1x, three won orbit and load). |
| DOC-037 | "`?renderer=webgpu`… the like-for-like comparison"; "Both desktop scenes use explicit 4× MSAA" | examples/conveyor-simulator/README.md:12,14 | The pages match the description. No results committed. | no (Git LFS, server, manual flags) | PROVEN | Fixed (5d): "the like-for-like setup ... No timing results from these pages are committed yet, so they back no speed claim"; the page description itself matches the HTML. |
| DOC-038 | "Verify both pages on the dedicated NVIDIA GPU with `node …/benchmark.test.mjs`" | examples/conveyor-simulator/README.md:20 | Writes to test-results. Asserts `vendor === 'nvidia'`. | no (NVIDIA only) | PROVEN | Fixed (5d): the README says the check asserts an NVIDIA adapter. |
| DOC-039 | "Eight real-browser check groups on… RTX A6000", "CPU median 2.0 ms / p95 3.2 ms", "4.2–4.6 ms warm asynchronous completion" | MODERN-ENGINE.md:269-275 | test-results only. Oct 11, pre-rename. | partly | REMOVED | Fixed (5d): MODERN-ENGINE.md keeps one numberless historical sentence (suites passed on an RTX A6000 and an AMD iGPU before the rename; captures not committed). |
| DOC-040 | "0.050 ms mean / 0.060 ms… 0.211 ms"; AMD "CPU median/p95 2.2/3.0 ms… 15.9/17.7 ms" | MODERN-ENGINE.md:279-281 | Local only. | no | REMOVED | Fixed (5d): as DOC-039. |
| DOC-041 | SwiftShader "CPU median 4.7 ms / p95 7.0 ms"; "tick mean was 0.108 to 0.120 ms" | MODERN-ENGINE.md:303-311 | `benchmarks/swiftshader/*.json` (b3987dd, Linux VM, software GPU) | no | PROVEN | Committed SwiftShader JSON at b3987dd; the section now says what it predates (WebGL2 in core, core changes since). |
| DOC-042 | "500 queued parts… 0.0135/0.0137 ms" (Ryzen 9 9950X) | benchmarks/README.md:34 | test-results only. | `npm run modern:bench:machinery` | REMOVED | Fixed (5d): removed from benchmarks/README.md. |
| DOC-043 | "100,000-triangle STL import kept animation frames running"; "51 check groups per browser" | benchmarks/README.md:36,38 | test-results only. | no | REMOVED | Fixed (5d): removed from benchmarks/README.md (one numberless historical sentence remains). |
| DOC-044 | "sustained **60.03 FPS**… 118.68 FPS"; "643 instances and 15 draw calls… no minor/major GC" | benchmarks/README.md:40-44 | Local only. | no | REMOVED | Fixed (5d): removed from benchmarks/README.md. |
| DOC-045 | "SkyMoonPass… 0.0195 ms median"; "`npm run modern:bench:sky`" | benchmarks/README.md:46 | The pass was merged away. **`modern:bench:sky` does not exist in package.json.** | broken command | REMOVED | Fixed (5d): removed, with the nonexistent `modern:bench:sky` command. |
| DOC-046 | "500 / 500", "131,877 tracked GPU buffers/textures", "181.4 / 210.9 ms" | benchmarks/stress-results.md:7-18 | Dirty workspace on 9b98d25. test-results only. | `npm run modern:test:stress -- --sessions=500 --frames=120` | HISTORICAL | stress-results.md is dated (9b98d25, uncommitted workspace) and now also says the raw reports were not committed. |
| DOC-047 | "actual WebGPU on NVIDIA RTX A6000 in Edge 155", "six real browser checks pass" | MODULE-AUDIT.md:68-80 | test-results only. | `npm run test:modules:browser` | HISTORICAL | Fixed (5d): MODULE-AUDIT.md opens as a dated record (2026-10-11) whose reports were not committed. |
| DOC-048 | "GPU work… 1.638 ms → 0.655 ms… 60%/67%/67%/63%" | desktop-frame-rate.md:35-40 | `test-results/gpu-diagnosis.json` (RTX A6000) | no | HISTORICAL | Fixed (5d): desktop-frame-rate.md banner (DOC-012). |
| DOC-049 | "about 59.5 FPS at the 60 target and 120.3 FPS"; "3.21–7.41 ms" | desktop-frame-rate.md:53,198-200 | Local only, over RDP. | no | HISTORICAL | Fixed (5d): desktop-frame-rate.md banner (DOC-012). |
| DOC-050 | Historical cold-load table ("615 ms… 1,858 ms") | demo-loading.md:48-56 | NVIDIA, Oct 12, local. Labelled historical. | – | HISTORICAL | Labelled historical in demo-loading.md, which now also says the raw reports stayed local. |
| DOC-051 | "Afterlight 2,305 ms / 4,497 ms Fail…"; "DOF… 1553 ms… Tonemap… 902 ms" | demo-loading.md:164-168,193-195 | Arc, test-results only. | `npm run benchmark:demo-loads` (after build:site) | HISTORICAL | As DOC-050. An honest negative result; commit the JSON from a re-run to make it PROVEN. |
| DOC-052 | "Phones use 1024 × 512 Earth WebP maps: 381,276 bytes"; helmet "600,948 bytes versus 3,773,916" | demo-loading.md:85,89 | `wc -c` on the committed assets matches. | `wc -c` | PROVEN | – |
| DOC-053 | "156 three.js features in 19 areas… COVERED 84, PARTIAL 40, MISSING 32" | docs/threejs-parity.md:7-13 | The recount matches exactly. But 50 of the 84 COVERED rows are † (exports and README only), and the doc says no row was run. Most need WebGPU. | script recount | PROVEN | Recount at 3d845a0: 87 COVERED (50 of them †), 39 PARTIAL, 30 MISSING; the doc's own summary says the same. Quote as "87 of 156 covered by API, 37 of them read line by line; none were run against three.js". Never shorten it to "parity with three.js". |
| DOC-054 | "Real GPU: the instanced frame equals N meshes" | docs/threejs-parity.md:252 | `results/textured-instancing-gpu.json` | `textured-instancing-gpu.mjs` | PROVEN | – |
| DOC-055 | "texel-locked (no shimmer) under orthographic pan and zoom" | docs/threejs-parity.md:64 | `results/shadow-shimmer.json` | `shadow-shimmer.mjs` | PROVEN | Fixed (5d): "zoom is bit-identical and a slow pan changes about 0.6 of 14,423 shadow-edge pixels per frame, against 194 for a 0.01° light turn". |
| DOC-056 | "removed 6,017 bytes of gzip… about 7.5 kB and 3.3 kB more gzip" | docs/threejs-parity.md:385 | test-results/dedupe only. | no | REMOVED | Fixed (5d): numbers dropped ("shrank the five packages' root entries; ... a few kB more ... measured locally at the time; not committed"). |
| DOC-057 | "8 check groups for both backends", "automatic fallback", "keep the base WebGL2 fallback" | benchmarks/README.md:27; MODERN-ENGINE.md:231,269,281,307 | True only before 1356787. | – | PROVEN | Fixed (5d): MODERN-ENGINE.md says "keep the optional `@margoengine/webgl` fallback usable"; the SwiftShader tables say WebGL2 was still in core at b3987dd. |
| DOC-058 | "285 bytes total per slot" | MODERN-ENGINE.md:83 | Step 1 added 66 B per slot (docs/cad-performance.md). | `cad/run.mjs` | PROVEN | Fixed (5d): "81 bytes per capacity slot and change tracking 66 more (about 351 bytes total per slot ...)" (285 + the step-1 input snapshot and flags). |
| DOC-059 | Quiet-machine before/after table, e.g. "orbit 50,004 … 49 → 92" FPS, "still 89,883 … 33 → 52", "move 50,004 … 54 → 133"; "the kernel is 3-4x cheaper in every case"; "orbit at 90k is unchanged (34 → 33 FPS)"; "`move` at 10k got slower" | docs/cad-performance.md (merged fast paths section) | `cad/results-{before,after}{1,2}-{orbit,still,move,orbitmove}.json` (quiet machine, Arc, AC, GPU lock, 2026-10-14 19:08-19:21 local; `node examples/package-benchmarks/cad/summary.mjs before1 before2 after1 after2`) | `node examples/package-benchmarks/cad/run.mjs` per case (doc lists them), on a quiet machine | PROVEN | Publication-grade (quiet machine, AC, alternating rounds). Fixed (5d): the doc's "kernel is 3-4x cheaper in every case" overstated the table (orbitmove 50k is 2.6x, move 10k/90k 2.75x): now "2.6-4x", in the page's new headline too. One integrated GPU, two rounds per cell: state the spread. |
| DOC-060 | Fast paths bit-exact: "0 differing pixels over 25 comparisons plus 4 unchanged redraws"; "`npm run verify`: 1,051 tests pass" | docs/cad-performance.md | `tests/core-dirty-transforms.test.js` (in verify); `cad/pixels-check.mjs` (real GPU, output not committed); the test count is from an uncommitted run log | `npm run verify`; `node examples/package-benchmarks/cad/pixels-check.mjs` | PROVEN | Fixed (5d): "`npm run verify` passed at the merge (1,051 tests then)". Commit the pixel-check JSON. |
| DOC-061 | Back-face culling by `cullMode`: "about 2 ms (12%) of GPU per frame on the 50k CAD scene and up to 2.5x on heavy overdraw" | docs/cad-performance.md | `cull-bench.mjs` and `results-cull-*.json` are on branch `scratch/core-backface-cull`, not this branch | not on this branch | UNPROVEN | Not shipped: fine as a measured proposal, never as an engine property. |
| DOC-062 | "physical materials with shadows, IBL and LocalShadows use all 16, and gltf-pro throws naming the combination" | docs/shader-contracts.md:37-39 | `packages/gltf-pro/tests/instancing.test.js:117-135`; `results/binding-limit-gpu.json` (`e017d50` throws at 17, HEAD renders at 16); `binding-limit.proof.js` | `npm run verify` + `binding-limit-gpu.mjs` | PROVEN | – |
| DOC-063 | "COVERED 87 / PARTIAL 39 / MISSING 30" | docs/threejs-parity.md:11-13, 393 | Recount: 156 rows = 87/39/30; 50 of the 87 are † | script recount | PROVEN | Same quoting rule as DOC-053. |
| DOC-064 | PointLight/SpotLight shadows COVERED (no †), "up to 16 shadowed lights", "run on a real GPU" | docs/threejs-parity.md:18, 135-136, 291 | `results/local-shadows-gpu.json`; `MAX_LIGHTS=16` and `validate()` in `packages/clustered/src/shadows.ts` | `node examples/package-benchmarks/local-shadows-gpu.mjs` | PROVEN | – |
| DOC-065 | "six 512² cube-face layers, a spot light one"; "Maps are cached and re-render only when their light or a caster moves" | docs/from-threejs.md:313-314 | JSON `layersPerFrame` 0 cached vs 6/24/48 dynamic; shadows.ts defaults; snippet type-checks | `node --test tests/from-threejs-snippets.test.js` | PROVEN | – |
| DOC-066 | Features attach with "one form, `X.attach(engine, options)`" | docs/from-threejs.md:40 | `tests/api-conventions.test.js` (in verify): every package class with `setup()` has static `attach` | `node --test tests/api-conventions.test.js` | PROVEN | Packages only; core and stage are exempt. Fixed (5d): the leftover `engine.use(lighting)` in threejs-parity.md is now `EnvironmentLighting.attach(engine, ...)`. |
| DOC-067 | "everything disposable has `dispose()` and `[Symbol.dispose]`"; "every disposable Margo object has `[Symbol.dispose]`" | docs/from-threejs.md:41, 878 | The convention test skips core and margoengine; no `Symbol.dispose` in `packages/{core,margoengine}/src` | `node --test tests/api-conventions.test.js` | PROVEN | Fixed (5d): "Everything disposable has `dispose()`, and every package object also has `[Symbol.dispose]` for `using` (core's `Engine` and meshes and the stage facade have `dispose()` only)"; same scoping in the table row. |
| DOC-068 | "Gzip: root entry min+gzip bytes" (the column) | docs/api-surface.md | Was git-ignored `test-results/modern-bundle-sizes.json` with a per-package external list (controls 29,522 there vs 17,133 with other packages external) for 25 of 71 packages. | `npm run api:update` | PROVEN | Fixed (5d): `scripts/api-report.js` reads the committed `entry-sizes.json`; all 71 rows filled with one method. |
| DOC-069 | "71 packages, 144 entries, 1333 exported names" | docs/api-surface.md:6 | `entry-sizes.json`: 71 packages, 144 entries; `api:check` in verify | `npm run api:check` | PROVEN | – |
| PKG-094 | glTF export round trip: RobotExpressive goes from 752 Khronos glTF-Validator errors in the source (unnormalized skin weights) to 0 in the exported file (weights normalized) | exporters (`exportModel`, b45fec0/3e1433a); HANDOFF | `packages/exporters/tests/model.test.js` (in `verify`); `examples/package-benchmarks/exporters-model.mjs` → `results/exporters-model.json` (validator `gltf-validator` from node_modules, Node 24, 2026-10-14) | `node examples/package-benchmarks/exporters-model.mjs` | PROVEN | Deterministic (validator counts), not a timing. Say "the source file has 752 validator errors". |
| PKG-095 | "DamagedHelmet exports in 7.7 ms" (Node 24, median of 7) | HANDOFF; `results/exporters-model.json` | Same script and JSON (`exportMs` 7.73, min 5.83). Measured while other agents ran. | same | STALE | A Node CPU timing from a busy machine. Re-measure in the quiet-PC run (bench:all includes it, see reproduce.md) before quoting. |
| PKG-093 | "Static scenes cost little per frame: the kernel recomputes only entities whose … changed" | packages/core/README.md | DOC-059 (`still`, `move`), `tests/core-dirty-transforms.test.js` | as DOC-059 | PROVEN | Fixed (5d): the paragraph now quotes DOC-059 (kernel 2.6-4x cheaper, 50k parts orbit 92 vs 49 FPS) and the caveat (90k orbit stays GPU-bound at 33 FPS). |

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
| PKG-001 | "A separate entry (6.1 kB gzip…)" | animation/README.md:28 | HANDOFF 1c prose only. `proofs/size.js` measures root entries only. | no | PROVEN | Fixed (5d): "about 5.6 kB min+gzip" (`./vat` 5,552 B, `entry-sizes.json`). |
| PKG-002 | "per-frame CPU work is one 160-byte uniform write whatever the crowd size" | animation:28 | `proofs/animation-vat.proof.js` → `proofs/results/animation-vat.json` (uploadBytes 160, 1 draw at 100 and at 1,000); mock GPU; 700838e | `node pkb/proofs/animation-vat.proof.js` | PROVEN | Measured at 100 and 1,000 copies only. |
| PKG-003 | "1,000 skinned models 30.5 ms update + 434 ms draw recording (19,000 draws…27.8 MB)… under 0.01 ms… 120-180 ms and 6.9 MB" | animation:43 | Same JSON | same | PROVEN | Mock GPU. The bake was measured once at 118 ms: say "about 120 ms". |
| PKG-004 | "Real GPU (Intel Arc 140V…): silhouette IoU 0.98… 1,024 walking robots… 0.7-0.9 ms CPU and 11-16 ms GPU" | animation:43 | `pkb/atlas-vat/check.mjs`. No committed JSON. HANDOFF: "machine busy". | no | REMOVED | Fixed (5d): timings dropped; the README says `check.mjs` (not in CI) asserts IoU above 0.97 and 1,024 robots in one draw, and that frame timings are not yet recorded. |
| PKG-005 | "installation/export are exercised in Blender 5.3 Beta" | blender:42 | Needs `MARGO_BLENDER`. The gate run of `modern-blender-tests.js` (7.1 s) did not use Blender. | no | UNPROVEN | Softened (5d): "developed against Blender 5.3 Beta; exercised only when `MARGO_BLENDER` is set (no recorded run yet)". Record a run to make it PROVEN. |
| PKG-006 | Benchmark table "Terrain… 1.54 s… 187,620… Bumpy sphere… 2.03 s…" ("Node 22, one core of a shared 2-core container") | bvh:73-78 | `packages/bvh/scripts/bench.js` prints only. Date unknown. bvh src changed since. | partly | HISTORICAL | Labelled (5d): "older, undated run, no committed result; rerun for current numbers". |
| PKG-007 | "`'center'` builds about 3x faster" | bvh:60 | Same table (2.5x and 3.6x) | no | HISTORICAL | Fixed (5d): "faster (2.5-3.6x in the benchmark below)", tied to the labelled table. |
| PKG-008 | "roughly 3,000 to 4,200 times the brute-force ray rate… about 26 MB for 1M triangles" | bvh:80 | Same table | no | HISTORICAL | Fixed (5d): scoped to "in that run". |
| PKG-009 | Models table "0.94 ms per part… 84 µs… 1.8 s… 7.6 µs" | bvh:82-89 | `scripts/bench-models.js` → `test-results/bench-models.json` (ignored) | no | HISTORICAL | Labelled (5d): "one run, written to the git-ignored `test-results/bench-models.json`, no committed copy". |
| PKG-010 | "It covers what three-mesh-bvh (…) and `THREE.Raycaster` do" | bvh:3 | Parity doc: lines are never hit, points use a separate pick, skinned meshes are hit in bind pose. | n/a | PROVEN | Fixed (5d): "covers the triangle-mesh queries of three-mesh-bvh and `THREE.Raycaster` (not lines, points or sprites; see Limits)". |
| PKG-011 | "about 1.9 kB min+gzip" | cameras:54 | HANDOFF prose (1,931 B) | no | PROVEN | Fixed (5d): "about 1.7 kB min+gzip" (1,674 B, `entry-sizes.json`). |
| PKG-012 | "Cascades stay texel-locked under orthographic pan and zoom (no shimmer…)" | cameras:50-51 | `pkb/shadow-shimmer.mjs` → `results/shadow-shimmer.json` (Arc, 43052ce). Zoom bit-identical; pan 0.57 of 14,423 edge px per frame vs 194 for real shimmer. | `node pkb/shadow-shimmer.mjs` | PROVEN | Fixed (5d): ortho zoom leaves shadow matrices unchanged; a slow pan changes about 0.6 of 14k edge pixels per frame vs 194 for a 0.01° light turn (Arc 140V, Edge 155, `shadow-shimmer.json`). |
| PKG-013 | "for up to 1,024 point/spot lights" | clustered:3 | `scripts/modern-game-tests.js` asserts no truncation at 1,024; gate pass | `node scripts/modern-game-tests.js` | PROVEN | Functional only. No FPS is claimed. |
| PKG-014 | "The default grid uses 13.5 MiB for indices" | clustered:31 | 16×9×24×1,024×4 B (`src/index.ts:47`) | n/a | PROVEN | – |
| PKG-015 | "30 and 60 fps settle identically" | controls:80 | `tests/controls.test.js` | `npm test -w @margoengine/controls` | PROVEN | – |
| PKG-016 | "on an integrated laptop GPU roughly halves GPU time compared with 4× MSAA" | core:5 | `results/vfx-island-final.json` (Arc, one demo) | `node pkb/vfx-island.mjs` (variants) | PROVEN | Fixed (5d): "on an Intel Arc 140V laptop cut the island demo's GPU frame from about 20 to 10 ms (particles off)" (medians 20.8 / 10.1 ms). |
| PKG-017 | "[measured baselines](…/benchmarks/README.md)" | core:29 | Captured 11 Oct before the rename, at core 19,874 B. Core has changed a lot since. | no | PROVEN | Fixed (5d): the "measured baselines" link (Oct 11, pre-rename) now points to this file ("committed measurements and how to reproduce them"). |
| PKG-018 | "Use `VFX` directly for… up to 1,000,000 particles" | creative:43 | `modern-game-tests.js` asserts the 1M indirect count; VFX GPU runs at 1M | yes | PROVEN | – |
| PKG-019 | 89,883-part culling table (CPU 23.4 / 0.48 / 0.41 / 0.55 ms; FPS / GPU ms) | culling:66-81 | `pkb/cad/culling.mjs` → `cad/results-culling.json` (Arc, 037d098). No src change since. | `node pkb/cad/culling.mjs --check --views=orbit,still,grazing --layouts=sheet,stack` | PROVEN | GPU ms ±15% by the README's own note. |
| PKG-020 | "0 differing pixels in all 640 compared frames" | culling:83-87 | Same JSON | same | PROVEN | – |
| PKG-021 | "Output matches the meshoptimizer reference decoder bit for bit" | decoders:27 | `tests/decoders.test.js` (meshoptimizer 1.1.1 vectors) | `npm test -w @margoengine/decoders` | PROVEN | – |
| PKG-022 | DOF cost table ("4.91 → 1.45 ms" …) | dof:22-31 | `pkb/gates/dof.mjs` → `results/gates-dof.json` (Arc, 3371f5c) | `node pkb/gates/dof.mjs` | PROVEN | – |
| PKG-023 | "differ by a mean of 0.00–0.11 levels (at most 0.3% of pixels by more than 6 levels)" | dof:33 | Same | same | PROVEN | – |
| PKG-024 | "creates no JS arrays, typed arrays, descriptors or shader strings in steady-state frames" | dof:35 | `tests/dof.test.js` counts typed arrays and GPU objects only, on a mock | test | PROVEN | Fixed (5d): "no typed arrays and no GPU objects (counted by a mock-GPU test)". |
| PKG-025 | "Replaces Three.js `RGBELoader`, `EXRLoader`, …, `PMREMGenerator`" | environment:7 | The package rejects PXR24/B44/DWAA/DWAB, tiled and multipart EXR (its own README:129). three reads PXR24 and DWAA/DWAB. | n/a | PROVEN | Fixed (5d): "Covers the common cases of ... `EXRLoader` (single-part scanline NONE/RLE/ZIPS/ZIP/PIZ; no PXR24, B44, DWAA/DWAB)". |
| PKG-026 | "All three allocate nothing in steady frames" | environment:43 | Only the backgrounds are tested | partly | PROVEN | Fixed (5d): "built to allocate nothing (the browser test measures this for the backgrounds)". |
| PKG-027 | "off renders the same pixels as no fog (checked on the real GPU)" | environment:41 | `results/pipeline-toggles.json` (0 of 3.7M channels; Arc) | `node pkb/pipeline-toggles/toggle.mjs pixels` | PROVEN | – |
| PKG-028 | "20 EXR fixtures… decoding bit-exactly" | environment:135 | `tests/environment.test.js` | `npm test -w` | PROVEN | – |
| PKG-029 | "`dist/workers/fbx.js`, 16.7 kB gzip" | fbx:14 | HANDOFF prose only | no | PROVEN | Fixed (5d): "about 16.8 kB min+gzip" (16,767 B, `entry-sizes.json`). |
| PKG-030 | "Same model as `loadFBX` / `parseFBX`, byte for byte" | fbx:14 | `test/worker.test.js` | yes | PROVEN | – |
| PKG-031 | "85.8 kB with three.js before, 12.0 kB now (13.9 kB…)" | fbx:29 | Commit 95132e9 message only, no method. fbx src changed since. | no | PROVEN | Fixed (5d): "about 10.6 kB min+gzip for the root entry" (`entry-sizes.json`); the 85.8 kB three.js bridge is now attributed to commit `95132e9`'s message with "method not recorded". Pin that ref and measure it with `entry-sizes.mjs` before using the comparison on HN. |
| PKG-032 | "compares 20 primitives… against a fixture generated from Three.js r180… to 1e-5" | geometry:55,89 | `tests/fixtures/three-reference.json` + `geometry.test.js` | yes | PROVEN | The fixture is r180; the parity doc targets r186. |
| PKG-033 | "`boxGeometry` plus `toGeometry` is under 1 KiB gzip" | geometry:60 | The test asserts < 1,500 B only | test | PROVEN | Fixed (5d): "under 1.5 kB gzip and under an eighth of the package (both enforced by `npm test`)". |
| PKG-034 | "GPU time fell from 0.85 to 0.52 ms, with identical pixels for every material kind" | gltf-pro:29 | `results/pipeline-toggles.json` (Arc, 7f1c9c6) | `toggle.mjs override` | PROVEN | – |
| PKG-035 | "`gltf-pro-lighting-hooks.proof.js` shows the GPU calls equal the text patches they replaced" | gltf-pro:41 | Default ref 15c87f1, no result file. Later passes recorded vs 114130c only. | default command probably fails | PROVEN | Fixed (5d): default ref re-baselined to `f8a36ca` (5c); README: "they matched until 5c moved the IBL BRDF LUT into a storage buffer; `binding-limit.proof.js` maps that change back, and the default run now checks 4,556 calls byte-identical against `f8a36ca`". |
| PKG-036 | "`@margoengine/gltf-pro/instancing` (about 2.5 kB gzip)" | gltf-pro:51 | HANDOFF prose (2,466) | no | PROVEN | Fixed (5d): "about 2.2 kB min+gzip" (2,243 B, `entry-sizes.json`). |
| PKG-037 | "The non-instanced draw makes the same GPU calls as before" | gltf-pro:71 | Proofs vs 114130c: 4,556 and 1,277 identical calls | `node pkb/proofs/gltf-pro-lighting-hooks.proof.js 114130c` | PROVEN | Fixed (5d): "the same GPU calls as before instancing (... run against `114130c` when instancing became opt-in; their default refs are now later commits)". |
| PKG-038 | "`dist/workers/gltf.js` (5.5 kB gzip)" | gltf-pro:88 | Later HANDOFF records 6,408 B | no | PROVEN | Fixed (5d): "about 5.6 kB min+gzip" (5,592 B, `entry-sizes.json`; HANDOFF's 6,408 used another method). |
| PKG-039 | "equals `loadGLTF`… byte for byte" | gltf-pro:88 | `tests/worker.test.js` | yes | PROVEN | – |
| PKG-040 | "Main-thread blocking measured in a real browser" | gltf-pro:88 | `pkb/workers/run.mjs` → `results/workers.json` (Edge 155, Arc) | `node pkb/workers/run.mjs` | PROVEN | – |
| PKG-041 | "perspective GPU calls and buffer writes are byte-identical to `96edc75`" | lines:90 | `proofs/lines-perspective.proof.js`. Later changes are math only. | yes | PROVEN | – |
| PKG-042 | "importing `parsePLY` pulls in about 3.8 KB gzip" | loaders:42 | No record | no | REMOVED | Fixed (5d): size dropped; "only the PLY reader and its helpers, not the 3MF, ZIP or XML code". |
| PKG-043 | "`dist/workers/usd.js`, 6.6 kB gzip" | loaders:83 | HANDOFF prose only | no | PROVEN | Fixed (5d): "about 6.6 kB min+gzip" (6,642 B, `entry-sizes.json`). |
| PKG-044 | "nothing is allocated per frame (tested with 3,000 objects…)" | lod:36-37 | `lod.test.js` asserts heap growth < 64 KB over 1,000 frames | yes | PROVEN | Fixed (5d): "no measurable heap growth (under 64 KB over 1,000 frames with 3,000 objects, `npm test`)". |
| PKG-045 | LOD table (CPU 1.1 ms; GPU 160-232 vs 11-25 ms), rerun "writes `test-results/lod-benchmark.json`" | lod:64-77 | The cited file is ignored. Committed gate `results/gates-lod-2500.json`: CPU 0.5/0.8/0.7 ms, GPU 3.6/23.2/226.9 ms. | `node packages/lod/test/browser-check.mjs` | PROVEN | Fixed (5d): table from `gates-lod-2500.json` (7c90b73, Arc 140V, Edge 155, one run): CPU 0.5/0.7/0.8 ms, GPU 3.6/226.9/23.2 ms; bake about 0.16 s. |
| PKG-046 | "differs… by 1.7/255 on average and covers 99%" | lod:74 | Gate: 1.72 and 0.99 | yes | PROVEN | – |
| PKG-047 | Atlas-seam "before" figures and "+2 ms… (20.5-20.9 → 22.6-22.9 ms)" | lod:79-97 | The "after" values are in `results/gates-lod-imposter-check.json`. "Before" and the timing are prose only. | partly | HISTORICAL | Labelled (5d): the "before" figures and the +2 ms say "earlier run, not committed"; the "after" values cite `gates-lod-imposter-check.json`. |
| PKG-048 | "about 10.8 kB min+gzip" | lod:111 | No record (commit 0fff93c said about 9.0 kB) | no | PROVEN | Fixed (5d): "about 9.9 kB min+gzip" (9,851 B). |
| PKG-049 | "Entry size about 4.0 kB min+gzip" (dimensions) | machinery:77 | Prose 3,973 B. Machinery changed after. | no | PROVEN | Fixed (5d): "about 3.4 kB min+gzip" (`./dimensions` 3,434 B). |
| PKG-050 | "(160-230 ms measured on an Arc 140V, versus about 8 ms…)" | machinery:83 | `results/pipeline-toggles.json`: +178 ms (146-228) vs +8.6 ms | yes | PROVEN | Fixed (5d): "about 180 ms, 146-228 ms over 5 runs (Arc 140V) vs about 9 ms" (`pipeline-toggles.json`). |
| PKG-051 | "These assets add about 7.7 MB" | machinery:91 | OCCT 7,604,031 + 96,871 B | n/a | PROVEN | Also give 3.1 MB gzip. |
| PKG-052 | "an exploded view at rest costs nothing per frame" | machinery:79 | `cad/results-after-*.json` | `node pkb/cad/run.mjs` | PROVEN | – |
| PKG-053 | "combined core and stage facade… strictly below 20,000 bytes gzip" | margoengine:9 | `core-budget.js` via build-modern/measure-size; 19,543 B at 0ed56b9 | `npm run measure:size` | PROVEN | CI is paused this month; the gate runs locally. |
| PKG-054 | "Without a transform the GPU calls are byte-identical to before (`materials-uv-transform.proof.js`)" | materials:25 | Default ref 1970fda already differed. Passes vs 114130c. | default fails | PROVEN | Fixed (5d): default ref re-baselined to `7f1c9c6` (1,277 identical calls); README: "byte-identical to the package before transforms existed (checked when they landed; ... now checks 1,277 calls against `7f1c9c6`, the last intentional change to that output)". |
| PKG-055 | "256 textured boxes go from 256 draws and 8.3 ms CPU per frame to 1 draw and 0.05 ms" | materials:27 | `proofs/results/materials-atlas.json` is labelled "recording mock GPU"; the draw path changed since | yes | PROVEN | Fixed (5d): "on the mock GPU (CPU encoding only)". |
| PKG-056 | "5,000 textured boxes: 5,000 draws and 36 ms… 1 draw and 0.4 ms… equals… pixel for pixel" | materials:46 | HEAD run `results/textured-instancing-gpu.json` (f4c6196): 55 → 0.7 ms, maxDiff 1 | `node pkb/textured-instancing-gpu.mjs` | PROVEN | Fixed (5d): "5,000 draws and 55 ms -> 1 draw and 0.7 ms CPU (Arc 140V, Edge 155); instanced frame within 1/255 per channel". |
| PKG-057 | "ships about 1.3 kB gzip. The whole package is about 10.4 kB gzip" | math:13 | The test asserts Vector3 < 1,500 B; the whole-package size is not recorded | partly | PROVEN | Fixed (5d): `./vector3` about 1.3 kB and the whole package about 10.4 kB min+gzip, from `entry-sizes.json`. |
| PKG-058 | "nothing allocates except `clone()` and `toArray()`" | math:3 | No test | no | REMOVED | Fixed (5d): "write into `this`/`out` instead of returning new objects; only `clone()`/`toArray()` with no target return new ones" (a description of the API, no allocation claim). |
| PKG-059 | "kept bit-for-bit identical to the package copies they replaced" | math:15 | `proofs/math-consolidation.proof.js` (~2.0M checks) | yes | PROVEN | – |
| PKG-060 | "Covers what Babylon.js offers with its Havok plugin… and what `@react-three/rapier` gives" | physics:7 | No matrix. The README's own Limits list many missing features. | n/a | PROVEN | Fixed (5d): "Covers the common rigid-body subset (not multibody, rope or spring joints, vehicles or snapshots; see Limits) of ...". |
| PKG-061 | "the 1.6 MB (gzip) Rapier bundle" | physics:48 | No record | no | REMOVED | Fixed (5d): "the Rapier bundle and its Wasm" (no size). |
| PKG-062 | "a given sequence of inputs replays bit for bit" | physics:49 | `tests/physics.test.js` | yes | PROVEN | Same build and platform only. |
| PKG-063 | "built for millions of points" | points:3 | Browser test draws 2M under a 500k budget (output ignored). CPU pick on 500k is about 130 ms. No FPS. | partly | PROVEN | Fixed (5d): "built for big scans: the browser test culls and draws a 2,000,000-point cloud under a 500,000-point budget". |
| PKG-064 | "2,000,000 points chunk in about 0.4 to 0.8 s" | points:39 | No record | no | REMOVED | Fixed (5d): deleted. |
| PKG-065 | "Used alone, every effect makes exactly the GPU calls it made before the stack existed" | post:36-37 | `proofs/post-stack.proof.js`. DOF and SSAO were rewritten after it, so it cannot hold at HEAD. | no | PROVEN | Fixed (5d): default ref re-baselined to `e12fc9c` (13,056 identical calls, 12 stories; creative stays on `5b1fe66^`); README: "When the stack landed (`5b1fe66`), every effect used alone made exactly the GPU calls it made before the stack existed; ... now checks 13,056 recorded calls ... against `e12fc9c` (the DOF rewrite)". |
| PKG-066 | "held to about 60 FPS… Slow PCs never show a slow phase or a reload" | quality:3-5 | Unit tests only. Prose: 53-61 FPS on a busy laptop. | no | PROVEN | Fixed (5d): "paced to at most about 60 FPS ... No PC is first shown the 4x tier or reloaded by the probe (the light tier's own frame rate depends on the GPU)". |
| PKG-067 | "6.1 kB min+gzip with Sky's base, against 10.2 kB for the full Sky" | scenery:27-28 | 10.2 matches `docs/api-surface.md`. 6.1 is not recorded. | no | PROVEN | Fixed (5d): "about 6.6 kB min+gzip summed over this entry, Sky's base and Sky's night, against 10.2 kB for the full Sky" (a sum of separately gzipped entries, as the README says). |
| PKG-068 | "With `xray` off… byte-identical… (10,586 recorded calls)" | selection:20 | `proofs/selection-xray-off.proof.js` (ref 46f9484). Selection changed after; not re-run. | probably | PROVEN | Re-run (5d): the default `46f9484` still passes (10,586 identical calls); README names the ref and the re-run commit. |
| PKG-069 | "`Picking.attach(engine)` enables faster `engine.pick`" | selection:22 | No timing of Picking vs `engine.pick` | no | REMOVED | Fixed (5d): "faster" dropped; describes the mechanism and says no pick-latency comparison is recorded yet. |
| PKG-070 | "A 600-pixel grid agrees with the bvh Raycaster within one pixel…; about 99% agree exactly" | selection:51 | `test/models.browser.mjs` passes in the gate run. Selection changed after. | yes | PROVEN | Fixed (5d): "must agree within one pixel; gate run `7c90b73` (Arc 140V): 590 of 600 orthographic pixels exact"; says selection changed since and to re-run `test:browser`. |
| PKG-071 | "whole package 11.8 kB…; `NodeMaterial`… 5.8 kB" | shader:100 | `shader.test.js` asserts < 12,500 / < 6,500 B and prints the values | yes | PROVEN | Commit the exact values. |
| PKG-072 | "a slow pan… and an orthographic zoom leave shadow edges unchanged" | shadows:7 | `shadow-shimmer.json` (pan changes 0.57-9.7 px per frame; zoom bit-identical) | yes | PROVEN | Fixed (5d): PKG-012 wording, orthographic only, citing `shadow-shimmer.json`. |
| PKG-073 | Sky entry table (base 5.1, +0.6…; "Night Citadel… 7.2 kB, `stage.sky()`… 6.1 kB") | sky:23-35 | Root 10,173 B in api-surface. Entries not recorded; `stage.sky()` fetch recorded as 6,720 B. | no | PROVEN | Fixed (5d): entry-alone sizes from `entry-sizes.json` (base 5.0, preetham 0.7, bruneton 2.2, clouds 0.9, night 1.3, fog 1.7, reflection 0.8, lighting 1.0 kB); combinations given as sums. |
| PKG-074 | "With every feature the WGSL is byte-identical… rendered pixels are the same" | sky:35-37 | `test/split.test.js`, `test/browser-check.mjs` (gate pass) | yes | PROVEN | – |
| PKG-075 | "for 1–3,000,000 world-space splats" | splats:7 | 3M is an input cap. One 3M run on an AMD iGPU at 181.4 ms (2026-10-11, raw data local). Splats changed since. | yes | PROVEN | Fixed (5d): "accepts 1-3,000,000 splats (an input cap, not a frame-rate promise)"; the uncommitted 181 ms AMD figure is not quoted. |
| PKG-076 | "update… 0.05 ms at 256, 0.25 ms at 512 and 0.9-1.1 ms at 1024; the plane 0.02-0.04 ms" | staging:28-31 | `results/staging-contact.json` (Arc, 43052ce) | `node packages/staging/test/browser-check.mjs` | PROVEN | – |
| PKG-077 | "about 5.0 kB min+gzip" | staging:46 | Later HANDOFF records 5,362 B | no | PROVEN | Fixed (5d): "about 4.6 kB min+gzip" (4,579 B). |
| PKG-078 | "Zero runtime dependencies" | stats:3 | `package.json` | n/a | PROVEN | – |
| PKG-079 | "Replaces troika-three-text's `Text`" | text:7 | Its own Limits: no Arabic/Indic shaping and no ligatures | n/a | PROVEN | Fixed (5d): "Covers troika's `Text` for Latin, Greek, Cyrillic, CJK, Hebrew and emoji (no Arabic/Indic shaping, no ligatures; see Limits)". |
| PKG-080 | "no per-track allocations in update"; "without allocations"; "without allocating a new vector" | tween:3; procedural:28; cinematic:3-4 | No allocation tests | no | UNPROVEN | Softened (5d) to in-place wording read from the code (tween: "steps the existing tracks in place and creates no per-track objects"); no heap test exists yet. |
| PKG-081 | "`dist/workers/usdz.js`, 25.9 kB gzip" | usdz:18 | HANDOFF prose only | no | PROVEN | Fixed (5d): "about 26.4 kB min+gzip" (26,448 B). |
| PKG-082 | "13.7 kB… before, 8.7 kB now; 16.1 kB before and 12.6 kB now including… loaders" | usdz:30 | Commit message only. `docs/api-surface.md` has the usdz root at 11,371 B (another method). Src changed since. | no | PROVEN | Fixed (5d): "about 7.8 kB min+gzip root, about 8.5 kB `/worker`" (`entry-sizes.json`); the 13.7 kB before figure is attributed to `95132e9`'s message, "method not recorded". |
| PKG-083 | "capacity up to 1,000,000"; "64 MB for state plus 4 MB for the draw list" | vfx:3,24 | `modern-game-tests.js`; arithmetic; `scripts/measure-vfx-memory.js` | yes | PROVEN | – |
| PKG-084 | "Intel Arc 140V (Edge 154…)… 1,000,000 1x 5.00 ms → 2.46 ms… all 16 rounds faster" | vfx:46-57 | `pkb/vfx-gpu.mjs` → `results/vfx-gpu-final-fill.json` (68771a2) | `node pkb/vfx-gpu.mjs` (A/B builds) | PROVEN | Fixed (5d): "Edge 155" (was 154) and "Intel Arc 140V laptop iGPU". |
| PKG-085 | "particle passes went from 5.7 to 2.6 ms and the frame's GPU span from 15.7 to 13.5 ms" | vfx:59-61 | `results/vfx-island-final.json` | `pkb/vfx-island.mjs` | PROVEN | – |
| PKG-086 | "`VFX`… (7.7 kB min+gzip)… `base` (5.7 kB)… +0.8 / +0.1 / +0.7 / +0.4 kB" | vfx:65-68 | `pkb/vfx-size.mjs` → `results/vfx-size.json` | `node pkb/vfx-size.mjs` | PROVEN | Updated (5d): root 7.0 kB and base 5.2 kB from `entry-sizes.json`; feature entries alone 1.2/0.4/1.1/0.6 kB; `vfx-size.json` named as the older base-plus-feature record at `76af7a0`. |
| PKG-087 | "the WGSL, uploads and GPU calls are byte-identical for every feature combination" | vfx:78 | `test/split.test.js` | yes | PROVEN | – |
| PKG-088 | "Zero-copy WebGPU external video textures" | video:3 | `importExternalTexture`. Whether the browser copies depends on the platform. Mock tests only. | n/a | PROVEN | Fixed (5d): "imported with `importExternalTexture` (no JS-side copy; whether the browser copies depends on the platform)". |
| PKG-089 | "3.1 kB min + gzip (the test enforces under 3.5 kB)" | viewcube:57 | `viewcube.test.js` | yes | PROVEN | – |
| PKG-090 | "saves about 1.4 KB gzip" | webgl:17 | Commit 1356787 message: 19,972 → 18,554 B | `measure:size` at both refs (not recorded) | PROVEN | Fixed (5d): "apps that target WebGPU only do not load its about 2.1 kB min+gzip" (2,088 B). |
| PKG-091 | "`npm test`… runs N Node tests/checks" (26/25/33/15/26/47/29) | audio:81, bvh:104, controls:119, labels:78, loaders:75, geometry:98, physics:119 | Counted `test(` calls: audio 26, bvh 25 and labels 15 match; controls 34, loaders 33, geometry 57 differ. | yes | REMOVED | Fixed (5d): test counts dropped in audio, bvh, controls, labels, loaders, geometry and physics. |
| PKG-092 | Package browser-test results ("byte-identical to the synchronous build", "within 2%", "within 1 px", "within 2.5 px", "restores the original frame byte for byte", 2M points…) | bvh:106, audio:81, labels:78, lines:92, text:92, points:112, environment:137, decoders:55, exporters:67, physics:121, controls:121 | The scripts are committed and assert these. None is in the gate run or CI; outputs go to ignored test-results. | per package `npm run test:browser -w …` | UNPROVEN | Labelled (5d): each sentence now says "(a real-GPU script, not in CI)" (physics: also a CI step on SwiftShader, results not committed). Add them to the gate runner and commit its JSON to make them PROVEN. |
| PKG-096 | "its GPU calls are byte-identical to the previous release otherwise" | clustered:51 | `proofs/clustered-local-shadows.proof.js` vs `0ed56b9`: 482 identical calls, 8 modules, 1x/4x MSAA (re-run at HEAD, passes) | `node examples/package-benchmarks/proofs/clustered-local-shadows.proof.js` | PROVEN | Fixed (5d): nothing has been released; now "byte-identical to clustered before shadows existed (482 recorded calls at 1x and 4x MSAA against `0ed56b9`)". |
| PKG-097 | "A `castShadow` flag without the entry only writes an unused field of the light buffer" | clustered:51 | Same proof: 8 differing writes, params.z only, shaders identical | same | PROVEN | – |
| PKG-098 | "physical variant (13 maps) together with directional `Shadows` and IBL reaches 17 textures, over WebGPU's default limit of 16" | clustered:53 | `f8a36ca` moved the BRDF LUT to a storage buffer; `results/binding-limit-gpu.json`: HEAD renders at 16 | `node examples/package-benchmarks/binding-limit-gpu.mjs` | PROVEN | Fixed (5d): "a gltf-pro physical material (13 maps) with directional `Shadows`, IBL and LocalShadows uses exactly the 16 per stage that WebGPU guarantees on every device, so one more texture on it throws a `RangeError` naming the combination". |
| PKG-099 | "shadows on the floor and boxes … no change on lit floor (max luma difference 0 over 2,285 points), shadows touching their casters (0 px gap)" | clustered:55 | `results/local-shadows-gpu.json` `visual[]`: acne 0 (2,285 point / 1,389 spot), gap 0 px; shadow ratios measured on floor points only | `node examples/package-benchmarks/local-shadows-gpu.mjs` | PROVEN | Fixed (5d): boxes were never measured as receivers; now "every box casts onto the floor ... on core and materials floors alike; no shadow acne (... 2,285 sample points, 1,389 under the spot light); shadows touch their casters (0 px gap)". |
| PKG-100 | "frame time 8.5 ms … 1/4/8 … 8.9/9.9/11.4 ms cached and 9.8/12.6/16.2 ms … spot 9.9 ms cached, 11.2 ms" | clustered:55 | Same JSON; every number matches. No `conditions` block (predates quiet-gate `9bf292b`), single run; the baseline without the entry read 9.2/9.1 ms | same, after `scripts/quiet-gate.mjs` | PROVEN | Fixed (5d): labelled "one run, before the quiet-machine gate existed" and "8.5-9.2 ms with no light shadowed, with or without the entry (the spread is run-to-run noise)". Re-run under the quiet gate before quoting small deltas. |
| PKG-101 | "WebGPU guarantees 16 sampled textures and 16 samplers per shader stage (… phones included), and Margo's device asks for no more" | gltf-pro:51 | WebGPU spec defaults; `packages/core/src/renderer.ts` `requestDevice` passes no `requiredLimits` | grep | PROVEN | – |
| PKG-102 | Physical row "**16 (16)**" with all three; "Before 5c … 17 and failed"; named `RangeError` | gltf-pro:55-71 | `packages/gltf-pro/tests/instancing.test.js:117-135` (asserts 15 for physical + shadows + IBL, and the error text); `binding-limit-gpu.json` (`e017d50` throws at 17, HEAD renders at 16); `binding-limit.proof.js` | `npm run verify` + the GPU script | PROVEN | – |
| PKG-103 | Other table cells: standard 5, materials 10, matcap 11, NodeMaterial 10+N, G-buffer "5 or 13" | gltf-pro:55-66 | Counted from shader source; no test asserts them | no | UNPROVEN | Add one `texture_` count assertion per cell to the 5c test; then PROVEN. |
| PKG-104 | "node textures count against the 16 … (about four remain)" | shader:94 | Contradicted the gltf-pro table since `f8a36ca` | no | UNPROVEN | Fixed (5d) to match the table: "fits 6 texture nodes alone, 5 with directional shadows and 3 with shadows, IBL and LocalShadows; past that, gltf-pro throws a `RangeError`". Same evidence as PKG-103 (source counts); PROVEN once those assertions exist. |
| PKG-105 | "IBL costs one of the 16 sampled textures … a physical glTF material with every lighting package needs all 16" | environment:63 | `instancing.test.js:131` (15 = 13 + 1 + 1); `binding-limit-gpu.json` | as PKG-102 | PROVEN | – |

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
