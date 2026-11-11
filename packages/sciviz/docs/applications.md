# State and application integration

## Portable state and provenance

Choose the opt-in `/spec` Figure factory before plotting. `toJSON` is asynchronous,
defaults to inline typed arrays and includes timeline frames. Versioned schema/hash
validation precedes resource allocation. URL-backed arrays must be pinned and hash
checked; the document is data, never executable code. Restore custom resource kinds
with application codecs and pipeline names with a trusted registry. Unknown custom
kinds reject; absent pipeline registries preserve dormant descriptions. `/link`
serializes brush and undo history, while timelines retain frame snapshots/options.
Exact-size round trips refer to recorded source arrays and state, not arbitrary
unregistered application closures. A colour map is saved as its 256-entry table; pass
your own maps as the `colormaps` load option (built-ins match on their own) and a saved
map with the same name, kind and table comes back with its exact `sample(t)`, so CPU
colours do not drift to the table's interpolation. `Figure.record` must precede additions to an
existing empty figure.

```ts
import { Colormap } from '@margoengine/sciviz/colormaps';
import { encodeFigureValue, decodeFigureValue } from '@margoengine/sciviz/spec';

const quadratic = new Colormap('quadratic', 'sequential', (t) => [t * t, 0, 0]);
const saved = await encodeFigureValue(quadratic);
const restored = (await decodeFigureValue(saved, { colormaps: [quadratic] })) as Colormap;
console.log(restored.sample(0.123)[0] === 0.123 * 0.123); // true
``` Factories affect only that instance, never a global prototype.

```ts
import { Figure } from '@margoengine/sciviz/provenance';
import { validateFigureSpec } from '@margoengine/sciviz/spec';
import { validateProvenance } from '@margoengine/sciviz/provenance';
import { createShareURL, readShareURL } from '@margoengine/sciviz/share';

using figure = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!, { axes: false });
await figure.scatter({ x: [0,1,2], y: [2,1,3] });
await figure.ready();
const spec = await figure.toJSON();
validateFigureSpec(spec);
const provenance = await figure.provenance();
await validateProvenance(provenance);
const url = await createShareURL(spec, location.href);
console.log((await readShareURL(url)).spec.version, await figure.trace());
```

`/provenance` includes /spec support and successful-call recording. Metadata contains
version, createdAt, spec SHA-256, data digests/type/URL/length/path, package versions
and available GPU/browser identity. Hashes detect accidental changes, not authorship
or trust. `withProvenance` uses current recorded state as the baseline. PNG/SVG exports
embed metadata automatically; `exportProvenancePDF` embeds it in PDF information.
Trace replay retains successful calls, mutations and removals in order, with explicit
resource references/codecs. Defaults: 10000 calls and 256 MiB retained arguments,
excluding the baseline spec. Exceeding bounds makes trace reject rather than silently
truncate. Applications must preserve their codec/registry definitions for replay.

## Share links, embeds and notebooks

`/share` compresses versioned data into a DEFLATE/base64url fragment. The default
32 MiB URL-character bound is a safety cap, not a promise browsers/messaging systems
accept that length. `inlineShareData` resolves pinned URLs for offline export.
`exportStandalone` requires an explicit bundled IIFE runtime including needed optional
entries/assets, built with the package's bundle-share script. It is not a CDN loader.
Camera and zero-based timeIndex deep links apply after validated state restoration.
`serveEmbed`/`connectEmbed` use an exact parent origin/channel and explicit commands/
events; no wildcard trust is implied. Dispose the client/server handles and the
owned Figure, and propagate signal to loading.

`/notebook` implements AFM `render({model,el,...})`, returning cleanup for one view.
Named binary spec attachments preserve byte-view offsets; camera/selection traits
synchronize with the host model. Static export uses the same portable document.
See the [notebook guide](../../../docs/guides/sciviz-notebooks.md) for Python setup,
traits and the complete host contract.

Notebook `render` and offline `startStandalone` accept host-owned `prepareBackend`:
it runs for auto/webgl2 with force false/true and signal, but never for webgpu.
Omit it to use an already installed backend. The shipped Python AFM and offline
bundle provide lazy compatibility installation themselves; sciviz imports none.
Native-only mode bypasses that callback. Setup errors/aborts propagate and clean up
the view. [Backend ownership](../../../docs/sciviz-host-backends.md).

## Accessibility, annotations and picking

```ts
import { Figure } from '@margoengine/sciviz';
import { attachAccessibility, sonificationPlan } from '@margoengine/sciviz/a11y';
import { annotate, annotationMeasure } from '@margoengine/sciviz/annotate';
import { GpuPicking } from '@margoengine/sciviz/pick-gpu';
import { installFigureStats } from '@margoengine/sciviz/monitor';
import { progressiveRendering } from '@margoengine/sciviz/progressive';
import { applyTheme, journalPreset } from '@margoengine/sciviz/themes';

using figure = await Figure.create(document.querySelector<HTMLCanvasElement>('canvas')!);
await figure.scatter({ x: [0,1,2], y: [1,3,2], z: [0,0,0] });
using theme = await applyTheme(figure, 'light');
using progressive = progressiveRendering(figure);
using annotations = annotate(figure);
const ruler = { id: 'distance', kind: 'ruler' as const, points: [[0,0,0],[1,0,0]] as const, unit: 'm' };
annotations.add(ruler);
using access = attachAccessibility(figure, { title: 'Three measured observations' });
await access.ready;
using picker = new GpuPicking(figure);
const monitored = installFigureStats(figure);
await figure.ready();
figure.engine.render();
console.log(monitored.stats.snapshot(), annotationMeasure(ruler),
  sonificationPlan([1,3,2]), journalPreset('nature',1), progressive.state);
console.log(await picker.pick(10,10));
```

