# GPU picking

`@margoengine/sciviz/pick-gpu` exports `GpuPicking`, `GpuPickOptions` and `GpuPickResult`.
Construct with a figure, await `pick(x, y, options)` in canvas-relative CSS pixels, and dispose
the picker before disposing its figure. `attachHover()` installs it in the existing tooltip
and hover-event path; its removal function restores CPU hover. `figure.pick()` is unchanged.
The demo is `examples/sciviz-pick-gpu.html`, with `?backend=webgl2` for compatibility rendering.
README examples are owed during the build phase.

## Selection contract

- Scatter points and line vertices use every source position, independently of the rendered
  point budget. Radius defaults to 8 CSS pixels. Nearest projected centre wins; depth breaks
  exact distance ties within f32 ranking precision. Points take precedence over cells and volumes,
  matching the CPU figure picker's category order. Positions outside clip depth are excluded.
- Bar, histogram and heatmap IDs are original cell indices. Regular surfaces use original
  grid-cell indices, with the same two triangles and NaN holes as the colour render.
  `MeshLayer` returns the original `TriangleSet.cells` ID, including IDs above 16,777,216.
  The value on a mesh is interpolated from its corner values. Scalar opacity and zero opacity
  are respected. The nearest depth wins among non-point geometries.
- Volumes return the first sample whose step-corrected classified opacity reaches
  `opacityThreshold` (default 0.002). The current transfer texture, gradient/preintegrated
  classification, density, quality and clipping planes are used. Samples start at half a
  stride after entry, with at most 2048 samples through the entire box. Both composite and
  MIP volumes use this explicitly defined first-hit policy. This is not peak-opacity picking
  or the perceptual structure selection of WYSIWYP. All-zero density and fully clipped rays miss.
- Coordinates and scalar values are in data units, with date/log axis inversion for points
  and chart cells. Volume IDs are x-fastest voxel indices; coordinates locate the actual
  ray sample, which need not be a voxel centre. Returned depth is original reversed-Z depth.

The pass renders a one-pixel `rgba32uint` attachment and a `depth32float` attachment. A hit
stores layer ID, original item index, depth bits and scalar bits. A 256-byte aligned mapping
reads back one texel. CPU work per query visits layers, performs constant-size matrix math and
decodes one hit; it never projects or scans source items. GPU work still visits the points
or cells: this is not an acceleration structure or a constant-GPU-work claim.

Volume samples use eight clamped texture loads and explicit f32 trilinear interpolation.
This avoids implementation-dependent half-float filtering precision in the returned scalar.
Input samples remain the colour renderer's normalized binary16 texture, so no original-value
precision beyond that representation is claimed. The independent TCIA CPU reference checks
the same half-float input, scalar error below 0.1 HU and identical voxel ID at an interior ray.
Picking near an exact shared voxel face can select either neighbouring voxel at f32 precision.

## Lifetime, defaults and limits

Construction allocates no GPU resources. CPU-backed point/rectangle inputs upload on first use, at
12/16 bytes per item, plus a 320-byte uniform per supported layer. Each picker owns 276 bytes
for the ID/depth targets and aligned readback (16 + 4 + 256), excluding driver overhead.
Call `invalidate(layer)` after in-place point/rectangle edits, or `invalidate()` for all.
Replacing a point array rebuilds automatically. Surfaces and unstructured grids borrow live
GPU buffers; volume textures and classifiers are rebound each query. Never dispose the borrowed
resources. Removed layers are pruned on the next query and picker disposal releases the rest.

Queries serialize; hover coalesces to the latest pointer and suppresses stale results and
post-disposal publication. `signal` cancels queue waits, readiness and readback. `timeout`
defaults to 30000 ms and bounds the entire query, including queue wait. Errors retain their
code/help link; hover failures emit `pickerror`. Outside the canvas or a 2D plot area is a miss.
Engine device replacement lazily rebuilds owned state and rebinds restored layer resources.
Picking is supported on native WebGPU and full WebGL2 compatibility; native WebGL2 figures
reject with a coded unsupported error. Custom layers without a supported picking resource
are not candidates. Each volume supports at most 2^32 voxels; point/rectangle uploads must
fit the device's maxBufferSize, otherwise split the data into layers.

The existing CPU nearest-point helper uses a half-pixel distance tie band, while the GPU
uses strict centre-distance ranking. Its normalized-depth tie direction is also an existing
CPU defect recorded in known-bugs.md. The browser suite compares isolated exact-centre points
and chart cells against the existing CPU picker, and volume first hits against an independent
CPU ray integrator. These comparisons do not claim identical tie-band or surface bilinear
intersections: the GPU surface picks the actual drawn triangles and returns a cell ID.

## Proof and reproduction

`pick-gpu.test.js` and `pick-gpu-hover.test.js` cover validation, allocation-free construction,
cancellation, queued deadlines, disposal, coalescing, stale suppression and error recovery.
`pick-gpu-browser.mjs` covers real million-point 2MASS picks, charts, live surface buffers,
NaN holes, original unstructured IDs above 24 bits, calibrated TCIA CT-ORG first hits and
actual engine reboot on both backends. It also opens and screenshots the real-data demo.
Data provenance and licences are the existing `examples/assets/sciviz/stars.json` and
`examples/assets/sciviz/clip/source.json`; no data or implementation was copied from a rival.

Build packages, then run `node --test --test-timeout=120000 packages/sciviz/tests/pick-gpu*.test.js`.
The browser command, from repository root, is `node scripts/gpu-lock.mjs run
--owner=codex-batch181 --max=4 --wait-max=60 -- node packages/sciviz/scripts/browser-root.mjs
tests/pick-gpu-browser.mjs` (one shell line). Output JSON and screenshots are in test-results.
No frame-time, throughput or rival speed result is published during the deferred speed phase.

Linked selection replacement draws retain logical source visibility for both CPU and GPU queries. Hiding the replacement excludes its source; disposal restores ordinary source visibility. pick-visibility.test.js is the regression for draw suppression previously disabling box/lasso selection and CPU hover. Mesh updates through empty and back retain picking.
