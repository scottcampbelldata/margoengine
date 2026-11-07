# @margoengine/lines

Import `margoengine/lines` from the `margoengine` package, or `@margoengine/lines` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Fat lines with joins, caps, dashes and antialiasing, plus the debug helpers, as a WebGPU engine plugin for Margo Engine.

Build from source with `npm run build` in `packages/lines`.

Exports `Line` and `LineMaterial`, and `GridHelper`, `PolarGridHelper`, `AxesHelper`, `BoxHelper`, `Box3Helper`, `ArrowHelper`, `CameraHelper`, `PlaneHelper`, `VertexNormalsHelper`, `SkeletonHelper` and the light helpers (`PointLightHelper`, `SpotLightHelper`, `DirectionalLightHelper`, `HemisphereLightHelper`, `RectAreaLightHelper`).

```ts
import {Engine, box} from 'margoengine/core';
import {Lines, Line, LineMaterial, GridHelper, AxesHelper, BoxHelper} from 'margoengine/lines';
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas);
const lines = new Lines();
engine.use(lines);

// A polyline 4 CSS pixels wide with round joins, red to blue.
const path = lines.add(new Line({
  positions: [-2, 0, 0, 0, 1, 0, 2, 0, 0],
  colors: [1, 0, 0, 0.5, 0, 0.5, 0, 0, 1],
  width: 4, join: 'round', cap: 'round',
}));

// Dashed segments that follow a mesh, sharing one material.
const mesh = engine.createMesh().setGeometry(box());
const dashed = new LineMaterial({color: '#ffaa00', width: 0.05, worldUnits: true, dashed: true, dashSize: 0.2, gapSize: 0.1});
lines.add(new Line({mode: 'segments', positions: [-1, 1, 0, 1, 1, 0], material: dashed, mesh}));

lines.add(new GridHelper({size: 10, divisions: 10}));
lines.add(new AxesHelper({size: 2, width: 2}));
lines.add(new BoxHelper(mesh));

// Same-size updates reuse the CPU and GPU buffers.
path.setPositions([-2, 0, 0, 0, 2, 0, 2, 0, 0]);
dashed.dashOffset += 0.01;

// On teardown: engine.removePlugin('lines') or engine.dispose().
```

## How it works

