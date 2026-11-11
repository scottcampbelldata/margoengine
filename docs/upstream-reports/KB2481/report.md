# Intel Arc 140V and NVIDIA RTX A6000: 4x MSAA blending is not repeatable (draft)

Drafts for Intel (graphics driver feedback) and NVIDIA. Not filed. Margo row: KB2481.

## Environment (from Margo's records, 2026-10-26 to 2026-10-30)

- Intel Arc 140V, driver 32.0.101.8860, Edge 156.0.4314.50 (Dawn D3D12). A second Arc 140V laptop gave the same pixel.
- NVIDIA RTX A6000, driver 32.0.16.1742, same browser.

## NVIDIA half: reproduces here

Use `../KB3508/msaa-blend-repeat.html` and `../KB3508/report.md`. Result on this PC 2026-11-11: WebGPU 299 of 299 frames differ, with a
sample mask of 7 none do.

## Intel half: no standalone page yet

On the Arc one pixel, (101, 72) of a 4-sample frame, came out wrong in about 6 of 450 frames: only sample 0 held `99.96.92` instead of
`65.63.62`, i.e. a translucent face blended over the colour of a different sample's surface (the destination of samples 2 and 3). It
was traced by recording one frame of an application (every WebGPU object, shader text and bytes) and replaying it 1000 times on a fresh device: 4 wrong
frames in 1000, 8 in 1000 with the opaque pass left out. The fault therefore needs no engine code and no opaque content,
but the recorded frame comes from Margo's tracer (`scripts/support/webgpu-trace.js`, `scripts/support/webgpu-replay.html`; command in docs/known-bugs.md,
entry "4x MSAA blending is not repeatable"), not from a hand-written page. A hand-built page (one blended triangle on samples 2 and 3, then one on sample 0, in 9 layouts) stayed exact
on the Arc, and the KB3508 page gave 0 of 30 differing frames on the Arc (2026-10-30).

## Result on this PC

NVIDIA half reproduces. The Intel half cannot be run here (no Arc on this PC), so no hand-written repro page exists for it; the
report to Intel should attach the recorded frame and replay page produced by the command above on an Arc machine.
