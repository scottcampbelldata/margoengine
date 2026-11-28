# @margoengine/machinery

Import `margoengine/machinery` from the `margoengine` package, or `@margoengine/machinery` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Joints and couplings, bounded IK, Wasm surface transport, binary telemetry, stencil sections, assembly BVH picking and metrology for Margo Engine.

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

CAD import (`loadCAD`, `parseCADAsync`, `parseCAD`, `deduplicateParts`, `PartInstancer`) lives in `@margoengine/cad`; see its README. STEP, IGES, SAT, XT and JT go through Margo's own B-rep kernel there.

Import individual systems from these subpaths to keep unrelated code out of direct browser imports and lazy-loaded modules. Each entry includes its associated TypeScript types. Existing imports from `@margoengine/machinery` remain supported and use the same classes and functions.

| Subpath | Public system |
| --- | --- |
| `/kinematics` | `Kinematics` joints, couplings and constraints |
| `/mechanisms` | Closed-form poses: Geneva, Scotch yoke, Oldham, Sarrus, toggle, Reuleaux, rose engine, Archimedes screw, gimbal, epicyclic, differential, harmonic drive, integrator, Watt governor, stroboscope |
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

const index = AssemblyIndex.attach(engine); // call index.refresh() after renaming or adding meshes
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

