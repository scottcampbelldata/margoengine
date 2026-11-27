# Density scatter

`@margoengine/sciviz/density` is an optional entry. `densityScatter(figure, positions, options)` adds interleaved float32 xyz directly, or accepts an existing scatter belonging to the figure. An attached scatter keeps CPU/GPU picking and selection, while its budgeted point draw is suppressed. Dispose/remove the density replacement to restore the original draw. One replacement can own a source at a time. The root sciviz, core and stage entries do not import density.

Every finite point inside the camera frustum and plot scissor votes once in its drawing-buffer pixel. The raster uses exact unsigned 32-bit integer atomics, with no float blending, half-float saturation or dropped-point budget. Native WebGPU runs count accumulation on the GPU. WebGL2 compatibility uses its supported compute tier: the current atomic kernel uses the CPU compute tier, while Gaussian smoothing uses GPU scatter dispatches. This is an accepted implementation difference, not a claim of equal throughput.

`mode: 'count'` is the default. Per-pixel opacity is `1 - (1 - opacity)^count`, with exact zero/one endpoints. `opacity` defaults to 0.08 and ranges from zero through one. The default sRGB colour is `#56b4e9`; hex alpha multiplies opacity. Density is composited as a screen overlay after opaque geometry, without depth occlusion between points. It describes projected occupancy, including in 3D (`dimensions: '3d'`); it does not encode which point is nearest. The default `dimensions: '2d'` needs a 2D figure.

