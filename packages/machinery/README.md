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
| `/bench` | `CadBench`, `cadFinish`, `CAD_FINISHES`: measured metal finishes, feature edges and a surface-plate deck |
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

`packages/machinery/test/*-check.mjs` (`npm run test:gpu` in this package) check edges, dimensions, caps on open shells and the CAD bench (both backends) on a real adapter.

This ESM package includes TypeScript declarations and requires `@margoengine/core` 1.0.0. See the API and supported geometry guide.

### CAD bench

`margoengine/machinery/bench` puts solids from a CAD kernel on an inspection bench. `CadBench.attach(engine, { deck })`
lays a black granite surface plate (`deck: false` for none); `cad.show(meshOrGeometry, { finish, tint, roughness, edges })`
gives the part a finish on a measured metal from `@margoengine/materials/presets` and draws its feature edges (faces
meeting above `angle` degrees, plus open boundaries) as `@margoengine/lines` segments that follow the mesh, on WebGPU and
on the WebGL2 layer alike. Pass a glTF model's meshes straight in: the bench keeps their geometry.

| Finish | Metal | Roughness | Tint (linear, on F0) |
| --- | --- | --- | --- |
| `'machined'` (default) | aluminium | 0.32 | none |
| `'cast'` | cast iron (`castIron`) | 0.75 | none |
| `'anodised'` | aluminium | 0.4 | [0.22, 0.34, 0.5], a Type II steel blue; `tint` sets the dye |
| `'cut'` | aluminium | 0.16 | none: a fresh saw or section face |

Edge defaults: `angle` 30, `width` 1.25 CSS px, `color` '#0c1013', `opacity` 0.82, `depthBias` 0.0012. Deck defaults:
`size` [0.42, 0.3] m, `thickness` 0.04, `top` the thickness (the plate rests on studio/bench's floor at y 0; parts rest
on `cad.deckTop`), `center` [0, 0]. `casters` takes anything with `add(mesh)`, such as
studio/bench's `openBench` result, so shown parts cast its shadows. The bench stages nothing else: open the engine,
lights, shadows and backdrop with `openBench`; its `'tent'` environment preset (studio/backdrop) lights flat metal
faces from every heading.

`show(mesh, { metal })` swaps the finish's metal for any measured one in `@margoengine/materials/presets` (or
`'castIron'`) and keeps the finish's roughness and tint: a machined copper or steel part. `cad.mark(point, { size,
color, width })` draws a three-axis cross at a point through the bench's lines (defaults 0.008 m, '#d2302a', 2 px), for
a centre of mass, a datum or a probe hit; `mark.remove()` takes it off.

```ts
import { box } from 'margoengine/core';
import { openBench } from 'margoengine/studio/bench';
import { CadBench } from 'margoengine/machinery/bench';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const bench = await openBench(canvas, {
  camera: { position: [0.3, 0.2, 0.38], target: [0, 0.03, 0], fov: 35, near: 0.01, far: 20 },
  environment: { preset: 'tent', intensity: 0.5 },
  contact: false,
});
const cad = CadBench.attach(bench.engine, { deck: { size: [0.42, 0.3] }, casters: bench });
cad.show(box(0.12, 0.06, 0.08), { finish: 'anodised' }).mesh.setPosition([0, cad.deckTop + 0.03, 0]);
cad.show(box(0.04, 0.02, 0.04), { finish: 'machined', metal: 'copper' }).mesh.setPosition([0.1, cad.deckTop + 0.01, 0]);
const centre = cad.mark([0, cad.deckTop + 0.061, 0]); // on the anodised block's top face
await bench.ready();
centre.remove();
```

The demo solids travel as GLB: a build script meshes the B-rep body, writes it with `exportGLB` and
`compressMeshopt` (EXT_meshopt_compression with KHR_mesh_quantization), and the page loads it with
`loadGLTF(engine, url, { extensions: [meshopt, quantized] })` and hands `model.meshes` to `show`.

Sources: glTF 2.0 (ISO/IEC 12113:2022) for the metallic-roughness F0; EXT_meshopt_compression; ISO 10303-21:2016 for the
B-rep faces whose shared boundaries are drawn; Saito and Takahashi 1990 ("Comprehensible rendering of 3-D shapes") and
Gooch, Gooch, Shirley and Cohen 1998 (technical illustration) for dark crease lines over shading; Isenberg et al. 2003
(silhouette algorithms guide) for dihedral crease detection; Bærentzen et al. 2008 for depth-biased antialiased lines.

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

### Mechanism rigs on physics

`margoengine/machinery/rigs` builds the mechanisms above as stepped `@margoengine/physics` worlds: the input shaft is a body driven by position (a servo that reaches its angle each fixed step), the followers are dynamic bodies held by the solver's joints, and after every step the bodies the solver moved are compared with the closed form. `drive(angle)` turns the input there in steps of at most 2 degrees, the shortest way round unless the second argument is `false`, and returns the pose read from the bodies; `check` holds the largest gap (in metres or radians) over the last drive and since the rig was made, and `describeCheck` writes it for a readout.

```ts
import { loadRigs, scotchYokeRig, genevaRig, oldhamRig, epicyclicRig, describeCheck } from 'margoengine/machinery/rigs';

