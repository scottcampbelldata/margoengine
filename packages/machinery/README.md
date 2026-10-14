# @margoengine/machinery

Joints and couplings, bounded IK, Wasm surface transport, binary telemetry, worker CAD import, stencil sections, assembly BVH picking and metrology for Margo Engine.

Package name: `@margoengine/machinery`, version `0.1.0`. Build from source or install a local tarball until the renamed package is published.

```sh
npm install @margoengine/core@0.1.0 @margoengine/machinery@0.1.0
```

```ts
import { Engine, box } from '@margoengine/core';
import { Kinematics } from '@margoengine/machinery/kinematics';
import { industrialMaterial } from '@margoengine/machinery/materials';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const arm = engine.createMesh().setGeometry(box()).setScale([0.3, 1.5, 0.3])
  .setMaterial(industrialMaterial('anodizedAluminum'));
const kinematics = Kinematics.attach(engine, [
  { node: arm, axis: 'y', kind: 'revolute', min: -Math.PI / 2, max: Math.PI / 2 },
]);
let elapsed = 0;
engine.onFrame((_, delta) => {
  elapsed += delta;
  kinematics.setAngle(0, Math.sin(elapsed));
});
engine.start();
```

Call `engine.dispose()` on teardown. `loadCAD` uses a worker in browsers; `parseCADAsync` transfers and detaches an owned ArrayBuffer. Both support STL/OBJ/STEP/IGES. Synchronous `parseCAD` retains STL/OBJ support. STEP/IGES tessellation loads separate OpenCascade assets only when needed and returns meters; STL/OBJ retain their input units. Worker imports smooth welded normals by default; use `{ smoothing: false }` to retain hard faces.

Use `@margoengine/machinery/cad` for `loadCAD`, `parseCAD`, `deduplicateParts` and `PartInstancer`, or `@margoengine/machinery/cad-async` for `parseCADAsync` and its option types. These entries exclude unrelated machinery systems and share module identity with the existing package root. CAD worker assets remain in `dist/workers` and resolve relative to the shipped JavaScript; retain that directory when copying the package directly.

Import individual systems from these subpaths to keep unrelated code out of direct browser imports and lazy-loaded modules. Each entry includes its associated TypeScript types. Existing imports from `@margoengine/machinery` remain supported and use the same classes and functions.

| Subpath | Public system |
| --- | --- |
| `/kinematics` | `Kinematics` joints, couplings and constraints |
| `/surface` | `SurfacePhysics` transport |
| `/telemetry` | `TelemetryChannel` binary playback |
| `/section` | `SectionPlanes`, `boxSection` |
| `/assembly` | `AssemblyIndex` |
| `/metrology` | Vertex, edge, face, hole and snap anchors; `measureDistance` |
| `/spatial` | `AssemblyBVH` picking |
| `/clearance` | `measureClearance` |
| `/materials` | `industrialMaterials`, `industrialMaterial` |
| `/overlays` | `EngineeringAnnotations`, `worldAnchor`, `projectAnnotation` |
| `/exploded` | `ExplodedView` |
| `/edges` | `FeatureEdges`, `featureEdges` (uses `@margoengine/geometry`) |
| `/dimensions` | `Dimensions` GPU dimension callouts (uses `@margoengine/lines` and `@margoengine/text`) |

Required dependencies remain shared: telemetry uses kinematics, and BVH picking uses its Wasm spatial kernel. Importing materials or exploded views does not load those systems. Retain the JavaScript and shared chunks in the package's `dist` directory when serving these entry points directly.

`SurfacePhysics.create(parts, carriers)` and `TelemetryChannel.create(kinematics)` asynchronously prepare fixed Wasm storage before `engine.use`. Surface transport uses world-space carrier velocity or angular velocity × contact offset, friction bounded by μg, and lanes with fixed unit axes and supplied part half lengths. It supports reverse travel, stopped parts and carrier transfer. Parts must be root meshes without prismatic joints. This is supported surface transport with 1D accumulation, not general rigid-body physics.

Telemetry accepts little-endian `[u32 timestampMs, u16 count, (u16 jointIndex, f32 value) × count]`, using indices in the attached `Kinematics` joint list. `push` validates an entire frame before updating its two-state buffer; invalid floats/limits reject, duplicate/stale timestamps return false, and interpolation holds at the latest sample. `connect(webSocket)` receives binary frames; supply `onError` to handle rejected packets. Attaching telemetry suspends autonomous joint velocity/IK updates; removing it restores them. `reset()` starts a new timeline after a PLC clock restart; u32 rollover is handled automatically. Default playback delay is 100 ms.

`FeatureEdges` draws CAD feature lines: edges whose faces meet at more than `angle` degrees (default 30) plus open boundaries. They are computed once per distinct geometry and drawn with one instanced draw per geometry from the transforms the core already uploaded, so culling, hidden parts and `ExplodedView` apply with no extra work. Lines keep a constant screen width (`width`, CSS pixels), use hardware depth bias (`depthBias`) so they never z-fight their own faces, work with `@margoengine/cameras` orthographic views and are clipped by `SectionPlanes`. WebGPU only. Call `refresh()` after `setGeometry`, or after replacing meshes without changing the mesh count.

`Dimensions` draws CAD dimension callouts on the GPU: linear distances with extension lines, arrowheads and a label, angles (arc) and radii or diameters (leader). They keep a constant screen size at any zoom, perspective or orthographic (`@margoengine/cameras`), and read the same anchors as metrology and `EngineeringAnnotations`, so a machinery `Dimension` can be added as is.

