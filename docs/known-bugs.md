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
