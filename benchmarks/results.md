# Three.js vs Margo conveyor benchmark

Captured 2026-10-11T23:05:58.666Z; Chromium 155.0.4283.45.

Each scene renders exactly 1,200 frames: 200 warmup frames and 1,000 measured frames. Frame cadence uses the 999 intervals within the measured window. Actual duration depends on frame rate; 1,200 frames take 20 seconds only at 60 FPS.

| Scene | Entities | JS gzip payload (bytes) | JS transfer incl. headers (bytes) | Heap delta (bytes) | Minor / major GC | Mean ms | P95 ms | P99 ms | Draws/frame | GPU direct / indirect / dispatch / GL calls (1,000 frames) | Measured duration (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Margo (webgpu) | 12014 | 19207 | 19807 | 159232 | 1 / 0 | 16.67 | 16.80 | 17.00 | 2 | 2000 / 0 / 0 / 0 | 16.65 |
| Three.js 0.186.1 (webgl2) | 12014 | 131858 | 132458 | 7544948 | 196 / 8 | 16.67 | 16.80 | 17.40 | 9012 | 0 / 0 / 0 / 9012000 | 16.65 |

Both consume the same 12,014-node hierarchy and cylinder buffers, camera, animation and uncullled geometry. Three uses shared geometry/materials with ordinary Mesh objects; Margo performs its native batching. Three InstancedMesh is a separate optimization and is not evaluated. Lighting and tone mapping differ. This compares WebGPU Margo with WebGL2 Three, not identical render backends.

Gzip payload and actual transfer come from Resource Timing with cache disabled and gzipped production bundles served by Vite. Heap delta is retained/temporary heap change after a forced baseline GC, not total allocated bytes. GC counts are completed MinorGC/MajorGC trace events. Tracing and draw-call instrumentation add overhead. Software GPU results are validation data, not hardware performance claims.

Margo adapter: `{"gpu":{"vendor":"nvidia","device":"","description":"","isFallbackAdapter":false},"userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0"}`
Three.js 0.186.1 adapter: `{"gpu":{"vendor":"nvidia","device":"","description":"","isFallbackAdapter":false},"userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0"}`