`mode: 'kernel'` applies a normalized separable Gaussian to the pixel histogram. `bandwidth` is its standard deviation in CSS pixels (target pixels times the target's pixels per CSS pixel), default 4, greater than zero and at most 32. Support is `ceil(4 * bandwidth)` pixels each side, with zero extension at the plot scissor. The Gaussian is a smoothed pixel histogram, not a continuous/subpixel KDE or a probability density normalized by observation count. At the boundary, mass outside the plot is clipped rather than renormalized; offscreen points do not contribute a halo. Exact bin counts remain available before smoothing. Floating point smoothing and opacity are visual summaries; integer readback retains all counts.

The raster follows camera, model, viewport, scissor and resize changes. Input uploads are cached, with at most 1,048,576 xyz points in each buffer, further limited by device buffer size, storage binding size and dispatch dimensions. Twenty million points use 240,000,000 GPU source bytes in 20 chunks on the tested device. The three raster buffers use 12 bytes per drawing-buffer pixel. The raster is limited to 8192 per axis, 16,777,216 pixels total, and the device's binding/allocation limits. At most 4,294,967,295 source points are allowed, so even coincident counts cannot overflow u32. Initial bounds inspection is on the CPU; per-frame projection on native WebGPU is entirely on the GPU. Unchanged views reuse the histogram and smoothing. No speed claim is made.

`setStyle()` changes mode, bandwidth, opacity and colour. Mutating a borrowed position array requires `invalidate()` before the next render. Replacing an attached source's positions/cloud is detected automatically. Direct arrays use their initial finite bounds; remove and recreate the density layer when changing the data extent, or use explicit figure limits. Remove the density before removing its source scatter. Figures must use linear plot coordinates for custom layers; callers with date/log data can pass already transformed positions to an appropriate linear figure.

`readCounts({ signal, timeout })` reads the last rendered top-first integer histogram. Render first. Timeout defaults to 30,000 ms and must lie in (0, 2147483647] ms (the largest delay every host timer honours), otherwise the call rejects with a coded RangeError; each call owns its mapping buffer, so concurrent calls do not alias. Cancellation, disposal, timeout and device replacement reject in-flight reads; the next render rebuilds resources after restore. Retaining a source scatter preserves its existing pick/selection events; a direct array density layer has no invented single-point hit. Inspect density pixels through readback or aggregate data-space bins.

`layer.aggregate(tableOrCrossFilter, options)` lazily loads the existing optional `/table` entry and calls `aggregateTable`. It preserves exact row counts, validity, sum, mean, minimum, maximum, declared bin edges and filter predicates. It accepts the same GPU option and AbortSignal. Explicit data-space ranges need not match the current visual crop. It does not substitute smoothed pixels for analytical statistics. `bindTableAggregate` remains available for automatically refreshing linked histograms and heatmaps after CrossFilter changes. The demo reports the actual TLC aggregate and total charges alongside its cropped geographic density.

Open `examples/sciviz-density.html`, or append `?backend=webgl2`. The demo uses the retained one million original 2MASS sources and 1,024 original NYC TLC pick-ups. Data and licence records are `examples/assets/sciviz/stars.json` and `examples/assets/sciviz/limits/source.json`. Scale correctness tiles these observations explicitly to 20M and 10M; these are repeated observations, not a claim of new independent stars or trips.

## Evidence and remaining measurement

`packages/sciviz/tests/density.test.js` checks malformed inputs, cancellation, exclusive replacement ownership, all-point chunking, invalidation and unchanged-view work reuse. `density-browser.mjs` checks exact analytical raster pixels despite `pointBudget: 1`, opacity, an independent Gaussian impulse within 2 output bytes, filtered exact aggregation, update/visibility/disposal, resource rebuild, actual engine device replacement, resize and empty input on both backends. `density-scale-browser.mjs` checks every pixel against the histogram of the base observations plus the exact repeated tail at 20M 2MASS and 10M TLC, and an exact single-pixel count of 16,777,217 on both backends. The current compatibility route is explicitly recorded, including its CPU dispatches.

The requested timed comparison against regl-scatterplot at 20M and deck.gl at 10M is deferred by Scott's build-phase speed rule, and remains in the speed-phase inventory. Pixel-only black-box comparisons use the same data, camera window, white point colour, 256 x 256 target and per-observation opacity; losses and visual policy differences must be retained. No rival source is read, copied or adapted, and rival packages are installed outside this repository. Results do not imply frame-rate parity or universal memory limits.

Pixel-only black-box results (2026-11-10, RTX A6000, Edge 157, 256 x 256, same float32 normalized source coordinates, white colour and nominal per-observation opacity 0.08):

| Rival | Real observations tiled to | Mean absolute red-byte difference | Maximum | Pixels differing by more than 2 |
| --- | ---: | ---: | ---: | ---: |
| regl-scatterplot 1.16.0, 1-pixel squares, alpha blending enabled | 20,000,000 2MASS | 0.1480712891 | 246 | 0.2227783203% |
| deck.gl 9.4.1 ScatterplotLayer, 1-pixel circles, antialiasing off, alpha 20/255 | 10,000,000 TLC | 0.0787353516 | 255 | 0.1724243164% |

These are retained non-parity results, including maximum differences; Margo does not claim byte-identical rival images. Margo's captured count-opacity image has zero red-byte difference from its independent analytical count-opacity image in both cases. Margo retains 41,420 occupied pixels for the 2MASS window and 113 for TLC; the rivals show 41,427 and 95. This compares actual images, not an analytical substitute for the Margo capture. Full hardware, versions, histogram counts and policies: [frozen evidence](whitepaper/results/batch181-density.json). Timed comparison remains owed; no speed winner is asserted.

## Why the pixels differ

Measured on 2026-11-27 on the same device (RTX A6000, Edge, ANGLE Direct3D 11) with `node scripts/sciviz-density-attribution.mjs`: both rivals are driven only through their public APIs and probed with coincident points and with single points at 324 sub-pixel positions in two parts of the target, and their images of the real data are then rebuilt from the measured rules one cause at a time. The rules (`scripts/support/density-raster-model.mjs`) predict all 100 stack bytes and all 648 positions of each rival. Report: [attribution evidence](whitepaper/results/density-attribution-2026-11-27.json).

| Renderer | Pixel a point is drawn in | Opacity of n coincident points |
| --- | --- | --- |
| Margo density | the pixel containing the position; every point votes | exact u32 count, then `1 - (1 - a)^n` once |
| regl-scatterplot 1.16.0, squares | position snapped to 1/256 pixel; on a boundary, the left pixel and the lower pixel | matches `1 - (1 - a)^n` rounded once, up to white |
| deck.gl 9.4.1, circles, no antialiasing | the same pixel, only if its centre is within half a pixel of the snapped position | alpha 20/255, rounded to a byte after every point: stops at 249 |

| Compared with the rival's image | Differing pixels of 65,536 | Mean red-byte difference | Maximum |
| --- | ---: | ---: | ---: |
| regl-scatterplot: Margo as drawn | 236 | 0.1480712891 | 246 |
| regl-scatterplot: after its coverage rule | 7 | 0.0034942627 | 207 |
| deck.gl: Margo as drawn | 113 | 0.0787353516 | 255 |
| deck.gl: after its coverage rule | 95 | 0.0086975098 | 6 |
| deck.gl: after coverage and 8-bit accumulation | 0 | 0 | 0 |

- regl-scatterplot: the coverage rule accounts for 229 of the 236 differing pixels. The opacity law changes no pixel. Each of the 7 left over lies next to an observation within 0.000028 pixel of the 1/256 grid's tie, where rounding in the renderer's transform decides the pixel; the largest, 207 bytes, is the size of one star's 20 repeats landing in another pixel.
- deck.gl: the disc covers pi/4 of a pixel, so 2,363,292 of the 10,000,000 points (23.6%) light nothing. That is the whole difference in the 18 pixels Margo lights and deck.gl leaves black. The other 95 are dense pixels where accumulating in 8 bits stops 6 bytes short of white (Williams, Frank and LaMar, 2003). The opacity byte alone changes no pixel at these counts. The rebuilt image equals deck.gl's in every pixel.
- Margo: its float32 projection puts 9 of the 1,000,000 2MASS observations in another pixel than a binary64 binning of the same float32 positions (18 pixels differ in count; in the image one pixel differs, by 2 bytes), each within 0.000011 pixel of a boundary. WGSL has no 64-bit float. The TLC bins agree exactly.

No Margo defect was found: Margo counts every point in the pixel that contains it, to float32 precision, so these differences are kept. The 1/256 grid and its tie direction are measurements on this device, not a promise about other drivers: OpenGL ES 3.0.6 fixes only the square a point covers (3.4.1) and allows either neighbouring byte in the fixed-point conversion (2.1.6.2).

Sources: [OpenGL ES 3.0.6](https://registry.khronos.org/OpenGL/specs/es/3.0/es_spec_3.0.pdf) (Khronos, 2019); [Direct3D 11 rasterization rules](https://learn.microsoft.com/en-us/windows/win32/direct3d11/d3d10-graphics-programming-guide-rasterizer-stage-rules) (Microsoft); P. L. Williams, R. J. Frank and E. C. LaMar, *Alpha Dithering to Correct Low-Opacity 8 Bit Compositing Errors* (Lawrence Livermore National Laboratory, 2003); T. Porter and T. Duff, [*Compositing Digital Images*](https://doi.org/10.1145/800031.808606) (SIGGRAPH 1984).
