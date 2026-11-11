# Playwright WebKit (macOS): requestAnimationFrame runs at 20 or 30 FPS on some same-tab navigations (draft, no standalone repro)

Draft for Playwright (microsoft/playwright, WebKit) and WebKit (bugs.webkit.org, component Graphics / Animation). Not filed. Margo row: KB2224c.
Status: draft only. A minimal repro does not exist yet and cannot be built on this PC.

## Environment

Apple M6, Playwright WebKit (Version/27.2, build 2370) driven by Playwright, 1920 x 1000 viewport, 60 Hz display, WebGPU page.
Safari itself was not run.

## What was seen (Margo's record, 2026-11-05)

The Margo `voxel-sandbox` example at `quality=high`, 1920 x 1000: in chains of five same-tab loads (`page.goto` to the same page again), 7 of 30 loads
ran at 30 FPS (first seen as 20 and 30), then the rate came back by itself on a later load. The rate of the page's own `requestAnimationFrame` loop
is the same as the frame count, frame CPU time 2 ms, GPU 24% busy. Never on the first load of a browser (0 of 11 chains), and not at 1280 x 720 (0 of 11 loads).

Ruled out: GPU load, CPU load, the back-forward cache as the only cause, the old page's device (destroying it on `pagehide` still gave 3 of 25).
A plain WebGPU page that only clears the canvas held 60 FPS in 20 of 20 loads at the same size, so a frame's real work plays a part.

## Steps

1. Launch Playwright WebKit headed or headless, viewport 1920 x 1000.
2. `page.goto` the same WebGPU page five times in a row in one tab; each load runs the page for a few seconds and records the rate of its `requestAnimationFrame` callbacks.
3. Repeat the chain until a load reports 20 to 30 FPS.

Expected 60 FPS on a 60 Hz display on every load. Actual: some loads of the 2nd to 5th in a chain run at 30 (or 20).

## Result on this PC

Not run: Playwright WebKit for Windows has no WebGPU, and the fault was seen on macOS only. No standalone page is attached because none has reproduced
the fault: the plain clear page does not. What is needed before filing: a page with a heavier frame (several render passes with a 4x target) that does show it
on the Mac, then this report with that page.
