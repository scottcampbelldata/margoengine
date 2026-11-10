# Large data and geography

## Aggregation and projected density

`/aggregate` visits every selected row from a ColumnarTable/CrossFilter. Coordinate
columns describe points, segments, area trapezoids, triangles or quads; mesh values
are cell values. Defaults: points, 256x256 bins, value 1, chunkRows 32768 (max 65536).
Counts, finite counts, binary64 sums/means, extrema, first/last/source row and category
counts remain separate from shading. Missing coordinates exclude primitives; missing
values exclude numeric statistics only. First/last follow source order. Empty bins
have sum 0 and NaN nonadditive statistics. Final upper domain edges are inclusive.

```ts
import { ColumnarTable } from '@margoengine/sciviz/table';
import { aggregateRaster, shadeAggregate } from '@margoengine/sciviz/aggregate';
import { TimeSeries, downsampleSeries } from '@margoengine/sciviz/series';
import { climateProjection } from '@margoengine/sciviz/projections';
import { prepareGeoTrack, geoPositionAt } from '@margoengine/sciviz/geo-time';
import { greatCircleArc } from '@margoengine/sciviz/geo-vector';

const table = new ColumnarTable({ x: new Float64Array([0.1,0.2,0.8]),
  y: new Float64Array([0.1,0.2,0.8]), value: new Float64Array([1,2,3]) });
const raster = await aggregateRaster(table, { columns: { x: 'x', y: 'y' }, value: 'value',
  bounds: [0,1,0,1], width: 4, height: 4 });
console.log(raster.at(0.1,0.1), shadeAggregate(raster));
const series = new TimeSeries({ x: [0,1,2,3,4], y: [1,5,2,8,3] });
console.log(downsampleSeries(series, { width: 2 }));
const projection = climateProjection('mercator');
console.log(projection.forward(-74,40.7));
const track = prepareGeoTrack({ id: 'track', times: [0,10], positions: [170,0,0, -170,0,0] });
console.log(geoPositionAt(track,5), greatCircleArc([170,0],[-170,0]));
```

Omit gpu for the exact CPU reference; GPU values retain binary64 words and exact
integer accumulation, rounded once. Geometry uses the documented projected raster
model, not arbitrary analytical coverage. `shadeAggregate` and circular spreading
alter only display colours. Incremental spreading uses neighbour presence density,
clips at edges and leaves numerical bins unchanged. `bindRasterAggregate` refreshes
after pan/filter changes; call refresh after programmatic limits. Bounds, cancellation,
staging/output memory and the explicitly repeated-observation 100M proof are detailed
in the [aggregation guide](../../../docs/sciviz-aggregate.md). No speed claim follows
from that count proof.

`/density` is all-point drawing-buffer occupancy, separate from data-space aggregates.
Defaults: 2D count mode, opacity 0.08, colour #56b4e9; kernel mode uses bandwidth 4
pixels (max 32), support ceil(4*bandwidth) and zero extension/clipping at plot edges.
Integer counts are exact; smoothing is a display summary, not normalized continuous
KDE. Direct xyz arrays or an existing scatter can supply points; disposing a replacement
restores the source scatter. Mutated borrowed arrays require invalidate, while replaced
scatter arrays are detected. Render before readCounts; timeout defaults to 30000 ms.
Restore rebuilds resources and cancels stale reads. Compatibility currently counts
through its CPU compute tier and smooths on GPU. `aggregate` uses the exact table
contract rather than reading smoothed pixels. [Density limits, 2MASS/TLC and real
implementation differences](../../../docs/sciviz-density.md).

## Cloud volumes and point clouds

`/omezarr` opens OME-Zarr 0.4/0.5, N5 and Neuroglancer precomputed stores through
explicit adapters. Stored-level sources preserve level selection, bounds, scalar
ranges and chunk origins. No invented pyramid level or implicit full-volume read
is substituted for missing metadata. Codec refusals are explicit. HTTP Range/CORS,
fetch headers, immutable objects, cancellation and resident cache budgets are part
of the cloud-store contract. The three scientific crop demos retain manifests with
the actual regions, level and provenance; their crops are not whole-dataset proofs.

`/pointcloud` exposes asynchronous `pointcloud` and `openPointCloud`. Supply an
OctreeSource or choose the documented URL format; source origins are transformed
once into the Figure's data frame. Global attribute maps stay stable across chunks.
Set point/cache budgets for the device, inspect attribute hover and use rectangle
or lasso selections with an open SelectionStore for newly arriving keys. Browser
tests run through the common browser-root launcher. Dispose the layer to cancel
pending loads and release its cache without disposing caller-owned sources/figures.

