# Overall package opinion

Date: 2026-10-16. This is a reading review of the packages in this checkout. The suite was not re-run for this note. Package counts were refreshed to 63 after the optional materials package landed; the review and recommendations remain a historical assessment.

The engine is a small kernel with a wide, carefully labeled shelf around it. The kernel is the part that is genuinely distinctive. The shelf is real code, and a lot of it is honest about its limits, but the catalog is now broader than the product.

## The part that is sharp

`packages/kernel` is about 270 lines of Rust. It owns transforms, hierarchy, and culling, with no allocator and no wasm-bindgen. `@margoengine/core` plus the `margoengine` stage facade are the TypeScript and GPU shell around that, held under a 20,000-byte gzip ceiling. That split is the right architecture: Rust publishes matrices, TypeScript talks to the browser, and optional packages attach through plugins and passes. Core stays frozen. Almost every other package peers on core and can be left out of a page.

The packages that match that idea are the ones with a narrow job and a hard edge:

- **Industrial and motion:** `machinery`, `kinematics-constraints`, `blender`, `ifc`. Constraints is the cleanest of these. It has no engine dependency, about 970 lines of solver against about 1,500 lines of tests, and the README refuses swept collision, safety certification, and velocity guarantees.
- **Rendering extensions:** `gltf-pro`, `animation`, `post`, `shadows`, `clustered`, `splats`, `terrain`, `taa`, `environment`, `water`, `sky`, `scenery`. These are frame-graph features with explicit capacity and format limits.
- **Interchange that does work:** `loaders`, `exporters`, `decoders`, `geometry`, `bvh`, `points`, `text`, `lines`, `controls`, `physics`. Several of these are 1,000–2,000 lines, with tests at roughly half the source size.

`vfx` is a good example of the house style. A million particles, fixed buffers, no per-particle JavaScript objects, and a direct statement that it does not replace the smaller particles in `creative`.

## The part that is wide

There are 63 public packages and about 29,000 lines of package source, plus shared GPU helpers that are not a package. The October module sweep filled the shelf: `ecs`, `fsm`, `input`, `tween`, `splines`, `net`, `wfc`, `road`, `cinematic`, `navmesh`, `navigation`, `stats`, `inspector`, `selection`, `html`, `video`, and others. Those are bounded and tested. `ecs` is a fixed-capacity sparse set. `navigation` is a thin Recast wrapper. `fsm` is a small hierarchical state machine. They are correct kernels of those features.

Taken together they read like a full game engine. A new user cannot tell `machinery` from `road`, or `kinematics-constraints` from `tween`, by the package list alone. A few entries are facades: `gizmo` re-exports `controls`, `usdz-export` re-exports `exporters`, and `toon` is a thin layer over `creative`.

Several jobs are also split across packages that a caller has to reconcile:

| Job | Packages |
| --- | --- |
| Sky | `scenery` (moonlit SkyMoon) and `sky` (Preetham / Bruneton) |
| Particles | `creative` and `vfx` |
| Post | `post`, `dof`, `tonemap`, `taa`, plus passes inside `creative` |
| Paths | `navmesh` (A* and ORCA) and `navigation` (Recast) |
| USD | `usdz`, `loaders`, `exporters`, `usdz-export` |
| IK | `animator` foot IK, `machinery` bounded IK, and `kinematics-constraints` |
| Screen anchors | `labels` and `html` |

`fbx` now uses a native parser and the existing Margo glTF exporter. USDZ vendors standalone Three.js-derived parsers; its package build needs no Three.js installation or renderer.

## How it feels overall

The engineering habit is strong. READMEs state units, capacity, and what is not guaranteed. Peer dependencies stay on core. `sideEffects: false` is consistent. The size gate is still doing its job. A package in this repo is more likely to mean what it says than a typical engine module of the same length.