`/a11y` attachment owns keyboard focus, summaries, full pageable tables (50 rows/page,
1..1000) and optional custom complete-data adapters. Arrow keys navigate series/
records, Home/End endpoints, Tab leaves; focus is separate from selection. Adapters
retain source precision and must observe signal; call refresh after in-place edits.
Contrast/motion defaults follow media queries. High contrast changes chrome, not
measured colour scales. Reduced motion suspends frame delivery reversibly; retained
playback keeps its promise/options/cancellation and an already stopped engine stays
stopped. Dispose restores prior state. Sonification starts only explicitly after a
gesture: default 10 seconds, 220..880 Hz logarithmic pitch, volume 0.05, maxPoints
100000. Missing observations keep silent slots. Owned AudioContexts close; borrowed
ones stay open. Automated audits are not screen-reader or complete WCAG certification.
[Accessibility contracts/evidence](../../../docs/sciviz-a11y.md).

`/annotate` records text/arrows/lines/rectangles/ellipses/scales/rulers/angles/polylines/
boxes/spheres in physical linear coordinates. Handles are editable by default with
pointer/keyboard and excluded from publication output. Units are labels on physical
lengths, angles are degrees. ROI membership is explicit; volume picking finds the
first classified voxel, grid picking the first cell. Default occupancy is finite
value >0, so supply the actual display classification when different. PNG/SVG and
native spec restoration retain annotation records. Abort/dispose removes handles,
listeners/export integration. Classification predicates are caller supplied, not
an implicit medical interpretation.

`/pick-gpu` adds an async one-pixel integer-ID pass over all points regardless of
draw budget. Defaults: radius 8 CSS px, opacityThreshold 0.002, timeout 30000 ms.
`pick` serializes bounded readbacks and accepts signal. Hover is explicit through
attachHover and reports asynchronous pickerror; disposal restores CPU hover. Original
surface cell/volume voxel IDs differ from CPU nearest-sample picks. CPU depth ties
use normalized depth, independent of layer range. CPU-backed in-place position and
rectangle edits synchronize automatically before queries; invalidate is available
for explicit cache control. Live GPU buffers/textures remain borrowed. Device loss
cancels pending queries; query again after shared-device restoration. [Picking
contract and 2MASS/TCIA demo](../../../docs/sciviz-pick-gpu.md).

## Layouts, monitoring and refinement

`/views` links physical 2D ranges or 3D cameras, including explicitly rendered stopped
engines. FigureLayout owns its canvases/figures; defaults are ceil(sqrt(count)) columns,
320 px height and 12 px gap, with an injectable creation factory. ComparativeGrid
evaluates one portable pipeline independently per time/parameter cell, using the
explicit registry and disposing graph outputs before figures. VolumeQuad creates
three orthogonal slices plus 3D volume, a physical nearest-sample crosshair and
isotropic resize. Signal cancels creation and owns ongoing lifetime; partial layouts
clean up transactionally. External figures linked by LinkedCameras remain borrowed.

`/monitor` explicitly installs `figure.stats`; no frame hook is added. Snapshot
counts/live buffers/textures distinguish unallocated, allocated, released and restored
resources. GPU bytes are descriptor payloads, not driver memory. JS backing stores
deduplicate identity; ordinary arrays use a separate estimate. Unknown custom layers
are marked unavailable, not claimed zero-cost. Track adapters/tables explicitly and
unregister them on teardown. `sweepLimits` emits versioned bounded JSON; timing results
remain deferred. [Inventory scope](../../../docs/sciviz-monitor.md).

`/progressive` owns one controller per engine. Defaults: soft frameBudgetMs 16.7,
movingResolution 0.5, movingSamples 0.25, minima min(0.25,resolution)/min(0.125,samples),
settleFrames 2, refinementFrames 8. Per-view motion/target changes restart refinement,
then return to original full quality at rest. Feedback is submitted-frame latency,
not GPU timestamps or a deadline guarantee. Device restore discards stale targets;
externally owned GPU source recreation remains the application's responsibility.
Disposal removes passes/targets without changing original layer settings. [Progressive
states and real-data test](../../../docs/sciviz-progressive.md).

## Worker readers and themes

`/workers` exports `readInWorker(reader,args,options)`. Pass the reader's actual argument
tuple, including its own options. It returns a disposable session whose `.value`
contains metadata and async proxies to lazy reads. Keep the session until the last
read. Default timeout is 30000 ms, cloned inputs unless transfer lists explicitly
detach buffers. Any cancellation/deadline terminates the session, including synchronous
parsing. Custom stores use cloneable descriptors, not transported closures. Progress
events are ordered start/complete milestones with unique backing bytes, not percentage
estimates. No fallback secretly parses on the page. [Worker guide](../../../docs/sciviz-workers.md).

```ts
import { readInWorker } from '@margoengine/sciviz/workers';

using session = await readInWorker('openNetCDF', [
  new URL('/examples/assets/sciviz/wind-classic.nc', location.href).href,
], { signal: AbortSignal.timeout(30000), timeout: 30000 });
console.log(await session.value.variables.uwnd.read());
```

`/themes` validates copied/frozen tokens and provides dark/light/print/print-mono/
presentation presets. `applyTheme` scopes CSS variables to the Figure/publication roots;
refresh reads authored variable changes, explicit layer options remain authoritative.
Disposal restores prior variables/listeners, leaving the chosen Figure theme.
Journal presets: Nature 89/183 mm, IEEE 88.9/182 mm for one/two columns, height
0.67*width and raster 300 dpi by default. They supply matching media/PDF sizing but
do not certify printer/CMYK profiles or font coverage. [Theme guide](../../../docs/sciviz-themes.md).
