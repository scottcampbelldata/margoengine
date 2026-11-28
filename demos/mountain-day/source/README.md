# Mountain Day

Silverpass is a fictional glacial range drawn live in Margo Engine at one world unit per metre. The time slider and four named stops redraw the scene in three dimensions. Play advances 24 hours of equinox solar time in 40 seconds at 44.4° north. The solar position is analytical. Cloud cover, altitude, wind and growth follow a designed sequence. The star field and first-quarter Moon are stylized.

## Art and rendering

The 44 × 43 km height field uses 513 × 513 original samples. The opening uses every fourth row and column of that field for a 129 × 129 terrain mesh. A compact Margo frame pass renders the mesh, sky, direct sun, cloud layer and night colour on native WebGPU or Margo's small WebGL2 renderer. The two opening shaders share their colour model. Both views take the same camera, time and sun direction. The opening sky uses one planar cloud layer.

The full scene streams in a dedicated renderer worker where OffscreenCanvas is available. Its Hillaire sky, ray-marched clouds and aerial perspective share the same sun direction. Margo terrain clipmaps, four original textured surfaces, a seeded scatter of 45,000 conifers and baked octahedral imposters provide the view’s scale. The night pass uses depth to keep stars behind the terrain. The page keeps rendering the opening terrain and solar time while the worker loads data and prepares GPU work. It reveals the full scene after its frame matches the current camera and time. A browser without OffscreenCanvas initializes the same full scene on the page thread.

Run **node bake-map.mjs** in this folder to regenerate both height fields. A reversible horizontal and vertical predictor and two byte planes preserve the original values inside each gzip file. The Margo Engine source pin is **0efd9cff8230507a32deb49907ecd499d46925f5**.

## Verification

The full height asset matched all 263,169 original samples. An actual slider touch changed the terrain, lighting and time. A second touch confirmed that the controls remain usable while full detail streams. The full renderer passed dawn, cumulus, sunset, stars, and play, pause and replay checks.

| Browser profile | First usable frame | First rendered input | Full atmosphere |
| --- | ---: | ---: | ---: |
| 390 px phone, native WebGPU | 1.730 s | 2.165 s | 6.236 s |
| 390 px phone, automatic WebGL2 | 1.454 s | 1.976 s | 13.748 s |
| 390 px phone, forced WebGL2 | 1.160 s | 1.479 s | 8.594 s |
| 1440 px desktop, native WebGPU | 0.412 s | 0.503 s | 2.396 s |

Phone measurements are from cold Chrome emulation at 150 ms latency, 1.6 Mbps downstream and fourfold CPU slowdown. Compatibility performance varies with the first full-scene shader submission. The complete atmosphere streams beyond the first interaction on both backends.

## References

- Sébastien Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*, 2020. [Eurographics](https://doi.org/10.1111/cgf.14050)
- NOAA Global Monitoring Laboratory, *General Solar Position Calculations*. [Solar hour angle and zenith equations](https://gml.noaa.gov/grad/solcalc/solareqns.PDF)
- Andrew Schneider and Nathan Vos, *The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn*, 2015. [SIGGRAPH course](https://advances.realtimerendering.com/s2015/index.html)
- U.S. Geological Survey, *Geology of Grand Teton National Park*. [Cirques, high ridges and glaciation](https://www.usgs.gov/geology-and-ecology-of-national-parks/geology-grand-teton-national-park)
- WHATWG HTML Living Standard. [OffscreenCanvas rendering on a worker](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface)