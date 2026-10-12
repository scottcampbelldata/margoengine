# Conveyor simulator: three.js vs Margo

Captured 2026-10-12T05:21:31.764Z with 155.0.4283.45 (headless), 1280x720 at device pixel ratio 1, adapter `{"vendor":"nvidia","architecture":"ampere","fallback":false}`.

Both pages embed the same 569-part GLB, HDR environment and assembly facts. Each page was measured 5 times in a fresh browser context, interleaved and alternating which page ran first. Cells show the median over those runs with the range in brackets. Each scenario runs 60 warm-up frames and 600 measured frames with vsync and the frame-rate limit disabled.

| | three.js (webgl2) | Margo (webgpu) |
|---|---:|---:|
| Viewer script, raw / gzip (KiB) | 669.1 / 172.6 | 150.0 / 54.3 |
| Navigation to assembly ready (ms) | 609 (596 to 968) | 816 (804 to 855) |
| JS heap after all scenarios (MB) | 8.7 | 4.0 |
| Parts / triangles drawn | 569 / 2445442 | 569 / 2445442 |
| Orbit: frames per second | 1586 (1259 to 1681) | 1446 (1322 to 1770) |
| Orbit: frame interval mean (ms) | 0.63 (0.59 to 0.79) | 0.69 (0.56 to 0.76) |
| Orbit: frame interval p95 (ms) | 0.90 (0.80 to 1.10) | 1.70 (1.40 to 2.90) |
| Orbit: frame interval p99 (ms) | 1.20 (1.00 to 1.50) | 6.10 (2.40 to 7.80) |
| Orbit: render call on the main thread (ms) | 0.439 (0.416 to 0.549) | 0.522 (0.386 to 0.575) |
| Orbit: draw / compute-dispatch calls per frame | 282 / 0 | 243 / 0 |
| Orbit: heap change (MB) | 2.0 (1.8 to 2.0) | 0.8 (0.6 to 0.8) |
| Orbit: minor GCs | 44 | 14 |
| Orbit: major GCs | 0 | 0 |
| Explode sweep: frames per second | 786 (559 to 813) | 1219 (1034 to 1238) |
| Explode sweep: frame interval mean (ms) | 1.27 (1.23 to 1.79) | 0.82 (0.81 to 0.97) |
| Explode sweep: frame interval p95 (ms) | 1.80 (1.70 to 2.80) | 1.10 (1.00 to 1.30) |
| Explode sweep: frame interval p99 (ms) | 2.20 (2.00 to 3.60) | 1.50 (1.40 to 1.70) |
| Explode sweep: render call on the main thread (ms) | 0.534 (0.511 to 0.719) | 0.184 (0.181 to 0.225) |
| Explode sweep: draw / compute-dispatch calls per frame | 282 / 0 | 243 / 0 |
| Explode sweep: heap change (MB) | 1.0 (0.6 to 1.4) | 0.5 (0.3 to 0.8) |
| Explode sweep: minor GCs | 212 (211 to 213) | 50 |
| Explode sweep: major GCs | 1 | 1 |
| Explode sweep: state update per frame (ms) | 0.137 (0.133 to 0.195) | 0.062 (0.061 to 0.071) |
| Clicks that selected a part, of 48 | 5 | 5 |
| Click on a part to selection, per-run median (ms) | 11.4 (11.0 to 14.7) | 5.8 (5.6 to 6.5) |
| Click on empty space, per-run median (ms) | 2.6 (2.5 to 2.7) | 2.4 (2.3 to 2.6) |
| Slowest click in a run (ms) | 25.5 (24.0 to 33.6) | 27.2 (26.0 to 29.3) |
| Clicks that needed a GPU readback | 0 | 6 |

The two viewers selected the same part (or both missed) on 47 of 48 clicks per run.

## What is not equal

- three.js renders through WebGL2 with 4x MSAA; Margo renders through WebGPU with no multisampling. Margo shades fewer samples per pixel.
- Margo draws a 2-pixel jump-flood outline on the selected part; three.js draws a bounding box.
- Lighting is matched in kind (two directional lights, a hemisphere light, HDR image-based lighting, ACES filmic tone mapping at exposure 1.08) but not pixel for pixel.
- Frame intervals are requestAnimationFrame cadence with pacing uncapped. They include GPU back-pressure in both engines but are not a GPU timing. "Render call" is main-thread time inside `renderer.render` / `engine.render` only.
- three.js selects inside the click event. Margo skips the GPU when the click ray misses the bounding box of every visible part; otherwise it renders a culled 3x3 ID pass and awaits its readback. Click time ends when the port reports the selection applied.
- three.js casts a ray through the exact click point. Margo prefers the center pixel, then its neighbors within one pixel; silhouette selections can therefore differ.
- Heap change is retained plus not-yet-collected heap after a forced GC before the scenario, not bytes allocated. Tracing and call counting add overhead to both.
- One machine, one browser. Frame rates at this level move with machine load; compare the ranges, not single values.
