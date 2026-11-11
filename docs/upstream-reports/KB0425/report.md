# WebKit: drawImage of a WebGPU canvas keeps returning the first read until a new task

Draft for bugs.webkit.org, product WebKit, component WebGPU. Not filed. Margo row: KB0425.

## Environment

- Playwright WebKit build 2370 (Version/27.2, Safari-like user agent) on an Apple M6 (Margo's record, 2026-11-11).
- Control on the same Mac: Playwright Chromium, which reads red then green.
- Playwright WebKit for Windows has no WebGPU (`requestAdapter()` gives null), so this PC cannot run the WebKit half.

## Steps

1. Serve this folder over `http://localhost` and open `drawimage.html` in WebKit with WebGPU on
   (or `node docs/upstream-reports/run-page.mjs docs/upstream-reports/KB0425/drawimage.html --browser=webkit`).
2. In one task the page: clears the canvas's current texture red and submits; draws the canvas into a 2D canvas with `drawImage` and
   reads a pixel; clears the same current texture green and submits; reads again; awaits `onSubmittedWorkDone()`, clears blue, reads a third time.

## Expected

red, green, blue. WebGPU 21.2 (`GPUCanvasContext`, `[[drawingBuffer]]`): "Any time the drawing buffer is read, implementations must ensure
that all previously submitted work (e.g. queue submissions) have completed writing to it via [[currentTexture]]."
https://www.w3.org/TR/webgpu/

## Actual

WebKit: red, red, blue. Later reads in the same task return the first read's image although more work was submitted to the same
current texture; after a task boundary a new clear reads as drawn. A real case: Margo's voxel check read 2116 red pixels after
disposing a renderer and rendering once more; Chromium read 0.

## Result on this PC (2026-11-11)

Not run on WebKit (no WebGPU in Playwright WebKit for Windows: "no WebGPU adapter"). The page runs on Edge 157 and gives red, green, blue,
the expected result, so the page itself is sound. The WebKit result is from Margo's record on the Mac and is to be re-confirmed there before filing.
Margo's workaround: the check draws its disposed frame after the queue drains.

## Files

`drawimage.html` (the repro, no libraries), `../run-page.mjs` (optional Playwright driver).