Assembly BVHs also discover static glTF PBR/FBX triangles, including multiple primitives per mesh, without attaching core geometry. Vertex and edge snapping work on those sources. PBR circular-ring snapping requires an explicit local anchor. A mesh deformed on the GPU (an `Animation`'s skin or morph, a `BatchedMesh`) is held at the pose its deformer evaluates on the CPU; a new pose counts as a move: call `rebuild()`, and a raycast or snap before it throws `state`. A deformer with no CPU pose makes creation, rebuild and queries throw `unsupported` with a direction to use asynchronous `Raycaster.intersectModel(model)`; the bind pose is never substituted for a deformed surface.

CPU machinery tools work with either backend. Section rendering requires WebGPU; caps require depth32float-stencil8 and closed, consistently oriented geometry. Depth-fail winding uses a dedicated plane-depth/stencil target and composites against beauty depth. For open, nonmanifold or mixed-winding surfaces, use `{ cap: false }`; no stencil algorithm can infer their missing solid interior.

`SectionPlanes` also clips native primitives loaded by `@margoengine/gltf/pbr` and their directional shadows from `@margoengine/shadows`. Both renderers reuse the existing section uniform and world-space plane test. Use `{ cap: false }` for loaded models: stencil caps currently draw core geometry only. Attached sections redraw the directional shadow atlas each frame so editing planes or `enabled` cannot leave stale shadows; removing sections restores normal caching.

Scene sections reserve their own mesh-shader uniform binding so they can run with directional shadows and clustered
lights. The section pass runs before the lighting passes so clipped objects cast matching shadows. The GPU
regression draws both a capped solid and an open sheet with both light providers active. See the W3C specifications
for the [WGSL resource interface](https://www.w3.org/TR/WGSL/#resource-interface) and
[WebGPU pipeline layout validation](https://www.w3.org/TR/webgpu/#pipeline-layout).

Three more entries draw on top of the scene:

- `margoengine/machinery/edges`: `FeatureEdges`, CAD feature lines (faces meeting above an angle, plus open boundaries) drawn with GPU culling and level of detail; `featureEdges(geometry, angle)` returns the edge index pairs on the CPU.
- `margoengine/machinery/dimensions`: `Dimensions`, linear, angle and radius dimension callouts whose lines and labels keep their size on screen.
- `margoengine/machinery/react`: `<SectionPlanes>`, the section plugin as a React component for `@margoengine/react`.

`packages/machinery/test/*-check.mjs` (`npm run test:gpu` in this package) check edges, dimensions and caps on open shells on a real adapter.

This ESM package includes TypeScript declarations and requires `@margoengine/core` 1.0.0. See the API and supported geometry guide.

### Mechanism poses

`margoengine/machinery/mechanisms` holds the exact pose of fifteen classic mechanisms as pure functions: angles in radians, lengths in metres, plain numbers and arrays back. Each is the closed-form solution of the mechanism's loop-closure equations, so it is what a physics-joint model of the same mechanism tracks (see `tests/machinery-mechanisms-physics.test.js`, where a hinge motor, sliders, a pin in a slot and a gear joint of `@margoengine/physics` follow `genevaPose`, `scotchYokePose`, `oldhamPose` and `epicyclicSpeeds`) and the number a readout shows. No engine is needed.

```ts
import {
  genevaPose, scotchYokePose, oldhamPose, epicyclicSpeeds, harmonicDriveRatio,
  wattGovernorEquilibrium, stroboscopicRate, ballDiskIntegrator,
} from 'margoengine/machinery/mechanisms';

// A four-slot Geneva wheel 0.32 m from its crank: dwells, then indexes a quarter turn each crank turn.
const geneva = genevaPose(0.3, { slots: 4, centerDistance: 0.32 });
console.log(geneva.wheel, geneva.indexing, geneva.velocityRatio);

console.log(scotchYokePose(1, 0.14).slide); // 0.14 cos(1), simple harmonic motion
console.log(oldhamPose(1, 0.1).output); // 1: the Oldham coupling has constant velocity

// Willis: sun 21, planet 18, ring 57 with the ring held; the carrier turns 21/78 of the sun.
console.log(epicyclicSpeeds({ sun: 21, planet: 18, ring: 57 }, { sun: 1, ring: 0 }).carrier);
console.log(harmonicDriveRatio({ flexTeeth: 60, circularTeeth: 62 })); // -1/30

// Maxwell 1868: the balls of a governor at 90 rpm sit where w^2 L cos(a) = g.
const governor = wattGovernorEquilibrium((90 * 2 * Math.PI) / 60, { arm: 0.29, pickoff: 0.2, link: 0.23 });
console.log(governor.angle, governor.sleeve);

console.log(stroboscopicRate(120, 14, 6)); // -20 rpm: a six-spoke rotor seems to turn backwards
const integrator = ballDiskIntegrator({ wheelRadius: 0.046, diskRadius: 0.24 });
integrator.advance(1, 0, 0.2); // one disk turn while the ball moves out to 0.2 m
console.log(integrator.outputTurns); // 0.1 / 0.046
```

| Function | Mechanism and source |
| --- | --- |
| `genevaPose`, `genevaCrankRadius` | External Geneva drive, tangential pin entry (Bickford 1972; Uicker, Pennock and Shigley 2017) |
| `scotchYokePose` | Scotch yoke, exact simple harmonic motion |
| `oldhamPose` | Oldham coupling, disc centre on a circle of half the offset (Reuleaux 1876) |
| `sarrusPose` | Sarrus straight-line linkage (Reuleaux 1876) |
| `togglePressPose` | Symmetric toggle and its mechanical advantage `h / 2x` |
| `reuleauxPose`, `reuleauxOutline` | Reuleaux triangle turning in a square, touching all four sides (Reuleaux 1876) |
| `roseEnginePose`, `rosetteModulation` | Rose engine: rosette, rubber and fixed tool |
| `archimedesScrew`, `archimedesScrewPose` | Inclined Archimedes screw buckets and flow (Rorres 2000) |
| `gimbalAngles`, `gimbalAxis`, `gimbalPose` | Two-ring gimbal and gimbal lock |
| `epicyclicSpeeds`, `epicyclicAssembles` | Simple planetary train by Willis's relation (Willis 1841) |
| `differentialSpeeds`, `differentialPose` | Open bevel-gear differential |
| `harmonicDriveRatio`, `waveGeneratorRadius`, `flexsplinePoint` | Strain wave gearing (Musser 1959) |
| `ballDiskIntegrator` | Disk-ball-roller integrator (Thomson 1876) |
| `wattGovernorEquilibrium` | Conical-pendulum governor (Maxwell 1868) |
| `stroboscopicRate`, `stroboscopicPose` | Apparent speed under a strobe (Shannon 1949; Edgerton 1932) |

Every input is checked: a bad count or length throws a `RangeError` naming it. `flexsplinePoint` is a drawing aid (where a flexspline point sits as its teeth hand over between the two pitches), not an elastic solution of the flexspline.

### Attaching from a second scene

`SurfacePhysics.attach` and `TelemetryChannel.attach` remember the scene that is active when you call them, before their first await, and join that scene when they finish. Start it inside a second scene's plugin `setup` and the plugin belongs to that scene; start it anywhere else and it belongs to the default scene. An abort or a failure leaves nothing in either scene.