The product risk is the shelf. Maintenance, docs, and the public story now scale with 63 names. The thing worth protecting is the kernel, the stage, and the few packs that make Margo different: small WebGPU runtime, CAD and machinery, and constraint-aware motion. The rest is a well-built optional library, and it should stay optional in the way people are told to approach it.

Line counts are authored `.ts`, `.tsx`, `.js`, `.wgsl`, and `.rs` under each package, excluding `dist` and `vendor`. Tests that live outside a package directory are not included in those ratios.

## What I would do differently

This is aimed at a Show HN of the engine. I would leave the solvers, skies, particle systems, and pathfinders split. Folding them together would hide the limits each README already states. I would leave core and the stage facade frozen. The week before the post is about the first click, not a new package.

**Make the first click true.** The catalog marks the packages unpublished. The README still opens with `npm install @margoengine/core@0.1.0`, `@margoengine/react@0.1.0`, `gltf`, `machinery`, and `creative`. Someone from the thread will run that and get a 404, and that comment will outrank the architecture. I would publish the stage, `core`, and `react` before the post, or I would delete those install blocks and lead with clone, `npm ci`, and `npm run modern:dev`. The live site at [margoengine.com](https://margoengine.com) should be the first link in the post. The post itself can be three sentences: a WebGPU engine with a WebGL2 fallback, core and stage held under 20 KB gzip, and optional packs that stay out of that download.

**Open the README on the kernel, and put the catalog below.** Sixty-three package names on the first screen will be read as a Three.js checklist. The interesting claim is the size, the Rust kernel, and the industrial packs. I would keep the full catalog linked. I would not make a stranger scroll through `wfc`, `road`, and `tween` before they see a canvas.

**Say what the engine is for, in the post.** A small embeddable stage, CAD and machinery, and constraint-aware motion. The thread will ask why this exists next to Three.js. The answer is the 20 KB core and the packs that do not enter it. A feature-count answer loses.

**Say where Three.js still appears.** `@margoengine/fbx` no longer parses with `FBXLoader` or writes with `GLTFExporter`. The package depends on `@margoengine/exporters` and `@margoengine/gltf-pro`. Root `devDependencies` no longer include `three` or `@types/three`. Benchmarks and visual parity checks download a pinned 0.186.1 reference through `scripts/three-reference.js`; USDZ vendors standalone parsers with attribution. The README should say that in one sentence, so a reader who searches the lockfile does not think the runtime is Three.js. Native demos stay on `gltf` and `gltf-pro`.

**Call it 0.1.0.** Core and the stage package are `0.1.0`. The size freeze is the v1 discipline, and it is not a 1.0 release. `dof` and `tonemap` are already `1.0.0`, which looks like a different product. I would not claim 1.0 in the title.

The native FBX importer is in, and the code-grade fixture gate is closed. A CC0 Blender file has headless bind and clip checks plus a required browser playback and seek check. `docs/code-to-nine.md` records 53 FBX tests and a 939-test Node 24 run. I would not spend the launch week on another package or on cubic FBX curves. A working quickstart, a demo that renders, and a README that matches npm are still the changes a reader can check.

The rest can wait until after the post.

**Tier the catalog.** `docs/README.md` and the searchable catalog treat all 63 packages as one list. I would mark a short product set and leave everything else as a library module. The product set is the stage, `core`, `react`, `gltf`, `gltf-pro`, `machinery`, `kinematics-constraints`, `blender`, and the rendering packs the current demos actually load. `ecs`, `fsm`, `tween`, `road`, `wfc`, and the other October modules stay installable and searchable, with a library label so a new reader can tell a CAD kernel from a spline helper.

**Put the overlap table in the catalog as a choice, one short paragraph each.**

| Choice | I would tell the caller |
| --- | --- |
| Sky | `scenery` for the moonlit SkyMoon plugin. `sky` for a Preetham or Bruneton daytime model. |
| Particles | `creative` for the existing textured and weather effects. `vfx` for the fixed-capacity million-particle billboards. |
| Post | `post`, `dof`, `tonemap`, and `taa` for a single pass. `creative` when the page already uses that pack's combined stack. |
| Paths | `navmesh` for the pure A* and ORCA helper. `navigation` for Recast and Detour. |
| USD | `usdz` and `loaders` to read. `exporters` to write. `usdz-export` is the same writer under a second name. |
| IK | `machinery` for assembly joints. `animator` for foot IK on a playing clip. `kinematics-constraints` for a standalone two-bone clearance solve. |
| Screen anchors | `labels` for projected markers. `html` when those markers also need scene-depth occlusion. |

**Stop adding package names.** `gizmo` and `usdz-export` are aliases and should be labeled that way. `toon` can keep its name: it adds the inverted-hull outline on top of `creative`'s toon shading. New particles, sky, and post work go to `vfx`, `sky` or `scenery`, and the single-pass post packages. `creative` stays in place for the pages that already use it.

**Keep package tests next to the package.** Core, machinery, glTF, animation, and several rendering packs keep their checks in the repo-level `tests/` and `scripts/` runners. I would move each package's own checks beside that package so `npm test --workspace` is the contract. The shared browser sweeps can keep calling those workspace tests.

**Build the next skinning demo from packages that already exist.** Skeletal playback stays in `animation`, clip state and foot IK stay in `animator`, and interactive two-bone clearance stays in `kinematics-constraints`. That demo needs a rig, a draggable target, and a browser check. It needs another package name only if one of those three refuses the job.

## From a 7 to a 9

**7** as an engine. **5** as something a Hacker News reader can install today.

The 7 is the kernel, the 20 KB ceiling, and the packs that stay narrow and say what they refuse to guarantee. `kinematics-constraints`, `machinery`, and the frame-graph extensions are real work. The README habit of stating units and limits is better than most engines of this size.

The 5 is the public surface. The catalog marks the packages unpublished while the README opens with `npm install`. The first screen lists 63 packages, so the project reads as a finished platform. Core is `0.1.0`. A reader who stays on the site and the demos will see the 7. A reader who runs the install command will see the 5.

A 9 is the same engine with a smaller public claim that a stranger can install and check. More packages would push the score down.

### 7 to 8: the page matches the repo

Publish `margoengine`, `@margoengine/core`, and `@margoengine/react`, then make the top of the README the command that installs them. Until that publish exists, take the `npm install @margoengine/core@0.1.0` blocks out. The catalog currently says unpublished while the README tells people to install.

Put three things above the catalog: the live demo, the five-line `createStage` example, and one gzip number from `npm run measure:size`. The verified run on 2026-10-16 reported **19,999 bytes gzip**, limit 20,000, raw 47,983. Use that figure for the current release. Earlier benchmark reports cite 19,874 bytes, and sandbox notes describe an older 20,480-byte gate; those historical figures belong to their recorded builds. One command, one number, one commit.

Call the release 0.1.0. Say in one sentence that FBX import is native, USDZ vendors standalone parsers, and Three.js rendering remains a pinned benchmark and visual parity reference in `scripts/three-reference.js`.

### 8 to 9: the claim survives outside this repo

Add a CI job that starts from an empty directory, installs the published packages, renders the orb, loads one glTF, and disposes. The monorepo tests do not prove that. This one does.

Pick one demo as the front door and link only that in the post. The night citadel, the machinery conveyor, or the constraints arm. That demo has to be the thing the first paragraph claims: a small WebGPU stage, CAD and machinery, or constraint-aware motion.

Name about six packages as the product: stage, `core`, `react`, `gltf`, `gltf-pro`, and `machinery`. Leave the other fifty-seven in the catalog as a library, with the choice notes for the two skies, the two particle systems, and the three IK paths.

That is the whole gap. The kernel is already good enough for a 9. The 7 is the unpublished install and a front page that claims 63 products. Keep the verified release size distinct from historical benchmark measurements.
