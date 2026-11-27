# @margoengine/lines

Import `margoengine/lines` from the `margoengine` package, or `@margoengine/lines` from this package alone; the two are the same module. Both are on npm at 0.1.0. See [Install](https://github.com/scottcampbelldata/margoengine/blob/main/README.md#install) in the repository README.

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


## Live light helpers

```ts
import {Engine} from '@margoengine/core';
import {Lines, PointLightHelper} from '@margoengine/lines';
const engine = await Engine.create(document.querySelector('canvas')!);
const lines = Lines.attach(engine);
const light = {position: [0, 1, 0] as [number, number, number], color: [1, 0.5, 0] as [number, number, number]};
const helper = lines.add(new PointLightHelper(light, {size: 0.25}));
engine.render();
light.position[0] = 2; // The helper follows live positions on the next render.
engine.render();
helper.dispose();
engine.dispose();
```

Point, spot and hemisphere helpers retain the original 33 circle samples on
first use, including the closing endpoint, and reuse two coordinate arrays.
Moving a point-light helper then needs zero circle sine/cosine calls instead
of 1,152, with identical geometry bytes. Helpers without circles allocate no
circle table. This is a work-count result; timing pending the quiet rerun.

## Export

`lines.lines` is the live, read-only set of lines the plugin draws (empty by default). The `@margoengine/exporters`
scene writers read it through `engine.plugins`: `exportGLB(engine)` writes each visible line as its centre polyline,
a glTF LINES primitive, with its width in the primitive's extras as `lineWidth` and `lineWidthUnits` and a
`Stroke`'s `widths` as `_WIDTH`; OBJ, PLY, COLLADA and USDZ write it in their line forms. Dashes, joins and caps are
not written. See the exporters README, "Lines and point clouds".

## How it works

- **Instanced screen-space quads.** Each independent butt or square segment uses six vertices (two body triangles); round caps, connected lines and custom shader extensions keep all 78 vertices. Points come from a storage buffer; there is one draw call per line. The vertex shader projects the segment and its neighbors, then builds the body quad, the join on its end (owned by the incoming segment) and the cap on its start. Miter joins share their corner points with the next segment, so translucent lines have no double-blended overlap; bevel and round joins add a wedge and a 10-triangle fan on the outer side. A miter longer than `miterLimit` times the width falls back to bevel. Repeated points (GPS stops, a loop closed by giving its first point again) are joined across: each point carries the index of its nearest distinct neighbour on either side (`distinctNeighbours`, computed on the CPU when the points change and uploaded after them, 8 bytes a point), a segment between two copies of one point draws nothing, and the join there uses the points around the repeat, as the HTML canvas path rules prune zero-length segments. A line that is all one point keeps its zero-length segment, so round or square caps still draw a dot (SVG 2). `expandLine` in this package is the same algorithm on the CPU, in pixels, and the Node tests check it for exact areas and zero overlap.
- **Widths.** Pixel widths are CSS pixels, scaled by the ratio of the render target to the canvas client size. World-unit widths are converted per endpoint from the camera's focal length and the clip w, so thick lines taper with perspective. Lines thinner than one pixel are drawn one pixel wide with proportionally lower alpha.
- **Antialiasing.** Geometry grows by one pixel and the fragment shader ramps coverage over the last pixel of every edge, butt or square cap end and dash end (dash ends use `fwidth` of the distance). This coverage ramp works alongside 4× MSAA on the WebGPU canvas path.
- **Dashes.** Distances accumulate along the line in world space (after the model or mesh matrix) on the CPU, are recomputed only when the points or the matrix change, and are interpolated perspective-correctly. Segment lists accumulate across segments.
- **Depth.** Lines test against the scene depth with reversed-Z `greater-equal` and do not write depth unless `depthWrite` is set (see [Depth writing](#depth-writing)). `onTop` lines use `always` and draw after the depth-tested ones. Endpoints behind the near plane are clipped in clip space, so a line passing beside the camera is cut, not mirrored.
- **Color.** Colors are linear RGB (`'#rrggbb'` and `0xrrggbb` are sRGB and converted, like `PbrMaterial`). Output is sRGB-encoded for unorm canvas formats and left linear for `-srgb` and float targets such as the `rgba16float` target of the post-processing packages. Blending is straight alpha (`src-alpha, one-minus-src-alpha`).
- **Plugin lifecycle.** The pass is `lines:draw` at frame-graph order 20, after the scene, sky and particles and before post-processing resolves at 30. GPU buffers are created lazily per line and rebuilt from the CPU copies in `onDeviceRestored`. `dispose()` (and `engine.removePlugin`) removes the plugin from its scene and destroys every buffer and the pass; the lines stay registered with the plugin object, so it can be attached again.
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
| `colorMode` | `'multiply'` | How per-point colors meet `color`: `'multiply'`, `'set'` (the point's color alone) or `'add'` (clamped to 1); needs per-point colors. See [Per-point width and color](#per-point-width-and-color) |
| `onTop` | `false` | Skip the depth test |
| `depthWrite` | `false` | Write depth: crossing lines occlude each other and later passes respect them |
| `alphaToCoverage` | `false` | Turn alpha into MSAA coverage instead of blending; see [Alpha to coverage](#alpha-to-coverage) |
| `behind` | `false` | Draw only where the scene is in front of the line; see [Hidden lines](#hidden-lines) |
| `depthBias` | `0` | Fraction of its distance the line moves nearer for depth tests, 0 up to 1, so edges on a surface do not flicker |
| `antialias` | `true` | |
| `fog` | `true` | Fogged by the plugin's `setFog`; `false` keeps the line clear |

`new Lines({name, order})` sets the plugin name (default `'lines'`) and pass order (default `20`). `lines.stats` reports lines, segments and draw calls of the last frame.

Helpers are `Line` subclasses and take the material options too (they default to butt caps and miter joins): `GridHelper({size, divisions, color1, color2, fade})`, `PolarGridHelper({radius, sectors, rings, divisions, color1, color2, fade})`, `AxesHelper({size})`, `Box3Helper(min, max, {color})`, `BoxHelper(mesh, {color})` (world bounds every frame), `ArrowHelper({direction, origin, length, color, headLength, headWidth, solidHead})`, `CameraHelper(camera, {aspect})` (unprojects `camera.matrix`), `PlaneHelper({normal, constant, size, color, fillOpacity})` and `VertexNormalsHelper(mesh, {size, color})` (world space with the normal matrix).

A large grid ends in a hard straight edge against the sky. `fade: {near, far}` (world units from the grid's centre,
default none) keeps full opacity out to `near` and fades the lines to nothing at `far` along smoothstep; the lines past
`far` are not drawn at all, so the grid melts into the horizon:

```ts
import {Engine} from 'margoengine/core';
import {Lines, GridHelper} from 'margoengine/lines';

const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 2, 8], target: [0, 0, 0]}});
const lines = Lines.attach(engine);
lines.add(new GridHelper({size: 200, divisions: 200, fade: {near: 20, far: 90}}));
engine.render();
```

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

## Per-point width and color

A `Line` takes a color per point (`colors` in the options, `setColors(...)`: r, g, b or r, g, b, a, linear 0..1, same-size updates reuse the buffer) and a `Stroke` a width multiplier per point (`widths`, `setWidths(...)`, one finite non-negative number per point, live without a rebuild). `colorMode` on the material decides how the per-point color meets the material `color`: `'multiply'` (default), `'set'` replaces it (opacity still applies) and `'add'` sums them, clamped to 1. Colors and widths interpolate along each segment.

```js
import { Stroke } from '@margoengine/lines/stroke';

const stroke = new Stroke({
  positions: [-2, 0, 0, 0, 1, 0, 2, 0, 0],
  colors: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  widths: [0.2, 1, 3],
  width: 8,
  colorMode: 'set',
});
stroke.setWidths([3, 1, 0.2]);
stroke.setColors([1, 1, 0, 1, 0, 1, 0, 1, 1]);
```

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

## Animated flow paths

Use `@margoengine/lines/flow` for color-coded air, liquid or signal paths in a 3D cutaway. Each path draws moving pulses over a faint guide and tapers their opacity at both ends. Opaque scene geometry occludes the lines. The application supplies the route, speed and time.

```ts
import { Engine } from '@margoengine/core';
import { Lines } from '@margoengine/lines';
import { FlowPath } from '@margoengine/lines/flow';

const engine = await Engine.create(document.querySelector('canvas')!);
const lines = Lines.attach(engine);
const air = new FlowPath(lines, {
  positions: [-1, 0.3, 0, 0, 0.4, 0, 1, 0.3, 0],
  color: '#16aeff',
  speed: 0.5,
});
const fuel = new FlowPath(lines, {
  positions: [-0.2, -0.5, 0, 0.12, -0.3, 0, 0.4, 0.34, 0],
  color: '#ffca29',
  speed: 0.22,
  dashSize: 0.08,
  gapSize: 0.12,
});

function renderAt(seconds: number) {
  air.seek(seconds);
  fuel.seek(seconds);
  engine.render();
}

renderAt(1.5);
// Call renderAt with the playhead's time for each frame, in any order.
air.dispose();
fuel.dispose();
engine.dispose();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `positions` | Required | Ordered x, y, z coordinates with at least two distinct points. |
| `color` | `'#57c6ff'` | Shared color for the pulse and guide. |
| `width`, `worldUnits` | `5`, `false` | Pulse width in CSS pixels, or world units when enabled. |
| `speed`, `phase` | `0.5`, `0` | World units per second and initial advance in world units. Negative speed reverses flow and zero holds it. |
| `dashSize`, `gapSize` | `0.14`, `0.2` | Lengths in world units. Dashes have rounded ends. |
| `opacity`, `guideOpacity` | `1`, `0.28` | Layer opacity at full gain. A zero-opacity guide allocates no line. |
| `guideWidth` | `0.38` | Guide width as a fraction of the pulse width. |
| `startFade`, `endFade` | `0.12`, `0.14` | Fractions of local route length. Each can be zero, and their sum can be at most one. |
| `mesh`, `matrix` | None, identity | Follow a mesh's world transform or position an unmounted path with a matrix. |

`seek(seconds, gain = 1)` uses absolute time and a gain from 0 to 1. It does not rebuild path geometry. Gain zero hides both layers. Each visible path draws one dashed line and, if configured, its guide. `dispose()` or `using` unregisters both. The same API works on WebGPU and the WebGL2 compatibility layer.

## BVH, octree and raycaster helpers

`@margoengine/lines/tree-helpers` draws what a spatial query sees. `BVHHelper(bvh, { depth })` draws the boxes of a `MeshBVH` at one level (the root is level 0) plus every leaf above it, so the boxes always cover the mesh; `setDepth` redraws, and `maxDepth` is the deepest level, for a depth slider. `OctreeHelper(octree, { depth })` does the same for a `MemoryOctree`, any `OctreeSource` or a root node of `@margoengine/points/octree`. `RaycasterHelper(ray, hits)` draws the ray to its farthest hit with a cross and a normal tick on each hit. The shapes are structural, so this entry imports neither the BVH nor the points package.

```ts
import { Engine } from '@margoengine/core';
import { Lines } from '@margoengine/lines';
import { BVHHelper, OctreeHelper, RaycasterHelper } from '@margoengine/lines/tree-helpers';
import { MeshBVH } from '@margoengine/bvh';
import { buildOctree } from '@margoengine/points/octree';

const engine = await Engine.create(document.querySelector('canvas')!);
const lines = Lines.attach(engine);
const triangles = new Float32Array(90).map((_, i) => ((i * 7919) % 1000) / 1000);
const bvh = lines.add(new BVHHelper(MeshBVH.build({ positions: triangles }, { maxLeafTriangles: 2 }), { depth: 2 }));
const cloud = new Float32Array(3000).map((_, i) => ((i * 104729) % 1000) / 1000);
const tree = lines.add(new OctreeHelper(buildOctree({ positions: cloud }, { maxPointsPerNode: 100, grid: 4 }), { depth: 1 }));
const ray = lines.add(
  new RaycasterHelper({ origin: [0, 2, 0], direction: [0, -1, 0], far: 5 }, [{ point: [0, 0, 0], normal: [0, 1, 0] }]),
);
bvh.setDepth(bvh.maxDepth); // Every leaf.
tree.setDepth(3);
engine.render();
engine.dispose();
```

Options: `depth` (default 3, whole number 0 to 64), `color`, and every `LineMaterial` option; `RaycasterHelper` also takes `length` (drawn when the ray has no hit and an infinite `far`, default 10) and `markSize` (default 0.1). Sources: Timothy L. Kay and James T. Kajiya, Ray Tracing Complex Scenes (SIGGRAPH 1986), for bounding-volume hierarchies; Donald Meagher, Geometric Modeling Using Octree Encoding (Computer Graphics and Image Processing, 1982), for octrees. The helpers only read node bounds; no rival source was read.

## Light probe and positional audio helpers

`@margoengine/lines/scene-helpers` draws two things that have no mesh. `LightProbeHelper(source, { position, size })` draws a light probe as a wire sphere (7 latitude rings, 12 meridians) whose every point is coloured by the probe's irradiance in that point's normal direction, so it reads like a diffuse ball lit by the probe. `source` is 12 (L1) or 27 (L2) RGB spherical-harmonic coefficients in `Environment.sh` order (pass `environment.sh.irradiance`), or a function of the normal (`(n) => probes.irradianceAt(position, n)` for a `LightProbes` volume, or `environment.irradianceAt`). `PositionalAudioHelper(audio)` draws a positional sound's Web Audio inner and outer cones (8 lines and a rim each, at `length`; a cone wider than 180 degrees opens backwards and 360 draws none) and its `refDistance` and `maxDistance` as spheres of three circles (the maximum only below Web Audio's 10,000 default, which means no limit). A `PositionalAudio` from `@margoengine/audio` fits as it is. Both re-read their source on `update()` and rebuild only when a drawn value changed; `shIrradiance(sh, normal)` is the evaluator they use.

```ts
import { Engine } from '@margoengine/core';
import { Lines } from '@margoengine/lines';
import { LightProbeHelper, PositionalAudioHelper } from '@margoengine/lines/scene-helpers';

const engine = await Engine.create(document.querySelector('canvas')!);
const lines = Lines.attach(engine);
// 9 L2 coefficients x RGB: a grey ambient with warm light from above (environment.sh.irradiance has this layout).
const sh = new Float32Array(27);
sh.set([1, 1, 1], 0);
sh.set([0.6, 0.4, 0.1], 3);
const probe = lines.add(new LightProbeHelper(sh, { position: [0, 1, 0], size: 0.3 }));
const sound = {
  worldPosition: [2, 1, 0],
  worldDirection: [0, 0, 1],
  refDistance: 1,
  maxDistance: 6,
  panner: { coneInnerAngle: 60, coneOuterAngle: 140 },
};
const cones = lines.add(new PositionalAudioHelper(sound)); // Or a PositionalAudio from @margoengine/audio.
sound.panner.coneOuterAngle = 200; // Followed on the next update.
cones.update();
probe.position[1] = 2; // Moves the sphere.
engine.render();
engine.dispose();
```

Options: `LightProbeHelper` takes `position` (default `[0, 0, 0]`, editable later as `helper.position`), `size` (sphere radius, default 0.25), `exposure` (`'auto'` scales the brightest point to 1, or a number that multiplies the irradiance; default `'auto'`) and `convolve` (the coefficients are radiance: apply the clamped-cosine band factors 1, 2/3, 1/4 first; default false). `PositionalAudioHelper` takes `length` (cone length, default the reference distance, or 1 when it is 0), `innerColor`, `outerColor` and `distanceColor`. Both take every `LineMaterial` option. Sources: Ravi Ramamoorthi and Pat Hanrahan, An Efficient Representation for Irradiance Environment Maps (SIGGRAPH 2001, https://graphics.stanford.edu/papers/envmap/), for the L2 basis and the irradiance band factors; W3C, Web Audio API, PannerNode (https://www.w3.org/TR/webaudio/#PannerNode), for whole cone angles in degrees about the orientation and the distance parameters. No rival source was read.

## Infinite grid

`InfiniteGrid` from `@margoengine/lines/infinite-grid` is a ground grid with no edge: thin cell lines, thick section lines, analytic antialiasing, a smooth distance fade and a disc that follows the camera. The lines come from the fragment shader, so one draw of two triangles covers any `cellSize`; `GridHelper` stays the finite, geometry-based grid. Lines closer than two pixels fade out instead of turning to moire, and the grid is depth tested against the scene without writing depth. WebGPU only (the engine's WebGL2 compatibility layer is a WebGPU device, so it works there too).

```ts
import { Engine } from '@margoengine/core';
import { InfiniteGrid } from '@margoengine/lines/infinite-grid';

const engine = await Engine.create(document.querySelector('canvas')!);
const grid = InfiniteGrid.attach(engine, { cellSize: 0.5, sectionSize: 5, fadeDistance: 60 });
grid.sectionColor = '#ff8800'; // Every field is live and checked each frame.
engine.render();
grid.dispose();
engine.dispose();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `cellSize`, `sectionSize` | `1`, `10` | Distance between thin and thick lines in world units. `sectionSize` is 0 (no sections) or at least `cellSize`. |
| `cellThickness`, `sectionThickness` | `1`, `1.5` | Line width in drawing-buffer pixels. |
| `cellColor`, `sectionColor` | grey, lighter grey | Any `ColorInput`. |
| `y` | `0` | Height of the grid plane. |
| `fadeDistance` | `100` | Distance where the grid is gone, from the camera (or the origin). |
| `followCamera` | `true` | `false` fixes the fading disc on the origin. |
| `opacity`, `order`, `name` | `1`, `19`, `'infinite-grid'` | Overall opacity, frame graph order (just before `Lines`) and plugin name. |

`gridCoverage(coord, size, thickness, pixel)` is the shader's per-axis coverage in plain JavaScript, for tests and CPU renderers. Sources: Eric Chan and Frédo Durand, [Fast Prefiltered Lines](https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-22-fast-prefiltered-lines) (GPU Gems 2, 2005), for the distance-to-line ramp that antialiases a line; David Ebert et al., Texturing and Modeling: A Procedural Approach (3rd ed., 2003), chapter 2, for fading a pattern out as its period drops below the sampling rate.

## Trails

`Trail` from `margoengine/lines/trail` is a line that follows something and fades behind it: missiles, swords, cursors. It advances with the `Lines` plugin's frames, so there is nothing to call each frame. The fade clock (`trail.time`) moves in the frame update (`lines.advanceTime(delta)`), once a frame however many views draw, so `seek` from `@margoengine/cutscene/seek` starts a film scene on the clock a continuous run reads; the points are the target's history, which a warm-up of `lifetime` seconds refills.

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

## Freehand tubes: /tube-painter

`TubePainter` from `@margoengine/lines/tube-painter` turns freehand 3D strokes into smooth tube meshes. `begin(point)`
starts a stroke, `add(point, pressure)` extends it (a point closer than `minDistance`, default half the radius, is
skipped and `add` returns false), `end()` finishes it, `undo()` drops the last stroke and `clear()` drops all. Feed it
the point under a pointer ray with `rayPoint(origin, direction, distance)`, or an XR controller's tip position each
frame while its trigger is held. `pressure` scales the radius (default 1), so a pen or a trigger can taper a stroke.
`data()` returns `{positions, normals, indices}` of every stroke and `toGeometry()` a core `Geometry` for
`engine.createMesh().setGeometry(...)`; both rebuild in linear time, so call them when a stroke changes, not per frame
of a long stroke. Options: `radius` 0.01, `sides` 8 (3 to 64), `minDistance` radius / 2, `maxPoints` 4096 per stroke and
`caps` true (flat discs close the ends). A stroke of fewer than two points draws nothing; a bad option throws a
RangeError that names the fix.

The tube is framed with rotation-minimizing frames, so it does not twist or flip along a curving path: the
double-reflection method of Wang, Juettler, Zheng and Liu, "Computation of rotation minimizing frames", ACM Transactions
on Graphics 27(1), 2008, after the parallel transport frame of Bishop, "There is more than one way to frame a curve",
American Mathematical Monthly 82(3), 1975.

```ts
import { Engine } from '@margoengine/core';
import { TubePainter, rayPoint } from '@margoengine/lines/tube-painter';

const canvas = document.createElement('canvas'); document.body.append(canvas);
const engine = await Engine.create(canvas, { camera: { position: [0, 0, 4] } });
const painter = new TubePainter({ radius: 0.05, sides: 12 });
painter.begin(rayPoint([0, 0, 4], [0, 0, -1], 3));
for (let i = 1; i <= 20; i++) painter.add([Math.sin(i / 4) * 0.8, i / 20 - 0.5, 1 + Math.cos(i / 4) * 0.3], 0.5 + i / 40);
painter.end();
const stroke = engine.createMesh().setGeometry(painter.toGeometry());
engine.render();
console.log(painter.strokeCount, stroke ? 'painted' : '');
engine.dispose(); canvas.remove();
```

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

## Selection masks

`line.setMask(values, style?)` marks points selected (true or above 0, one value a point); a segment is selected when
both its points are, and the shader fades, highlights or hides the others while every other look stays: width, joins,
caps, dashes, vertex colours, ribbons, fog, clipping and GPU picking (hidden segments cannot be picked). The mask is one
bit a point after a 16-byte style header, so `updateMask(start, values)` uploads it once at the next frame and never
reallocates or recompiles; points added later by `setPositions` start selected. Styles: `mode` 'fade' (default;
unselected segments show `fade` of their displayed sRGB colour, default 0.12), 'highlight' (fade plus selected
segments moved `highlightAmount`, default 0.7, toward `highlight`, default `[1, 0.4508, 0.0194]`, linear #ffb326) or 'filter' (unselected
segments hidden). Lines without a mask bind a zeroed 16-byte stand-in, so they draw exactly as before. Solid helper
fills ignore the mask.

```ts
import {Lines, Line} from 'margoengine/lines';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const lines = Lines.attach(engine);
const line = lines.add(new Line({positions: [0, 0, 0, 1, 1, 0, 2, 0, 0, 3, 1, 0], width: 4, dashed: true}));
line.setMask([true, true, false, true], {mode: 'filter'}); // draws only the first segment
line.setMaskStyle({mode: 'fade', fade: 0.3});
console.log(line.isSelected(2)); // false
```

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
import {loadGLTF} from 'margoengine/gltf/pbr';
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

## Tiled capture

`@margoengine/lines/tiles` keeps joins, widths, dashes and edge distances in the whole image's pixels while a camera
renders one tile of it, so tiles of a large image meet without seams (`@margoengine/sciviz/export-media` uses it). The
first `setLineCameraTile` of a page widens the line renderers' Frame uniform from 96 to 112 bytes and adds a capture
step to their shaders; a page that never calls it keeps the base Frame and shaders and ships none of this code.
The tile rectangle is the camera's viewport in whole-image pixels, which may reach past the image's right and bottom
edges (draw the image part with a scissor). With a power-of-two width and height, every step from the whole image's
1/256 pixel grid to the tile's window is exact in float32, so line vertices land on the same pixel grid in every tile.

```ts
import { Camera } from '@margoengine/core';
import { setLineCameraTile } from '@margoengine/lines/tiles';
const camera = new Camera({ position: [0, 1, 8], target: [0, 0, 0] });
camera.update(16 / 9, true);
// The top-left 1024 x 1024 tile of a 4096 x 2304 image: pass the uncropped matrix, then crop the camera to the tile.
const release = setLineCameraTile(camera, {
  matrix: camera.matrix,
  fullWidth: 4096,
  fullHeight: 2304,
  x: 0,
  y: 0,
  width: 1024,
  height: 1024,
});
release(); // Lines draw this camera normally again; calling it twice is harmless.
```

## Limits

- Requires native WebGPU or the full WebGL2 compatibility layer. The small preview throws linked `unsupported` during setup.
- By default lines do not write depth, so crossing lines do not occlude each other unless they set [`depthWrite`](#depth-writing). `engine.pick` finds lines through [`LinePicking`](#gpu-picking) only. Round joins of translucent lines overlap on the inner side only when a segment is shorter than the join (the inner miter would overshoot).
- Repeated points are found by exact equality of their stored coordinates: two different points that project to less than 1e-4 pixels apart still end in caps there. Every point of a strip or loop carries 8 more GPU bytes for its neighbour indices.
- Dashes run continuously through joins, and `cap` applies to line ends only; `dashCap` shapes each dash. World-unit widths ignore the mesh scale.
- Filled helper shapes are flat colour with no lighting, and do not pick; the lines around them do. `CameraHelper` expects a WebGPU (reversed-Z) camera matrix.

## Feature edges and gradients

`@margoengine/lines/edges` (`margoengine/lines/edges`) finds the creases of a mesh and colours a line along its length. Pages that use neither do not load it.

```ts
import {box} from 'margoengine/core';
import {Line, Lines} from 'margoengine/lines';
import {EdgesHelper, featureEdges, gradientColors, wireframeEdges} from 'margoengine/lines/edges';

const lines = new Lines();
// Edges whose faces meet at more than 30 degrees (the default), and the outline of open surfaces.
lines.add(new EdgesHelper(box(2, 1, 1), {color: '#20242a', width: 2}));
console.log(featureEdges(box(2, 1, 1)).length / 6);   // 12
// Every triangle edge once, a full wireframe: the 12 edges and a diagonal on each face.
lines.add(new Line({positions: wireframeEdges(box(2, 1, 1)), mode: 'segments', color: '#4080ff'}));
console.log(wireframeEdges(box(2, 1, 1)).length / 6);   // 18

// One rgb per point, by distance along the line.
const positions = [0, 0, 0, 1, 1, 0, 2, 0, 0];
lines.add(new Line({positions, colors: gradientColors(positions, ['#ff0000', '#0000ff'])}));
```

Vertices at one position count as one (`tolerance`, default 1e-5), so hard-shaded meshes with split normals work, in `featureEdges` and in `wireframeEdges`; `featureEdges` with `angle: 0` is the wireframe without the diagonals of flat faces. An edge with three or more faces is always kept. `gradientColors` takes `mode: 'segments'` to run over each pair of points, and `stops`. The shader blends between points, so add points where a stop inside a long segment must be exact.

## Tests

`node scripts/run-with-timeout.mjs -- node scripts/fog-all-gpu-check.js` (repository root, real GPU) checks
fog on lines against the analytic fog amount and draws a `SkeletonHelper` over a posed rig (lines present, following a
new pose, gone when removed).

`npm test` in `packages/lines` runs Node checks on the CPU geometry: segment counts and neighbors per mode, dash distances in world space, exact quad areas for every cap, exact join areas with zero overlap for miter, bevel and round in both turn directions, repeated points joining across the repeat for every join and cap, miter-limit fallback, collinear points, loops, buffer reuse on same-size updates, validation, every helper's geometry (including the normal matrix under non-uniform scale and a reversed-Z frustum unprojection), SSR-safe import and the linked WebGL2 preview refusal.

`npm run test:browser` drives Chromium or Edge with a real engine and reads pixels back: summed edge coverage in a column equals the width for 10, 4, 2.5, 1 and 0.5 pixels, world-unit width matches the projection, antialiased and hard edges, per-vertex colors and opacity, a line behind a core mesh is hidden while one in front and an `onTop` one are visible, attached lines follow mesh transforms and visibility, dashes produce six dashes with gaps and move with `dashOffset`, depth-writing lines occlude each other in either order with gaps and cut parts writing nothing and a later plugin respecting them, same-size updates allocate no buffers, every join, cap and helper renders with zero validation and WGSL errors, a polyline with a repeated corner draws the same pixels as one without it, `engine.rebootDevice()` keeps lines rendering, `removePlugin` removes the pass and releases the buffers, and a line passing behind the camera is clipped. It also saves `test-results/lines-gallery.png`. In a container run it with:

```sh
BROWSER_CHANNEL=bundled BROWSER_EXECUTABLE=/path/to/chrome BROWSER_ARGS='["--enable-unsafe-webgpu","--use-webgpu-adapter=swiftshader","--no-sandbox"]' npm run test:browser
```

Apache-2.0 licensed.

## Preview tier contract

The small `@margoengine/webgl2-compat/preview` renderer reports `backend: 'webgl2'` and has no GPU device. GPU-only attachments throw a linked `MargoError` with code `unsupported` before allocating resources. Native WebGPU and the full WebGL2 compatibility layer both report `backend: 'webgpu'`. Use [`autoEngine` with `loadCompat`](../webgl2-compat/README.md#automatic-escalation) during scene setup to select a complete tier automatically.

The renderer now refuses the preview during setup, allowing automatic escalation instead of accepting an attachment that cannot draw.


## Retained frame data

Unchanged camera uniforms stay on the GPU: 101 identical frames queue one
96-byte frame write instead of 101. Independent butt and square segments,
including default skeleton bones, omit 72 zero-area fan vertices. All visible
triangles, dashes and pixel coverage stay the same. No options are required.

```ts
import {Engine} from '@margoengine/core';
import {Lines, Line} from '@margoengine/lines';
const engine = await Engine.create(document.querySelector('canvas')!);
const lines = Lines.attach(engine);
lines.add(new Line({mode: 'segments', cap: 'butt', width: 3,
  positions: [-1, 0, 0, 1, 0, 0]}));
engine.render();
engine.render(); // Same camera bytes remain resident; the line still draws.
engine.dispose();
```
