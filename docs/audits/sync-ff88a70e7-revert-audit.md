# Audit: public work reverted by the private syncs ff88a70e7 and e2177dc6e

Audited 2026-11-25 against `origin/main` = `15163e866` ("chore(quality): record the physics entry's size after the
film.ts split"). This audit used only this repository's own git history. It did not use the private repository.
Nothing was edited, built or committed except this file.

## Summary

| | ff88a70e7 (2026-11-24) | e2177dc6e (2026-11-20) |
|---|---|---|
| What it was | The tree of `e2177dc6e` plus private work in 39 files (cutscene film titles, weather thermal/eruption, terrain crater, `tools/shot`). | The private engine at `3b68fe7569`: a superset of public main `44e0cc029` with a large restructure. |
| Public commits it sat on | 242 public commits `e2177dc6e..ff88a70e7^` (2026-11-20 to 2026-11-24). It dropped nearly all of them. | About 600 public commits checked (`44e0cc029~600..44e0cc029`, 2026-11-10 to 2026-11-14). 492 were kept. |
| Files deleted and still missing | **102** (129 deleted plus 2 renamed away; 29 back on main) | 206 (all deliberate, see section B) |
| Modified files still reverted | **267** source, test, script and doc files (240 fully, 27 partly), plus 97 generated records. In addition, 2,180 files lost formatting only. | None that is substantive. Lines missing only in records, proof baselines and docs. |
| Fix commits lost (`fix(...)`) | **61** still lost (4 of them redone differently since: `4d4c0b094`, `b6b85638b`, `8f3e996da`, `e3badb692`); 9 partly restored (2 of them redone: `cae80d0a9`, `8cde748ff`); 11 fully restored | 0 substantive |
| Feature commits lost (`feat(...)`) | **7** (rigging x2, terrain, biomes, lines, water, examples) | 0 (the two demo commits were superseded) |
| Test/docs/chore commits lost | 37 still lost, 4 partly (owner fixtures, proofs, known-bugs, records) | Records and proof baselines only |
| Formatting commits lost | 94 `style(*): biome format` commits, fully lost (7 partly) | none |

The key fact: `git diff e2177dc6e ff88a70e7` changes only 39 files. So ff88a70e7 put back the tree of
2026-11-20 and dropped every public commit after it. The private repository did not hold those commits. Restoring is
mostly a matter of taking public history `e2177dc6e..ff88a70e7^` again, apart from the items redone since.

### Method

1. **Deleted files.** I listed every `D` and `R` source in `git show --name-status ff88a70e7` and checked whether it
   exists on `origin/main`. The last and the adding commit come from `git log -1 ff88a70e7^ -- <path>`.
2. **Modified files, commit by commit.** For each of the 242 public commits, I took its added lines (`git show -U0`),
   kept only lines still present in `P = ff88a70e7^`, and dropped trivial lines (under 12 characters once whitespace
   is removed; whitespace, quote style and trailing `;`/`,` are normalised). I then checked each line against the
   same file in `ff88a70e7` and in `origin/main`.
   - Lines missing in ff88a70e7 were **lost by the sync**.
   - Lost lines found again on main were **restored**.
   - A commit is STILL-LOST when 85% or more of its lost lines are missing on main, RESTORED when 15% or fewer are,
     and PARTLY in between.
3. **Cross-check.** I tried to apply each commit's patch, forward and in reverse, onto an index of `origin/main`. Only
   about 30 applied cleanly, because later formatting moves context. Their results agree with step 2. The known cases
   came out as expected: `0e11055b5`/`a65c16551` RESTORED by `508b6c1cc`/`f970d0250`, and `d09a13541` RESTORED.
4. **Redone since.** I matched the KB and GAP ids in the lost commit messages against post-sync commit messages and
   `docs/known-bugs.md` on main. That finds fixes landed again in a different form.
5. **e2177dc6e.** The same line method, with P = `e2177dc6e^` = `44e0cc029`, over the 600 commits before it. The
   1,814 renames in that sync (`-M`) are mapped, and only lines still present in `44e0cc029` are counted.

Caveat: this is line-level evidence. Work that was rewritten under another path or name shows as lost unless a KB
id or a renamed file links it, so each "restore" below still needs a read of the current file before it is applied.

---

## A. ff88a70e7: losses by package

Status key: **LOST** = still missing on main; **PARTLY** = some of it is back; **REDONE** = main landed the same fix
again in another form, after the sync; **BACK** = restored.

### rigging, animator (feature work, the largest loss)

- **Lost commits:**
  - `028a6ecc6` feat(rigging): add aquatic motion, contact constraints and reef coral (1,297 lines)
  - `a4f419fcf` feat(rigging): register human palms and articulate forearm roll
  - `aed58d8fc` fix(rigging): constrain wrist, digit and character limb contact
  - `8a314c3a3` fix(rigging): stabilize hinged contact and articulate the thumb
  - `459e33f9b` fix(rigging): check joint directions between poses
  - `30629b4eb` fix(rigging): preserve palm orientation during rest retargeting
- **Deleted, still missing:**
  - `packages/rigging/src/{swim,contact,joint-limits,hinged-contact,bar-grip,limb-collision}.ts`
  - `packages/rigging/tests/{swim,contact,joint-limits,limb-collision}.test.js`
  - `packages/animator/src/ccd-entry.ts`, `packages/animator/test/ccd-entry.test.js`
  - the kit shims `packages/{game,margoengine}/src/rigging/{swim,contact,joint-limits}.ts` and
    `packages/{game,margoengine}/src/animator/ccd.ts`
  - API reports `api/rigging.{swim,contact,joint-limits}.api.md` and `api/animator.ccd.api.md`
- **Modified, still reverted:**
  - `packages/rigging/src/retarget.ts`, `src/rig.ts`, `README.md` (177 lines), `package.json` (entries)
  - `tests/hands.test.js` (218 lines), `tests/retarget.test.js`
  - `packages/animator/src/ccd.ts`, `src/index.ts`, `README.md`, `package.json`
- **Status:** LOST. The only post-sync rigging commit is `a79903fb9` (jiggle bone), which does not overlap.
- **Action:** restore as is, from `028a6ecc6` through `459e33f9b` in order. Then reconcile `package.json` exports and
  the README with `a79903fb9`.

### horses

- **Lost commits:**
  - `9a1298004` fix(horses): keep gait joints continuous and anatomically aligned
  - `74281e285` fix(horses): stabilize gait transitions and fit authored rigs
  - `50b82ebf4` fix(horses): correct foreleg motion and plant hooves on terrain
  - `4a259433c` fix(horses): carry tail swishes through the dock and hair
  - `a665f0f57` fix(horses): articulate the fore fetlock during the walk
- **Deleted, still missing:** `packages/horses/src/clip-plan.ts`, `src/grounding.ts`, `test/grounding.test.js`.
- **Modified, still reverted:**
  - `packages/horses/src/model.ts` (484 lines), `src/index.ts` (partly), `README.md` (94 lines)
  - `test/horses-check.{html,mjs}`, `test/horses.test.js` (partly)
- **Status:** LOST. `8b051490b` (scene across lazy imports) is BACK through `6309b5744`.
- **Action:** restore as is, after `6309b5744`.

### water

- **Lost commits:**
  - `c82e6722a` fix(water): improve HDR ocean light and the camera waterline (553 lines)
  - `f616fc932` fix(water): match refraction color and attenuation to the bent ray
  - `294127ec6` fix(water): the surf's tanh takes a bounded argument, so the open sea no longer drains to NaN
    (KB-WATER-SURGEVOL1)
  - `1faee7666` fix(water): the coastal flow's first-step set-up goes to the GPU in bounded submissions
    (KB-SCENES-DUNE-ARCHANG1)
  - ship work:
    - `6a043daf2` fix(water): age turbulent ship foam from the stern
    - `7c122f224` fix(water): sweep the breaking bow crest aft around the hull
    - `79891ff72` fix(water): displace the surface along moving hulls
    - `a15b997d8` fix(water): keep bow wash and stern foam visible at harbor speed
    - `191664768` fix(water): correct the Kelvin wake stationary phase
    - `e16934f32` feat(water): colour turbulent stern wakes
  - `64265c9db` fix(water): keep horizon fill behind visible terrain
  - `1de24300d` fix(water): resolve continuous open-water ripple and reflection detail
  - `d76f08be5` fix(water): bound GPU checks in separate suites
  - tests, docs and proofs: `786055fbf`, `c3cbaad4e`, `68b49042b`, `56c9d84a6`, `7062e12f1`, `21be2cacb`,
    `7e7176579`, `eefac4069`, `bfa6c541b`, `28284065a`
- **Deleted, still missing:**
  - `packages/water/src/sky-radiance.ts`
  - `test/{sky-radiance,contact-foam,refraction-depth}.browser.mjs`
  - `docs/upstream-reports/KB-WATER-FLOODFILM-COMPAT1/report.md`
- **Modified, still reverted:**
  - `src/index.ts` (204 lines), `src/ships.ts` (279), `src/coastal.ts`, `src/surf.ts`, `src/reflector.ts`,
    `src/underwater*.ts`, `src/spray.ts`
  - `test/ships.{test.js,browser.mjs}`, `test/surf.browser.mjs`, `test/surge.browser.mjs`, `test/coast-runup.test.js`,
    `test/horizon.browser.mjs`, `test/underwater.browser.mjs`, `test/browser-root.test.js`
  - `README.md`, `package.json`
  - `examples/package-benchmarks/proofs/water-ssr.proof.js` and its baseline
- **Status:** LOST. `43d6035e9` is PARTLY back.
- **Action:** restore and reconcile. Main has 15 later water commits: flood sediment (FG-13), flood bakes (FG-03),
  sparse density spray mist (FG-10) and `e406829a7` (frame light as unit direction). Replay in order and re-record
  water-ssr. The NaN fix `294127ec6` comes first; it is a correctness bug.

### terrain

- **Lost commits:**
  - `3eafe4490` feat(terrain): bake heightfield sun and sky visibility (805 lines)
  - `9176e5cdd` fix(terrain): anchor bounded clipmaps in world space
  - `7b77cb53f` fix(terrain): give procedural rocks distinct forms and mineral grain
  - tests: `a5a527435`, `c85abff3f`, `0df7a8b88`, `50d5b957b`
- **Deleted, still missing:**
  - `packages/terrain/src/{relief-lighting,surface-height}.ts`
  - `test/{relief-lighting,surface-height,clipmap-anchor}.browser.mjs`
  - the kit shims `packages/{game,kit-viz,margoengine}/src/terrain/relief-lighting.ts`
  - `api/terrain.relief-lighting.api.md`
- **Modified, still reverted:** `src/index.ts`, `src/stream.ts`, `src/rocks.ts`, `src/rock-surface.ts`, `README.md`
  (76 lines), `package.json`, rocks tests, `test/owner-lifetime.fixture.js`.
- **Status:** LOST.
- **Action:** restore and reconcile with `4ca2133e0`, `dcde53594` and `e406829a7` (displaced relief and sun shadows,
  post-sync). `surface-height.ts` comes from the biomes fix `fdf8b1908`.

### biomes

- **Lost commits:**
  - `e57c6009a` feat(biomes): shape alpine treelines with sheltered cohorts
  - `04f9cc4e8` docs(biomes): register treeline validation messages
  - `fdf8b1908` fix(biomes): root distant forest in the rendered terrain (449 lines)
  - `63b19ee4a` fix(biomes): keep regional and tile curvature consistent
  - `9300fb9d8` fix(biomes): keep the visual scorch division annotation with the formula
  - `ac00dd0ff` test(biomes): compare streamed views with a shared terrain anchor
- **Deleted, still missing:**
  - `packages/biomes/src/treeline.ts`, `tests/treeline.test.js`
  - the kit shims `packages/{game,margoengine}/src/biomes/treeline.ts`
  - `api/biomes.treeline.api.md`
- **Modified, still reverted:**
  - `src/{cover,crown,define,far,objects,sample,view,disturbance,biomes.worker}.ts`
  - `tests/workers.test.js`, `tests/browser-check.*`, `README.md`
  - `scripts/errors/entries.js` (treeline messages)
- **Status:** LOST.
- **Action:** restore and reconcile with 11 post-sync biomes commits (for example `1fe7527e7` nearRadius shrubs).

### usdz (KB1942c parts 25 to 30)

- **Lost commits:**
  - `4afa0f2be` part 25: an arc implied from an implied class arc keeps that arc's own pair
  - `d17ac0156` part 26: an implied specializes arc stops on a placeholder an inherit holds
  - `59d7d8044` part 27: an arc to an ancestor or descendant of its site is a cycle
  - `691a83cdd` part 28: class arcs implied from under a variant rank from its holder
  - `bb5f62ac2` part 29: a class arc implied below the index root counts its parent node's depth
  - `772fcc4f4` part 30: an implied class arc reads its ancestral variant selections across the index
- **Deleted, still missing:** six tests `packages/usdz/tests/{implied-implied-targets,implied-through-held,
  namespace-cycles,implied-variant-holder,implied-parent-depth,implied-chain-variants}.test.js` and their six JSON
  fixtures.
- **Modified, still reverted:** `src/stage.ts` (105 lines), `tests/stress-stages.test.js`, the KB1942c rows in
  `docs/known-bugs.md`, `docs/limits.md` and `docs/whitepaper/claims.md`.
- **Status:** LOST. Main's known-bugs still lists KB1942c only up to part 24.
- **Action:** restore as is, in order. Only `6f00b0208` (README docs) touched usdz since.

### environment and react (KB-ENVDECODERS2, GAP-REACT-SCENEPLUGINS)

- **Lost commits:**
  - `5067bd189` fix(environment): loadEnvironmentImage loads only the decoder its file needs (KB-ENVDECODERS2)
  - `a6e0fe9f8` fix(environment): a test imports the /main and /loaders entries
  - `bd916175a` fix(react): the bindings that read no environment file no longer bundle the image decoders (PARTLY)
  - `87262bfb5` fix(react): `<Environment src>` loads only the decoder its file needs
  - `286e420cc` fix(react): tests mock every environment entry (PARTLY)
  - `21c5840eb` fix(react): bindings other than models attach to the enclosing Scene (PARTLY)
  - `ff102c60e` fix(react): environment, post, shadows, sprite and figure bindings attach to the enclosing Scene
    (GAP-REACT-SCENEPLUGINS)
  - `721728e1d` fix(react): a Model inside a named Scene builds in that scene (PARTLY)
  - `d9cb43729` fix(react): subpaths build check ignores the plugin timings report (PARTLY)
  - `fa9dd5ee7` chore(react): size ceiling
- **Deleted, still missing:**
  - `packages/environment/src/{parse-image,signature}.ts`
  - `tests/{entries,lazy-decoders}.test.js`
  - the `/load` and `/loaders` entries: `packages/{game,kit-react,kit-viz,kit-web,margoengine}/src/environment/{load,loaders}.ts`
    and `api/environment.{load,loaders}.api.md`
  - `packages/react/src/{scene-owner,scene-shadows}.ts`
- **Modified, still reverted:**
  - `packages/environment/src/{load,loaders}.ts`, `scripts/build.js`
  - about 25 react sources: `environment.tsx`, `environment-asset.ts`, `composer.tsx`, `views.tsx`, `ui.tsx`,
    `post-targets.tsx`, `sky.tsx` and others
  - about 15 react tests (`extras`, `lightformer`, `post`, `scene-loaders`, `cube-camera`, `kit-helpers`)
- **Status:**
  - The `/main` entry was REDONE by `43b1e1355` (KB-REACT-ENVDECODERS1, lights/fog/cube camera).
  - The borrowed-object part of `8cde748ff` and `f6f22a497` is BACK through `4e1f611ed`.
  - The decoder-per-file loading (KB-ENVDECODERS2), `/load`, `/loaders` and the scene-owner work are still LOST.
- **Action:** restore and reconcile with `43b1e1355`. Its `/main` design must stay, and `/load`/`/loaders` rejoin it.
  **Scott decides** whether to re-add the two entries (public API) or fold them into `/main`.

### lines, text, shared (frame uniform), lines flow

- **Lost commits:**
  - `263bbf80a` feat(lines): add seekable flow paths (463 lines)
  - `fca349770` fix(rendering): share frame uniform setup for lines and vector text
- **Deleted, still missing:**
  - `packages/lines/src/flow.ts`, `tests/flow.test.js`
  - the kit shims `packages/{kit-viz,margoengine}/src/lines/flow.ts`
  - `api/lines.flow.api.md`
  - `packages/shared/frame-uniform.{js,d.ts}`
- **Modified, still reverted:**
  - lines: `README.md`, `package.json`, `scripts/build.js`, `src/batch.ts`, `tests/batch.test.js`,
    `tests/features-browser.js`, `tests/owner-lifetime.fixture.js`
  - `packages/text/src/vector.ts`
- **Status:** LOST. `61f3dcf3f` (lines colorMode) landed since.
- **Action:** restore and reconcile `package.json` and the README.

### procedural, sky (fir sprays, coral, live scene depth)

- **Lost commits:**
  - `313392e37` fix(sky): use live scene depth and share fir foliage geometry
  - `3e1317193` docs(sky): show automatic scene depth for clouds and fog
  - `eba999ff0` test(sky): exercise default fog depth on a captured frame
  - `e601576b2` test(sky): use native sample indices for the reference fog rig
  - coral, from `028a6ecc6`
- **Deleted, still missing:**
  - `packages/procedural/src/{fir-sprays,coral}.ts`, `test/{fir-sprays,coral}.test.js`
  - the kit shims `packages/{game,margoengine}/src/procedural/{fir-sprays,coral}.ts`
  - `api/procedural.{fir-sprays,coral}.api.md`
- **Modified, still reverted:**
  - `packages/sky/src/{base,depth,fog,volumetric-clouds}.ts`, `README.md`, several sky checks
  - `packages/procedural/src/foliage.ts` (rocks, from `7b77cb53f`), `src/index.ts`, `README.md`, `package.json`,
    `test/surface.test.js`
- **Status:** LOST. There are 5 post-sync sky commits (overcast deck, KB-SKY-OVERCAST2).
- **Action:** restore and reconcile.

### clustered (bounce)

- **Lost commits:**
  - `3017a4ee6` fix(clustered): the bounce's receiver plane holds only where the texel holds the receiver's own
    surface (KB-BOUNCE-SHADOWSNOW1) (PARTLY)
  - `40df5bc56` fix(clustered): the bounce asks the texel beside for a wall standing on the joined surface
  - `9e4b9a1ad` docs
- **Deleted, still missing:** `packages/clustered/test/contact-borrowed-restore-browser.mjs`.
- **Modified, still reverted:** `src/bounce-math.ts` (192 lines), `src/contact.ts`, `test/bounce.test.js` (partly),
  `README.md`, `package.json`, `scripts/cabin-hearth-browser-test.mjs` (partly).
- **Status:**
  - `cae80d0a9` (KB-BOUNCE-REVEAL1) was REDONE by `d2745f850`.
  - ContactLights borrowed depth was REDONE by `4d033fdcb` (`setDepth`).
  - The KB-BOUNCE-SHADOWSNOW1 fix is LOST; main's known-bugs shows it **open** again.
- **Action:** restore `3017a4ee6` and `40df5bc56`, reconciled with `d2745f850` and `ec85cab3c`. Leave out the
  `8cde748ff` clustered part; it was redone.

### scatter, post (dune grass GTAO)

- **Lost commit:** `db158554e` fix(scatter): covered grass writes its coverage depth, so GTAO darkens the dune coast's
  grass again.
- **Modified, still reverted:** `packages/scatter/src/{cover,grass,index}.ts`, `test/grass.test.js`, `README.md`,
  `packages/post/README.md`.
- **Status:** LOST. KB-SCENES-DUNE-GTAO1 is **open** again on main.
- **Action:** restore as is.

### blender

- **Lost commit:** `b30c0c422` fix(blender): the TANH math node takes a bounded argument (KB-BLENDER-TANH1).
- **Modified, still reverted:** `src/nodes-wgsl.ts`, `tests/nodes.test.js`, `tests/nodes-browser.mjs`.
- **Status:** LOST.
- **Action:** restore as is.

### points (KB2481)

- **Lost commits:**
  - `aa53c692e` fix(points): surfels at 4x resolve by a masked draw per sample at the full level too
  - `7afd40e76` docs
- **Deleted, still missing:** `docs/upstream-reports/KB2481/msaa-additive-repeat.html`.
- **Modified, still reverted:** `src/surfels.ts`, `tests/{surfels,compat-level}.test.js`, `tests/features-browser.js`,
  `README.md`, `docs/upstream-reports/KB2481/report.md`.
- **Status:** LOST.
- **Action:** restore and reconcile with the 5 post-sync points commits (E57 and adaptiveSize).

### toon

- **Lost commit:** `abe38d562` fix(toon): apply hatching after light and shadow composition.
- **Modified, still reverted:** `src/hatch.ts`, `test/hatch*.{js,mjs,test.js}`, `README.md`,
  `docs/shader-contracts.md`.
- **Status:** LOST.
- **Action:** restore as is.
- **Note:** `e3badb692` (GAP-OUTLINES-INSTANCED) was REDONE by `a90cad7f2` (toon) and `b4d7c1442` (react). Leave it out.

### tonemap

- **Lost commits:** `8f3e996da` fix(tonemap): autoExposure.mask follows the borrowed GPU object rule, and
  `c3d4c3687` (its records).
- **Deleted, still missing:** `packages/tonemap/tests/borrowed-restore-browser.mjs`.
- **Status:** REDONE by `d0cc35ea5` (`setAutoExposureMask`, a different API).
- **Action:** leave out the source. Re-add the GPU restore test only if `d0cc35ea5` has no browser case.

### gltf

- **Lost commits:**
  - `4d4c0b094` fix(gltf): a loaded model's root and nodes are the public Mesh too, so parenting needs no cast
  - `b6b85638b` fix(gltf): loadAuto without a GPU device names the light loader's reason
  - `fb956a495` (its records)
- **Status:** REDONE by `7f52e41c4` (KB-GLTF-MESHTYPE1) and `273d6aabd` (KB-GLTFA B17).
- **Action:** leave out. Restore only the `examples/kitty-hawk/main.ts` and `tests/public-engine-types.test.js` lines
  if main still casts.

### materials

- **Lost commit:** `cd727fe31` fix(materials): the sheen albedo test holds its closed-form reference in the repo, not in
  git history (KB-SHEEN-HISTORY1/2).
- **Modified, still reverted:** `packages/materials/test/sheen-albedo-fit.test.js` (37 lines).
- **Status:** LOST. `f6f22a497` is BACK through `4e1f611ed`.
- **Action:** restore as is. The test otherwise reads git history, which a shallow or fresh clone lacks.

### machinery, netcode, voxel-net, sciviz, geometry, inspector, creative, horses, armies, bvh, navmesh, mesh-edit, voxel-edit, voxel-pathtracer

- **Status:** BACK, through `6309b5744`, `15547fd1b` and the owner-fixture restores. All the owner/lifetime fixtures
  are present again, including `voxel-pathtracer`.
- **Residue:**
  - `1a585ae1c` fix(machinery): reserve a binding for scene sections is PARTLY back (8 of 32 lines missing).
  - `packages/inspector/test/dispose-scene.test.js` and `packages/netcode/tests/connection-listeners.test.js` are
    back.
- **Action:** check `1a585ae1c` against `packages/machinery/src` and restore the missing lines.

### scene, compute (owner fixtures)

- **Lost commits:** `636af412b` test(scene) and `001fa4684` test(compute) owner/lifetime fixtures.
- **Deleted, still missing:** `packages/scene/tests/owner-lifetime.fixture.js` and
  `packages/compute/tests/owner-lifetime.fixture.js`.
- **Status:** LOST.
- **Action:** restore as is. `check:owners` reports these packages as pending without them.

### webgl2-compat

- **Status:** BACK: `0e11055b5` and `a65c16551`, through `508b6c1cc`, `f970d0250` and `7144a4fc0`.
- **Still lost:**
  - `fb45900a9` fix(webgl2-compat): a `--only` pixel run stamps its own rows
  - `5ff5dc647` fix(webgl2-compat): a `--only` budget run stamps its own rows' frame numbers
  - `1369f93ff` fix(webgl2-compat): a full budget run records its own Frames last recorded line
    (KB-COMPAT-PIXELSTAMP1, KB-COMPAT-BUDGETSTAMP1, KB-COMPAT-FRAMELINE1)
  - the docs commits `f68d09090` and `af7da2066` (PARTLY)
- **Files:** `scripts/visual-compat.mjs`, `scripts/visual-compat-budget.mjs`, `scripts/support/visual-compat-doc.js`,
  `tests/visual-compat-status.test.js` (66 lines), `docs/webgl2-compat-demos.md` (144 lines).
- **Action:** restore as is.

### examples

- **Lost commits:**
  - `7c0fbec11` feat(examples): HUD and item preview demo for separate scenes (M8)
  - `f68d09090` docs
  - `e66d9f84b` fix(examples): the example type check names the missing build
  - `9fd3d2443` (probes-decals lint; nothing left to apply)
- **Deleted, still missing:** `examples/hud-preview.{html,ts}`.
- **Modified, still reverted:**
  - the M8 wiring: `scripts/test-views-browser.mjs`, `scripts/support/{site-routes,visual-demos,affected-gpu}.mjs`,
    `docs/multi-view-roadmap.md`, `examples/README.md`
  - `scripts/check-example-types.mjs`, `tests/check-example-types.test.js`
- **Status:** LOST.
- **Action:** restore as is.

### Root scripts and tests (tooling fixes)

All of these are LOST. Restore them as is.

- `c9235ea1b` fix(scripts): package Vite test servers turn HMR off. It touches about 45 package `scripts/test-*.js` and
  `*-browser.mjs` files. The test `tests/vite-test-servers-no-hmr.test.js` is deleted.
- `cf84d58fa` fix(scripts): waitForPipelines no longer fails a calm page after one long frame (KB-GPUREADY-CALM), and
  `177f940dc` (simulate the deadline with a clock). Files: `scripts/support/gpu-ready.js`,
  `scripts/support/compat-shim.js`. The test `tests/gpu-ready.test.js` is deleted.
- `779823aa7` fix(scripts): sort the compaction entries so the size build is the same on every file system
  (`scripts/compact-package.js`, `tests/compact-package.test.js`).
- `da275e0c0` fix(readme-run): an example's deadline no longer counts its browser's OS teardown (KB1703)
  (`scripts/run-readme-examples.mjs` and its test).
- `5ff16b2b2` fix(hygiene): a catalog entry missing an export its api report declares fails the fast gate
  (KB-HYGIENE-CATALOGSTALE1) (`scripts/support/package-records.mjs` and its test).
- `978939383` fix(tools): match the import map generator to its formatted output (`scripts/umbrella.mjs`, 50 lines).
- `ca0c4c03e` fix(tests): the upstream-reports README check accepts hyphenated report ids (KB-UPSTREAM-IDS1).
- `8a443f7ea` fix(tests): the nature AO probe finds the instance shader's fragment entry (KB-TESTS-NATUREPROBE1).
- `a93bd4309` chore(create-margo): set the approved web starter size ceiling (`tests/create-margo.test.js`).
- `1037ae59a`, `23405a5cb`, and `4e981fbea` (the `.gitattributes`/`biome.json` line endings for generated API entries).

### Documentation (restore together with each feature)

- `docs/known-bugs.md`: 634 of 742 lost lines are still missing.
  - 24 KB/GAP ids are absent from main: GAP-REACT-SCENEPLUGINS, KB-BLENDER-TANH1, KB-ENVDECODERS2,
    KB-WATER-SURGEVOL1, KB-WATER-FLOODFILM-COMPAT1, KB-WATER-REFRACTDEPTH1, KB-SCENES-DUNE-ARCHANG1, KB-GPUREADY-CALM,
    KB-UPSTREAM-IDS1, KB-SHEEN-HISTORY1/2, KB-COMPAT-*STAMP1/FRAMELINE1, KB-HYGIENE-CATALOGSTALE1,
    KB-EXAMPLES-NOTBUILT1, KB-ENV-ENTRYTEST1, KB-REACT-ENVMOCK1, KB-REACT-PLUGINTIMINGS1, KB-TESTS-NATUREPROBE1,
    KB-CABIN-WINDOWGLOW1, KB-CREATIVE-POSTVIEW1, KB-AREA-NAME1, KB1042f.
  - KB-BOUNCE-SHADOWSNOW1 and KB-SCENES-DUNE-GTAO1 read as open again.
  - `ca9b666b6`, `6aca95f3a` and `9b4a5244b` (the log of bugs fixed on 2026-11-20 and 21) are lost.
- `docs/architecture/operational-playbook.md` (288 lines, from 35 commits), `docs/limits.md` (180),
  `docs/whitepaper/claims.md` (103), `docs/clean-room.md` (65, the citations for the water and lines work),
  `docs/guides/imports.md`, `docs/upstream-reports/README.md`.
- Action: restore each part with its feature. Keep the post-sync entries (for example `41b9e9dc6` and `d640a7242`
  already re-closed rebase-reopened rows).

### Generated files (evidence only; regenerate, do not hand-restore)

- 97 still reverted: `api/*.api.md`, `site/llms*.txt`, `docs/api-surface.md`, `scripts/quality/baselines/sizes.json`,
  `examples/package-benchmarks/results/*`, and the proof baselines. Plus the 11 deleted `api/*.api.md` for
  `animator.ccd`, `biomes.treeline`, `environment.load`, `environment.loaders`, `lines.flow`, `procedural.coral`,
  `procedural.fir-sprays`, `rigging.contact`, `rigging.joint-limits`, `rigging.swim` and `terrain.relief-lighting`.
- Action: run `npm run api:update`, `build-llms` and `measure:size` after the source restores.
- **API lock:** the sync removed these exports from locked or watched reports without `api/breaks.json` lines.
  Re-adding them restores the pre-sync API.

### Formatting (style)

- 94 `style(<pkg>): biome format, whitespace only` commits (`4344bb1e9` through `e3b40d430`, 2026-11-21/22) are fully
  lost, and 7 more partly; about 2,180 files are back to the old formatting.
- Action: do not cherry-pick them. Once the code restores land, run the repo formatter in one `style:` commit.
- **Scott decides** whether that large diff is wanted now.

### physics (physics: Scott's Mac decides)

- `c9235ea1b` changed `packages/physics/scripts/test-browser.js` and `test-replay.js` (HMR off). The second is PARTLY
  back.
- `68a486872` style(physics) and `cf01b8a8e` style(physics2d) are partly lost.
- No physics source logic was lost in ff88a70e7. Rapier glue was removed on purpose on 2026-11-24 (`bff101818`,
  `6f436d2e9`). Do not restore anything that brings Rapier back into a 3D package.

---

## B. e2177dc6e (2026-11-20): public work it removed

### What it was

`e2177dc6e` replaced public main `44e0cc029` (2026-11-14) with the private engine at `3b68fe7569`. That tree held the
public work up to 2026-11-14 and also restructured the repository.

- Renames:
  - `gltf-pro` to `gltf`
  - `scenery` to `sky`
  - `staging` to `studio`
  - `net` to `netcode`
  - `transitions` GLSL to `shader/glsl`
  - the kits `react-kit`/`viz`/`web` to `kit-react`/`kit-viz`/`kit-web`
- Removals: the GPU lock tooling (Scott 2026-11-16: "I want it gone") and the Night Citadel and Tokyo demos.

Of the 600 public commits checked, 492 survived (80% or more of their lines are in `e2177dc6e`) and 28 had nothing to
check. 83 have some lines missing, and each of those was read:

- Missing lines in source files are later private rewrites, not reverts:
  - `packages/text/src/font-outlines.ts` went from 1,080 to 192 lines; its parsing now lives in
    `@margoengine/loaders/font`.
  - `packages/sciviz/src/media-tiles.ts` replaced the `MIN_TILE_TARGET` fix with 1024 px render blocks (a superset).
  - `packages/environment/src/volumetric.ts` and `packages/usdz/src/stage.ts` grew by about 500 and 1,100 lines.
  - The gltf parts browser test is back, grown, at `packages/gltf/scripts/test-parts-browser.mjs`.
  - The `transitions` aggregate-equality fix `308b981ae` is in `packages/shader/src/glsl/emit.ts`.
  - The basic-scene-network sort `6f255f890` is in `scripts/basic-scene-network.mjs`.
- What remains missing is records only: entry-sizes and basic-scene-network results, proof baselines, `llms` files,
  `docs/api-surface.md` and a few known-bugs lines (KB-A3c, KB-A3d, KB3574, batch 160, sciviz bricks).
  - Of these, `a23db23b9` (KB-A3c, a mirror-floor ruling) and `b31c13b68` (KB-A3d, savePrefilteredEnvironment mixed
    state) are open-bug entries. They should be checked against main's known-bugs and re-added if those bugs are
    still open.
- The examples `e4cac5a31`/`4e38cdc1b` (Event Horizon) were superseded: they now live in `examples/event-horizon/`.
  The Calibre chronometer page was already turned into a test page in public by `131878311` before the sync.

### Deleted files (206, none restored, all deliberate)

| Group | Files | Evidence |
|---|---|---|
| Shims for merged and renamed kits and umbrellas (`packages/{game,react-kit,viz,web,margoengine}/src/{gltf-pro,scenery,staging,net,...}`) | 141 | The packages were renamed in the same commit (1,814 renames); the features live on in `kit-*`, `gltf`, `sky`, `studio`, `netcode` (for example `sky/src/milky-way.ts`, `netcode/src/interpolation-{delay,timeline,fields}.ts`). |
| GPU lock and queue tooling, and its tests (`scripts/gpu-*.mjs`, `scripts/support/gpu-*`, `tests/gpu-*.test.js`, `tests/basic-scene-network-lock.test.js`) | 39 | Scott 2026-11-16 removed the GPU lock ("I want it gone"; AGENTS.md "no GPU lock is used, ever"). |
| Package files of the merged packages (`gltf-pro`, `scenery`, `staging`, `net`, `transitions`), including `api/scenery*.api.md` | 20 | Same restructure. `gltf-pro/tests/sheen.test.js` is now `packages/gltf/test/sheen.test.js`. |
| Examples (`event-horizon.*`, `orrery/ephemeris.ts`, gltf-pro lighting proof baselines) | 5 | Moved to `examples/event-horizon/` and `packages/sky`. |
| `packages/rigging/tests/mtoon-browser.mjs` | 1 | Split into `packages/rigging/tests/mtoon-*.browser.mjs`. |

### physics in e2177dc6e (physics: Scott's Mac decides)

- `8cdc1d8d6` fix(physics): ship Rapier's Wasm as its own file, and `9e797e6df` fix(physics2d): ship Rapier 2D's Wasm as
  its own file. Some of their lines are not in `e2177dc6e` or main.
- Rapier has since left every 3D package (`bff101818`) and Physics2D (`6f436d2e9`), so these are most likely superseded.

**e2177dc6e action:** nothing to restore in source. Optionally re-add the KB-A3c and KB-A3d known-bugs entries if those
bugs are still open, and regenerate the records.

---

## Summary table

| package | lost items | still missing | recommended action |
|---|---|---|---|
| rigging, animator | 2 feat and 4 fix commits; 12 src/test files deleted, 8 modified | all | restore as is, in order; reconcile `package.json`/README with `a79903fb9` |
| horses | 5 fix commits; 3 files deleted, 7 modified | all (dispose part back) | restore as is |
| water | 1 feat, 12 fix, 10 test/docs commits; 4 files deleted, 25 modified | all | restore and reconcile with the post-sync flood work; NaN fix first |
| terrain | 1 feat, 2 fix, 4 test commits; 8 files deleted, 14 modified | all | restore and reconcile with `4ca2133e0`, `dcde53594`, `e406829a7` |
| biomes | 1 feat, 3 fix, 2 docs/test commits; 4 files deleted, 15 modified | all | restore and reconcile with 11 post-sync biomes commits |
| usdz | 6 fix commits (KB1942c parts 25 to 30); 12 tests/fixtures deleted | all | restore as is |
| environment, react | 8 fix commits; 21 files deleted, about 40 modified | `/main` redone; `/load`, `/loaders`, decoder-per-file, scene-owner lost | restore and reconcile with `43b1e1355`; **Scott decides on the entries** |
| lines, text, shared | 1 feat, 1 fix; 7 files deleted, 9 modified | all | restore and reconcile with `61f3dcf3f` |
| procedural, sky | 1 fix plus coral; 8 files deleted, 15 modified | all | restore and reconcile with the post-sync sky commits |
| clustered | 2 fix (KB-BOUNCE-SHADOWSNOW1), 2 redone; 1 test deleted | SHADOWSNOW lost; REVEAL and ContactLights redone | restore `3017a4ee6`, `40df5bc56`; leave out the redone parts |
| scatter, post | 1 fix (KB-SCENES-DUNE-GTAO1) | all | restore as is |
| blender | 1 fix (KB-BLENDER-TANH1) | all | restore as is |
| points | 1 fix (KB2481) plus docs; 1 upstream page deleted | all | restore and reconcile with E57 work |
| toon | 1 fix (hatching); outlines redone | hatching lost | restore `abe38d562`; leave out `e3badb692` |
| tonemap | 1 fix; 1 GPU test deleted | redone by `d0cc35ea5` | leave out; re-add a restore test if missing |
| gltf | 2 fix | redone by `7f52e41c4`, `273d6aabd` | leave out |
| materials | 1 fix (sheen test) | lost | restore as is |
| machinery | 1 fix | partly (8 lines) | restore the missing lines |
| netcode, voxel-net, sciviz, geometry, inspector, creative, armies, bvh, navmesh, mesh-edit, voxel-edit, voxel-pathtracer | dispose/listener fixes, owner fixtures | none | done (`6309b5744` and others) |
| scene, compute | 2 owner fixtures | all | restore as is |
| webgl2-compat | 2 fix restored; 3 fix plus docs (run stamps) lost | stamp fixes lost | restore as is |
| examples | 1 feat (hud-preview M8), 1 fix | all | restore as is |
| root scripts/tests | 10 tooling fixes (HMR off, calm-page gpu-ready, compaction sort, readme-run, hygiene, umbrella and others); 2 tests deleted | all | restore as is |
| docs (known-bugs, playbook, limits, claims, clean-room) | about 1,300 lines, 24 KB ids | mostly | restore with each feature |
| generated (api, llms, sizes, proofs) | 97 modified, 11 api reports deleted | all | regenerate after the restores |
| formatting | 94 style commits, about 2,180 files | all | one formatter run; **Scott decides when** |
| physics, physics2d | script HMR line, style; Rapier Wasm commits (e2177dc6e) | partly | **physics: Scott's Mac decides** |
| e2177dc6e (all packages) | 206 deletions, 83 commits with stray lines | records and 2 open-bug entries only | nothing in source; check KB-A3c and KB-A3d, regenerate the records |
