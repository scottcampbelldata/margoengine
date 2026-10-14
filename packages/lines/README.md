# @margoengine/lines

Fat lines with joins, caps, dashes and antialiasing, plus the debug helpers, as a WebGPU engine plugin for Margo Engine.

Build from source with `npm run build` in `packages/lines`.

Replaces the three.js `Line2`, `LineSegments2`, `LineGeometry`, `LineSegmentsGeometry` and `LineMaterial` add-ons, and `GridHelper`, `PolarGridHelper`, `AxesHelper`, `BoxHelper`, `Box3Helper`, `ArrowHelper`, `CameraHelper`, `PlaneHelper` and `VertexNormalsHelper`.

```ts
import {Engine, box} from '@margoengine/core';
import {Lines, Line, LineMaterial, GridHelper, AxesHelper, BoxHelper} from '@margoengine/lines';

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
- **Widths.** Pixel widths are CSS pixels, scaled by the ratio of the render target to the canvas client size. World-unit widths are converted per endpoint from the camera's focal length and the clip w, so thick lines taper with perspective. With an orthographic camera (clip w constant in `camera.matrix`, e.g. `@margoengine/cameras`) the pixels per world unit come from the matrix, so world widths are the same at every depth and follow the zoom. Lines thinner than one pixel are drawn one pixel wide with proportionally lower alpha.
- **Antialiasing.** Geometry grows by one pixel and the fragment shader ramps coverage over the last pixel of every edge, butt or square cap end and dash end (dash ends use `fwidth` of the distance). This coverage ramp works alongside 4× MSAA on the WebGPU canvas path.
- **Dashes.** Distances accumulate along the line in world space (after the model or mesh matrix) on the CPU, are recomputed only when the points or the matrix change, and are interpolated perspective-correctly. Segment lists accumulate across segments like `LineSegments2.computeLineDistances`.
- **Depth.** Lines test against the scene depth with reversed-Z `greater-equal` and do not write depth. `onTop` lines use `always` and draw after the depth-tested ones. Endpoints behind the near plane are clipped in clip space, so a line passing beside the camera is cut, not mirrored.
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
| `mode` | `'strip'` | `'segments'` (pairs, `LineSegments2`), `'strip'` (`Line2`), `'loop'` (closed) |
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
| `vertexColors` | when colors exist | |
| `onTop` | `false` | Skip the depth test |
| `antialias` | `true` | |

`new Lines({name, order})` sets the plugin name (default `'lines'`) and pass order (default `20`). `lines.stats` reports lines, segments and draw calls of the last frame.

Helpers are `Line` subclasses and take the material options too (they default to butt caps and miter joins): `GridHelper({size, divisions, color1, color2})`, `PolarGridHelper({radius, sectors, rings, divisions, color1, color2})`, `AxesHelper({size})`, `Box3Helper(min, max, {color})`, `BoxHelper(mesh, {color})` (world bounds every frame), `ArrowHelper({direction, origin, length, color, headLength, headWidth})`, `CameraHelper(camera, {aspect})` (unprojects `camera.matrix`), `PlaneHelper({normal, constant, size, color})` and `VertexNormalsHelper(mesh, {size, color})` (world space with the normal matrix).

## Limits

- WebGPU only. On the WebGL2 backend the plugin warns once and draws nothing.
- Lines do not write depth, so crossing lines do not occlude each other and are not pickable through `engine.pick`. Round joins of translucent lines overlap on the inner side only when a segment is shorter than the join (the inner miter would overshoot).
- Dashes run continuously through joins, and caps apply to line ends only, not to each dash. World-unit widths ignore the mesh scale.
- `ArrowHelper` draws its head as a wire cone, and `PlaneHelper` draws an outline with diagonals; there are no filled meshes. `CameraHelper` expects a WebGPU (reversed-Z) camera matrix.
- No line picking (`Line2.raycast`) yet; `expandLine` gives the screen-space triangles for a CPU hit test.

## Tests

`npm test` in `packages/lines` runs Node checks on the CPU geometry: segment counts and neighbors per mode, dash distances in world space, exact quad areas for every cap, exact join areas with zero overlap for miter, bevel and round in both turn directions, miter-limit fallback, collinear points, loops, buffer reuse on same-size updates, validation, world-unit widths against the projection under perspective and orthographic cameras (fake GPU), every helper's geometry (including the normal matrix under non-uniform scale and a reversed-Z frustum unprojection), SSR-safe import and the single WebGL2 warning. `node examples/package-benchmarks/proofs/lines-perspective.proof.js` checks that perspective GPU calls and buffer writes are byte-identical to `96edc75` (before orthographic support).

`npm run test:browser` drives Chromium or Edge with a real engine and reads pixels back: summed edge coverage in a column equals the width for 10, 4, 2.5, 1 and 0.5 pixels, world-unit width matches the projection, antialiased and hard edges, per-vertex colors and opacity, a line behind a core mesh is hidden while one in front and an `onTop` one are visible, attached lines follow mesh transforms and visibility, dashes produce six dashes with gaps and move with `dashOffset`, same-size updates allocate no buffers, every join, cap and helper renders with zero validation and WGSL errors, `engine.rebootDevice()` keeps lines rendering, `removePlugin` removes the pass and releases the buffers, and a line passing behind the camera is clipped. It also saves `test-results/lines-gallery.png`. In a container run it with:

```sh
BROWSER_CHANNEL=bundled BROWSER_EXECUTABLE=/path/to/chrome BROWSER_ARGS='["--enable-unsafe-webgpu","--use-webgpu-adapter=swiftshader","--no-sandbox"]' npm run test:browser
```

MIT licensed.
