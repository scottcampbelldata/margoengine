# NVIDIA RTX A6000 (Windows): 4x MSAA blended draws give a different result from frame to frame

Draft for NVIDIA (driver feedback / developer forums) with copies for Dawn (crbug, Dawn component) and ANGLE (issue tracker) because
it shows through WebGPU and through WebGL2 on ANGLE D3D11. Not filed. Margo rows: KB3508 (this report), KB3497 and KB2481 (same
repro, own reports), KB5185b and KB5247d (WebGL2 side).

## Environment

- Windows 11, NVIDIA RTX A6000, driver 32.0.16.1742 (617.42), also an AMD Radeon (Raphael, RDNA2) iGPU in the same PC (used as the control).
- Microsoft Edge 157.0.4341.42 (Chromium 157, Dawn D3D12 for WebGPU, ANGLE D3D11 for WebGL2), headless, `--enable-unsafe-webgpu`.
- Also seen with Edge/Chrome 156 and with standalone Dawn (Node binding 0.6.2) on D3D12 and D3D11.

## Steps

1. Serve this folder over `http://localhost` and open `msaa-blend-repeat.html?api=webgpu&frames=300` (or
   `node docs/upstream-reports/run-page.mjs docs/upstream-reports/KB3508/msaa-blend-repeat.html --query="api=webgpu&frames=300"` from the Margo repository).
2. Repeat with `?api=webgl2&frames=300`, and with `?api=webgpu&frames=300&mask=7`.

The page draws one frame 300 times on the same device with the same resources and commands: clear (colour and depth),
a dense mesh of flat-coloured triangles (so edge pixels hold different colours per sample), a coarse mesh blended with
`color = dst * constant` (src factor zero, dst factor src; alpha zero/one), a resolve. WebGPU mode also copies the 4 samples of every
pixel before and after the blended pass with a compute shader.

## Expected

Per-sample blending makes each sample `dst_sample * constant`, so every frame is identical.

## Actual (RTX A6000, 2026-11-11)

| run | frames differing from frame 0 | distinct resolved images |
|---|---|---|
| WebGPU (Dawn D3D12), 4x | 299 of 299 | 36 |
| WebGPU, 4x, pipeline `mask: 7` (sample 3 left out) | 0 | 1 |
| WebGL2 (ANGLE D3D11), 4x, 640x480 | 10 of 299 | 9 |
| WebGL2 (ANGLE D3D11), 4x, 1024x768 | 3 of 299 | 4 |
| WebGL2, `--use-angle=vulkan` | 0 | 1 |
| WebGL2, `--use-angle=d3d11on12` | 0 | 1 |
| AMD Radeon iGPU, WebGPU 100 frames and WebGL2 300 frames | 0 | 1 |

In WebGPU mode the samples are the same before the blended pass (0 differ) and different after it. Example (pixel 492,80, BGRA words):
before the blend `ff54712f ff337f19 ff337f19 ff337f19`; after it, frame 0 `ff49672c ff2c7417 ff2c7417 ff2c7417` (correct, dst x constant per
sample); in a later frame all four samples hold `ff33701c`, about the average of the four correct results. No input can make a
per-sample blend do that. The pixels that change are along the edges of the blended mesh, in blocks of 4x4 or 8x8 pixels.

A blended draw that leaves out one sample (`mask: 7`, and 11, 13, 14 in earlier runs) is stable; mask 15 is not. Without the blended draw, at 1x,
and with `max` blending the frames are stable. Recorded frames of a real scene replayed in a fresh browser with no engine code show the same.

## Result on this PC

Reproduces (table above, 2026-11-11, Edge 157). Not reproducing on the AMD iGPU, on ANGLE Vulkan or on ANGLE D3D11on12, which narrows it to the
NVIDIA D3D11/D3D12 path of this driver.

## Files

`msaa-blend-repeat.html` (the repro, no libraries, both APIs), `../run-page.mjs` (optional Playwright driver).
