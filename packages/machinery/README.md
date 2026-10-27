# @margoengine/machinery

Import `margoengine/machinery` from the `margoengine` package, or `@margoengine/machinery` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Joints and couplings, bounded IK, Wasm surface transport, binary telemetry, worker CAD import, stencil sections, assembly BVH picking and metrology for Margo Engine.

Package name: `@margoengine/machinery`, version `1.0.0`. Build from source or install a local tarball until the renamed package is published.

```sh
npm install @margoengine/core@1.0.0 @margoengine/machinery@1.0.0
```

```ts
import { Engine, box } from 'margoengine/core';
import { Kinematics } from 'margoengine/machinery/kinematics';
import { industrialMaterial } from 'margoengine/machinery/materials';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const arm = engine.createMesh().setGeometry(box()).setScale([0.3, 1.5, 0.3])
  .setMaterial(industrialMaterial('anodizedAluminum'));
const kinematics = new Kinematics([
  { node: arm, axis: 'y', kind: 'revolute', min: -Math.PI / 2, max: Math.PI / 2 },
]);
engine.use(kinematics);
let elapsed = 0;
engine.onFrame((_, delta) => {
  elapsed += delta;
  kinematics.setAngle(0, Math.sin(elapsed));
});
engine.start();
```

STEP and IGES import uses [OpenCascade](https://dev.opencascade.org/) (occt-import-js, WebAssembly, LGPL-2.1 with the Open CASCADE exception), run in a worker and loaded only when a STEP or IGES file is; see the licence note at the end.

Call `engine.dispose()` on teardown. `loadCAD` uses a worker in browsers; `parseCADAsync` transfers and detaches an owned ArrayBuffer. Both support STL/OBJ/STEP/IGES. Synchronous `parseCAD` retains STL/OBJ support. STEP/IGES tessellation loads separate OpenCascade assets only when needed and returns meters; STL/OBJ retain their input units. STEP/IGES shade with OpenCascade's own surface normals by default: smooth across each curved face, hard at every B-rep edge. STL/OBJ worker imports weld corners at the same point and smooth their normals by default, up to a crease angle: triangles that meet at more than `creaseAngle` degrees (default 40) keep a hard edge, so a box stays sharp and a cylinder cut into 9 or more sides shades round. `{ smoothing: false }` gives one flat normal per triangle.

OBJ triangles and quads become triangles directly (a quad splits along its inside diagonal); faces with five or more corners go through contour triangulation, whose 10,000,000-step work budget still bounds them. `node scripts/machinery-cad-large-tests.js` loads a 50,000-part OBJ through `parseCADAsync` on a real GPU and packs it.

For STEP and IGES, `parseCADAsync` and `loadCAD` take an optional `linearDeflection`: the largest distance in meters that OpenCascade's triangles may stray from the true surface (smaller is finer). Omitted, the OpenCascade call is unchanged. The 100,000-part default `maxParts` is unchanged.

To read STEP or IGES with a reader of your own instead of OpenCascade, pass an `importer` to `loadCAD` or `parseCADAsync` (default none). It gets the engine, the file's bytes, the format and the import options after the size and option checks, and returns the `CADModel`:

```ts
import { Engine } from 'margoengine/core';
import { loadCAD, type CADModel } from 'margoengine/machinery/cad';

declare function readStep(engine: Engine, bytes: ArrayBuffer): Promise<CADModel>;

const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const model = await loadCAD(engine, '/part.step', {
  importer: (engine, bytes) => readStep(engine as Engine, bytes),
});
```

`PartInstancer.attach(engine)` (WebGPU) first runs `deduplicateParts`, which shares Geometry between identical core parts and points identical static glTF-pro primitives of one model at one GPU buffer pair (skinned and morphed primitives keep their own). It then packs small closed static parts that have their own Geometry and equal material values under one root into root-space GPU buffers: each part stays a visible mesh with its name, Geometry, material and parent, core skips its claimed batch, and the plugin draws each pack once inside every core draw with that draw's pipeline and bindings, so section clips, caps, bloom and SSAO include packed triangles. Picks still draw the parts themselves; selection's id capture (`DrawOptions.partIds`) draws a pack part by part. A part returns to its own draw when it moves, hides, changes material or geometry, or another visible mesh starts sharing its geometry. Big parts (`partVertices`, default 4,096), shared Geometry and open shells stay on their own draws; `instancer.pack = false` restores one draw per part, and `refresh()` packs parts loaded later. Pass the instancer to `shadows.add` for the packs' directional shadows (clipped by sections). Packed parts keep their own GPU buffers too, so their vertex memory doubles. `node scripts/machinery-pack-tests.js` (after `npm run build:packages`) checks draws, picks, section beauty, shadow and cap pixels, glTF buffer sharing and `linearDeflection` on loaded files on a real GPU.

Use `@margoengine/machinery/cad` for `loadCAD`, `parseCAD`, `deduplicateParts` and `PartInstancer`, or `@margoengine/machinery/cad-async` for `parseCADAsync` and its option types. These entries exclude unrelated machinery systems and share module identity with the existing package root. CAD worker assets remain in `dist/workers` and resolve relative to the shipped JavaScript; retain that directory when copying the package directly.

CAD grouping also counts nodes loaded by `@margoengine/gltf-pro` and `@margoengine/fbx`. It compares static bind-pose triangles and normals across all primitives without replacing PBR buffers or attaching core geometry. Skinned and morphing parts remain distinct. Hierarchy-only nodes are skipped; an input with no supported geometry throws.

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

Find parts by name or tag, measure the gap between two parts, and explode an assembly (zero configuration; `amount` starts at 0, `measureClearance` defaults to `'obb'`):

```ts
import { Engine, box } from 'margoengine/core';
import { AssemblyIndex } from 'margoengine/machinery/assembly';
import { measureClearance } from 'margoengine/machinery/clearance';
import { ExplodedView } from 'margoengine/machinery/exploded';

const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const base = engine.createMesh().setGeometry(box());
base.name = 'Base plate';
const lid = engine.createMesh().setGeometry(box()).setPosition([0, 2, 0]);
lid.name = 'Base lid';

const index = new AssemblyIndex(engine); // call index.refresh() after renaming or adding meshes
index.tag(lid, 'cover');
const plates = index.findChildrenByName('Base*'); // '*' is the only wildcard
const covers = index.findByTag('cover');
index.setSubtreeVisible(covers[0], true);

engine.render();
const { distance, interfering } = measureClearance(base, lid); // 'obb' (default) or 'aabb'
console.log(plates.length, distance, interfering);

const exploded = ExplodedView.attach(engine, [{ node: lid, offset: [0, 3, 0] }]);
exploded.amount = 1; // 0 = assembled, 1 = fully exploded
```

One short example per system (every option has a default; `engine.render()` first so world transforms are current):

```ts
import { Engine, box } from 'margoengine/core';
import { Kinematics } from 'margoengine/machinery/kinematics';
import { SurfacePhysics } from 'margoengine/machinery/surface';
import { TelemetryChannel } from 'margoengine/machinery/telemetry';
import { SectionPlanes, boxSection } from 'margoengine/machinery/section';
import { vertexAnchor, measureDistance } from 'margoengine/machinery/metrology';
import { EngineeringAnnotations } from 'margoengine/machinery/overlays';
import { AssemblyBVH } from 'margoengine/machinery/spatial';

const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const belt = engine.createMesh().setGeometry(box()).setScale([4, 0.1, 1]);
const crate = engine.createMesh().setGeometry(box()).setScale([0.4, 0.4, 0.4]).setPosition([-1, 0.25, 0]);

// Surface transport: a belt moving at 0.5 units per second carries the crate along +x (friction 0.5 by default).
await SurfacePhysics.attach(
  engine,
  [{ node: crate, carrier: 0, lane: 0, axis: [1, 0, 0], halfLength: 0.2 }],
  [{ node: belt, velocity: [0.5, 0, 0] }],
);

// Telemetry: drive a joint from binary frames over a WebSocket, played back 100 ms late by default.
const joint = Kinematics.attach(engine, [{ node: belt, axis: 'z', min: -1, max: 1 }]);
const telemetry = await TelemetryChannel.attach(engine, joint, { delay: 100 });
telemetry.connect(new WebSocket('wss://plant.example/joints'));

// Sections: cut the scene to the inside of a box; closed solids get hatched caps (cap: false turns them off).
SectionPlanes.attach(engine, { planes: boxSection([-3, -1, -1], [3, 1, 1]), hatch: 8 });

// Metrology and annotations: measure between two vertices and draw the dimension over the canvas.
engine.render();
const a = vertexAnchor(crate, 0);
const b = vertexAnchor(crate, 1);
console.log(measureDistance(a, b, 'mm')); // 'mm' (default), 'in' or 'm'
EngineeringAnnotations.attach(engine, { unit: 'mm', scale: 1000, dimensions: [{ a, b }] });

// Picking: a Wasm BVH over the assembly; call rebuild() after parts move.
const bvh = await AssemblyBVH.create([belt, crate]);
bvh.rebuild();
console.log(bvh.raycast([0, 5, 0], [0, -1, 0])?.distance);
bvh.dispose();
```

Errors follow the engine convention: `TypeError` and `RangeError` for bad arguments, and a `MargoError` with a `code` (`'state'` for an unattached plugin or a stale BVH, `'disposed'`, `'attached'`, `'unsupported'` for missing WebGPU, `'failed'`) for everything else; branch on `error.code`, not on the message.

Required dependencies remain shared: telemetry uses kinematics, and BVH picking uses its Wasm spatial kernel. Importing materials or exploded views does not load those systems. Retain the JavaScript and shared chunks in the package's `dist` directory when serving these entry points directly.

`SurfacePhysics.create(parts, carriers)` and `TelemetryChannel.create(kinematics)` asynchronously prepare fixed Wasm storage before `engine.use`. Surface transport uses world-space carrier velocity or angular velocity × contact offset, friction bounded by μg, and lanes with fixed unit axes and supplied part half lengths. It supports reverse travel, stopped parts and carrier transfer. Parts must be root meshes without prismatic joints. This is supported surface transport with 1D accumulation, not general rigid-body physics.

Telemetry accepts little-endian `[u32 timestampMs, u16 count, (u16 jointIndex, f32 value) × count]`, using indices in the attached `Kinematics` joint list. `push` validates an entire frame before updating its two-state buffer; invalid floats/limits reject, duplicate/stale timestamps return false, and interpolation holds at the latest sample. `connect(webSocket)` receives binary frames; supply `onError` to handle rejected packets. Attaching telemetry suspends autonomous joint velocity/IK updates; removing it restores them. `reset()` starts a new timeline after a PLC clock restart; u32 rollover is handled automatically. Default playback delay is 100 ms.

`AssemblyBVH.create(meshes)` builds a Wasm triangle BVH. Render after editing transforms, then `rebuild()` after transform/visibility changes; recreate it after geometry changes. `raycast` returns a mesh, triangle, world point and distance; `snap` selects triangle vertices, edge midpoints or supplied circular-ring centers. `measureClearance(a,b,'obb'|'aabb')` measures bounding boxes, not exact mesh solids; OBBs reject sheared transforms. Dispose the BVH separately. Float32 geometry/transforms limit metrology precision.

Assembly BVHs also discover static glTF Pro/FBX triangles, including multiple primitives per mesh, without attaching core geometry. Vertex and edge snapping work on those sources. PBR circular-ring snapping requires an explicit local anchor. Active GPU skin/morph buffers cause creation, rebuild and queries to throw with a direction to use asynchronous `Raycaster.intersectModel(model)`; a static assembly never silently substitutes the bind pose for a deformed surface.

CPU machinery tools work with either backend. Section rendering requires WebGPU; caps require depth32float-stencil8 and closed, consistently oriented geometry. Depth-fail winding uses a dedicated plane-depth/stencil target and composites against beauty depth. For open, nonmanifold or mixed-winding surfaces, use `{ cap: false }`; no stencil algorithm can infer their missing solid interior.

`SectionPlanes` also clips native primitives loaded by `@margoengine/gltf-pro` and their directional shadows from `@margoengine/shadows`. Both renderers reuse the existing section uniform and world-space plane test. Use `{ cap: false }` for loaded models: stencil caps currently draw core geometry only. Attached sections redraw the directional shadow atlas each frame so editing planes or `enabled` cannot leave stale shadows; removing sections restores normal caching.

Run `node scripts/section-loaded-asset-tests.js` from the repository root after building packages. The real checked-in `Box.glb` is loaded through `loadGLTF`; at actual 1x and 4x MSAA, the removed beauty matches the empty scene, its removed shadow matches the lit receiver, and the retained half keeps both its beauty and shadow. Core + stage measures 21,107 bytes gzip.

This ESM package includes TypeScript declarations and requires `@margoengine/core` 1.0.0. See the API and supported geometry guide.

Margo Engine code is Apache-2.0 licensed. The separately loaded OCCT assets are LGPL-2.1; notices and the license ship in `dist/workers`. These assets add about 7.7 MB to the package, separate from the machinery runtime JavaScript.
