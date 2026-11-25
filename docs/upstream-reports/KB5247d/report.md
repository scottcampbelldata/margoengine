# ANGLE D3D11 (NVIDIA): a 4x RGBA16F resolve rereads as two different images (draft, no standalone repro yet)

Draft for the ANGLE issue tracker (and NVIDIA). Not filed. Margo row: KB5247d (materials dispersion live reset on the WebGL2
compatibility layer). The same defect is written up for the lane that owns it as KB5822a ("ANGLE D3D11 returns two versions of the
MSAA-resolved texture"); this file only adds what the materials case shows. KB5822a has no folder of its own: its candidate page,
`hdr-resolve-repeat.html`, lives here (below).

## Environment

RTX A6000, driver 32.0.16.1742 (617.42), Windows 11, Edge 157, default ANGLE backend (Direct3D 11). ANGLE Vulkan on the same machine is exact.

## Observation (from Margo's records, 2026-11-10)

`node scripts/material-dispersion-gpu-check.js --backend=compat` renders a 57-frame grid on a WebGL2 context. After a live change of one
uniform from positive to zero, the 4x multisampled RGBA16F frame resolves to an image that differs from the constructor-zero image in 10
channels, each by one float16 step (max 0.000244140625), mostly outside the transmissive quad where only the opaque background and the
final 4x resolve touch the pixels. Nine of nine full-grid runs reached the same second image. 1x is exact.

Ruled out in Margo: stale uniforms (the GL call streams are identical but for a 4-byte write), `invalidateFramebuffer`, readback layout,
program variants, engine timing.

## Why there is no standalone repro here

Raw WebGL2 pages without engine code (a UBO-driven refraction shader; a 4x RGBA16F renderbuffer resolve with 3,000 edge triangles, with and
without invalidate; 300 frames each) did not reproduce it: the trigger also needs the earlier resource churn of the full grid.

Nearest standalone evidence on this PC (2026-11-11): `../KB3508/msaa-blend-repeat.html?api=webgl2&frames=300` shows ANGLE D3D11 on the
RTX A6000 returning different resolved bytes for identical commands (10 of 299 frames, 9 distinct images) while ANGLE Vulkan and D3D11on12
give one image. That is a different pixel format and draw (RGBA8, blended), so it shows that D3D11 MSAA on this driver is not repeatable, not that
it is this fault.

## Candidate standalone page (2026-11-25)

`hdr-resolve-repeat.html` in this folder (raw WebGL2, no engine code) has the shape of the frame that varied: clear a 4x
RGBA16F colour and a 4x depth renderbuffer, draw a dense mesh of flat HDR triangles (values up to 2.7), `blitFramebuffer` it
into an RGBA16F snapshot texture, draw a translucent quad that samples the snapshot three times with a per-channel offset,
`blitFramebuffer` again into an RGBA16F final texture, then read the final texture twice as RGBA/FLOAT: through a pixel pack
buffer and a fence, then at once with a direct `readPixels` (the two reads that disagreed on the A6000). Query:
`?frames=N&size=WxH&invalidate=1&churn=N&wait=ms`. Expected result: `changedFrames: 0`, `readPairsDiffer: 0`,
`distinctFinal: 1`, `distinctSnapshot: 1`; `sanity` shows the frame is HDR and the glass changed it.

`node docs/upstream-reports/run-page.mjs docs/upstream-reports/KB5247d/hdr-resolve-repeat.html --browser=chrome --query="frames=300"`,
then the same with `&invalidate=1&churn=40`, and each with `--arg=--use-angle=vulkan`.

Results on an Intel Arc 140V (driver 32.0.101.8860), 2026-11-25:

| backend | query | changedFrames | readPairsDiffer | distinctFinal | distinctSnapshot |
|---|---|---|---|---|---|
| ANGLE D3D11, Chrome 157 | `frames=120` | 0 | 0 | 1 | 1 |
| ANGLE D3D11, Chrome 157 | `frames=120&invalidate=1&churn=40` | 0 | 0 | 1 | 1 |
| ANGLE Vulkan, Chrome 157 | `frames=120` | 0 | 0 | 1 | 1 |
| ANGLE Vulkan, Chrome 157 | `frames=120&invalidate=1&churn=40` | 0 | 0 | 1 | 1 |
| ANGLE D3D11, Edge 158, beside the full Margo grid | `frames=400&size=1920x1080&churn=40` | 0 | 0 | 1 | 1 |

`sanity`: 48,375 channels above 1 and 92,864 channels changed by the glass at 320x240.

## Result on this PC

The full Margo grid is exact on the Arc too (see docs/known-bugs.md, 2026-11-25), so this page cannot show the fault on
this PC: it is exact here as expected. Still to do before filing: run the page on the RTX A6000. If it is exact there as well,
the trigger needs more of the full grid, and the next step is a self-contained replay of the recorded Margo session (full
payloads, not hashes). Status: draft only.
