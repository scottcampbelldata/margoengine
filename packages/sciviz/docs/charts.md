# Charts and linked data

## Stable row identities

`/link` provides `SelectionStore`, `bindSelection` and `selectionOperation`.
Use unique finite-number/string keys, not current layer order. Bind row IDs for raw
marks or groups of keys for aggregate marks. Dispose bindings before replacing layers.
Defaults are fixed universe, global brush resolution, empty:true and 32 history edits.
Union/intersect resolution retains one brush per source; missing brushes add no
constraint, while an explicit empty brush rejects all rows. Open universes admit
streamed keys and enumerate explicit selections only. Operations are replace, union,
intersect, toggle and subtract; Shift toggles, Ctrl/Meta adds, Alt intersects.

```ts
import { SelectionStore } from '@margoengine/sciviz/link';
import { ColumnarTable, CrossFilter } from '@margoengine/sciviz/table';
import { QuerySelection } from '@margoengine/sciviz/query';

const table = new ColumnarTable({ time: new Float64Array([0,1,2]),
  value: new Float64Array([2,5,9]) });
using filter = new CrossFilter(table);
using dimension = filter.dimension('value');
dimension.filterRange(2,9); // Lower inclusive, upper exclusive.
using selection = new SelectionStore(['a','b','c']);
using query = new QuerySelection(table, { rowIds: ['a','b','c'], selection });
query.select('value > mean(value)');
console.log([...filter.rows()], query.rows(), query.series('time','value'));
selection.undo();
using restored = SelectionStore.fromJSON(selection.toJSON());
console.log(restored.rowIds);
```

Store notifications expose source, active, revision and lazy row IDs. Subscriptions
accept AbortSignal/unsubscribe. Bindings own aligned f32 masks (one per mark, minimum
16 bytes), rebuild on device restoration, and restore visibility on disposal. Default
fade brightness is 0.12; highlight/filter are explicit modes. Numerical bins are not
recomputed by visual selection. The [linked-stars guide](../../../docs/sciviz-link.md)
states aggregate membership semantics and the real 2MASS sample's selection bias.

## Tables, predicates and spreadsheets

`/table` reads CSV, Arrow IPC and Parquet into `ColumnarTable`. Borrowed immutable
typed columns preserve physical widths, int64, units, dictionary categories and an
LSB-first null bitmap. Null and numeric NaN are distinct. `take` owns its copied
storage. `CrossFilter` ANDs indexed dimensions; range is [lower,upper), exact sets
can explicitly include null. CPU/GPU aggregates have their declared precision and
supported types; do not downcast int64/decimal values merely for chart convenience.
`bindTableAggregate` refreshes linked output and owns only its binding/layers.
The TLC table demo records format and numeric limits alongside the source data.

`/query` accepts an inert numeric calculator predicate. Unary min/max/sum/mean/count
reduce over the complete table, ignoring null/nonfinite values; binary min/max are
componentwise. Missing/nonfinite comparisons are false. Syntax failures leave the
selection unchanged. Numeric calculations use binary64; exact typed extraction
preserves storage, but the calculator is not an exact arbitrary-int64 query engine.
`series` returns an owned, time-sorted snapshot with original keys; `plot` must be
called again after selection changes and owns its resulting layer. Empty/singleton
selections draw no line. `Spreadsheet(container,query,options)` is sortable/read-only
with bounded DOM, click/Space selection and modifier algebra. Defaults: rowHeight 28,
columnWidth 160, height 360, overscan 3, all columns, selectedOnly false. Dispose or
abort removes its view/listeners, leaving the table/query alive.

`/parcoords` creates parallel coordinates and scatter matrices using common row keys
and shared scales. Reorder/flip axes and apply axis/cell brushes without changing key
identity. Pixel-density rendering counts the actual pixel bins; CPU and compatibility
paths implement the same rule. Its 2D CustomLayer declaration is deliberate. Dispose
the chart owner to remove listeners/layers, never the caller's table or selection.

A scatterplot matrix (SPLOM) puts column `cx` against column `cy` in the cell at column `cx`, row `cy` from the top:
each table row draws at `(cx + u[cx], d - 1 - cy + u[cy])` in matrix units, where `u` is the row's value on that
column's shared scale (0 to 1) and `d` the number of columns. The diagonal shows a 32-bin histogram of the selected
rows. `brushCell(x, y, xRange, yRange)` selects the rows inside both inclusive physical ranges.
`tests/splom-browser.mjs` checks every cell against that formula on both backends.

