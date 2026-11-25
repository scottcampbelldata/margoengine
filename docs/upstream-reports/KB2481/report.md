# Intel Arc 140V and NVIDIA RTX A6000: 4x MSAA blending is not repeatable (draft)

Drafts for Intel (graphics driver feedback) and NVIDIA. Not filed. Margo row: KB2481.

## Environment (from Margo's records, 2026-10-26 to 2026-10-30)

- Intel Arc 140V, driver 32.0.101.8860, Edge 156.0.4314.50 (Dawn D3D12). A second Arc 140V laptop gave the same pixel.
- NVIDIA RTX A6000, driver 32.0.16.1742, same browser.

## NVIDIA half: reproduces here

Use `../KB3508/msaa-blend-repeat.html` and `../KB3508/report.md`. Result on this PC 2026-11-11: WebGPU 299 of 299 frames differ, with a
sample mask of 7 none do.

## Intel half: reproduces with `msaa-additive-repeat.html` (2026-11-21)

Environment: Intel Arc 140V laptop, Windows 11, Edge 157.0.4341.46 (Dawn D3D12), headless, adapter reported as `intel xe-2lpg`.

Steps: serve this folder over `http://localhost` and open `msaa-additive-repeat.html?frames=120`, then `?route=mask&frames=120`,
`?source=refill&frames=60` and `?source=fixed&frames=60` (or `node docs/upstream-reports/run-page.mjs
docs/upstream-reports/KB2481/msaa-additive-repeat.html --query="frames=120"` from the Margo repository). Each frame, in one encoder:
576 overlapping instanced discs added (blend one + one) into a cleared 4x `rgba16float` target; that target laid over a cleared 4x
`bgra8unorm` target by a full-screen alpha-blended draw that reads its own sample (`@builtin(sample_index)`, or with `route=mask` four
draws each writing one sample through `multisample.mask`); a resolve; a compute copy of every sample of the `rgba16float` target.

Expected: nothing changes between frames and blending happens in primitive order, so every frame gives the same samples and pixels.

Actual (this laptop, 120 frames): the `rgba16float` samples change in 119 of 119 frames (up to 3,989 of the 65,536 floats in a frame, by one half-float
ulp), and the resolved frames differ by up to 18 of 255 with the `sample_index` draw and by up to 1 of 255 with the masked draws. With the
same target written by plain masked writes instead of additive discs (`source=refill`, `source=fixed`), both routes give one image in 60 of
60 frames. `../KB3508/msaa-blend-repeat.html` stays exact here (0 of 299 frames, WebGPU).

In Margo the same fault moves `SurfelPlugin`'s 4x frame by up to 33 of 255 from frame to frame at the full feature level, where the
sums of the last frame are bit for bit the same at every pixel that moved (known-bugs entry "surfels at 4x on a compatibility-level
WebGPU device"). Margo works around it there since 2026-11-21 by resolving with the masked per-sample draws, which repeat.

## Intel half, 2026-10-30: no standalone page then

On the Arc one pixel, (101, 72) of a 4-sample frame, came out wrong in about 6 of 450 frames: only sample 0 held `99.96.92` instead of
`65.63.62`, i.e. a translucent face blended over the colour of a different sample's surface (the destination of samples 2 and 3). It
was traced by recording one frame of an application (every WebGPU object, shader text and bytes) and replaying it 1000 times on a fresh device: 4 wrong
frames in 1000, 8 in 1000 with the opaque pass left out. The fault therefore needs no engine code and no opaque content,
but the recorded frame comes from Margo's tracer (`scripts/support/webgpu-trace.js`, `scripts/support/webgpu-replay.html`; command in docs/known-bugs.md,
entry "4x MSAA blending is not repeatable"), not from a hand-written page. A hand-built page (one blended triangle on samples 2 and 3, then one on sample 0, in 9 layouts) stayed exact
on the Arc, and the KB3508 page gave 0 of 30 differing frames on the Arc (2026-10-30).

## Result on this PC

NVIDIA half reproduces on the workstation. The Intel half reproduces on the Arc 140V laptop with `msaa-additive-repeat.html` (above);
the report to Intel attaches that page and, for the voxel pixel, the recorded frame and replay page from the command above.
