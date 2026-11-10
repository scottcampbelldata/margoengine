# Scientific visualization against the web rivals

Batch 182, 2026-11-10. This page compares `@margoengine/sciviz` with the scientific and charting libraries people
use on the web today. It has four parts: features, measured scenes, accuracy against closed-form answers, and
losses. Nothing here is a speed claim. Every timed number waits for the quiet-machine run (see "Losses and
pending timing"). The public page is [site/sciviz/compare.html](../../site/sciviz/compare.html).

## How to read the feature rows

- Margo cells name the test file or README section that proves the feature. Paths are relative to
  `packages/sciviz/`.
- Rival cells say what the rival's public documentation lists, with the URL, the version and the date it was
  read. We never read rival source code. Six rivals were also installed and run as black boxes; their pinned
  versions are in `scripts/sciviz-compare/manifest.mjs`.
- "Desktop tools" (ParaView, VisIt, 3D Slicer, yt) show what scientists expect from experience. They are an
  expectation, not a score, and they are not rivals of a web library.
- "Not found" means we found no feature, export or test with that name in Margo. It does not mean the work is
  impossible. Those gaps are listed at the end.

Rival documentation read on 2026-11-10: VTK.js 38.0.5 ([API docs](https://kitware.github.io/vtk-js/docs/)), Plotly.js
4.2.0 ([reference](https://plotly.com/javascript/reference/)), deck.gl 9.4.1 ([layers](https://deck.gl/docs/api-reference/layers)),
ECharts 6.1.0 and ECharts-GL 2.1.0 ([features](https://echarts.apache.org/en/feature.html)), regl-scatterplot 1.16.0
([README](https://github.com/flekschas/regl-scatterplot)), Cosmograph 2.5.1
([config reference](https://cosmograph.app/docs-lib/api/interfaces/CosmographConfig/)), Neuroglancer
([data sources](https://neuroglancer-docs.web.app/datasource/index.html)), Bokeh
([linking](https://docs.bokeh.org/en/latest/docs/user_guide/interaction/linking.html)), Vega-Lite
([selections](https://vega.github.io/vega-lite/docs/selection.html), [transforms](https://vega.github.io/vega-lite/docs/transform.html)),
ParaView Glance ([readers](https://kitware.github.io/glance/doc/readers.html)). Unversioned rows are the documentation
current on that date.

## Feature rows

| Row | Margo (evidence) | Web rivals (their docs) | Desktop tools (expectation) |
| --- | --- | --- | --- |
| Chart types | scatter, line, bar, histogram, heatmap, surface, contour, error bars, box, violin, area, density, parallel coordinates, polar, ternary, Sankey and more (`tests/charts.test.js`, `tests/stats.test.js`, `tests/charts-extra.test.js`, `tests/parcoords.test.js`, `tests/contour2d.test.js`), scatterplot matrix with every cell placed to the closed form, cell brushing, flip and reorder on both backends (`tests/splom-browser.mjs`) | Plotly lists 40+ trace types; ECharts 20+ series; Vega-Lite composes marks with transforms | Matplotlib-style breadth |
| 3D scalar volume | 1D and 2D transfer functions, pre-integration, label maps, MIP and MinIP (`tests/volume-modes-browser.mjs`, `tests/minip-kinds-browser.mjs`), ambient occlusion, shadows, GPU and CPU isosurfaces (`tests/transfer.test.js`, `tests/labels.test.js`, `tests/cinematic.test.js`, `tests/fallback.test.js`) | VTK.js volume mapper: composite, additive, MIP, MinIP; Plotly volume and isosurface traces | ParaView and Slicer: all of these plus multi-volume |
| Vector and tensor | quiver, RK4 streamlines, particles and pathlines, LIC, tubes and ribbons, tensor glyphs, DTI fibre tracking (README "Vector fields", `tests/flow.test.js`, `tests/lic.test.js`, `tests/tubes.test.js`, `tests/tensor.test.js`, `tests/tensor-real.test.js`) | Plotly cone and streamtube traces; VTK.js glyph mapper | ParaView stream tracer, LIC, tensor glyphs |
| Volume scale | bricked level-of-detail volumes, OME-Zarr multiscale, N5, precomputed chunks (README "Bricked volumes", `tests/bricks.test.js`, `tests/omezarr.test.js`) | Neuroglancer reads precomputed, N5 and OME-Zarr chunked sources | Out-of-core readers |
| Grid types | image, structured, rectilinear, curvilinear, unstructured, polydata, multiblock, polyhedra, higher-order cells, AMR (`tests/grids.test.js`, `tests/datasets.test.js`, `tests/datasets-elements.test.js`, `tests/amr.test.js`) | VTK.js documents ImageData and PolyData | ParaView: every VTK data type |
| Formats | NRRD, NIfTI, DICOM, Zarr, VTK legacy and XML, NetCDF classic, HDF5, CGNS, Xdmf, Exodus, OpenFOAM, EnSight, FITS, MRC, OME-TIFF, Arrow, Parquet, CSV (`tests/nrrd.test.js`, `tests/formats.test.js`, `tests/climate-formats.test.js`, `tests/hdf5.test.js`, `tests/engineering.test.js`, `tests/astronomy.test.js`, `tests/table.test.js`); Zarr Blosc 1 and Zstandard chunks from real zarr-python and zarr_implementations stores (`tests/formats-spec.test.js`) | ParaView Glance lists its readers through ITK and VTK.js | ParaView and VisIt read hundreds of formats |
| Scale | point budget option, exact binary64 aggregation, additive point octree (README "Figures", `tests/aggregate.test.js`, `tests/pointcloud.test.js`) | deck.gl performance guide, regl-scatterplot and Cosmograph document million-scale rendering | Datashader-style aggregation |
| Interaction | hover, pick, box and lasso, linked selection across figures, cross-filter, annotations, measurement (README "Picking, tooltips and selection", `tests/pick.test.js`, `tests/link.test.js`, `tests/annotate.test.js`) | Bokeh linked brushing; Vega-Lite union and intersect selections | Linked views and rulers |
| Analysis filters | contour, clip, probe, calculator, gradient, glyph in a re-executing pipeline (`tests/datasets.test.js`, `tests/contour.test.js`, `tests/clip.test.js`, `tests/probe.test.js`, `tests/calc.test.js`, `tests/glyph.test.js`); threshold by point or cell, component, magnitude, all or any and one-sided ranges (`tests/clip.test.js`), plot over a polyline with arc-length samples and masks, exact length, area and volume integrals of fields, resample to a dataset or image, warp by vector or scalar (`tests/probe.test.js`, `tests/glyph.test.js`), connectivity regions with all, largest, listed, seeded, closest and scalar modes (`tests/clip.test.js`) | Vega-Lite table transforms; VTK.js has few grid filters | ParaView: all of these |
| Multi-view | linked cameras, comparative grids, orthogonal slice views (`tests/views.test.js`) | Vega-Lite concatenation with shared scales | Slicer and ParaView linked views |
| Publication | PNG with physical size, SVG, vector 3D, PDF, TeX labels, video (`tests/export-media.test.js`, `tests/export-vector.test.js`, `tests/pdf.test.js`, `tests/math.test.js`; video in `tests/export-media-browser.mjs`) | Plotly static export (3D rasterized), Bokeh SVG and PNG export | Vector and raster export |
| Accessibility | ARIA summaries, keyboard data navigation, sonification (`tests/a11y.test.js`) | ECharts ARIA descriptions and decals; Vega-Lite ARIA on SVG | Little |
| Notebook | Jupyter widget through anywidget (`tests/notebook.test.js`, `python/`) | Plotly, Bokeh, pydeck, Altair widgets | Jupyter |
| Sharing | versioned figure spec, URL state, standalone HTML, provenance (`tests/spec.test.js`, `tests/share.test.js`, `tests/provenance.test.js`) | Neuroglancer URL state; Glance standalone HTML | State files |
| Geo and time | tile level of detail, vector tiles, time-dynamic layers, CF conventions, projections (README "Geographic layers", `tests/geo-lod.test.js`, `tests/geo-vector.test.js`, `tests/geo-time.test.js`, `tests/cf.test.js`, `tests/projections.test.js`) | deck.gl tile and geo layers; CesiumJS globe | GIS tools |
| Platform | WebGPU first, native WebGL2 path, GPU picking, progressive rendering (README "A first WebGPU figure", "Native WebGL2 drawing", `tests/webgl2.test.js`, `tests/pick-gpu.test.js`, `tests/progressive.test.js`) | WebGL2 throughout; deck.gl documents partial WebGPU | Native GPU |

## Measured scenes

`npm run sciviz:compare` runs each case in one headless page: Margo and one rival draw the same data at 256 x 256
pixels with the same camera, background and colour. Six rivals are installed outside this repository under the
engine-bench folder (`MARGO_ENGINE_BENCH` overrides it). Only their documented public APIs are called.

| Scene | Rival | Real data | Scales in the timed run |
| --- | --- | --- | --- |
| volume | VTK.js | MRI head (`examples/assets/sciviz/head.nrrd`), one shared nearest-neighbour cube | 64, 128, 256, 512 voxels per axis |
| isosurface | VTK.js | the same MRI cube, level 0.5 | 32, 64, 128, 256 voxels per axis |
| scatter | Plotly, deck.gl, ECharts-GL, regl-scatterplot | NYC TLC taxi trips (`limits/taxi.csv`), distance against fare | 1,024 to 16,777,216 points |
| line | Plotly, ECharts-GL | the same taxi rows as one polyline | 1,024 to 1,048,576 vertices |
| heatmap | Plotly | taxi rows binned on both sides from one shared count grid | 32 to 1,024 cells per axis |
| streamlines | VTK.js | NOAA daily mean winds (`wind.bin`) | 8 to 512 seeds per axis |
| graph | Cosmograph | OpenAlex citation graph (`tests/fixtures/graph-gpu/openalex.json`) | 1 to 256 copies |
| tiles | deck.gl | the repository's geo level-of-detail tiles | zoom 1 to 6 |

Rows past the source size repeat the source rows and say so in the JSON (`replicated: true`); nothing is
synthesized or resized silently. Each run records the commit, GPU, browser, driver and CPU load, the image
difference of the last pair, exact repeat-frame equality on both sides, public GPU API call counts per frame and
memory where the library exposes it.

### Smoke results (one run, no timing)

The smoke on 2026-11-10 (RTX A6000, Edge 157 headless, the batch 182 tree before its commit, so the record says `dirty: true`) ran every scene once at its first scale with `--runs=1`. No clock was read. Every case
drew a non-empty image and repeated it byte for byte on both sides. The raw records are in
[results/batch182-smoke.json](results/batch182-smoke.json).

| Scene | Rival | Mean RGB difference (0 to 255) | Pixels over 8 levels | Margo draws / passes per frame | Rival draws per frame |
| --- | --- | --- | --- | --- | --- |
| volume (64) | vtk | 0.34 | 0.8 % | 5 / 9 | 1 |
| isosurface (32) | vtk | 2.60 | 4.3 % | 1 / 3 | 1 |
| scatter (1024) | plotly | 1.26 | 3.3 % | 1 / 3 | 1 |
| scatter (1024) | deck | 0.97 | 3.3 % | 1 / 3 | 1 |
| scatter (1024) | echarts | 1.34 | 4.1 % | 1 / 3 | 1 |
| scatter (1024) | regl | 1.15 | 3.3 % | 1 / 3 | 2 |
| line (1024) | plotly | 1.03 | 4.5 % | 1 / 3 | none (PNG or SVG path) |
| line (1024) | echarts | 1.81 | 6.1 % | 1 / 3 | 1 |
| heatmap (32) | plotly | 0.01 | 0.0 % | 1 / 3 | none (PNG or SVG path) |
| streamlines (8) | vtk | 4.46 | 15.1 % | 1 / 3 | 1 |
| graph (1) | cosmograph | 23.06 | 34.9 % | 2 / 3 | 3 |
| tiles (1) | deck | 4.71 | 23.3 % | 4 / 3 | 4 |

Image differences are observations, not pass marks. They come from different antialiasing, point and line
rasterization, interpolation and storage precision. They are not used to accept or reject a run. The graph row
has the largest difference: Cosmograph draws links dimmer than the shared colour at width 1 and adds an
attribution overlay outside its canvas; the node layout matches.

### Explicit differences in work

- **Volume:** Margo captures scene depth and composes the volume with opaque geometry through its multisample frame
  graph: 9 render passes, 5 draws, 3 buffer writes per frame against one VTK.js draw. This supports clipping volumes
  against geometry and stays. Margo stores normalized scalars as half floats; VTK.js receives float32.
- **Plotly:** both sides go through PNG export and decode in that pairing, because Plotly's static image route is its
  documented capture path.
- **Cosmograph:** it keeps its own animation loop; two idle animation frames record its draws with no frame
  requested (`work.idleTwoAnimationFrames` in the JSON). That work also runs during Margo's samples.
- **ECharts-GL and regl-scatterplot** run on WebGL1 contexts; deck.gl, VTK.js and Cosmograph on WebGL2; Margo on
  WebGPU.

## Accuracy against closed-form answers

All four run in the normal sciviz CPU tests. Each runs at two resolutions and requires the error to fall by more
than three times when the spacing halves (second order gives four), and the fine error to stay below the grid
spacing squared.

| Reference | Margo result | Test |
| --- | --- | --- |
| Beer-Lambert: pre-integrated opacity of constant extinction and linear colour | alpha within 1/510, colours within 0.0021 of the analytic integral | `tests/transfer.test.js` "preintegration matches constant optical depth" |
| Sphere r = 0.7 isosurface, area 4 pi r^2 and volume 4/3 pi r^3 | relative error 0.25 % then 0.062 % (area), 0.47 % then 0.12 % (volume) at 33 and 65 samples per axis | `tests/analytic-references.test.js` |
| ABC flow streamline (A = sqrt 3, B = sqrt 2, C = 1), against a float64 RK4 of the analytic field | end-point distance 0.0053 then 0.0013 after one time unit | `tests/analytic-references.test.js` |
| Isoline of x^2 + y^2 = 0.25 | largest radial error 0.00094 then 0.00024, one closed line | `tests/analytic-references.test.js` |

Rival accuracy rows are not measured: running these references through the rivals needs their own extraction APIs
and is listed as open work.

## Losses and pending timing

| Loss | Cause | Plan |
| --- | --- | --- |
| Volume-64 frame slower than VTK.js 38.0.5 (1.500 against 1.300 ms, busy machine, diagnostic, perf history entry 102, known-bugs) | The historical scene used unequal sampling and lighting; Margo also does depth capture and composition (above). Two matrix allocations per frame were removed with an exact work-count test | Quiet rerun of legacy-64 and the isotropic 64 and 128 controls ([sciviz-rivals.md](../sciviz-rivals.md)); a loss on the like-for-like control is fixed as a bug |
| Every other scene | Not timed yet | Quiet run: `--runs=7`, every scale, sweeps to the 16.7 ms frame and to failure; every loss lands in this table |

Timing pending the quiet rerun. The quiet run publishes every sample, both minima and the environment, losses
included.

## Not found in Margo today

Multi-component and general multi-volume compositing. This is listed in docs/known-bugs.md
under "Sciviz comparison gaps".

## Reproduce

```sh
npm run build:packages
npm run sciviz:compare -- --runs=1            # smoke: installs the rivals outside the repo, no clock
npm run sciviz:compare -- --list              # every case and scale
node --test packages/sciviz/tests/analytic-references.test.js packages/sciviz/tests/transfer.test.js
```

The timed run needs the active speed phase (`MARGO_SPEED_PHASE=active`) and takes the GPU alone; see
[reproduce.md](reproduce.md).
