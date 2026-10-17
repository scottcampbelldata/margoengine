# CLAUDE TAKEOVER: Margo Engine, 2026-10-17

You are the Claude taking over Margo Engine from the Claude that ran on Scott's laptop (Intel Arc 140V, Windows)
until 2026-10-17. This file is everything that Claude knew that is not obvious from the code. Read it fully before
doing anything.

**Reading order:** `AGENTS.md`, then this file, then `docs/selection-children-decision.md`, then `docs/HANDOFF.md` (the long running log; the LAUNCH GATES
section and 5k are the parts you need), then `docs/repository-consolidation-2026-10-16.md` (Codex's 74-package
inventory). The handoff's opening "Where things are" section is stale (it still names `perf/auto-quality`).

---

## 1. Who and what

- **Scott Campbell** is the only user and owner. Margo Engine is his project; he is not a graphics specialist, so explain
  in plain language, lead with the answer, keep reports short, and never claim something you did not measure.
- **Goal:** sell Margo as a modern replacement for three.js: good-looking, smooth on PCs and phones, small, modular
  (load only the packages you use), and "the smallest, fastest, best CAD visualization engine". Launch plan:
  margoengine.com (live), npm (set up, nothing published), then Hacker News, YouTube, LinkedIn, X.
- **Two AI workers share the repo:**
  - **Codex** (Scott's other tool) commits to `main` as "Scott Campbell" and was still finishing about 30 packages on
    2026-10-17, for several hours. It reads `AGENTS.md`.
  - **Claude** (you) does the merging, verification, hygiene, security, docs and launch gates, mostly by running
    background sub-agents in git worktrees and merging their results.

## 2. Hard rules (Scott's decisions; do not relitigate)

1. **Core + stage size gate: 25,000 bytes gzip** (`npm run measure:size`, `scripts/core-budget.js`, CI). Raised from
   20,000 on 2026-10-16 deliberately; Scott confirmed 2026-10-17. 22,000-24,999 is an allowed band. Measured
   **20,850 B** at 95b4eae. Core (`packages/core`) stays feature-frozen: new bytes go in the stage file
   (`packages/margoengine`), see `docs/core-stage-contents.md`. Still **ask Scott before any change to core**.
2. **No three.js code in anything that ships.** Nothing copied, ported, adapted or resampled from three.js (the LTC
   area-light table and the AgX shader were re-derived from primary sources for this reason). Comments that state API
   parity ("counterpart of three.js OrbitControls") are fine. Write new features from specifications and papers; do
   not open three.js source.
   - three.js **stays** as a dev dependency for tests, test models and head-to-head benchmarks (the reference oracle).
     Never remove it from dev/CI.
   - Attributed ports of standard permissive utility code are fine and must NOT be rewritten: meshoptimizer decoder
     (MIT), TinySDF in `packages/text/src/sdf.ts` (BSD-2). Credited in `THIRD-PARTY-NOTICES.md` / package NOTICE files.
   - Kept as optional third-party wrappers by Scott's choice: Rapier (physics), Recast (navigation), web-ifc (ifc),
     OpenCascade (STEP/IGES), Draco/Basis (decoders), React. procedural's simplex-noise and isosurface were replaced
     with our own code. Any new third-party runtime dependency needs Scott's OK.
3. **Code hygiene >= 9/10** is a hard launch requirement (launch gate 6; `npm run hygiene` scorecard).
4. **11 launch gates** in `docs/HANDOFF.md` must all pass before going live. Never publish invented numbers: every
   public number comes from a measurement with hardware, browser, commit and conditions.
5. **Outward actions need Scott's explicit yes each time:** npm publish, production deploys of margoengine.com,
   creating repos or other public actions on his accounts, changing account settings. **Pushing verified work to
   `main` is approved** (he accepted the work-on-main plan 2026-10-17).
6. **Deploy once:** Scott said "wait until Codex is done, then deploy once". Do not deploy margoengine.com before Codex
   finishes; then run the full check on final `main` and ask Scott for the go-ahead for one production deploy.
7. **Versions:** all 74 packages + `create-margo` + `margo-convert` ship in lockstep at **1.0.0**; every internal range
   is `^1.0.0`. `node scripts/set-version.mjs <x.y.z>` moves them all; `tests/versions.test.js` fails on drift.
8. **Security contact:** `security@margoengine.com` (Scott's decision), with GitHub private vulnerability reporting as
   the preferred channel. Never put `scott@scottcampbellconsulting.com` in the repo.
9. **Licences:** OpenCascade (LGPL-2.1) source offer = Scott's fork https://github.com/scottcampbelldata/occt-import-js
   (tag 0.0.23 = c2148e5) + the pinned upstream OCCT commit d2abb6d (OCCT 7.6.1) on Open-Cascade-SAS's GitHub. Do NOT
   mirror the OCCT repo itself (Scott decided that is enough).
10. **Galaxy S23** 3-5 FPS island issue is shelved (Scott has no device). Steam games plan is postponed ("later").

## 3. How to work on this machine-independent repo

- **Branch: `main`.** `perf/auto-quality` is retired (main contains all of it). `git pull --rebase origin main` before
  every push; never force-push; no merge commits of main into itself.
- **Push checklist** is in `AGENTS.md` ("Before every push to main"): verify, hygiene not worse, current-mode proofs
  pass, public numbers true, launch-gate status updated. Hold yourself and your agents to it.
- **Merge procedure for a sub-agent's commit** (do not pipe `git cherry-pick` through `tail`/`grep`; a failed pick then
  looks like success - this bit us twice):
  ```bash
  git checkout -q -- examples/package-benchmarks   # discard build-time rewrites of result JSONs
  git cherry-pick <sha> || { git cherry-pick --abort; exit 1; }
  npm run check:merge > log 2>&1; R=$?
  git checkout -q -- examples/package-benchmarks/results examples/package-benchmarks/proofs/results
  # push only if R == 0, or if the ONLY failures are "night-citadel-*: capture: page.goto: Timeout" (see section 6)
  ```
- **Checks:** `npm run verify` (build:packages + api:check + sandbox + node tests at --test-concurrency=4 + size gate +
  proofs --current); `npm run check:merge` = verify + `npm run build:site` + `npm run visual:check -- --no-build`.
  `npm run proofs` (all 46 pinned proofs, ~9 min), `npm run hygiene`, `npm run supply-chain -- --check`,
  `npm run fuzz` (seeded fuzzers; `-- --short` in test:release), `npm run csp-check` via
  `node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/csp-check.mjs`.
- **Any WGSL/shader change** is not done until `build:site` + `visual:check` pass. Node has no WGSL compiler and the
  GPU-call proofs compare shader TEXT, not validity (an AgX shader with an extra `(` passed every Node test once).
- **GPU lock:** real-GPU/browser runs go through `node scripts/gpu-lock.mjs run --owner=<id> -- <cmd>`; hold it only
  while running. Wrapping self-locking scripts (visual:check, benchmark runners) is safe since 303fecf
  (`MARGO_GPU_LOCK_NESTED`). Never delete another owner's lock; a lock whose pid is dead is taken over automatically.
- **Quiet gate:** timing numbers only on AC power after `node scripts/quiet-gate.mjs` passes; otherwise label them
  "diagnostic". Never all-core CPU loads (the laptop crashed once under a 128-thread burn): node tests at
  `--test-concurrency` 2-4, at most half the cores for load tests.
- **Usage limits:** the previous Claude hit the weekly limit running 7-8 agents at once. Run **2-3 sub-agents at a
  time**.
- **Sub-agent prompt pattern that worked:** give each agent a worktree (`isolation: worktree`), the exact package
  scope, "read AGENTS.md + HANDOFF sections X first", the rules above (no core changes, lockstep versions, no
  three.js, measured numbers only, test concurrency 2, GPU lock), "finish: rebase onto latest origin/main, run
  `npm run check:merge`, ONE commit, do not push", and a report format. Tell agents which packages another agent or
  Codex is editing so they stay out.
- **Windows noise:** LF/CRLF warnings everywhere are harmless. Builds rewrite
  `examples/package-benchmarks/results/{entry-sizes,basic-scene-network,csp-check}.json` and proof result JSONs; discard
  those before cherry-picks unless the work is meant to update them.
- **Git email:** Scott's global git email is the noreply `251750033+scottcampbelldata@users.noreply.github.com`
  (old commits keep the business email; do not rewrite history).

## 4. State of `main` at 1546299/95b4eae + b3ed8ca (2026-10-17)

| Check | Result |
| --- | --- |
| Node tests (`npm run verify`) | 2,339 / 2,339 pass |
| Core + stage | 20,850 B gzip (gate 25,000) |
| Packages | 74 (new: `@margoengine/kinematics-constraints`), all 1.0.0 |
| Hygiene | 5.9 / 10. format/lint/any 10; strict 9.1; types 0.3 (156 duplicate names); TSDoc 0.0 (481 undocumented exports); errors 0.0 (581 bare throws); dead code 7.9. Weakest: react 4.8 (74/85 exports undocumented, strict flags missing in its own tsconfig), animation 5.0, gltf-pro 5.4 (2 files unformatted), margoengine 5.3 (1 file unformatted) |
| Proofs `--current` | **6 pass / 9 fail** (deformed-shadows, gltf-pro-lighting-hooks, materials-uv-transform, oit-detached, post-ssr, post-ssr-models, post-stack, quality-presets, selection-xray-off). All passed at 849ff51; broken by Codex commits between 849ff51 and main |
| Visual check (55 views) | Fails. Night Citadel high/light: page-load timeout under load (known, section 6). **Regressions to triage:** khronos-ToyCar (62% px, max 122: the red SHEEN cloth now has dark blotches - clear regression), SheenChair (11%), MaterialsVariantsShoe (9%), DiffuseTransmissionTeacup (4.6%), flight-helmet high/light/phone (goggle lenses only, max 159 - maybe the intended fix in `docs/flight-helmet-transmission.md`), 11 Khronos models differ by exactly 1 level (one shared shader change, probably core ambient RGB in 6a57389) |
| Landing/limits size claims | Fixed in repo (b3ed8ca/4ad40e6: "about 21 kB", "fails at 25,000"), NOT deployed (deploy once, see rule 6) |

Codex's last-48h work (87 commits): React scene bindings, materials texture maps / dispersion / depth-distance /
back-side-only modes, gltf KTX2 + UV transform + 8-joint skinning, native FBX importer with a real CC0 Blender
fixture, kinematics constraints + IK example, Light Keeper demo (already deployed to production by Codex), stage
`fit`/`worldBounds` for PBR models (+642 B stage). The previous Claude graded it **B overall**: features A-,
correctness B+ (pending triage), tests B-, hygiene C+, docs/claims C, git history C (27 docs-only commits, 10 duplicate
messages, 5 self-merges).

**On `main` since this file was written (2026-10-17):**
- The pack: `ccdcf62` (entry sizes recorded in `ac0ffc6`). `@margoengine/machinery` `PartInstancer` packs small static
  CAD parts into shared GPU buffers; core gains one hook, `Batch.claimed`. `entry-sizes.json` at `ccdcf62`: core +
  stage 21,107 B gzip, core 18,876.
- The phone-quality change: `fb01fb1`, the phone tier caps phone pixels and turns SSAO and fog off.
- The selection question is closed: Scott kept descendant outlining (`docs/selection-children-decision.md`, section 5).

## 5. In-flight and parked work (branches on origin)

| Branch | What | State / what to do |
| --- | --- | --- |
| `claude/proof-triage` | Triage of the 9 failing proofs and the visual diffs: first bad commit, intended vs regression, evidence. Proof refs re-pinned for intended changes; findings written into HANDOFF gates 1/10/5. Report-only for package code | Was running on the old PC when this file was written; it pushes this branch when done. **If the branch does not exist or is a WIP, redo the triage** (prompt idea in section 7, step 1) |

**Triage results (branch `claude/proof-triage`, commit 13204982, findings in its docs/HANDOFF.md gates 1/5/10 - merge
that doc change into main):**
- Codex's d3629be re-pinned all 9 proofs' `--current` ref to b3ed8ac, so `--current` passes on main, BUT three of those
  refs already contain a real regression (below). Proof re-pins for the intended changes are therefore already on main.
- **Regression 1 (B), gltf-pro compact path, from consolidation 8f710eb3:** plain opaque/BLEND glTF materials compile
  with runtime `discard` again, losing the 1e.f early-Z win (0.852 -> 0.524 ms on DamagedHelmet). Cause
  `packages/gltf-pro/src/index.ts:1776` (`specialized = !compact || ...`) and `:1955`; fix: always add the
  `margoFaceTest:0, margoAlphaTest:0` overrides on the compact path. Then re-pin oit-detached,
  gltf-pro-lighting-hooks, materials-uv-transform to the fix commit. Claims PKG-035 / PKG-054 do not hold until fixed.
- **Regression 2 (B), derivative tangent frame, from b326518e "Add UV1 and geometry groups":** ToyCar, SheenChair,
  MaterialsVariantsShoe, DiffuseTransmissionTeacup (normal-mapped, no tangent data) render wrong (ToyCar's sheen cloth
  gets dark blotches). `packages/gltf-pro/src/shader.ts:49-56` and `:150-157`. Likely the bitangent is inverted
  (hypothesis, verify on GPU by comparing BoomBox/Corset/Lantern with tangents stripped vs with tangents).
- Intended (A), baselines may be updated together: the 10 Khronos models off by 1 level (8f710eb3 sets normal scale 0
  without a normal map). Not yet updated.
- **DECIDED by Scott (2026-10-17): keep it.** Selecting a parent outlines that mesh and everything under it, for a plain
  core mesh and for a loaded model; a child pick stays child-only. Do not revert, do not re-pin the old proof. Full
  note: `docs/selection-children-decision.md`.
- Not done: pinned `npm run proofs` (all 46), the flight-helmet lens comparison, Night Citadel.
| `claude/wip-gate9-deterministic-visual` | Gate 9: make sandbox capture deterministic, find the Night Citadel stall | WIP from 08f7eb5 base, merges cleanly onto main. Finish it: root-cause the Night Citadel load stall, then prove visual:check and verify 5x in a row under bounded load |
| `claude/wip-fuzz-gltf-textures` | Gate 11a part 1: fuzz gltf/gltf-pro/decoders (KTX2/Basis/Draco/meshopt)/environment images (EXR/HDR/UltraHDR)/.margo | WIP, conflicts with main (12 files). Redo on main, reusing its harness ideas; the shared harness is `scripts/fuzz/` (from 849ff51). ALSO fuzz Codex's new KTX2 path in `gltf` and the new native FBX importer (6bd2042 replaced the importer that 849ff51 fuzzed) |
| `claude/old-base-hygiene-group-c` | Hygiene group C (lighting/post) on the OLD base | Conflicts in 18 files with main. Do not merge; redo group C on main and use it only as reference |

## 6. Known issues

- **Night Citadel stall:** under heavy multi-agent load its high/light views sit at "Preparing the citadel..." past a 90 s
  `page.goto` timeout; alone it loads in 4-7 s and passes (verified 6+ times). Scott's rule: a Night Citadel page-load
  timeout alone does not block a merge; anything else does; run the complete test pass on a quiet machine at the end.
  Root cause still unknown (gate 9 branch). A visitor on a busy laptop must not hang, so it must be found before launch.
- `gameplay-sandbox-phone` was load-flaky (0.072 vs 0.047 once; normally ~0.022). Gate 9 branch addresses it.
- `npm run build:site` runs a real-browser network test (basic scene) under the GPU lock: it needs WebGPU and waits for
  the lock.
- `procedural-deps` proof is HISTORICAL (needs removed npm packages); reported, not failing.

## 7. What is left, in order (estimate 4-6 days of agent work)

1. **Proof + visual triage** (`claude/proof-triage`). Merge its proof re-pins; then fix every confirmed regression,
   starting with the sheen cloth (ToyCar/SheenChair/Shoe/Teacup). Wait for Codex to finish before editing packages it
   touches.
2. **Wait for Codex to finish its ~30 packages** (ask Scott). Then:
3. **Hygiene to >= 9 (gate 6)**, 2-3 agents in parallel on `main`, by group (groups in HANDOFF 5k: A done; redo B
   loaders/assets, C lighting/post, D interaction/CAD/UI), plus Codex's new code (react, kinematics-constraints,
   materials, gltf, animation). Shared types live in `@margoengine/math`; error convention in `docs/conventions.md`;
   allowlist in `scripts/hygiene-allowlist.json` (core's 21 + stage's 2 bare Errors are allowlisted by Scott's
   decision - frozen core). Then switch the verify hygiene check from warn to `--strict` fail.
