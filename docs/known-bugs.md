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

## Open defects

### 4x MSAA blending is not repeatable on the RTX A6000 under CPU load

- **What:** the voxel GPU check (`packages/voxel/tests/render-browser-check.mjs`, run by `check:merge`) fails now and
  then in a busy run at its "tree and overhang" view, at 4x MSAA: "meshes in another order drew {differing:36, max:1}"
  (mesh arrival order step) and "greedy vs naive differ over an area" (same view, same pixels). Run alone it passes.
- **Repro:** `node scripts/gpu-lock.mjs run --owner=<you> -- node packages/voxel/tests/render-browser-check.mjs
  --repeat=450`: one renderer, the still view drawn 450 times while the other cores spin. 1 to 3 frames in 450 differ
  from the first by 1 in 8 bits (1 ulp on rgba16float) on 13 to 82 pixels, then the next frame is back (Edge and
  Chrome, Dawn D3D12, RTX A6000, driver 32.0.16.1742, 2026-10-26).
- **Cause (measured; below the WebGPU API):** every differing pixel is seen through the glass wall, along glass and
  terrain edges (pixels whose samples hold more than one surface). Between the frames nothing that Margo hands the GPU
  changes: no buffer write but the frame uniform and indirect arguments, bit for bit the same each frame; the glass
  quads in the same order. The frames stay identical at 1x, without the glass, with the glass drawn unblended, with
  blending on but the destination factor zero, with the glass drawn in the opaque pass, without core's mid-frame
  resolve and with Dawn's D3D12 render-pass toggle off; they still differ with `max` blending, which does not depend
  on order. So the GPU's blend unit reads the 4x colour target's destination samples differently from frame to frame
  at partly covered pixels. Mesh arrival order is not involved: 168 permutations of the mesh replies drew the same
  pixels on a quiet machine. Another vendor's GPU was not available to compare (the AMD iGPU offers no WebGPU
  adapter).
- **Needed to close:** the same repro on another GPU (AMD, Intel, another NVIDIA driver) to confirm it is this driver,
  then a report to NVIDIA with the repro; and a decision on how the exact-pixel GPU checks treat blended 4x views on a
  GPU that does not repeat them (the comparison itself must stay exact).

## Performance losses still open

Measured but not fixed. Their history, sources and rerun commands are in
[whitepaper/perf-history.md](whitepaper/perf-history.md#open-losses).

- **three.js `InstancedMesh` against Margo's instanced paths:** partly closed on 2026-10-25 (culled pipeline, one
  upload per frame, GPU spheres, untextured materials); `CulledInstances` now leads on static boxes at 10k and 50k.
  The three gaps still open are the entries below.
- **Galaxy S23 Ultra island demo at 3-5 FPS** (particles off does not help). Partial fixes have landed; no after number
  exists. **Needed to close:** the device, then a measured run.

The entries below were measured with `npm run bench -- instanced --engines=margo,three-webgl,three-webgpu` (busy
machine, diagnostic; numbers and method in [whitepaper/boxes-vs-threejs.md](whitepaper/boxes-vs-threejs.md),
"Instanced: fixes and what is left"). Each cause was measured, not guessed.

### createInstancedMesh reads vertex attributes its material does not use

- **What:** `@margoengine/materials` `createInstancedMesh` boxes at 50,000: GPU 0.63 ms against three's WebGL2
  `InstancedMesh` 0.47 ms (10,000: 0.156 against 0.128 ms). `CulledInstances` draws the same scene in 0.30 ms.
- **Cause (measured):** gltf-pro's vertex is 80 bytes (position, normal, tangent, two UV sets, colour as five vec4)
  and its vertex stage reads all of them even when the material uses no UV, tangent or vertex colour. The same page
  with the vertex stage reading only position and normal draws 50k in 0.47 ms; texture reads at one fixed texel
  (0.643 ms) and dropping the node x instance matrix product (0.642 ms) change nothing.