## Large series and temporal fields

`/series` requires actual byte-Range service: validates Content-Range/body length,
rejects content coding and pins a strong ETag/Last-Modified when present. An unversioned
object must be immutable. Cross-origin servers expose required headers. CSV/Arrow/
Parquet batches stream with signal; iterator return prevents later reads. Defaults:
1 MiB network chunks, 512 MiB encoded/decoded block limit, 100M rows. TimeSeries owns
binary64 blocks with finite nondecreasing x and NaN gaps. Exact original selection
requires retaining loaded observations, so total browser memory is not constant.

Default M4 downsampling preserves original indices and the aliased pixel-column
model's envelope; it does not promise identical fractional antialiasing or thick
joins. Min-max and LTTB are available; LTTB normally also retains extrema, with
preserveExtremes:false for the original threshold rule. `bindSeries` selection events
report original rows; ordinary Figure line hits still refer to displayed vertices.
Progressive load awaits completed draws and supports cancellation. FFT/STFT use
original uniformly sampled observations and explicit positive sample rate, periodic
Hann/mean-removal defaults, physical PSD units, STFT 256-sample complete windows and
half-window hop. [Series ownership, spectral units and limits](../../../docs/sciviz-series.md).

`/temporal` supplies an explicit source contract, streaming reductions with missingness,
interpolation, physical probe charts and numbered/.series readers. Match time units
across source and animation; no browser date guessing replaces scientific time.
Spatial probes inherit locator interpolation/mask rules. [Temporal defaults and
NOAA/ERA5 examples](../../../docs/sciviz-temporal.md).

## Geographic layers

`/geo-lod` owns view-dependent tile selection, bounded cache and fades, with explicit
terrain-stream and quantized-height adapters. Provider attribution is required.
Cancellation/errors and retained restoration remain visible; failed tiles do not
become plausible fabricated terrain. The AWS Terrarium demo includes attribution
and height encoding. Cache capacity is a working-set policy, not whole-Earth memory.

`/geo-vector` lazily parses GeoJSON, TopoJSON and MVT, joins data by explicit keys,
and draws flat/globe layers, labels and great-circle arcs. Projected square/hex bins
retain exact source membership; their side/radius units are projection units, not
implicitly metres. Longitudes/latitudes are degrees and optional height is metres.
Default great-circle arcs use 64 segments, arch 0; deterministic antipodal routing
is a visualization convention. Budgets/signals bound preparation and restoration
uses retained snapshots. See `examples/sciviz-geo-vector.html` and its source manifest.

`/geo-time` snapshots strictly increasing keyframes with longitude/latitude degrees,
height metres and caller-consistent time. Linear interpolation uses shortest longitude;
great-circle/step are explicit. Tracks outside availability return undefined unless
clamped. Trails retain exact clipped endpoints; fadeSteps controls visual fading.
Timeline is caller-owned. SGP4 TLE/OMM propagation uses TEME and explicit conversion
to geographic coordinates; satelliteTrack is an orbital model, not a precision
ephemeris. WMTS time sources select explicit raster times and retain bounded caches,
AbortSignal and restoration; provider availability/attribution remain caller duties.

`/cf` reads named NetCDF planes with explicit coordinate/time/unit/calendar metadata,
all supported CF Appendix D vertical formulas and geographic/projected grids.
`/projections` supplies Snyder forward/inverse transforms: conics, polar stereographic,
Robinson, Mollweide, plate and Mercator. Default radius is 6378137, central meridian 0,
false origin [0,0]; conic parallels [30,60], polar origin +90. WGS84 flattening applies
to conics/polar/Mercator; world projections are spherical. Angles are degrees, outputs
radius units. Singular/out-of-domain transforms return undefined; invalid inputs
reject. CF curvilinear/periodic sampling and masks are explicit. Conservative regrids
report averages and coverage, not fabricated complete observations. The ERA5/CMIP6
demo and clean-room record document supported codecs, formulas and domains.

## GPU graph layout

`/graph-gpu` separates GPUGraphLayout from GraphLayoutReference and draws layout
positions directly on the shared device with gpuGraphLayer. Widths, colours and arrows
are explicit attributes. FDEB bundling has its own disposable resources; candidate
labels require refresh after layout/view changes. Cancel pending steps and release
owners on device loss rather than reusing stale buffers. The OpenAlex demonstration
retains source attribution and layout settings; it is not a claim that a particular
force layout reveals a unique scientific community structure.