4. **Security (gate 11):** finish 11a part 1 fuzzing (section 5), re-fuzz the native FBX importer and gltf KTX2. 11b
   (injection/URLs/pollution) and 11c (supply chain, SECURITY.md, releasing.md, publish workflow) are done.
5. **Gate 9:** finish the branch; Night Citadel root cause; 5x clean runs under bounded load.
6. **Gate 10 claims:** `docs/whitepaper/claims.md` - 0 OVERCLAIM / 0 UNPROVEN for public pages; fix the 6 STALE rows;
   add rows for Codex's new features.
7. **Gate 7 docs + playground** ("documentation is the product", HANDOFF item 8): quickstart, three.js migration
   (`docs/from-threejs.md` exists), two flagship tutorials, cookbook (drafts: `docs/guides/walkthrough.md`,
   `docs/guides/quality-tiers.md`, `docs/guides/blender-game.md`), generated API reference.
8. **Gate 8 landing page:** humble exact scope (WebGPU-first, CAD/engineering focus, link `docs/limits.md` next to the
   size claim; core is a Rust/Wasm kernel of ~480 lines inside ~85k lines of TypeScript + WGSL - never call it a
   "Rust engine").
9. **Gate 1 benchmarks + whitepaper:** needs Scott's laptop quiet for about an hour (close other apps), on AC, quiet
   gate passing; then `docs/whitepaper.md` from the reproducible proofs and benchmarks.
