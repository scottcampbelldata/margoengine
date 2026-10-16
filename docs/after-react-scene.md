# After the React scene layer

Date: 2026-10-16. Implemented. Core and the stage facade remain unchanged at **19,999 bytes gzip**.

Steps 1 through 3 are in the tree. `<MeshTransmissionMaterial>` and `<Animation>` export from `@margoengine/react`. Deformed picking is recorded in `docs/three-parity-next.md`. The quaternion table is `tests/modern-quaternion.test.js`. `direct_light` and the `@group` / `@binding` reject are in `packages/gltf-pro`.

Step 4 was tested in isolation and rejected: `opt-level = "z"` reduced the measured bundle from 19,999 to 19,376 bytes gzip, but ticks were 2.19–3.36 times slower than a fresh `opt-level = 3` build across eight scenarios. Both variants passed the four Rust tests and matched the shipping kernel's memory and flags. The shipping kernel and stride layout remain unchanged. `scripts/kernel-opt-experiment.js` reproduces the experiment without rewriting them.

Step 5 uses the allowed documentation alternative: unverified registry install commands were removed from the root and React READMEs. Source builds and local tarballs remain the documented installation path until publication is verified.

Verification of the isolated change set: a clean build with no prior distribution files; 1,225 Node tests with no failures, skips, or TODOs; strict types and packed imports for all 63 packages; 34 fresh tarballs with 120 React 18 tests and a packaged browser lifecycle; Vite, Next.js, React viewer, and showcase production builds. RTX A6000 checks passed for the eight new React cases, 16 existing React cases, 20 exact shader comparisons across 40 captures, deformed picking, and visual parity. Core plus stage remains 19,999 bytes gzip; core, stage, and shipping kernel sources are unchanged.

Clearcoat, transmission, volume, the node graph, KTX2, texture transforms, eight influences, and point and spot shadows are already in the engine. Do not rebuild them. The React layer should call them.

Core plus stage is still **19,999 bytes gzip**. The gate fails at 20,000. None of the steps below edit `@margoengine/core` or the stage facade except step 4, and step 4 runs only if a size experiment frees bytes.

## 1. Clicks on a skinned mesh

`engine.pick` and `@margoengine/bvh` still miss skinned and morphed draws. `@margoengine/selection` excludes them. `<Mesh onClick>` will feel finished, and a click on `<Gltf>` with a skeleton will miss.

Use the deformed vertex buffer `@margoengine/animation` already writes. The pick id has to be the mesh the React handler is attached to. A test loads a skinned glTF, deforms one frame, and asserts `engine.pick` returns that mesh. The React test clicks that mesh and asserts `onClick` runs once. This stays out of core.

## 2. The materials and the clip, as components

Transmission exists in `@margoengine/materials`. Clips exist in `@margoengine/animation`, and crossfades exist in `@margoengine/animator`. A React file should not import those packages to use them.

Add `<MeshTransmissionMaterial>` next to `<PbrMaterial>`. It installs the existing transmission extension. Factor `0` matches `<PbrMaterial>`.

Add `<Animation>` as a child of `<Gltf>`. The props are `clip`, `playing`, and `loop`. `clip` selects the name. Crossfading is a `blend` prop that calls `animator`, not a second component. Unmount removes the plugin.

Same props as everything else: `position`, `rotation`, `scale`, and `onClick`. No new vocabulary.

## 3. The code-review fixes that do not touch the gate

From `docs/hn-code-fixes.md`, do these while the React work settles. They do not change the measured bundle.

- One quaternion table. `Mesh.setRotation` and a kernel tick that clamps the same angles must write the same four lanes. No new core API.
- Name `direct_light` and `hemisphere_ambient` in `packages/gltf-pro/src/shader.ts`. Record the new baseline hash only after the pixels still match.
- Replace `any` in `@margoengine/animation` and `@margoengine/blender` with the interfaces those packages already check.
- Reject `@group` and `@binding` inside extension `declarations` in `gltf-pro`.

Eight influences are already accepted. Skip that step.

Leave `tween`, `road`, and the other small packages alone.

## 4. The kernel rename, only if the size falls

`opt-level = "z"` in `packages/kernel/Cargo.toml` is an experiment. Keep it only when `npm run measure:size` drops and the kernel tests still pass. If the tick gets slower, put `opt-level = 3` back.

Named kernel offsets and `#[inline(always)]` helpers come after that drop, not before. If the gzip number does not move, skip the rename. The stride stays the format.

## 5. The install line

The root README still says to build from source or install local tarballs until the packages are published. A React developer who finishes the scene tutorial will run `npm install` next.

Publish `margoengine`, `@margoengine/core`, and `@margoengine/react`, or remove those install lines. The first paragraph already states the production path and the material limits. Keep that paragraph in the same place as the install command.

## Done when

- A click hits a skinned mesh, in the engine test and in the React test.
- `<MeshTransmissionMaterial>` and `<Animation clip="Walk">` work from `@margoengine/react` without a direct import of `materials` or `animation`.
- The quaternion table, the named shader functions, the glTF interfaces, and the `@group` reject are in, and core plus stage is still under 20,000 bytes gzip.
- `npm install` of the three published packages matches the README, or the README does not tell anyone to run it.