- **Plan:** gltf-pro chooses the vertex inputs per primitive from what the finished shader reads: a material with no
  map and no tangent-space lobe (materials' bare standard material) drops the tangent frame, and the vertex stage then
  writes constant UV and tangent outputs without fetching them. It needs the instancing patch to anchor on the
  vertex stage after that choice (today it patches `o.uv=i.uv; o.color=...` last) and a pixel check that untextured
  materials draw the same frames.

### A package's own render pass costs a fixed MSAA store and reload

- **What:** at 1,000 boxes both Margo instancing paths take 0.037-0.039 ms of GPU per frame against three's WebGL2
  0.030 ms (three's WebGPU renderer 0.050 ms).
- **Cause (measured):** core draws a frame in one render pass when no package adds one. A package pass (gltf-pro for
  `createInstancedMesh`, `CulledInstances`) makes core store its multisampled colour and depth, the package reload
  and store them, and core resolve them in a final pass: three passes against one. The resolve pass's depth
  attachment is not the cost (removing it: 0.037 -> 0.037 ms).
- **Plan:** let a package draw inside core's main pass (for example a frame-graph pass that core encodes in its own
  render pass when it needs only core's targets). That is a new core capability, so it waits for the core freeze to
  lift; until then the cost is about 0.01 ms per frame and matters only for very small scenes.

### Moving instances spend twice three's CPU per frame

- **What:** 10,000 instances moving every frame: CPU 1.23 ms (`createInstancedMesh`) and 1.33 ms (`CulledInstances`)
  per frame against three's WebGL2 0.63 ms and WebGPU 0.89 ms.
- **Cause (measured by CPU profile):** the matrix maths is now the same cost in both (Euler to quaternion, about
  0.3 ms, mostly sine and cosine). The rest is Margo's per-row validation (finite values, affine last row, nonsingular
  for `CulledInstances`; about 0.2 ms), which three's `setMatrixAt` does not do, and the upload of 96-byte rows
  (960 KB a frame) where three uploads 64-byte matrices.
- **Plan:** a bulk `setMatrices(start, Float32Array)` on PBRInstances and CulledInstances that validates and copies
  a whole range in one call, and a separate matrix stream so moving instances upload 64 bytes each. Both are package
  changes; the validation itself stays (it is what keeps a bad matrix from reaching the GPU).

The two entries below come from the three.js speed matrix ([whitepaper/perf-vs-threejs.md](whitepaper/perf-vs-threejs.md),
rows 10.11 and 11.3; run `20261026-165034`, busy machine, diagnostic). Their first causes are fixed (perf-history entry
26); what is left is different work.

### STL import does more work than three's STLLoader

- **What:** `p-stl`, a 204,800-triangle binary STL: `parseCAD` 28.7 ms (111 before entry 26) against three's
  `STLLoader` 2.6 ms.
- **Cause (measured, Node CPU profile of `parseCADGeometry`):** three copies the file's floats into one non-indexed
  buffer (614,400 vertices). `parseCAD` welds the corners through a hash table (205,440 vertices, about 20 ms in
  Node), computes face normals, builds a core `Geometry` (bounds, about 6 ms) and creates a GPU mesh with a
  `PbrMaterial`. The weld is what CAD sections, edges and part deduplication rely on, so `parseCAD` keeps it.
- **Plan:** a like-for-like reader: `parseSTL` in `@margoengine/loaders`, returning CPU geometry data like `parsePLY`
  (no weld, no GPU), and the parity scene timing that; `parseCAD` stays the CAD path.

### USDZ export writes every mesh in world space

- **What:** `p-export-usdz`, 1,000 boxes: `exportUSDZ` 16.0 ms (52.8 before entry 26) against three's `USDZExporter`
  2.5 ms; the archives are 2.46 MB against 444 KB.
- **Cause (measured):** `exportUSDZ` writes each node as its own world-space mesh, so the box's 24 vertices, normals
  and UVs are written 1,000 times as shortest round-trip text (144,000 numbers). three's archive is 5.5x
  smaller, so it writes far fewer.
- **Plan:** write a geometry shared by several nodes once (a mesh under a class prim) and give each node an Xform with
  its transform that references it, with `orientation = "leftHanded"` for mirrored nodes. It changes the archive's
  layout, so it waits for the Quick Look check of the entry at the top of this page.

### Morph targets: one compute dispatch per model

- **What:** `p-morph`, 100 MorphStressTest copies with 8 weights each changing every frame: 0.51 ms CPU and 1.32 ms
  GPU a frame against three's WebGL 0.26 and 0.15 (1.06 / 1.57 before entry 28).
- **Cause (measured, timestamp per pass):** the models now draw in one render pass and deform in one compute pass, and
  that compute pass is 1.18 of the 1.32 ms: 100 small dispatches, one per model, each writing its own output buffer,
  which the GPU runs one after another. three applies morph targets in the vertex shader of each draw.
- **Plan:** dispatch the copies of one primitive together: one dispatch over (vertex, copy) reading each copy's
  weights, writing into one output buffer that the draws bind at their copy's offset. It needs gltf-pro to draw a
  deformed primitive from a buffer offset. The CPU half is the 100 Animations' per-frame checks and uploads.

### cloneModel uploads every copy and core frees meshes in quadratic time

- **What:** `p-skeleton-clone`, 50 `cloneModel` copies of RobotExpressive per call (the call also destroys the
  previous 50): 63.6 ms against three's `SkeletonUtils.clone` 7.9 ms (84.5 before entry 28).
- **Cause (measured, CPU profile of the call):** about 17 ms is core `Engine.remove`, which unparents a removed mesh's
  children by scanning the whole parents array (`indexOf` from 0 again for every child) for each of the 3,700 meshes
  destroyed; about 13 ms creates and fills each copy's GPU vertex buffers, 12 ms its textures and bind groups, and
  13 ms re-merges its static parts in world space. three's clone shares geometry and textures and touches no GPU.
  Entry 28 removed the repacking of every copy's vertices (about 13 ms).
- **Plan:** in core (a bug fix, needs the coordinator's go-ahead under the freeze): unparent in one pass over the
  children of the removed mesh. In gltf-pro: copies of one asset share its GPU vertex buffers, textures and merged
  static parts, counted by reference, so `cloneModel` creates only nodes, skeleton and uniforms.

### GPU picking builds its pipeline on every pick

- **What:** `p-gpu-pick`, 100 `engine.pick` calls: 407 ms against three's 65 ms.
- **Cause (read, not yet profiled):** core `GPURenderer.pick` compiles a shader module and creates a render pipeline
  for every call (and a 1x1 colour and depth texture and two buffers), then waits for its own readback; picks run one
  at a time.
- **Plan:** in core (needs the coordinator's go-ahead under the freeze): keep the pick pipeline per pick shader text and
  the 1x1 targets, so a pick costs one pass and one readback.

### SciFiHelmet with image-based lighting: GPU time

- **What:** `helmet`: 0.77 ms GPU a frame against three's WebGL 0.08 (CPU 0.11 against 0.07).
- **Cause (measured in part):** timestamps per pass on this machine: four shadow cascades 0.05 ms, the core pass
  (floor and sky) 0.28 ms, the model's pass 0.47 ms. Which instructions cost it (IBL sampling, the procedural sky, 4x
  MSAA) is not isolated yet.
- **Plan:** a GPU capture of both passes against three's draw of the same scene.

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