```ts
import {Engine, box} from '@margoengine/core';
import {Dimensions} from '@margoengine/machinery/dimensions';
import {vertexAnchor, holeAnchor} from '@margoengine/machinery/metrology';

const engine = await Engine.create(document.querySelector('canvas')!);
const part = engine.createMesh().setGeometry(box(0.25, 0.1, 0.1)); // stands in for a CAD part
const ring = [8, 9, 10, 11];                                          // vertex indices around a hole in your part
const dims = Dimensions.attach(engine, {unit: 'mm', decimals: 1, color: '#ffa76c', fontSize: 14});
const a = vertexAnchor(part, 0), b = vertexAnchor(part, 5);
const spec = dims.add({a, b});                                                            // "250.0 mm", 24 px off the part
dims.add({a, b, offset: -40, label: 'B'});                                                // other side, own text
dims.add({kind: 'angle', vertex: vertexAnchor(part, 0), a: vertexAnchor(part, 1), b: vertexAnchor(part, 3)}); // "90.0°"
dims.add({kind: 'radius', center: holeAnchor(part, ring), a: vertexAnchor(part, ring[0]), diameter: true});   // "Ø12.0 mm"
dims.value(spec);   // the measured number (measureDistance units, or degrees)
dims.remove(spec); dims.dispose();
```

Each frame the anchors (and their parts' current transforms) are projected, the callout is laid out in CSS pixels (offset 24, extension-line gap 3 and overshoot 6, arrowheads `arrowSize` 10, labels `fontSize` 14, lines `lineWidth` 1.5), and every point is placed back in the view plane through its anchor, so it projects to exactly that pixel. All lines of all dimensions are one `@margoengine/lines` segment list (one instanced draw, re-uploaded only when a point moves); labels are `@margoengine/text` SDF blocks (one draw each), read left to right and kept sharp by the SDF at any zoom. Spans shorter than 2.5 arrowheads put the arrows outside. Hidden or removed parts hide their dimensions; anchors behind the eye skip theirs. By default callouts draw over the scene (`onTop: false` depth-tests them). `Dimensions` adds its own `Lines` and `TextRenderer` plugins (`<name>:lines`, `<name>:text`, one 1 MB glyph atlas page) and removes them on `dispose()`. Entry size about 4.0 kB min+gzip plus lines and text if the app does not load them already; nothing if not imported. Limits: angle arcs are drawn in screen space between the projected rays (the label is the true 3D angle); in perspective a label sits at the first anchor's depth; labels cost one draw call each; WebGPU only.

`ExplodedView` writes part positions only when `amount` changes, so an exploded view at rest costs nothing per frame.

`AssemblyBVH.create(meshes)` builds one local-space Wasm triangle BVH per distinct geometry, shared by all its instances, and tests rays against per-part bounding spheres first; the 1,000,000-triangle limit applies to distinct geometry, not to instances. Render after editing transforms, then `rebuild()` after transform/visibility changes; recreate it after geometry changes. `raycast` returns a mesh, triangle, world point and distance; `snap` selects triangle vertices, edge midpoints or supplied circular-ring centers. `measureClearance(a,b,'obb'|'aabb')` measures bounding boxes, not exact mesh solids; OBBs reject sheared transforms. Dispose the BVH separately. Float32 geometry/transforms limit metrology precision.

`SectionPlanes.enabled` switches sections without removing the plugin and without a shader compile: the clip loop stays in core's shader (anchor `let facing=`, docs/shader-contracts.md) and reads a plane count of 0 while off, and the five cap pipelines compile in the background (`createRenderPipelineAsync`) while off; switching on waits for them (a frame or two after load) instead of stalling. For stall-free toggles create the plugin up front with `enabled = false`: adding it later compiles core's patched pipeline and the caps on that frame (160-230 ms measured on an Arc 140V, versus about 8 ms for switching on, most of it the caps' first draw). `FeatureEdges` compiles its other variant (with or without section clipping) in the background after the first, so adding or removing sections does not stall it either.

CPU machinery tools work with either backend. Section rendering requires WebGPU; caps require depth32float-stencil8 and closed, consistently oriented geometry. Depth-fail winding uses a dedicated plane-depth/stencil target and composites against beauty depth. For open, nonmanifold or mixed-winding surfaces, use `{ cap: false }`; no stencil algorithm can infer their missing solid interior.

Tests: `packages/machinery/test/dimensions.test.js` (mock GPU, real core cameras) checks pixel offsets, arrowhead and label em sizes at orthographic zoom 1 and 4 and in perspective, measured values, arrows outside short spans, vertical labels, angle arcs, radius leaders on attached parts, hidden parts and cleanup. Real GPU: `node packages/machinery/test/dimensions-check.mjs` (GPU lock) measures the drawn dimension line 24 px above a box edge and the label ink size unchanged across orthographic zoom 1, 2 and perspective.

This ESM package includes TypeScript declarations and requires `@margoengine/core` 0.1.0. See the [API and supported geometry guide](https://github.com/scottcampbelldata/margoengine/blob/main/MODERN-ENGINE.md).

Margo Engine code is MIT licensed. The separately loaded OCCT assets are LGPL-2.1; notices and the license ship in `dist/workers`. These assets add about 7.7 MB to the package, separate from the machinery runtime JavaScript.