10. **Final phase:** demo rebuild showcasing the new features (probes, decals, glass/refraction, skinned + VAT shadows,
    WalkControls dollhouse, material variants); the example game with the KayKit assets (`examples/assets/kaykit/`,
    all CC0, validator 0 errors; characters on a 23-joint `Rig_Medium`, clips in separate GLBs - play by joint name);
    the Tokyo diorama is already on main (Scott's other PC); the ArchViz walkthrough needs Scott's house model; one
    `CHANGELOG.md` section for 1.0.0.
11. **Release:** with Scott's go-ahead each: one production deploy (`npx wrangler pages deploy site/dist --project-name
    margoengine --branch main --commit-hash <sha>`, then `npm run site:check` against margoengine.com), npm publish
    per `docs/releasing.md` (publish workflow is manual and disabled until `NPM_PUBLISH_ENABLED=true`), then gate 2:
    `npm create margo@latest` on a clean machine.

## 8. Scott's own to-dos (remind him; you cannot do these)


- Create the `security@margoengine.com` mailbox (or forwarding).
- GitHub: enable private vulnerability reporting; "Keep my email addresses private"; 2FA. npm: 2FA.
- Create the `npm-publish` GitHub environment (himself as reviewer, `main` only); after the first publish set up npm
  trusted publishing and revoke the bootstrap token.
- Optional: Cloudflare dashboard -> Caching -> Browser Cache TTL -> "Respect Existing Headers" (the zone forces 4 h on
  assets; harmless since site/404.html exists).
- Pick a CC0/CC-BY house model for the walkthrough demo (reminder doc in his Google Drive folder "Margo Engine - To Do").
- Quiet laptop time for the benchmarks; go-aheads for deploy and publish.

## 9. Site facts

- Cloudflare Pages project `margoengine`, custom domains margoengine.com + www. `site/404.html` makes missing files
  404 + no-store (without it Pages served index.html as 200 for missing assets and browsers cached it as JS - that broke
  the demos once). No year-long cache rules (Scott: "people must enjoy the site"). `npm run site:check [origin]`
  verifies a deployment file by file.
- Strict CSP everywhere, no `'unsafe-eval'` anywhere (workers included); `node scripts/csp-check.mjs` under the GPU lock.