await loadRigs(); // the solver's Wasm, once

using yoke = scotchYokeRig(0.142); // a slider and a pin in its slot (a generic joint with two free axes)
console.log(yoke.drive(Math.PI / 3).slide, describeCheck(yoke.check)); // about 0.071, within a few micrometres

using geneva = genevaRig({ slots: 4, centerDistance: 0.32 }); // the pin joint is made as the pin enters a slot
console.log(geneva.drive(4 * Math.PI, false).wheel); // two crank turns: the wheel indexed two slot pitches

using coupling = oldhamRig(0.104); // two crossed sliders carry the input angle to the offset shaft
console.log(coupling.drive(1).output);

using train = epicyclicRig({ sun: 21, planet: 18, ring: 57 }, { held: 'carrier' }); // a gear joint at Willis's ratio
console.log(train.drive(1).ring, train.check.ever);
```

| Rig | Joints | Gap at 60 Hz, 2 degree steps |
| --- | --- | --- |
| `scotchYokeRig` | slider (prismatic), pin in the yoke's slot (generic, two free axes) | 1.4 µm over two turns |
| `genevaRig` | wheel hinge, pin in the slot (generic, made and removed at the slot mouth); the wheel is fixed while the locking disc holds it | 0.004 degrees over three turns |
| `oldhamRig` | output hinge, two crossed slides (generic) | 2 µm over two turns |
| `epicyclicRig` | driven member hinge, gear joint at Willis's ratio; `held` picks the still member | 0.0003 degrees over two turns |
| `harmonicDriveRig` | output spline hinge, gear joint at Musser's tooth-count ratio (circular or flex spline held) | 0.00002 degrees over three turns |
| `integratorRig` | roller hinge, gear joint of ratio r / rho remade from where the roller stands when the ball moves (`setRadius`, `resetOutput`) | 0.0002 degrees over four disk turns |
| `archimedesScrewRig` | water on a slide, the thread as a rack and pinion of radius pitch / 2 pi; the water moves back a pitch per bucket | 2.3 µm over 4.7 turns, 49 µm over 100 |
| `stroboscopeRig` | a rotor coasting on a frictionless hinge; the world steps onto each flash (`advance(seconds)`, `setSpeed`, `setFlashRate`) | 0.0004 degrees over 5 s at 120 rpm |
| `togglePressRig` | the upper link is the crank, the lower link hinged at the knee, the ram on a slide | 4.4 µm over a closing stroke and back |
| `gimbalRig` | light rings on frictionless hinges (outer about the mount's y, inner about its x) round a rotor free about its own axis; `locked` fixes the rings | 0.0001 degrees over four tilts |
| `differentialRig` | side gears and a spider pinion as a multibody on the carrier, the bevel meshes as couplings of their joint coordinates (`coupleDofs`), the road a gear on the left side (`setSplit`) | 0.005 degrees over 14 carrier turns |
| `roseEngineRig` | the rosette is the turning cam, its groove a closed path joint (Catmull-Rom through `points` per turn) holding a follower on the headstock's slide by a point 0.2 m off its centre; the rock and the cut are the follower's | 41 µm over three turns (the steady lag a h^2 / 2c of the path row at 2 degrees a step; 3.5 µm at share 1) |
| `reuleauxRig` | four fixed walls a width apart and a convex-hull triangle (`subdivisions` an arc) free in the plane with its turn locked to the input: the wall contacts place its centre | 0.7 mm of 456 mm over two turns (contact softness) |
| `wattGovernorRig` | two point-mass arms on damped hinges of the spindle under gravity, on a stop at low speed; `spin(rpm, seconds)` runs the world, `settle(rpm)` runs it until still; read `check.last`, the gap to Maxwell's balance now | 0.001 degrees settled, about 4 s after a speed change |

The joints are rows of the solver's sequential-impulse solve (Catto 2005; Baraff 1996); the closed forms are Reuleaux (1876) and Willis (1841). Without gravity, friction or load the rigs are kinematic chains solved by the dynamics: they show the solver holds each mechanism to its exact pose. The Watt governor is the one with real dynamics: gravity pulls the balls, the spin swings them out, and a drag on each hinge (which acts only while an arm swings, so it cannot move the balance) settles them where `w^2 L cos(a) = g` (Maxwell, "On Governors", 1868). The differential's meshes are relative to the carrier: the side gears' and the spider's hinge angles are joint coordinates of a multibody tree rooted on the carrier, and couplings hold `left + right` and `spider + (zs / zp) left` fixed, as Rapier's multibody DOF couplings do; `describeCheck(check, 'last')` reads a settling rig's gap now.

The gear and rack rows read their error from the poses, so they hold the exact ratio over long runs wherever the bodies stand (a rack driven 100 turns is one or two float spacings from the exact travel; KB-PHYS-COUPLINGDRIFT1 is fixed). The screw still keeps its water near the origin, where a position's float spacing is finest. A path joint on a turning body now tracks a cam groove (KB-PHYS-PATHMOVINGBASE1 is fixed), so the rose engine and the Reuleaux drive can be built as rigs.

```ts
import { loadRigs, harmonicDriveRig, integratorRig, archimedesScrewRig, stroboscopeRig } from 'margoengine/machinery/rigs';