- **Instanced screen-space quads.** Each segment is one instance of 78 vertices drawn from a storage buffer of points; there is one draw call per line. The vertex shader projects the segment and its neighbors, then builds the body quad, the join on its end (owned by the incoming segment) and the cap on its start. Miter joins share their corner points with the next segment, so translucent lines have no double-blended overlap; bevel and round joins add a wedge and a 10-triangle fan on the outer side. A miter longer than `miterLimit` times the width falls back to bevel. `expandLine` in this package is the same algorithm on the CPU, in pixels, and the Node tests check it for exact areas and zero overlap.
- **Widths.** Pixel widths are CSS pixels, scaled by the ratio of the render target to the canvas client size. World-unit widths are converted per endpoint from the camera's focal length and the clip w, so thick lines taper with perspective. Lines thinner than one pixel are drawn one pixel wide with proportionally lower alpha.
- **Antialiasing.** Geometry grows by one pixel and the fragment shader ramps coverage over the last pixel of every edge, butt or square cap end and dash end (dash ends use `fwidth` of the distance). This coverage ramp works alongside 4× MSAA on the WebGPU canvas path.
- **Dashes.** Distances accumulate along the line in world space (after the model or mesh matrix) on the CPU, are recomputed only when the points or the matrix change, and are interpolated perspective-correctly. Segment lists accumulate across segments.
- **Depth.** Lines test against the scene depth with reversed-Z `greater-equal` and do not write depth unless `depthWrite` is set (see [Depth writing](#depth-writing)). `onTop` lines use `always` and draw after the depth-tested ones. Endpoints behind the near plane are clipped in clip space, so a line passing beside the camera is cut, not mirrored.
- **Color.** Colors are linear RGB (`'#rrggbb'` and `0xrrggbb` are sRGB and converted, like `PbrMaterial`). Output is sRGB-encoded for unorm canvas formats and left linear for `-srgb` and float targets such as the `rgba16float` target of the post-processing packages. Blending is straight alpha (`src-alpha, one-minus-src-alpha`).
- **Plugin lifecycle.** The pass is `lines:draw` at frame-graph order 20, after the scene, sky and particles and before post-processing resolves at 30. GPU buffers are created lazily per line and rebuilt from the CPU copies in `onDeviceRestored`. `dispose()` (and `engine.removePlugin`) destroys every buffer and the pass; the lines stay registered with the plugin object, so it can be attached again.
- **Mesh attachment.** `mesh` or `line.attach(mesh)` reads the mesh's world matrix from `engineRuntime(engine).store.matrices` each frame. A hidden or disposed mesh hides its lines. Unattached lines use `line.matrix` (identity by default).
- **SSR safety.** Nothing touches `window`, `navigator` or GPU globals at import or construction time.

## Options

`Line` takes the geometry options below plus any `LineMaterial` option. Material fields can also be changed directly at any time (`line.material.width = 3`).

| Option | Default | Notes |
| --- | --- | --- |
| `positions` | none | x, y, z per point |
| `colors` | none | r, g, b or r, g, b, a per point, linear |
| `mode` | `'strip'` | `'segments'` (pairs), `'strip'` (polyline), `'loop'` (closed) |
| `mesh` | `null` | Follow a core mesh's world matrix |
| `matrix` | identity | Model matrix when not attached |
| `material` | new | Share a `LineMaterial` between lines |
| `color` | white | `'#rrggbb'`, `'#rgb'`, `0xrrggbb` or linear `[r, g, b]` |
| `opacity` | `1` | 0..1 |
| `width` | `1` | CSS pixels, or world units with `worldUnits` |
| `worldUnits` | `false` | |
| `join` | `'round'` | `'miter'`, `'round'`, `'bevel'` |
| `cap` | `'round'` | `'butt'`, `'round'`, `'square'` |
| `miterLimit` | `4` | Miter length over width before falling back to bevel |
| `dashed`, `dashSize`, `gapSize`, `dashOffset` | `false`, `1`, `1`, `0` | World units |
| `dashCap` | `'butt'` | The shape of each dash's ends: `'butt'`, `'round'` or `'square'`; see [Dash caps](#dash-caps) |
| `vertexColors` | when colors exist | |
| `onTop` | `false` | Skip the depth test |
| `depthWrite` | `false` | Write depth: crossing lines occlude each other and later passes respect them |
| `alphaToCoverage` | `false` | Turn alpha into MSAA coverage instead of blending; see [Alpha to coverage](#alpha-to-coverage) |
| `behind` | `false` | Draw only where the scene is in front of the line; see [Hidden lines](#hidden-lines) |
| `depthBias` | `0` | Fraction of its distance the line moves nearer for depth tests, 0 up to 1, so edges on a surface do not flicker |
| `antialias` | `true` | |
| `fog` | `true` | Fogged by the plugin's `setFog`; `false` keeps the line clear |

`new Lines({name, order})` sets the plugin name (default `'lines'`) and pass order (default `20`). `lines.stats` reports lines, segments and draw calls of the last frame.

Helpers are `Line` subclasses and take the material options too (they default to butt caps and miter joins): `GridHelper({size, divisions, color1, color2})`, `PolarGridHelper({radius, sectors, rings, divisions, color1, color2})`, `AxesHelper({size})`, `Box3Helper(min, max, {color})`, `BoxHelper(mesh, {color})` (world bounds every frame), `ArrowHelper({direction, origin, length, color, headLength, headWidth, solidHead})`, `CameraHelper(camera, {aspect})` (unprojects `camera.matrix`), `PlaneHelper({normal, constant, size, color, fillOpacity})` and `VertexNormalsHelper(mesh, {size, color})` (world space with the normal matrix).

Light helpers (`PointLightHelper`, `SpotLightHelper`, `DirectionalLightHelper`, `HemisphereLightHelper`,
`RectAreaLightHelper`) take the light objects themselves, typed by shape so lines imports neither
`@margoengine/clustered` nor `@margoengine/environment`, and follow their changes each frame:
`PointLightHelper(light, {size})` (three circles), `SpotLightHelper(light, {length})` (the outer cone to the range, or
`length` for an unlimited one, and the inner rim), `DirectionalLightHelper(light, {size, position})` (a square across
the light and a line the way it travels), `HemisphereLightHelper(light, {size, position})` (a sphere, sky colour above,
ground below) and `RectAreaLightHelper(light)` (outline on AreaLights' axes and the normal). Lines take each light's
colour, brightest channel scaled to 1, unless `color` is given. `new LightsHelper(() => lights)` draws a whole list in one
line, for example `lines.add(new LightsHelper(() => [...clustered.list, ...suns.list, hemisphere]))`
(`Clustered.list`, `DirectionalLights.list` and `AreaLights.list` return the lists last set); it rebuilds only when a
value it draws changes and skips anything that is not a light. The Inspector's "Light helpers" toggle uses it.

`BoxHelper` and `VertexNormalsHelper` also accept loader-owned glTF/FBX PBR nodes.
They combine all primitives on the node and use retained CPU bind-pose positions
and normals, transformed by the current world matrix. They perform no GPU readback
and create no core `Geometry`. Hidden ancestors and disposed models suppress the
helper; animation deformation is not reflected in these synchronous helpers.

## Depth writing

`depthWrite: true` makes a line write depth, so the nearer of two crossing lines wins whichever is drawn first, and anything drawn after the lines (a later `Lines` plugin, particles, transparent passes) respects it.

```ts
import {Engine} from 'margoengine/core';
import {Lines, Line} from 'margoengine/lines';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const lines = Lines.attach(engine);
lines.add(new Line({positions: [-2, 0, 1, 2, 0, 1], width: 6, color: '#ff4040', depthWrite: true}));
lines.add(new Line({positions: [0, -2, 0, 0, 2, 0], width: 6, color: '#40ff40', depthWrite: true}));
```

A depth-writing line takes two draws, so its edge stays smooth: the part at least half covered writes depth, then the rest of the edge ramp blends over it without writing. All writers draw before lines that do not write, so those sort against them. With `antialias: false` it is one draw. Dash gaps and parts cut by clipping planes write nothing. Depth is written at the line's centre, also for a translucent line, which then hides what is drawn behind it after it, as a depth-writing translucent mesh does.

## Trails

`Trail` from `margoengine/lines/trail` is a line that follows something and fades behind it: missiles, swords, cursors. It advances with the `Lines` plugin's frames, so there is nothing to call each frame.

```ts
import {Engine, box} from 'margoengine/core';
import {Lines} from 'margoengine/lines';
import {Trail} from 'margoengine/lines/trail';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const lines = Lines.attach(engine);
const missile = engine.createMesh().setGeometry(box(0.2, 0.2, 1));

// Half a second of smoke, orange to grey, thinning to a point. A mesh target follows its world position.
lines.add(new Trail({target: missile, lifetime: 0.5, width: 0.2, worldUnits: true, color: '#ffa030', tailColor: '#606060', tailWidth: 0}));

// The tip of a sword (`offset` in the mesh's space), or a cursor from a function, kept to 4 units of length.
const sword = engine.createMesh().setGeometry(box(0.1, 1, 0.1));
lines.add(new Trail({target: sword, offset: [0, 0.5, 0], lifetime: 0.25, width: 6}));
let cursor: [number, number, number] | null = [0, 0, 0];
const pointer = lines.add(new Trail({target: () => cursor, lifetime: Infinity, maxLength: 4, width: 3}));

// Teleporting? Forget the history, or the trail draws a line to the new place.
pointer.reset();
```

| Option | Default | Notes |
| --- | --- | --- |
| `target` | none | A mesh, or a function returning a world position (null to pause). Without one call `trail.moveTo(x, y, z)`. |
| `offset` | `[0, 0, 0]` | The followed point in a mesh target's local space |
| `lifetime` | `1` | Seconds a point lives; `Infinity` for none |
| `maxLength` | `Infinity` | World units from the head to the end |
| `maxPoints` | `256` | 2 to 65,536. Past this the oldest point goes, so the end jumps: raise it for long trails |
| `minDistance` | `0.05` | World units the head moves before it leaves a point behind |
| `fade` | `1` | Opacity falls as `(1 - part) ^ fade` along the trail, part being the larger of age over `lifetime` and distance over `maxLength`; 0 does not fade |
| `color`, `tailColor` | white, the head's | Colours at the two ends; `trail.setColor(color, tailColor)` changes them |
| `tailWidth` | `1` | Width at the far end as a fraction of the head's, 0..1; ignored on a dashed trail |
| `normal` | none | Lays the trail flat, facing this world direction: `[0, 1, 0]` for a tyre track on level ground. `width` is then world units across, the strip does not turn to the camera, it picks like any line, and `depthBias` keeps it off the ground. Not with `dashed` |

Any `LineMaterial` option applies too. The far end is cut exactly at the limit, between two points, so a trail shrinks smoothly, and a target that stops fades out with the rest of its trail. Like every line a trail faces the camera, unless `normal` lays it flat: a strip of world width that holds still as the camera moves, for a tyre track. It lies facing that one direction, so it does not follow a hill, and its segments are not joined at a corner.

## Massive batches

`LineBatch` from `margoengine/lines/batch` draws millions of independent segments from one buffer in one draw: wire views of huge models, graphs, flow lines. Each segment is one 6-vertex instance of 32 bytes, where a `Line` segment is 78 vertices with joins, caps and dashes.

```ts
import {Engine} from 'margoengine/core';
import {LineBatch, LineBatches} from 'margoengine/lines/batch';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const batches = LineBatches.attach(engine);

// One million random segments, each with its own colour, one draw.
const count = 1_000_000,
  positions = new Float32Array(count * 6),
  colors = new Float32Array(count * 3);
for (let i = 0; i < positions.length; i++) positions[i] = Math.random() * 20 - 10;
for (let i = 0; i < colors.length; i++) colors[i] = Math.random();
const flow = batches.add(new LineBatch({positions, colors, width: 1}));

// A wire view shares points through indices: pairs of point numbers, one pair a segment.
const square = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
batches.add(new LineBatch({positions: square, indices: [0, 1, 1, 2, 2, 3, 3, 0], color: '#40c0ff', width: 2}));

// Change part of a batch: only those segments upload.
flow.updateSegments(10, [0, 0, 0, 1, 1, 1]);
console.log(batches.stats); // {batches, segments, drawCalls} of the last frame
```

| Option | Default | Notes |
| --- | --- | --- |
| `positions` | none | x, y, z per point: two points a segment, or any number with `indices` |
| `indices` | none | Pairs of point numbers, one pair a segment |
| `colors` | white | Linear r, g, b or r, g, b, a, one per point, or one per segment without `indices`. Kept at 8 bits a channel, sRGB encoded |
| `color`, `opacity` | white, `1` | Multiply every segment |
| `width`, `worldUnits` | `1`, `false` | CSS pixels, or world units; under one pixel fades as `Line` does |
| `onTop`, `antialias` | `false`, `true` | As on `LineMaterial`; the ramp runs along the sides |
| `mesh`, `matrix`, `visible` | `null`, identity, `true` | Placement, as on `Line` |

`setSegments(positions, colors, indices)` replaces everything and keeps the buffers when the count stays. `updateSegments(first, positions, colors)` replaces a run of segments and uploads only those. Style fields can be set at any time (`batch.width = 2`).

A batch is one draw while it fits one GPU buffer: 8,388,608 segments at WebGPU's default `maxBufferSize` of 256 MiB, and one further draw for each buffer past that. A batch takes at most 67,108,864 segments. It keeps a CPU copy, 32 bytes a segment, to refill the GPU after a device loss.

Segments are independent: square ends, so those that share a point overlap at the corner, and translucent corners are darker there. There are no joins, round caps, dashes, fog, clipping planes, depth writing or picking. Use `Line` where those matter. WebGPU only.

## Dash caps

`dashCap` shapes the ends of every dash. `'round'` and `'square'` reach half the line width past the dash, so they add that to its length on screen, and a tiny `dashSize` with `'round'` draws a row of dots.

```ts
import {Engine} from 'margoengine/core';
import {Line, Lines} from 'margoengine/lines';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const lines = Lines.attach(engine);

lines.add(new Line({
  positions: [-2, 0, 0, 2, 0, 0],
  width: 8,
  dashed: true,
  dashSize: 0.001,
  gapSize: 0.3,
  dashCap: 'round',   // dots
}));
```

`dashSize` and `gapSize` stay in world units and the cap's reach is in the line's width, so a gap narrower than the line width closes up. Dash ends are drawn in the line's fragment, so a cap never reaches past the line's own ends, and a pick still counts the gaps as line.

## Alpha to coverage

`alphaToCoverage: true` turns a line's alpha into MSAA coverage instead of blending it, so translucent lines and antialiased edges need no draw order, and a line that also writes depth keeps its edge sample by sample.

```ts
import {Engine} from 'margoengine/core';
import {Line, Lines} from 'margoengine/lines';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const lines = Lines.attach(engine);

lines.add(new Line({
  positions: [-2, 0, 0, 2, 0, 0],
  width: 6,
  color: '#2a7de1',
  depthWrite: true,
  alphaToCoverage: true,
}));
```

It takes effect when the engine draws with MSAA, and without MSAA the line blends as usual, so one setting runs everywhere. Opacity comes in steps of one sample: four steps at 4x MSAA. Lines of the same opacity use the same samples, so the later one replaces the earlier one where they cross instead of mixing with it.

## Hidden lines

`HiddenLine` from `margoengine/lines/hidden` draws the part of another line that is behind a surface, dashed or faded: the standard technical drawing view.

```ts
import {Engine, box} from 'margoengine/core';
import {Lines} from 'margoengine/lines';
import {EdgesHelper} from 'margoengine/lines/edges';
import {HiddenLine} from 'margoengine/lines/hidden';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const lines = Lines.attach(engine);
const geometry = box(2, 1, 1);
const mesh = engine.createMesh().setGeometry(geometry);

const edges = lines.add(new EdgesHelper(geometry, {mesh, color: '#20242a', width: 2}));
lines.add(new HiddenLine(edges, {dashSize: 0.08, gapSize: 0.06}));   // dashed
// Faded instead: lines.add(new HiddenLine(edges, {dashed: false, opacity: 0.2}));
```

A `HiddenLine` takes any `LineMaterial` option. It starts from its source's colour and width, dashes of 0.1 and gaps of 0.1 world units, opacity 0.5 and butt caps. It follows the source's points, mode, matrix, mesh and visibility, and draws while the source is in a plugin. Add the source first.

Underneath it is a line with `behind: true`, which turns the depth test around. An edge lying on a surface sits at the surface's own depth, so a test either way flickers along it; `depthBias` (0.001 here, and given to the source too when it has none) moves both lines that fraction of their distance nearer, so edges on a surface count as seen. Raise it if a far, large model still flickers; too high and edges just behind a surface count as seen. Hidden lines test against what has drawn depth before them, so meshes count and transparent surfaces that write no depth do not. They do not pick.

## Filled helpers

`ArrowHelper` draws its head as a wire cone until `solidHead: true` fills it. `PlaneHelper` draws an outline with diagonals, and `fillOpacity` above 0 fills the square, the usual way to see a clipping plane.

```ts
import {Engine} from 'margoengine/core';
import {ArrowHelper, Lines, PlaneHelper} from 'margoengine/lines';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const lines = Lines.attach(engine);

lines.add(new ArrowHelper({direction: [1, 1, 0], length: 2, width: 3, solidHead: true}));
lines.add(new PlaneHelper({normal: [0, 1, 0], size: 4, fillOpacity: 0.25, color: '#2a7de1'}));
```

Fills take the helper's colour, opacity, fog and clipping planes, are not lit, and draw before the helper's lines. An opaque fill writes depth, whatever `depthWrite` says, so a solid head sorts against everything in the scene that follows; a translucent one writes none, so several overlapping ones blend in the order they were added. Fills do not pick.

## Fog

`lines.setFog(fog)` fogs every line whose material has `fog: true` (the default) with `@margoengine/environment`'s `Fog`
or any object with its fields (`color`, `near`, `far`, `density`, `heightFalloff`, `height`, `enabled`), read every
frame with Fog's maths: linear near/far, exp2 when `density` is above 0, thinner above `height`. A line fades toward the
fog colour by the distance of its centre line, in linear before the canvas sRGB encoding. Lines does not import
environment. `fog.enabled = false` clears it without recompiling; `lines.setFog(null)` (the default) draws exactly as
before.

```ts
import {Fog} from 'margoengine/environment';
import {Lines} from 'margoengine/lines';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const lines = Lines.attach(engine);
const fog = Fog.attach(engine, {color: '#8090a0', near: 5, far: 40});
lines.setFog(fog);
```

## Clipping planes

`LineMaterial.clippingPlanes` takes up to 6 world-space planes `[a, b, c, d]`; a line is cut away where
`a x + b y + c z + d < 0` (the `@margoengine/materials` convention). Each fragment is tested at its point on the line's
centre line, so a cut runs straight across the line. Planes are normalised on assignment and reading returns copies;
assign a new list to change them (live, next frame, no recompile). More than 6 planes throw a RangeError, a malformed
plane or a zero normal a TypeError. `clipIntersection: true` cuts only where the point is behind every plane (their
intersection) instead of any. Lines cast no shadows, so there is no `clipShadows`.

```ts
import {Engine} from 'margoengine/core';
import {Lines, Line, LineMaterial} from 'margoengine/lines';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const lines = Lines.attach(engine);
// Keep only the part of the line above y = 0.5.
const material = new LineMaterial({width: 3, clippingPlanes: [[0, 1, 0, -0.5]]});
lines.add(new Line({positions: [0, 0, 0, 0, 2, 0], material}));
material.clippingPlanes = []; // uncut again from the next frame
```

## SkeletonHelper

`SkeletonHelper` draws a skinned model's bones as lines from each parent joint to its child joint,
and follows the pose every frame. It takes `@margoengine/animation`'s `Skeleton` (any object with
`parents` and 16 `matrices` numbers per bone; `mesh` places the skeleton with the skinned mesh's world matrix) or, through
`SkeletonHelper.fromGLTF(model, skin)`, a glTF skin's joint nodes (each joined to its parent node when that is a joint).
Lines does not import animation. Colours run from `parentColor` (default green) to `color` (default blue);
`setColors(color, parentColor)` changes them. It draws over the scene (`onTop`) and is not fogged unless asked.

```ts
import {Lines, SkeletonHelper} from 'margoengine/lines';
import {Skeleton} from 'margoengine/animation';
import {Engine} from 'margoengine/core';
import {loadGLTF} from 'margoengine/gltf-pro';
const engine = await Engine.create(document.querySelector('canvas')!);
const lines = Lines.attach(engine);
const model = await loadGLTF(engine, '/hero.glb');
const skeleton = new Skeleton([{name: 'hip', parent: -1}, {name: 'knee', parent: 0}]);
// An @margoengine/animation Skeleton, placed by the skinned mesh it deforms:
const bones = lines.add(new SkeletonHelper(skeleton, {mesh: model.primitives[0].node, width: 2}));
const skin = lines.add(SkeletonHelper.fromGLTF(model)); // a loaded, animated glTF
bones.dispose(); // removes it from the plugin and frees its buffers
```

## Picking

Two routes. `@margoengine/lines/pick` picks on the GPU, in one depth test with the meshes. `intersectLines` from `margoengine/bvh/lines` picks on the CPU with a ray, and needs no readback.

### GPU picking

`LinePicking` from `margoengine/lines/pick` adds a `Lines` plugin to `Picking` from `margoengine/selection`. One `picking.pick` or `engine.pick` then answers whichever of lines and meshes is nearest at the pixel; a line behind a mesh is not hit, and `pickMany` works too. Only code that imports that entry pays for it.

```ts
import {Engine, box} from 'margoengine/core';
import {Lines, Line} from 'margoengine/lines';
import {LinePicking} from 'margoengine/lines/pick';
import {Picking} from 'margoengine/selection';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const lines = Lines.attach(engine);
const path = lines.add(new Line({positions: [-2, 0, 0, 0, 1, 0, 2, 0, 0], width: 6}));
engine.createMesh().setGeometry(box());

const picking = Picking.attach(engine);
const linePicking = LinePicking.attach(picking, lines);

canvas.addEventListener('pointerdown', async (event) => {
  const hit = await picking.pick(event.offsetX, event.offsetY);
  if (hit?.line === path) console.log('segment', hit.segment);
  else if (hit) console.log('mesh', hit.mesh);
});

// engine.pick answers meshes only: a line that follows no mesh answers an empty stand-in mesh.
const mesh = await engine.pick(10, 20);
console.log(linePicking.lineOf(mesh));
```

- `hit.line` is the line and `hit.segment` its segment index. `hit.mesh` is the mesh the line follows, or else an empty mesh made for that line, which draws nothing and which `lineOf` maps back. Stand-ins go when their line leaves the plugin or with `linePicking.dispose()`. Attach `Lines` to the engine before `LinePicking.attach`.
- A line hits where it is drawn, at its width, without the antialiasing ramp. Like every pick, the 3 x 3 tile also finds a neighbouring pixel when the exact one is empty. Dash gaps hit, so a hover does not flicker along a dashed line; parts cut by clipping planes and hidden lines do not. `onTop` lines win over everything, as they draw.
- One pick answers the nearest thing only. For everything under a pixel in order of distance, merge `intersectLines` with the `Raycaster` hits by `distance`.
- Lines at most 268,435,456 segments in all per pick (the IDs of one overlay); lines past that do not pick. While an overlay is registered, picks use Picking's 3 x 3 pass, not its cached ID texture, so each pick draws the lines near the pixel's view again: all of each line's vertices, with no culling.

### Ray picking

`intersectLines` from `margoengine/bvh/lines` tests lines against a `Raycaster` ray, the same ray you test meshes with. Only code that imports that entry pays for it.

```ts
import {Engine} from 'margoengine/core';
import {Lines, Line} from 'margoengine/lines';
import {Raycaster} from 'margoengine/bvh';
import {intersectLines} from 'margoengine/bvh/lines';
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas);
const lines = new Lines();
engine.use(lines);
lines.add(new Line({positions: [-2, 0, 0, 0, 1, 0, 2, 0, 0], width: 4}));

canvas.addEventListener('pointerdown', (event) => {
  const ray = new Raycaster().setFromEngine(engine, event.offsetX, event.offsetY);
  const [hit] = intersectLines(ray, lines.lines, {engine, tolerance: 5});
  if (hit) console.log(hit.line, hit.segment, hit.point, hit.distance, hit.offset);
});
```

A hit gives the `line`, the `segment` index, the world `point` on the centre line, the `distance` along the ray and the `offset` from the ray to the point. Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `engine` | none | Gives the view, attached lines' matrices and helper updates. An attached line needs it. |
| `view` | the engine's camera and canvas | `{matrix, width, height}`: a WebGPU view-projection matrix and the canvas size in CSS pixels, for picking without an engine. |
| `tolerance` | 3 pixels with a view, else 0 | The least distance from the centre line that hits. A line drawn wider hits across its drawn width instead. |
| `toleranceUnits` | `'pixels'` | `'pixels'` (CSS pixels, needs a view) or `'world'`. |
| `refresh` | true | Run the transform kernel first, as `Raycaster` queries do. |

- Dash gaps hit. A dashed line picks as one line, so a hover does not flicker along it.
- Each segment's pick area is a capsule: joins and ends count as round whatever the material says, so a butt end picks up to half a width past its drawn end.
- Hits sort by distance. Neighbouring segments inside the tolerance count as one crossing and give one hit, the segment closest to the ray. Set `firstHitOnly` on the Raycaster for the nearest only.
- Hidden lines and points cut away by the material's clipping planes do not hit; nor does anything behind the ray origin or outside `near` and `far`. Hits ignore depth, as all `Raycaster` hits do: merge with mesh hits by `distance`.
- A pick on a polyline of 100,000 segments takes 0.015 ms; the BVH behind it takes 51 ms to build, on the first pick and after the line changes (`node packages/bvh/scripts/bench-line-pick.js`, Node 26). A dashed line's matrix change counts as a change.

## Limits

- WebGPU only. On the WebGL2 backend the plugin warns once and draws nothing.
- By default lines do not write depth, so crossing lines do not occlude each other unless they set [`depthWrite`](#depth-writing). `engine.pick` finds lines through [`LinePicking`](#gpu-picking) only. Round joins of translucent lines overlap on the inner side only when a segment is shorter than the join (the inner miter would overshoot).
- Dashes run continuously through joins, and `cap` applies to line ends only; `dashCap` shapes each dash. World-unit widths ignore the mesh scale.
- Filled helper shapes are flat colour with no lighting, and do not pick; the lines around them do. `CameraHelper` expects a WebGPU (reversed-Z) camera matrix.

## Feature edges and gradients

`@margoengine/lines/edges` (`margoengine/lines/edges`) finds the creases of a mesh and colours a line along its length. Pages that use neither do not load it.

```ts
import {box} from 'margoengine/core';
import {Line, Lines} from 'margoengine/lines';
import {EdgesHelper, featureEdges, gradientColors} from 'margoengine/lines/edges';

const lines = new Lines();
// Edges whose faces meet at more than 30 degrees (the default), and the outline of open surfaces.
lines.add(new EdgesHelper(box(2, 1, 1), {color: '#20242a', width: 2}));
console.log(featureEdges(box(2, 1, 1)).length / 6);   // 12

// One rgb per point, by distance along the line.
const positions = [0, 0, 0, 1, 1, 0, 2, 0, 0];
lines.add(new Line({positions, colors: gradientColors(positions, ['#ff0000', '#0000ff'])}));
```

Vertices at one position count as one (`tolerance`, default 1e-5), so hard-shaded meshes with split normals work. An edge with three or more faces is always kept. `gradientColors` takes `mode: 'segments'` to run over each pair of points, and `stops`. The shader blends between points, so add points where a stop inside a long segment must be exact.

## Tests

`node scripts/gpu-lock.mjs run --owner=fog-all -- node scripts/fog-all-gpu-check.js` (repository root, real GPU) checks
fog on lines against the analytic fog amount and draws a `SkeletonHelper` over a posed rig (lines present, following a
new pose, gone when removed).

`npm test` in `packages/lines` runs Node checks on the CPU geometry: segment counts and neighbors per mode, dash distances in world space, exact quad areas for every cap, exact join areas with zero overlap for miter, bevel and round in both turn directions, miter-limit fallback, collinear points, loops, buffer reuse on same-size updates, validation, every helper's geometry (including the normal matrix under non-uniform scale and a reversed-Z frustum unprojection), SSR-safe import and the single WebGL2 warning.

`npm run test:browser` drives Chromium or Edge with a real engine and reads pixels back: summed edge coverage in a column equals the width for 10, 4, 2.5, 1 and 0.5 pixels, world-unit width matches the projection, antialiased and hard edges, per-vertex colors and opacity, a line behind a core mesh is hidden while one in front and an `onTop` one are visible, attached lines follow mesh transforms and visibility, dashes produce six dashes with gaps and move with `dashOffset`, depth-writing lines occlude each other in either order with gaps and cut parts writing nothing and a later plugin respecting them, same-size updates allocate no buffers, every join, cap and helper renders with zero validation and WGSL errors, `engine.rebootDevice()` keeps lines rendering, `removePlugin` removes the pass and releases the buffers, and a line passing behind the camera is clipped. It also saves `test-results/lines-gallery.png`. In a container run it with:

```sh
BROWSER_CHANNEL=bundled BROWSER_EXECUTABLE=/path/to/chrome BROWSER_ARGS='["--enable-unsafe-webgpu","--use-webgpu-adapter=swiftshader","--no-sandbox"]' npm run test:browser
```

Apache-2.0 licensed.