```ts
import { scatterMatrix } from '@margoengine/sciviz/parcoords';
import { ColumnarTable } from '@margoengine/sciviz/table';

const table = new ColumnarTable({
  x: Float64Array.of(2, 7, 5),
  y: Float64Array.of(3, 6, 8),
  z: Float64Array.of(9, 1, 4),
});
const splom = await scatterMatrix(document.querySelector('canvas')!, table, {
  axes: ['x', 'y', 'z'].map((column) => ({ column, domain: [0, 10] as [number, number] })),
  rowIds: ['a', 'b', 'c'],
});
splom.brushCell('x', 'y', [1, 6], [2, 7]); // selects row 'a' only
console.log([...splom.selection.rowIds]);
splom.reorder(['z', 'x', 'y']);
```

## Statistical and additional chart families

`/stats` produces owned data-space vector marks and SVG without a Figure/device.
Families: asymmetric error bars, Tukey boxes, Gaussian-KDE violins, area/stacked/step,
empirical CDF, QQ, density, hexbin and linear/robust trend. `/maths` exposes reusable
statistical computations. Missing/nonfinite observations are handled by each helper's
declared policy, never imputed as zero. Tukey whiskers are adjacent observations;
KDE bandwidth and trend confidence assumptions are model choices, not guarantees
for dependent or biased samples. Defaults include box width 0.6, violin maximum
half-width 0.4, SVG 800x480 and padding 58. The GHCN/NASA vector demo retains source
provenance and labels the computed statistics.

```ts
import { boxChart, cdfChart, stepChart } from '@margoengine/sciviz/stats';
import { polarChart, pieChart, ternaryChart } from '@margoengine/sciviz/charts-extra';
import { contour2D, scatteredContour2D, contourSVG } from '@margoengine/sciviz/contour2d';

console.log(boxChart([{ label: 'observations', values: [1,2,3,5,8] }]).toSVG());
console.log(cdfChart([1,2,2,4]).toSVG(), stepChart([0,1,2],[1,3,2]).toSVG());
console.log(polarChart([0,1,2],[1,2,1]).toSVG());
console.log(pieChart([{ label: 'A', value: 2 }, { label: 'B', value: 3 }]).toSVG());
console.log(ternaryChart([[1,2,3],[3,2,1]]).toSVG());
const contours = await contour2D({ x: [0,1], y: [0,1], values: [0,1,1,2] }, { levels: [0.5,1.5] });
const scattered = await scatteredContour2D([[0,0,0],[1,0,1],[0,1,1]], { levels: [0.2,0.8] });
console.log(contourSVG(contours), contourSVG(scattered));
```

`/charts-extra` owns scales/layout/SVG for polar/wind rose, ternary, candlestick/OHLC,
pie/donut, sunburst/treemap, Sankey/alluvial, radar and calendar heatmaps. Supply
consistent angle, date and value conventions from the typed options; these are
independent charts, not implicit Figure axis transformations. Hierarchical/flow
inputs must satisfy finite size and graph constraints. The NOAA/EIA demo documents
units and retained observations. Layout helpers expose their cells/flows for inspection.

`/contour2d` uses monotone ascending/descending rectilinear axes, x-fastest values
and at most 256 increasing finite levels. NaNs mask incident cells. Grid saddles use
bilinear disambiguation; scattered data use Delaunay interpolation inside the convex
hull and reject coincident sites. Bands span adjacent levels, rings use even-odd holes.
`contourSVG` defaults to 800x500, padding 36, labels true, lineWidth 1, blue/red bands;
labels are inline with a halo. Both builders accept signal. The climate demo makes
the interpolation and physical units explicit.

## Formatting and live data

`/format` attaches `polishFigure` to an existing 2D Figure after native resources
settle. It owns axis chrome/listeners and borrows the Figure/traces. Original data
coordinates remain available to hover even when plot coordinates are normalized.
Secondary/broken axes, insets, visibility, range selectors and controller.toSVG
share those mappings; use the controller exporter for custom axes/insets. Defaults:
existing domains, four minor ticks, crosshair/unified hover true. `setLimits` on a
scaled Figure uses physical data units; `space:'plot'` requests portable plot windows.
`/categorical` supplies band scales, deterministic jitter, RGB image traces and
single/complete/average hierarchical clustering. Supply category ordering and image
scale explicitly when physical meaning depends on them; clustering isn't a class
label inference or a statistical confidence result.

