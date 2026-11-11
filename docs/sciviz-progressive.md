# Progressive scientific rendering

Batch 181 job 5 adds `@margoengine/sciviz/progressive`. `progressiveRendering(figure, options)` and
`new ProgressiveRendering(figure, options)` attach the same disposable engine plugin. One controller owns an engine.
Importing the entry does not install anything, allocate GPU objects or change globals. Core and stage are unchanged.

Camera matrices and positions, view rectangles and target dimensions invalidate the per-view refinement state.
The first changed frame uses half-size dimensions and one quarter of the original integration samples. Two unchanged
frames settle motion, then eight frames interpolate dimensions and sample counts to their original values. Camera
motion interrupts refinement immediately. At the terminal level the optional target is released and the existing full
resolution renderer draws directly. Cinematic path histories naturally restart when dimensions, camera or sampling
change, then continue accumulating at rest using their existing seed and sample cap.

## Options and budget

| Option | Default | Contract |
| --- | --- | --- |
| frameBudgetMs | 16.7 | Positive finite soft submitted-frame latency target |
| movingResolution | 0.5 | Moving dimension multiplier in (0,1] |
| movingSamples | 0.25 | Moving integration multiplier in (0,1] |
| minResolution | min(0.25, movingResolution) | Positive lower dimension bound |
| minSamples | min(0.125, movingSamples) | Positive lower sample bound |
| settleFrames | 2 | Integer 0..120 unchanged frames before refinement |
| refinementFrames | 8 | Integer 1..120 frames to original quality |

Each completed submitted-frame measurement adjusts moving dimensions and samples by a cube-root budget ratio:
pixels scale quadratically and integration work approximately linearly. A 15% deadband and 0.8..1.1 step clamp limit
oscillation. Minima and initial moving settings bound adaptation. The controller keeps only one asynchronous queue
completion observation pending and never waits in the rendering path. `recordFrameTime(milliseconds)` also accepts an
application's own latency measurements. Feedback affects moving quality; it cannot prevent full resting convergence.
This is latency feedback including queue contention and CPU scheduling, not a GPU timestamp, deadline guarantee,
frame-rate claim or benchmark. Timing performance remains in the deferred speed phase.

`state` returns a snapshot with `moving`, `resolutionScale`, `sampleScale` and `progress`. Settings refer to the last
rendered view. All caller-owned volume quality/lighting options and canvas dimensions remain intact. The multiplier
applies to ordinary and bricked volumes, quality wrappers, categorical/fusion volumes, curvilinear and tetrahedral
volumes, and cinematic primary integration, shadow steps and AO directions/steps. Integer lighting counts round to at
least one; path bounce depth and accumulated-sample targets retain their physical meaning and are unchanged.

## Targets, restoration and limits

The optional frame-graph passes surround the scene. A single-sampled colour/depth target uses the original format and
reduced dimensions. Nearest pixel reconstruction writes both colour and reversed-Z depth into the original target.
Viewports/scissors scale with conservative integer bounds. Each view has separate camera state and reduced resources;
all layers sharing that scene receive the dimension change, including points, lines and mesh layers. The public canvas,
DOM overlays and picking coordinates retain their original size. Intermediate images intentionally differ in spatial
resolution, integration accuracy and antialiasing. No numerical error bound is claimed for these temporary images.
At full refinement the existing renderer's output is used unchanged. Do not use temporary motion frames for analysis.

Both native WebGPU and the full WebGL2 compatibility path are supported. A core WebGL2 preview engine, which does not
provide the device/pass API, rejects with the existing `unsupported` code before attachment; use `createFallbackFigure`. Reduced targets use the
device's ordinary texture limits and roughly width * height * (colour bytes + 4 depth bytes) per retained view.
Each view retains at most one reduced target. Replacement, full refinement and disposal release it. Applications
changing their view-ID set should recreate the controller to release removed views' state.

Engine device restoration releases all controller-owned textures/pipelines and invalidates pending timing results.
The figure recreates scientific layers from their retained host data, including volume slices,
bricked pages, surfaces and extracted isosurfaces. Points and lines remain owned by their existing plugins. Optional
cinematic, quality, mapped-grid, categorical, glyph and other layer plugins retain their own restore hooks. Bricked
sources reload through their abortable source reads; `ready({signal})` requires rendered frames to schedule them.
GPU-only sources have the existing explicit ownership contract: the application recreates the source on the new
device. They are hidden and cannot submit stale bindings until recreated; this controller does not invent CPU copies.
`dispose()` and `Symbol.dispose` remove the passes. Disposing the figure also disposes its controller, including when
the figure borrows an external engine.

## Evidence and clean-room design

`packages/sciviz/tests/progressive.test.js` checks deterministic motion/refinement, reset, budget bounds/deadband,
invalid options and lifecycle. `progressive-browser.mjs` runs real EMDB EMD-8117 and TCIA CT-ORG input on native WebGPU
and full WebGL2, checks lower moving settings, full resting convergence, cinematic history, budget feedback, retained
canvas/settings, actual engine device replacement and exact restored/final reference pixels. The existing package
browser restoration suites cover the other layer families through their owning engine hooks.
`examples/sciviz-progressive.html` shows bricked EMDB, cinematic EMDB and cinematic CT side by side. Its recorded inputs
and licences are the same as batch 173: EMDB CC0 and TCIA CT-ORG CC BY 3.0. `?backend=webgl2` selects compatibility.

Research compared before implementation, without reading companion code or rival sources:

- Jesus Diaz-Garcia, Pere Brunet, Isabel Navazo, Pere-Pau Vazquez (2018), *Progressive Ray Casting for Volumetric Models
  on Mobile Devices*, [paper](https://doi.org/10.1016/j.cag.2018.02.007). The controller combines their interaction/rest
  distinction with dimension refinement; it retains existing volume data instead of building another data pyramid.
- Thomas Kroes, Frits H. Post, Charl P. Botha (2012), *Exposure Render: An Interactive Photo-Realistic Volume Rendering
  Framework*, [paper](https://doi.org/10.1371/journal.pone.0038586). Reuse the existing progressive Monte Carlo histories
  at rest and invalidate incompatible camera/sampling histories.
- Jana Martschinke, Stefan Hartnagel, Benjamin Keinert, Klaus Engel, Marc Stamminger (2019), *Adaptive Temporal Sampling
  for Volumetric Path Tracing of Medical Data*, [paper](https://doi.org/10.1111/cgf.13771). Compared temporal reuse with
  the existing renderer's strict restart policy; no reprojection or stale-history reuse is claimed here.
- W3C GPU for the Web Working Group (2026), *WebGPU*, [device loss specification](https://www.w3.org/TR/webgpu/#device-loss).
  Resources remain tied to their creating device and are recreated through the engine's existing restoration hooks.

Entry size: 4746 B min+gzip, new ceiling 5002 B; core plus stage stays 24209 B. No existing entry ceiling is raised.

The generated `margoengine/sciviz/progressive` and `@margoengine/viz/sciviz/progressive` aliases expose the same optional controller.