await loadRigs();
using harmonic = harmonicDriveRig({ flexTeeth: 60, circularTeeth: 62 });
console.log(harmonic.drive(2 * Math.PI, false).output); // about -0.209: a thirtieth of a turn back

using integrator = integratorRig({ wheelRadius: 0.046, diskRadius: 0.24, radius: 0.1 });
integrator.drive(2 * Math.PI, false);
integrator.setRadius(0.15); // the ball moves out; the next turn integrates at it
console.log(integrator.drive(4 * Math.PI, false).output); // 2 pi (0.1 + 0.15) / 0.046

using screw = archimedesScrewRig(0.348);
console.log(screw.drive(4 * Math.PI, false).travel); // 0.696 m: two pitches

using strobe = stroboscopeRig({ rpm: 120, flashRate: 14 });
console.log(strobe.advance(1).sampled); // where the 14th flash caught the rotor
```

```ts
import { loadRigs, roseEngineRig, reuleauxRig } from 'margoengine/machinery/rigs';

await loadRigs();
using rose = roseEngineRig({ lobes: 6, amplitude: 0.015 }, { toolRadius: 0.125 });
console.log(rose.drive(Math.PI / 6, false).shift); // about 0.015: the rosette has pushed the headstock out its full swing

using square = reuleauxRig(0.456);
console.log(square.drive(Math.PI / 4).span); // about [0.456, 0.456]: constant width, all four walls touched
```

```ts
import { loadRigs, describeCheck, differentialRig, gimbalRig, togglePressRig, wattGovernorRig } from 'margoengine/machinery/rigs';

await loadRigs();
using governor = wattGovernorRig({ arm: 0.292, pickoff: 0.198, link: 0.232, rpm: 68 });
governor.spin(90, 1 / 60); // one frame at the new speed: the arms start to swing out
console.log(describeCheck(governor.check, 'last')); // the gap to Maxwell's balance, shrinking frame by frame
console.log(governor.settle(90).arm); // about 1.11 rad: acos(g / (w^2 L))

using press = togglePressRig(0.231, { angle: 0.9 });
console.log(press.drive(0.14).ram); // about 0.4575 m: 2 sqrt(L^2 - x^2)

using gimbal = gimbalRig({ mountAxis: [0.83, 0.38, -0.4] });
console.log(gimbal.drive(0.7).deviation); // about 0: the rotor stays on +z

using differential = differentialRig({ sideTeeth: 20, pinionTeeth: 14, split: 0.3 });
const turn = differential.drive(2 * Math.PI, false);
console.log(turn.left - turn.carrier, turn.right - turn.carrier); // about +1.885 and -1.885
```

Page helpers: `openRig(make, ...args)` loads the solver and makes a rig in one call; `keyedRig(make)` remakes a rig whenever a build parameter (its key, such as the held member or a shaft offset) changes, at the angle asked, so the solver never steps through a jump of the geometry; every rig and `keyedRig` take `signal` (default none), which disposes them on abort; `signedReading(value, unit, digits = 1)` writes a readout with a typographic minus or a plus and no sign on zero. The Geneva pose adds `turnWheel` (the wheel angle read within the crank turn last asked of `drive`), and the Oldham pose adds `orbitCenter` and `orbitRadius`, the circle the disc centre runs on.

```ts
import { epicyclicRig, keyedRig, openRig, scotchYokeRig, signedReading } from 'margoengine/machinery/rigs';

const stop = new AbortController();
const yoke = await openRig(scotchYokeRig, 0.142, { angle: 0, signal: stop.signal });
console.log(signedReading(yoke.drive(1).slide * 1000, ' mm')); // '+76.7 mm'

const train = keyedRig((held: 'sun' | 'ring' | 'carrier', angle: number) => epicyclicRig({ sun: 21, planet: 18, ring: 57 }, { held, angle }), { signal: stop.signal });
train.drive(1, 'carrier'); // built at 1 radian with the carrier held
console.log(train.drive(1.2, 'ring').carrier); // rebuilt with the ring held, then driven
stop.abort(); // disposes the yoke and the train
```

### Attaching from a second scene

`SurfacePhysics.attach` and `TelemetryChannel.attach` remember the scene that is active when you call them, before their first await, and join that scene when they finish. Start it inside a second scene's plugin `setup` and the plugin belongs to that scene; start it anywhere else and it belongs to the default scene. An abort or a failure leaves nothing in either scene.
