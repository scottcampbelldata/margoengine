# Known bugs and unverified features

What is known to be wrong or not yet proven, and what it would take to close each item. Design limits (where a
boundary is a decision, with its escape hatch) live in [limits.md](limits.md); this page lists defects and checks that
are still open.

## Blocked on hardware we do not have

These features pass their tests against the published specifications, but the only real check is a device the project
does not own. Each entry says exactly what is needed to close it.

### USDZ export with textures: never opened in Quick Look

- **What:** `exportUSDZ` in `@margoengine/exporters` (`packages/exporters/src/usdz.ts`) writes UsdPreviewSurface
  materials with texture readers (base colour with opacity and `opacityThreshold`, metal-rough on the g and b channels,
  normal, occlusion, emissive, `st`/`st1` texcoords with the V flip, a base-colour `UsdTransform2d`, wrap modes) and
  stores each image 64-byte aligned and uncompressed.
- **Verified:** the USDZ tests (`packages/exporters/tests/usdz.test.js`) check the shader graph text, every file's
  alignment, the image bytes and a round trip through our own USD reader (`@margoengine/usdz`). OpenUSD's own checker
  (`packages/exporters/tests/validate-usdz.py`) has not been run on textured output: it needs the `usd-core` Python package, which is not
  installed on the development machines.
- **Not verified:** that Apple's renderers show the textures as intended. A non-default `normalScale` writes a normal
  scale and bias that OpenUSD's validator may flag as non-standard.
- **Needed to close:**
  1. An iPhone or iPad on iOS 17 or later, or a Mac on macOS 14 or later (Quick Look and AR Quick Look).
  2. Five exported files opened there, each compared with the same scene drawn by Margo: a base-colour texture with an
     alpha mask (`opacityThreshold`), a blended (alpha) texture, a metal-rough map plus a normal map at `normalScale` 1
     and 2, an occlusion plus emissive map, and a base-colour texture transform (offset, rotation and scale) with
     repeat and mirror wrapping.
  3. `pip install usd-core`, then `python packages/exporters/tests/validate-usdz.py <file>` on the same five files.
  4. The result (pass, or the difference seen) recorded here and in `docs/threejs-parity.md` (USDZExporter row).

### WebXR AR hit testing: never run on an AR device

- **What:** `HitTest` in `@margoengine/xr` (`packages/xr/src/hit-test.ts`): hit-test sources from the viewer, an input
  source or transient input, results as reference-space poses, anchors.
- **Verified:** tests against the W3C WebXR Hit Test Module's interfaces with a mocked session
  (`packages/xr/tests/hit-test.test.js`); [limits.md](limits.md) has its row.
- **Needed to close:** an Android phone with ARCore and a Chromium browser that exposes WebXR `immersive-ar` with the
  WebGPU XR binding (`XRGPUBinding`), or an AR headset with the same; then a reticle placed on a real floor and a real
  table (viewer source) and by screen tap (transient source), one placement anchored, and the result recorded here.

## Performance losses still open

Measured but not fixed. Their history, sources and rerun commands are in
[whitepaper/perf-history.md](whitepaper/perf-history.md#open-losses).

- **three.js `InstancedMesh` beats Margo's instanced paths on static boxes.** In the diagnostic comparison
  ([boxes-vs-threejs.md](whitepaper/boxes-vs-threejs.md)), 10k static boxes ran at 645 FPS with three.js WebGL2
  `InstancedMesh` against 212 FPS (`createInstancedMesh`) and 270 FPS (`CulledInstances`). Neither Margo instanced
  path uses core's back-face-culled pipeline. **Needed to close:** route instanced core geometry through the culled
  pipeline, then a quiet-machine run against three.js.
- **Moving `CulledInstances` costs one buffer write per part:** 187 ms CPU per frame for 10,000 moving boxes (same
  diagnostic run). **Needed to close:** one upload per frame for all moved parts, then a re-measure.
- **Galaxy S23 Ultra island demo at 3-5 FPS** (particles off does not help). Partial fixes have landed; no after number
  exists. **Needed to close:** the device, then a measured run.

## Unverified against the specification

### IGES parametric spline surface (entity 114): coefficient order not checked

- **What:** `igesToSTEP` and `parseIGES` in `@margoengine/brep` (`packages/brep/src/iges/step.ts`) refuse entity 114
  with `MargoError` code `unsupported`; a file holding other surfaces converts with the 114 left out and named in
  `warnings`.
- **Why:** the IGES 5.3 specification (US PRO/IPO-100-1996) gives the 114 bicubic patch polynomial only as a formula
  image, which could not be viewed when the reader was written. The order of the 16 coefficients per coordinate
  (48 per patch: x, then y, then z, named A to S) was taken from memory, not the text, so it was not shipped.
- **Needed to close:**
  1. Read the specification's section on entity 114 (section 4.15, "Parametric Spline Surface Entity"; the request
     that opened this item said 4.25, which is the Offset Curve Entity) and its Appendix B.5, and write down the
     formula image: which power of s = u - TU(i) and t = v - TV(j) each of the 16 coefficients multiplies.
  2. Confirm or correct the assumed order 1, s, s^2, s^3, t, s t, s^2 t, s^3 t, t^2, ..., s^3 t^3, and confirm the
     patch order (u patches outer, with the (N + 1)-th placeholder column per row).
  3. Restore the power-to-Bezier conversion of each patch into one B-spline surface (knots at the breakpoints with
     multiplicity 3) and enable the 114 case.
  4. Test against an analytic bicubic with cross terms (for example x = s, y = t, z = s^2 t^3 over two patches each
     way), comparing sampled points and the meshed area with the exact values, and replace the refusal test in
     `packages/brep/tests/iges.test.js`.
