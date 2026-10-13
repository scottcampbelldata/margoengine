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

Required dependencies remain shared: telemetry uses kinematics, and BVH picking uses its Wasm spatial kernel. Importing materials or exploded views does not load those systems. Retain the JavaScript and shared chunks in the package's `dist` directory when serving these entry points directly.

`SurfacePhysics.create(parts, carriers)` and `TelemetryChannel.create(kinematics)` asynchronously prepare fixed Wasm storage before `engine.use`. Surface transport uses world-space carrier velocity or angular velocity × contact offset, friction bounded by μg, and lanes with fixed unit axes and supplied part half lengths. It supports reverse travel, stopped parts and carrier transfer. Parts must be root meshes without prismatic joints. This is supported surface transport with 1D accumulation, not general rigid-body physics.

Telemetry accepts little-endian `[u32 timestampMs, u16 count, (u16 jointIndex, f32 value) × count]`, using indices in the attached `Kinematics` joint list. `push` validates an entire frame before updating its two-state buffer; invalid floats/limits reject, duplicate/stale timestamps return false, and interpolation holds at the latest sample. `connect(webSocket)` receives binary frames; supply `onError` to handle rejected packets. Attaching telemetry suspends autonomous joint velocity/IK updates; removing it restores them. `reset()` starts a new timeline after a PLC clock restart; u32 rollover is handled automatically. Default playback delay is 100 ms.

`AssemblyBVH.create(meshes)` builds a Wasm triangle BVH. Render after editing transforms, then `rebuild()` after transform/visibility changes; recreate it after geometry changes. `raycast` returns a mesh, triangle, world point and distance; `snap` selects triangle vertices, edge midpoints or supplied circular-ring centers. `measureClearance(a,b,'obb'|'aabb')` measures bounding boxes, not exact mesh solids; OBBs reject sheared transforms. Dispose the BVH separately. Float32 geometry/transforms limit metrology precision.

CPU machinery tools work with either backend. Section rendering requires WebGPU; caps require depth32float-stencil8 and closed, consistently oriented geometry. Depth-fail winding uses a dedicated plane-depth/stencil target and composites against beauty depth. For open, nonmanifold or mixed-winding surfaces, use `{ cap: false }`; no stencil algorithm can infer their missing solid interior.

This ESM package includes TypeScript declarations and requires `@margoengine/core` 0.1.0. See the [API and supported geometry guide](https://github.com/scottcampbelldata/margoengine/blob/main/MODERN-ENGINE.md).

Margo Engine code is MIT licensed. The separately loaded OCCT assets are LGPL-2.1; notices and the license ship in `dist/workers`. These assets add about 7.7 MB to the package, separate from the machinery runtime JavaScript.