`/stream` attaches serialized append/patch to the actual line/scatter identity.
All supplied channels have matching lengths; patches replace only specified channels.
Original double-precision `streamData` survives display normalization. Default rollover
is 10000 (maximum one million). Each call snapshots input and publishes only complete
replacements; transient CPU/GPU allocation is possible. `disposeStream` ends streaming,
leaving layer disposal to its owner. It composes with `/format` without losing original
coordinates. `SlidingTimeWindow` duration is milliseconds for date axes, smoothing
defaults to 250 ms, and `advance(elapsed)` supports deterministic caller clocks.

WebSocket, SSE and polling adapters expose async iterators; callers own iterator
cleanup. Cancellation while SSE awaits bytes cancels the pending read and preserves
the exact reason. SSE defaults Accept to text/event-stream only when the caller
omits Accept; explicit overrides, including an empty value, remain unchanged.

```ts
import { Figure } from '@margoengine/sciviz';
import { polishFigure } from '@margoengine/sciviz/format';
import { streamLayer } from '@margoengine/sciviz/stream';
import { bandScale, jitterCategories } from '@margoengine/sciviz/categorical';
import { readCSV } from '@margoengine/sciviz/table';

using figure = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!, { mode: '2d' });
using polish = await polishFigure(figure);
const trace = await polish.line({ x: [0,1], y: [1,2] });
const live = await streamLayer(figure, trace, { data: { x: [0,1], y: [1,2] }, rollover: 100 });
await live.append({ x: [2], y: [4] });
await live.patch(1, { y: [3] });
console.log(live.streamData, readCSV('x,y\n0,1\n1,2\n').length,
  jitterCategories(['A','B','A'], bandScale(['A','B'])));
console.log(await polish.toSVG());
live.disposeStream();
```

## Colour and publication

`/colormaps` exports construction names (`colormapNames`/`describeColormap`), Tol
category schemes, Machado CVD diagnostics, `colorScale` and `encodingLegend`.
Domains/ranges, bins and under/over/missing colours survive export/state. Tol palettes
are finite category domains, not continuous ramps with unlimited distinguishable
categories. CVD simulation is a diagnostic, not proof of accessibility. Legends
support colour, size and shape. [Colour contracts](../../../docs/sciviz-colors.md)
give definitions, precision bounds and original author references.

`/export-vector` snapshots figure layers/scene and uses BSP ordering and colour facets
within explicit budgets. Unsupported appearance requires an explicit raster fallback;
it does not silently claim vector fidelity for every shader. [Vector export guide](../../../docs/sciviz-vector-export.md).
`/pdf` exports supported figure SVG to PDF 1.7; caller-owned OutlineFont coverage is
required, unknown operations reject. Default physical size is CSS px at 96 dpi,
widthMM preserves aspect. `/math` supplies inert bounded TeX parsing, native MathML
and shared PNG/SVG/PDF outline overlays. It has no macro/code evaluation and does
not claim exact TeX/OpenType-MATH layout. Outlined PDF text is not searchable.
[Publication syntax, font ownership and limits](../../../docs/sciviz-publication.md).

`/export-media` owns explicit sizing/alpha/DPI/tiled capture, ZIP sequences and video
exports, restoring camera/timeline/playback state after success or failure. Tiled
images are separate owned outputs; do not treat a tile as a whole-frame screenshot.
Provenance travels with supported exports. Codec/browser and maximum-canvas limits
remain explicit in the [media guide](../../../docs/sciviz-media.md).

Named-layer removal hides an empty default legend using native hidden semantics;
adding a named layer restores it without leaving hidden spacing behind.

```ts
import { Figure } from '@margoengine/sciviz';
import { parseTTF } from '@margoengine/loaders/font';
import { addMathLabel } from '@margoengine/sciviz/math';
import { exportPDF } from '@margoengine/sciviz/pdf';
import { exportVector } from '@margoengine/sciviz/export-vector';
import { exportImage } from '@margoengine/sciviz/export-media';

using figure = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!, { mode: '2d' });
await figure.line({ x: [0,1,2], y: [1,3,2] });
const response = await fetch('/examples/assets/sciviz/publication/DejaVuSerif.ttf');
if (!response.ok) throw new Error(`Font fetch failed: ${response.status}`);
const font = parseTTF(new Uint8Array(await response.arrayBuffer()));
using formula = addMathLabel(figure, 'x^2', { font, x: 20, y: 20 });
await figure.ready();
const vector = await exportVector(figure);
const pdf = await exportPDF(figure, { font, widthMM: 89, title: 'Three observations' });
const png = await exportImage(figure);
console.log(vector.mode, pdf.size, png.size);
```

The font URL is a licensed repository asset; serve the checkout with the command in
the main README. An application supplies its own licensed font with glyph coverage.
