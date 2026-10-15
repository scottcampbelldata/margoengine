# Margo Engine micro-kernel

Margo Engine is a small Rust/Wasm engine for web applications with optional domain packages. This delivery implements the four-phase minimal engine plus an extensible core and working machinery/creative packs. The workspace contains the modular packages, starters and their tests and validation evidence.

## Implemented scope

| Phase | Working implementation |
| --- | --- |
| Rust math and buffers | Dependency-free Rust kernel; fixed-capacity SoA transform views in Wasm memory; hierarchy composition; SIMD sphere/frustum culling; native joint-limit clamping and inherited visibility masks; atomic validation before publishing matrices. |
| Rendering | WebGPU adapter/device negotiation, cached pipeline and geometry buffers, instanced indexed drawing, ordered GPU passes, directional GGX PBR, optional WebGL2 fallback (`@margoengine/webgl`), reversed float depth, 1×1 uint picking, native CAD navigation, canvas/depth resize and disposal. |
| TypeScript/packages | Explicit ESM exports and declarations; `sideEffects: false`; precompiled gzip-embedded Wasm; 71 independent packages (core, glTF, React, machinery, creative, scenery and more; see the [catalog](docs/README.md)). |
| React/starters | `MargoCanvas` (`Canvas` alias), `useMargoStage`, `useFrame`, mesh components; SSR-safe setup, ResizeObserver and stable refs; Vite and Next.js starters. |
| Machinery pack | Revolute/prismatic joints, gear/slider-crank couplings, bounded IK/distance constraints, exploded views, GPU sections/stencil caps, SVG dimensions/callouts, worker STL/OBJ/STEP/IGES, Wasm surface transport and telemetry, part instancing, assembly BVH picking, metrology snapping and industrial material presets. |
| Creative pack | Grass, planet, a leaf-field preset over `@margoengine/vfx` particles, toon shading, HDR targets, and a grading effect (height fog, god rays, DOF blur, grain, ACES). Bloom comes from `@margoengine/post`, skies from `@margoengine/sky`. |
| Scenery pack | `SkyMoon`, a midnight preset of `@margoengine/sky` with stars, lunar phases, glow and horizon haze. See [usage and limits](packages/scenery/README.md). |

Rust owns transforms and culling. TypeScript owns asset orchestration and browser GPU commands. Numeric Wasm exports keep `wasm-bindgen`, `web-sys` and their glue unnecessary for this kernel. Consumers need no Rust installation or Wasm URL configuration. SIMD and browser DecompressionStream gzip support are required; decompression happens once before cached module compilation.

## Install from npm (once published)

The renamed libraries use `@margoengine/*` at version `0.1.0`, with `margoengine` as the meta-package. Build from source or install local tarballs until the renamed packages are published. Package names for a React 19 application:

```sh
npm install @margoengine/core@0.1.0 @margoengine/gltf@0.1.0 @margoengine/react@0.1.0 @margoengine/machinery@0.1.0 @margoengine/creative@0.1.0 react@^19 react-dom@^19
```

The React adapter also supports React 18. See [package choices and individual install commands](README.md#install-from-npm).

## Run and build

Use Node.js 22.12+ or 24+ and a browser with WebGPU (or WebGL2 with the optional fallback). TypeScript consumers need TypeScript 7+ with the DOM library; extension GPU types use its native declarations. WebGPU needs a supported browser on localhost or HTTPS.

```sh
npm ci
npm run dev                           # new Vite starter; compiles packages first
npm test                              # compiles packages; runs the modern unit checks
npm run build:packages                # all 71 packages; precompiled Wasm, no Rust
npm run build                         # builds packages and both production starters
npm run pack:packages                 # rebuilds and packs every public library
npm run modern:test:browser            # after build: real GPU + both production starters
npm run modern:test:domains            # caps, FX, sorting, depth readback and loss races
npm run modern:test:sky                # sky fog coverage and shader parity on WebGPU
npm run modern:test:packages           # frozen public exports/types + React 18 fixture
npm run modern:test:finalization       # picking/depth/conveyor UI + 12k-entity stress; dev server required
npm run modern:check:conveyor          # live picking/pivot, coupled tick and 15s Chrome drag trace
npm run modern:check:conveyor -- --allocations  # sampling, including collected objects
npm run modern:check:conveyor -- --constructors # retained constructor breakdown
npm run dev --workspace @margoengine/starter-next
```

`npm run build`, `npm test` and `npm run dev` use the checked-in precompiled Wasm. To change the kernel:

```sh
rustup target add wasm32-unknown-unknown
npm run modern:build                  # regenerate Wasm with simd128 and compile packages
cargo test --manifest-path packages/kernel/Cargo.toml
```

The release profile uses speed optimization, fat LTO, one codegen unit, stripped symbols and aborting panics. The no-std Wasm build reserves its memory once without a general allocator. Kernel rebuilds use the pinned Binaryen pipeline below; consumers use the precompiled optimized kernel. A build fails if the Wasm exceeds 30 KiB raw, the core exceeds 20 KiB gzip, core plus the stage facade reaches 20,000 bytes gzip, or core plus glTF exceeds 30 KiB gzip.

Consumers import the scoped packages below; the root package manages the workspace and its commands. The libraries remain at version `0.1.0` and are [MIT licensed](LICENSE); the root and starters remain private. Each library's `prepack` hook builds the workspace using the checked-in Wasm, removes stale distribution files and includes a package README and a copy of the root license. `npm run pack:packages` writes one archive per public package to `test-results/`. Committed results, with the command that reproduces each, are listed in [docs/whitepaper/claims.md](docs/whitepaper/claims.md).

## Plain TypeScript

```ts
import { Engine, box, PbrMaterial } from '@margoengine/core';

const engine = await Engine.create(canvas, {
  capacity: 1024,
  backend: 'auto',
  camera: { position: [0, 2, 5], fov: 60 },
});
const mesh = engine.createMesh()
  .setGeometry(box())
  .setMaterial(new PbrMaterial({ color: '#84d6bd', roughness: 0.3 }));
engine.onFrame((_, delta) => { mesh.rotation.y += delta; });
engine.start();
// engine.stop(); mesh.dispose(); engine.dispose();
```

`mesh.position` and `mesh.scale` access Float32 views directly. `mesh.rotation` exposes Euler angles in radians and updates the shared quaternion; `setQuaternion()` is also available. A mesh caches its world-matrix view. The Wasm tick uses fixed scratch memory without runtime allocation. JavaScript float accessors and validation are not guaranteed allocation-free by V8. `engine.stats` counts visible meshes and main geometry batches; additional plugin draws are not included. GPU encoding and framework/browser internals still allocate; this is not a whole-application zero-GC claim.

`capacity` is fixed for an engine (1–100,000 entities). All hierarchy nodes, including transform-only nodes, use slots. Each engine has its own Wasm instance/memory. Parent changes reject cycles, another engine's nodes and excessive depth. Disposed refs reject writes even after a slot is reused. Removal detaches surviving children without preserving their old world transform. World matrices update at `render()`. Each active world matrix and sphere is computed once per tick, using affine composition and cached parent results; validation completes before publishing. Fixed scratch costs an additional 81 bytes per capacity slot and change tracking 66 more (about 351 bytes total per slot, plus the frustum block and Wasm page/stack overhead).

Shared `Geometry` identity produces one instanced draw even when material parameters differ. Buffers retire when the last mesh reference disappears. Geometry arrays and bounds are immutable after attachment; dynamic geometry needs a replacement `Geometry`. Material colors are linear RGB arrays or converted sRGB `#rrggbb`; roughness/metalness are 0–1. Rendering uses one directional light plus ambient radiance. Canvas sizing occurs on render and is capped at 4096 pixels per axis.

`backend: 'auto'` tries WebGPU and, only when `Engine.create(canvas, {fallback: webglRenderer})` passes the optional `@margoengine/webgl` renderer, falls back to WebGL2; without it, a missing WebGPU rejects with "WebGPU unavailable". `fallbackReason` records initialization failure. Explicit `webgpu` reports an error instead of falling back. Once a WebGPU context is acquired, a context configuration failure can prevent fallback on that same canvas. WebGL2 context loss stops rendering and reports an error. WebGPU device loss starts automatic recovery; see the lifecycle below.

## Frozen portable API, picking and CAD navigation

`EngineKernel` and `Engine` are aliases of the same asynchronous factory. The portable TypeScript surface exposes mesh handles, camera, frame lifecycle, plugin attachment, statistics, rendering, picking and reboot. `useMargoStage`, `useFrame` and React `MeshRef` share that surface. `Canvas.onCreated` receives a `Stage` facade with the portable engine at `stage.engine`. Wasm slot IDs, matrix views, storage and raw GPU state are omitted. Runtime export snapshots and packed strict consumer checks guard the contract, including expected type errors for accessing hidden internals. Advanced plugin authors explicitly import `@margoengine/core/extension` for `EnginePlugin`, `FrameGraph`, `PassContext`, `TransformStore`, and `engineRuntime`/`meshRuntime`. This is an API boundary, not a JavaScript security membrane. Prior direct storage/device imports must migrate to that entry.

```ts
import { EngineKernel, CADCameraControls } from '@margoengine/core';
const engine = await EngineKernel.create(canvas, { backend: 'webgpu' });
const controls = new CADCameraControls(engine.camera, canvas);
const unsubscribe = engine.onFrame((_, delta) => controls.update(delta));
engine.camera.fitToBoundingBox([-3, -1, -1], [3, 1, 1], {
  aspect: canvas.clientWidth / canvas.clientHeight, duration: 0.3,
});
const hit = await engine.pick(clientX - canvas.getBoundingClientRect().left,
                              clientY - canvas.getBoundingClientRect().top);
if (hit) hit.visible = false;
// unsubscribe(); controls.dispose(); engine.dispose();
```

Picking is WebGPU-only, asynchronous and interaction-driven: it rasterizes retained visible geometry into a 1×1 `r32uint` target, uses the current instance slot as the integer ID, and copies/maps exactly four bytes. `AssemblyBVH` in the machinery pack provides a separate CPU/Wasm triangle-raycast path. Coordinates are canvas-local CSS pixels; backing-store scaling is applied internally. Occlusion, section fragment clipping, misses, hidden subtrees, recycled slots and device replacement are verified. One pick may be pending per renderer; topology changes during readback cancel its result. Synthetic stencil caps and creative particles are not independent pickable entities; cap-only regions with no surviving mesh surface can return a miss. GPU readback latency prevents an instantaneous-selection guarantee.

WebGPU uses reversed Z: near=1, far=0, clear=0 and `greater-equal` with `depth32float`. When the adapter exposes the optional `depth32float-stencil8` feature, it is requested and the same float depth precision is combined with stencil; solid machinery caps require this feature. Without it, float depth, picking and shader-only sections still work. HDR, cap, particle and sky passes use the same convention. WebGL2 retains its conventional -1..1 projection/depth path. Finite positive near/far planes still apply; float depth does not make Float32 world transforms infinitely precise. A real GPU check resolves surfaces 0.1 mm apart at 500 m with near=1 mm and far=10 km, even when the farther red surface is drawn last.

`CADCameraControls` owns pointer/wheel listeners: left drag orbits the current pivot, Shift/middle/right drag pans in screen space, and wheel zoom decays smoothly through `update(delta)`. `setPivot(point)` keeps the eye position; `Camera.fitToBoundingBox(min,max,{aspect,duration,padding})` fits a bounding sphere and smoothly advances during engine frames, including recovery. Pointer navigation cancels the fit. Dispose controls and unsubscribe the update callback when detached.

## React

```tsx
import { useRef } from 'react';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame,
  type MeshRef } from '@margoengine/react';

function Cube() {
  const ref = useRef<MeshRef>(null);
  useFrame((_, delta) => { if (ref.current) ref.current.rotation.y += delta; });
  return <Mesh ref={ref} position={[0, 0, 0]}>
    <BoxGeometry args={[1, 1, 1]} />
    <PbrMaterial color="#84d6bd" roughness={0.3} />
    <Mesh position={[1.4, 0, 0]}><BoxGeometry /><PbrMaterial color="#ffa76c" /></Mesh>
  </Mesh>;
}
export default function App() {
  return <Canvas camera={{ position: [0, 2, 5] }}><Cube /></Canvas>;
}
```

These are ordinary PascalCase components. Only the canvas/error message reaches the DOM. Pure render-time registries allow child effects to register upward before a parent entity exists; entity allocation happens after commit. Strict Mode replay, abandoned Suspense renders, live prop changes and teardown have browser coverage. `useFrame` subscribes to RAF through a latest callback ref; it does not trigger React state updates. Use one geometry and material component per mesh.

The package declares React 18/19 peers; browser verification used React 19.3.0 and React 18.3.1. The React 18 check installs the actual package tarballs in an isolated fixture, checks strict consumer declarations without workspace ambient types, and verifies SSR plus Strict Mode/nesting/live props/RAF/Suspense/teardown in the browser. It preserves its `use client` directive for Next.js, and the starter page is a client component. No custom reconciler or `*.wasm` bundler plugin is needed.

## glTF and machinery

```ts
const { loadGLTF } = await import('@margoengine/gltf');
const model = await loadGLTF(engine, '/machine.glb', { signal });
const axis = model.nodes.find(node => node.name === 'Axis_1');
if (!axis) throw new Error('Model is missing Axis_1');
const { Kinematics, ExplodedView } = await import('@margoengine/machinery');
const joints = Kinematics.attach(engine, [{ node: axis, axis: 'y', min: -1, max: 1 }]);
joints.setAngle(0, 0.5);
const explode = ExplodedView.attach(engine, [{ node: axis, offset: [0, 1.5, 0] }]);
explode.amount = 0.5;
// To restore before removing: explode.amount = 0; engine.render();
// engine.removePlugin(explode.name); engine.removePlugin(joints.name); model.dispose();
```

The loader supports glTF 2.0 JSON/GLB, embedded or external buffers, static triangle geometry, indexed/interleaved accessors, generated flat normals, TRS/reflected matrix nodes, selected scene hierarchy, shared primitives and opaque constant PBR materials. Downloads use HTTP(S), cancellation and a combined 64 MiB limit. Accessors/indices and hierarchy are validated; models cap at one million vertices. Invalid imports and exhausted entity capacity roll back created nodes and GPU resources. Matrix shear, sparse/normalized accessors, textures, skins, animations, morphs, required extensions and transparent/emissive materials produce clear unsupported errors.

`model.nodes` contains named imported transform nodes; `model.meshes` contains renderable primitive children; `model.root` moves the whole import. Dispose plugins referencing model nodes before disposing the model. Exploded-view offsets are local to each part; removing the plugin leaves the current positions, so restore `amount = 0` first when needed.

## Machinery extensions

`Kinematics(joints, options)` copies its joint descriptors on construction and supports local-axis revolute angles in radians and prismatic displacement in scene units from the captured starting position. `setValue(index, value)` drives either kind; `setAngle()` drives revolute joints. Rust clamps configured revolute/prismatic limits before matrix composition, including direct transform writes; removing the plugin clears its masks. Public out-of-range setValue calls reject atomically. Joint limits prevent configured over-travel; they are not a general mesh collision solver. Coupled targets are read-only. `gears` specify source/target joint indices, ratio and optional offset; `pistons` specify a revolute source, prismatic target, radius, connecting-rod length greater than radius, and optional phase/offset. Couplings follow dependency order; cycles, duplicate targets and incompatible joint kinds reject. Configure follower limits to contain the motion. Failed coupling updates restore the previous pose.

`targets: [{ node, target, point? }]` constrain world-space anchor positions; `distances: [{ a, b, length, pointA?, pointB? }]` constrain world distances. The damped numerical solver runs on pre-update or through `solve()`, exposing `result.converged`, `error` and `iterations`. Targets can move between frames. Direct joints and gear/piston couplings support up to 1,024 joints, with cached Float32 views and a retained rollback buffer. When IK targets or distance constraints are present, the limit is 32 joints, 64 constraints and 1–100 iterations (24 default). Revolute coupling writes Euler state directly; the next Wasm tick refreshes the quaternion and world matrix. This is a bounded local solver: unreachable/singular configurations can retain a residual; inspect the result. General rigid-body/contact dynamics remain outside its scope.

```ts
const { parseCAD, PartInstancer, SectionPlanes, EngineeringAnnotations } =
  await import('@margoengine/machinery');
const model = parseCAD(engine, await file.arrayBuffer(), 'stl');
PartInstancer.attach(engine);
const plane = [0, 0, -1, 0]; // keeps dot(normal, worldPosition) + offset >= 0
SectionPlanes.attach(engine, { planes: [plane], color: '#ffa76c', hatch: 8 });
plane[3] = 0.2; // between frames; geometry and Wasm transforms remain intact
EngineeringAnnotations.attach(engine, {
  dimensions: [{ a: { node: model.root, point: [0, 0, 0] },
                 b: { node: model.root, point: [1, 0, 0] } }],
  callouts: [{ anchor: { node: model.root, point: [0, 0, 0] }, label: 'Assembly' }],
});
```

`parseCAD(engine, input, 'stl' | 'obj')` accepts text, ArrayBuffer or a view. `parseCADAsync(engine, ownedBuffer, 'stl'|'obj'|'step'|'iges', {signal?,onProgress?,smoothing?})` transfers and detaches its input into an owned worker. `loadCAD(engine, url, options)` adds bounded HTTP(S) loading and uses the worker in browsers, with synchronous STL/OBJ fallback when Worker is unavailable. ASCII/binary STL and planar OBJ polygon faces, object/group names and negative indices are supported. Surface normals are regenerated from face winding. OBJ materials, UVs and supplied normals are ignored; external material files are never fetched. STEP/IGES are tessellated by occt-import-js 0.0.23 in the worker, with output in meters; original B-Rep topology and native materials are not retained. STL/OBJ units follow input coordinates. The importer JS/Wasm and LGPL-2.1 notices are separate packaged assets; they are downloaded only for B-Rep import. Parts bind as they arrive and remain hidden until the complete import succeeds; a late error rolls them all back. Production Vite asset URLs and the starter file picker are verified.

Limits: 64 MiB input, one million unique vertices per geometry, three million expanded indices across the import, 4096 vertices per OBJ face, 100,000 OBJ group records and ten million polygon-work units. Core entity capacity also applies. Invalid input/capacity exhaustion rolls back the import. Synchronous parseCAD and worker parsers retain temporary arrays; large inputs can need substantially more RAM than their file size. Worker output is validated there, deduplicated, and transferred as the actual 24-byte core vertex layout (position/normal) plus uint32 indices and bounds. Main-thread binding adopts those views without attribute remapping or fingerprinting. Optimized parts stream to the main thread individually; duplicate parts reference already bound geometry. Single-body STL remains one packed mesh rather than triangle chunks. GPU allocation/upload still costs main-thread time. The promise resolves with the complete model; cancellation or any later failure also retires parts already streamed. Parsing/optimization progress is incremental for STL/OBJ and stage-based for OCCT. Abort terminates the worker and failed binding rolls back created meshes.

Positions and face normals are quantized at 1e-5 for welding, preserving hard edges in synchronous imports. Worker imports optionally weld positions and generate area × corner-angle weighted smooth normals (default); smoothing false retains hard faces. Coincident opposing surfaces remain importable, but normal cancellation uses a contributing face normal and does not repair winding. The weld grid is 1e-5 scene units, not an exact CAD tolerance. Triangles collapsing at that tolerance reject. Indices use core's uint32 format. Deduplication canonicalizes triangle order and cyclic vertex order, hashes positions/normals with CRC32, then compares full data to guard collisions. Identical parts share geometry/GPU allocations and a core instanced batch. `deduplicateParts(meshes)` handles existing meshes; `PartInstancer` deduplicates at setup and enables indexed indirect draws per unique geometry on WebGPU. New parts require another deduplication call. Instance data uploads once per batch/frame even when cap passes replay draws.

`boxSection(min,max)` returns the six inward planes of an orthogonal box. `SectionPlanes` supports 1–6 global world-space planes on WebGPU. Reusable uniforms drive fragment clipping; vertices are never sliced and no CPU cap meshes are generated. A dedicated depth32float-stencil8 target is initialized with each cut plane's depth. Separate passes count logical back/front faces with wrapping increments/decrements on reversed-Z greater-equal depth failure. A nonzero-stencil mask is then composited against the beauty depth; geometry is never reconstructed. Face selection handles mirrored instances. Cap passes preserve existing depth and write the cap plane's depth; each plane begins with cleared stencil. Solid caps require depth32float-stencil8 support and closed, consistently oriented meshes. Open/nonmanifold or inconsistently wound meshes have no inferable solid interior; use cap:false for clipping alone. A manifold flag cannot repair that topology. The eight-bit winding count wraps at 256 overlapping layers. Plane count is fixed on attachment; mutate normals/offsets between frames. A fullscreen triangle reconstructs plane intersections, restricted by stencil and other planes. Clipping, hatching and stencil pipelines live in machinery. Native stencil semantics follow [WebGPU](https://www.w3.org/TR/webgpu/#enumdef-gpustenciloperation).

`EngineeringAnnotations` projects world anchors into a canvas-aligned SVG on either backend. Default dimension offsets are perpendicular to the projected dimension vector, in the camera image plane; explicit pixel offsets remain available. Dimension labels rotate along their dimension vector and measure world distance with optional `unit`, `scale` and `decimals`; callouts use text content and pixel offsets. Behind-camera anchors hide. Limit: 1000 annotations. The plugin owns/removes its SVG and creates no 3D text geometry.

`AssemblyIndex(engine)` indexes current names and optional tags. `findChildrenByName("Roller_Assembly_*", root?)` supports literal names and `*` glob matching; `tag`, `untag`, and `findByTag` manage tag lookups. Call `refresh()` after importing, renaming or disposing nodes. `setSubtreeVisible(root, visible)` writes the parent's visibility bit; the next contiguous Rust entity sweep resolves inherited visibility while retaining each descendant's own hidden bit. Transform state continues updating for hidden nodes. The measured toggle time excludes that deferred frame work and is not a universal <0.01 ms hierarchy-update guarantee.

`vertexAnchor(node,index)` and `faceAnchor(node,triangle)` produce local snap anchors. `holeAnchor(node,ringIndices,tolerance?)` solves a circular, coplanar supplied ring's center and rejects degenerate/noncircular rings; STL/OBJ provide no semantic hole labels, so arbitrary hole recognition is not inferred. `snapAnchor(node,worldPoint,{kind,holes,maxDistance})` finds the closest requested vertex, triangle midpoint or supplied hole center on the selected mesh. This bounded search runs on demand, not per frame. `measureDistance(a,b,'mm'|'in'|'m',sceneToMeters=1)` transforms anchors using current Wasm matrices and returns their Euclidean distance. Call render after transform edits before measurement. Calculations use JS doubles over stored Float32 geometry/matrices, not exact original CAD/B-Rep coordinates.


`SurfacePhysics.create(parts,carriers,{gravity?})` prepares a separate fixed-capacity machinery Wasm instance; attach it with engine.use. A carrier supplies a mesh, mutable world-space velocity/angularVelocity and contactOffset. Target velocity is linear velocity + omega cross offset, projected onto the contact plane. Each part supplies a root mesh, carrier index, lane ID, unit travel axis, halfLength and optional friction/mass/contactNormal. The SoA block retains position, velocity, target velocity, mass, friction, carrier/contact data and scratch. Acceleration is bounded by mu × gravity; mass cancels in this supported Coulomb model. Lane sorting and accumulation happen in Wasm with no runtime allocation. Neighbor order follows actual velocity through deceleration and reversal; stationary parts constrain incoming items, including parts on different carriers in the same lane. Contact clamps predicted separation and trailing speed, with tolerance for Float32 rounding. `setCarrier(partIndex,carrierIndex)` transfers support without resetting velocity. Half lengths may include desired air clearance. Parent transforms, conflicting prismatic joints, invalid/overlapping input and stale handles reject. Lane axes/extents remain fixed; there is no gravity fall, general 3D collision, automatic contact discovery or automatic shaft-speed inference. Attach kinematics before surface physics when driving carriers; applications provide carrier velocities. This is a machinery Wasm update separate from the core transform tick, retaining core size/isolation.

`TelemetryChannel.create(kinematics,{delay?:100,onError?})` prepares a two-state Wasm Hermite ring. Attach after Kinematics. `push(buffer,receivedAt=performance.now())` accepts exact little-endian `u32 timestampMs, u16 count, [u16 jointIndex, f32 target] * count` frames, including sparse updates. DataView is required because six-byte records alternate float alignment. Entire packets validate before ring mutation; malformed lengths, IDs, duplicates, non-finite values and physical-limit violations reject. Coupled targets cannot be directly driven. Duplicate/backward timestamps return false, unsigned clock rollover is supported, and `reset()` deliberately starts a new timeline after PLC restarts. Sampling delays playback, estimates bounded tangents and clamps to interval endpoints when packets stop. This smooths a valid bracket; it cannot guarantee jitter-free motion across arbitrary network gaps with only two states. Attaching telemetry suspends autonomous velocity/IK updates; removing it restores them. Kinematics applies the sampled vector and its couplings atomically. `connect(webSocket)` selects binary ArrayBuffer delivery and detaches any previous socket listener; the application owns socket lifetime. Supply onError for rejected message handling. No MQTT client or network polling is added.

`AssemblyBVH.create(meshes)` builds a median-partition triangle BVH directly in a separate Wasm instance, bounded at one million triangles / 256 MiB linear memory. Double-precision ray tests operate on world-space Float32 snapshots and handle reflected meshes. `raycast(origin,direction,maxDistance?)` returns node/triangle/distance/world point or null. `snap(hit,{kind:'vertex'|'edge'|'centerline',rings?,maxDistance?})` selects hit-triangle corners/midpoints or centers of explicitly supplied circular rings. Mesh semantics such as native cylinder axes are not inferred from tessellation; internal triangulation diagonals are also edges. Frustum culling does not remove pick targets; inherited visibility does. Render after transform edits and call rebuild after transforms/visibility change; recreate the BVH after geometry changes or disposal. Dispose it separately from the engine. Failed rebuilds invalidate queries until rebuilt successfully.

`edgeAnchor(node,a,b)` measures an endpoint midpoint. `measureClearance(a,b,'obb'|'aabb'='obb')` derives component bounds, uses separating axes for overlap and vertex/face/edge closest points for Euclidean box clearance. Returns distance, interfering, pointA and pointB; touching boxes have distance zero without interference. OBBs require orthogonal transforms; AABB works with shear. Overlapping bounding boxes do not prove actual mesh interference. These measures inherit Float32 scene accuracy and do not recover original B-Rep precision.

`industrialMaterials` is a frozen dictionary; `industrialMaterial(name,color?)` creates a material. Keys: machinedSteel (0.25 roughness/1 metalness), carbonSteel (0.35/1), galvanizedZinc (0.45/0.95), anodizedAluminum and coloredAnodizedAluminum (0.20/0.90), neoprene (0.85/0), powderCoat (0.30/0). These implement the requested nominal factory presets; colors/roughness are starting values rather than lab calibration for a particular manufactured finish.

The Vite demo's **Domain tools → Load conveyor assembly** loads an optional procedural conveyor with shared rollers/bolts, rails, belt, motor, cover and carriage. Choose 20–240 rollers before loading. A motor RPM control (−120 to 120) drives every roller through gear couplings while mounting bolts remain static. It wires cover/subtree visibility, revolute and stroke limits, six-plane capped box cuts, millimeter dimensions, explode amount and device restoration. The native explode input writes the plugin amount directly without React state updates during dragging. Native camera controls are active; Ctrl-click changes the pivot. The fixture is application code, not part of core. Switching imports disposes the previous model and its node-bound plugins.

## Creative and pass injection

```ts
const { GPUParticles, PostProcessing, ToonShading } = await import('@margoengine/creative');
const { Bloom } = await import('@margoengine/post/bloom'), { PostStack } = await import('@margoengine/post/stack');
if (engine.backend === 'webgpu') {
  GPUParticles.attach(engine, { count: 50_000, gravity: [0, -0.5, 0], wind: [1.2, 0, 0.4],
    curl: 0.2, sort: true,
    obstacles: [{ kind: 'sphere', center: [0, 0, 0], radius: 1 }],
  });
  ToonShading.attach(engine, { bands: 4, rim: 0.15 });
  PostStack.attach(engine, [new Bloom({ strength: 0.5, threshold: 0.8 }), new PostProcessing({ exposure: 0.3,
    focus: 5, aperture: 2, grain: 0.02,
    atmosphere: { density: 0.02, heightFalloff: 0.1, sun: [0.3, 0.6, -0.7], godRays: 0.3 },
  })]);
}
// engine.removePlugin('gpu-particles');
```

`GPUParticles` is a preset of `VFX` from `@margoengine/vfx`, Margo's one particle system: `count` particles wrap inside a 6 m cube, `wind` adds to `gravity`, `curl` is VFX turbulence. Up to 64 sphere/axis-aligned-box obstacles bend the flow and push particles out; opt-in bitonic sorting orders the live list back to front (O(n log² n), not an FPS guarantee); `texture` replaces the soft disc. Positions and velocities stay in GPU storage. See [the VFX README](packages/vfx/README.md) for emitters, lifetimes and limits.

`PostProcessing` owns an `HDRRenderTarget` with rgba16float color and sampleable reversed float depth (depth32float-stencil8 where supported). It captures main at -50 and resolves at 30 after caps/particles. It has no bloom or sky backdrop: use post `Bloom` before it in a `PostStack`, and `Sky` from `@margoengine/sky`. Resolve applies bounded depth-of-field blur, exponential height fog, radial depth-occluded god rays, exposure/contrast/saturation/lift/gain, ACES filmic tone mapping, sRGB conversion and grain. A fullscreen pass presents the rgba8unorm compute output. Change `options` between frames; zero aperture/ray strength skips corresponding work. Fog uses linear RGB; god rays use the sun direction. These are procedural/screen-space approximations; physical volumetric transport, HDR environment-map import and optical bokeh remain outside this pack.

`HDRRenderTarget(device, width, height)` is exported for custom passes; `resize()` replaces owned color/depth textures and `dispose()` frees them. Sizes are 1–4096 per axis within device limits. The post stack reserves roughly 25–26 bytes per full-resolution pixel with float/stencil depth (implementation-dependent stencil storage) for explicit textures, excluding driver padding and core depth/canvas buffers. `ToonShading` injects 2–16 lighting bands and a rim term. Advanced creative rendering requires WebGPU; omit these plugins to keep the optional `@margoengine/webgl` fallback usable. Importing only `GPUParticles` tree-shakes post/toon code.

The extension-entry `EnginePlugin` has `name`, `setup(engine)`, optional `onPreUpdate(delta)`, `registerPasses(graph)`, `onDeviceRestored(engine)` and `dispose()`. `engine.use()` attaches an instance to one engine; duplicate names/shared instances reject. Failed attachment removes owned passes and invokes cleanup. Removal unregisters passes before disposal, and engine disposal attempts every cleanup even when one throws. CPU machinery state persists across restoration; GPU plugins rebuild buffers, textures, bind groups and pipelines against the replacement device.

`FrameGraph.add({ name, order, execute(context), prepare?(context) })` sorts a stable ordered queue; main is order 0. GPU `PassContext` exposes the encoder, mutable color/depth views, output format, shader, additional group-0 bindings, pipeline blueprint and `draw({ pipeline?, bindings?, clear?, stencilClear?, indirect? })`. Custom passes can issue descriptors directly through the encoder. WebGL2 context/camera/dimensions/delta remain available. Passes registered during attachment belong to that plugin. Core reuses its per-device pass context, render-pass descriptor, depth view and submission array, resetting plugin overrides before each frame. Machinery caps, particles, sky and presentation retain descriptor shells; post-processing retains offscreen views and compute/presentation bind groups until resize or device restoration. Toon binding entries remain stable per device. Section/post matrix inversion uses a retained 52-double workspace. The canvas view is obtained once for each frame and passed through the graph. Transform/instance uploads use retained views and explicit element counts; there are no per-frame slice views or dynamic-offset array literals in the core loop. Editing or recursive execution during a frame rejects. The graph schedules explicitly; it does not infer dependencies or allocate transient targets. Add/remove plugins between frames. Optional prepare hooks inject geometry clipping for picking without executing beauty/FX passes.

## Device recovery

`device.lost` starts automatic recovery; `await engine.rebootDevice()` also resets explicitly. Active geometry references and retained vertex/index arrays form the lightweight resource manifest; batch arrays persist too. Recovery requests a replacement adapter/device, uploads active geometry, replaces renderer caches, reconfigures canvas and invokes GPU plugins' restoration hooks. The old renderer disposes without unconfiguring the new canvas. The next draw flushes fresh instance blocks.

Wasm memory, mesh refs, hierarchy, materials and CPU controllers remain intact. RAF callbacks, transforms and kinematics continue during device acquisition. Known invalid-state DOM exceptions interrupt GPU encoding and trigger recovery; ordinary validation/plugin errors remain visible. Failed recovery reaches `onError`; callers can retry `rebootDevice()` when a device becomes available. GPU-only particle simulation restarts from its deterministic seed, preserving configuration/texture. No asset re-parsing or page reload is required.

## Size and verification

Measured at `3d845a0` by `npm run build:packages` (minified ES bundles, peers external; the root-entry figures are committed in [entry-sizes.json](examples/package-benchmarks/results/entry-sizes.json) and [docs/api-surface.md](docs/api-surface.md)):

| Artifact | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Rust Wasm kernel, after Binaryen `-Oz` (embedded raw-deflated: 5,350 B) | 13,043 | – |
| Core plus the `margoengine` stage facade, embedded Wasm and the WebGPU backend | 45,524 | 19,543 |
| Core alone | 40,681 | 17,783 |
| WebGL2 fallback (`@margoengine/webgl`, optional) | 4,672 | 2,088 |
| glTF, excluding its core peer | 10,750 | 4,460 |
| React adapter, excluding React/core peers | 9,845 | 3,768 |
| Machinery root entry, excluding core peer | 72,828 | 33,418 |
| Creative root entry, excluding core peer | 57,418 | 17,186 |
| Particle-only consumer, excluding core peer | 24,570 | 8,035 |

`npm run measure:size` prints the current core + stage figure; the build fails at 20,000 bytes gzip or above. The 20/30 KiB JavaScript budgets are **gzip transfer budgets**, not raw-source budgets. React/ReactDOM and application code are additional. Optional packages load as separate dynamic chunks (`npm run modern:test:wrapper` checks they are not fetched at initial load). The build asserts no legacy scene/engine inclusion and no domain pack inside core. There is no competitor runtime dependency in these packages.

Release compilation explicitly freezes `opt-level=3`, `lto="fat"`, `codegen-units=1`, `panic="abort"`, `overflow-checks=false` and `strip="symbols"`. The root `rust-toolchain.toml` pins Rust 1.99.0 and the Wasm target; Binaryen 132.0.0 is pinned in package.json/package-lock.json. Use `npm ci` for locked dependencies. `modern:build` sets SIMD128 and a fixed Cargo output directory, then runs `wasm-opt -Oz --enable-simd --enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --strip-debug --strip-producers --strip-target-features --converge` to a separate output and embeds it raw-deflated in `packages/core/src/wasm.ts` (last rebuilt at `c449400`; SHA-256 of the decoded kernel `5a0f9310d6cba8a3ea14f94cb8f282e809d2d4345eb3a6e3fed5cb9ffffa5458`). Cargo's input artifact remains intact. Consumers use the checked-in optimized Wasm and need no Rust or Binaryen.

What runs, and where:

- `npm run verify`: the unit tests, Rust kernel tests (`cargo test`, four), API-surface reports, package isolation and the core size gate.
- The real-GPU browser suites (core and API pixels, instancing/culling, 100,000-particle storage readback, React Strict Mode/Suspense/teardown, the WebGL2 fallback, Vite and Next production builds, caps, device destruction and recovery, picking and depth precision) run through `node examples/package-benchmarks/gates/run-browser-tests.mjs`; the latest results are committed in [gates-browser-tests.json](examples/package-benchmarks/results/gates-browser-tests.json) (Intel Arc 140V laptop, Edge 155).
- Core size, machinery/creative isolation, frozen exports and particle-only tree shaking are enforced by the build; domain packages are absent from core.

Mobile coverage changes desktop viewport dimensions; it is not testing mobile GPU hardware. Firefox/Safari, physical driver reset/OOM recovery and comparative performance against other engines have no committed results yet.

Before the package rename (11 October 2026) the browser, domain, packaged-consumer, finalization and live conveyor suites also passed on an NVIDIA RTX A6000 and an AMD Radeon integrated GPU. Those raw captures were not committed, so no timing from them is quoted here; every number Margo publishes, with its hardware and reproduce command, is listed in [docs/whitepaper/claims.md](docs/whitepaper/claims.md).

## Remaining domain features

XR and asset interop are optional packages. `@margoengine/xr` implements WebGPU session negotiation, target/grip poses and stereo core-mesh rendering on a separate compatible device. `@margoengine/ifc` uses web-ifc for native geometry, placement, units and BIM identifiers. Loaders accept static USDA-backed USDZ; exporters write aligned static USDZ with PreviewSurface materials. Core and stage remain at 20,053 bytes gzip.

`npm run modern:test:interop` checks sessions, poses, cleanup, a native IFC4 fixture and USDZ round trips. `npm run modern:test:xr:browser` verifies stereo pixel readback with simulated sessions and a real WebGPU device. Official OpenUSD validation is available through `packages/exporters/tests/validate-usdz.py`. Physical XR sessions and Apple Quick Look presentation remain unverified. Binary USDC, composed USD stages and XR rendering of advanced effects/textured/skinned extension meshes remain unsupported; see the package READMEs.

| Area | Remaining work |
| --- | --- |
| Machinery | Original B-Rep topology/materials/UVs, generalized rigid-body/contact dynamics, automatic contact/feature recognition and triangle-chunk streaming within single bodies. Worker STEP/IGES tessellation, 1D transport, telemetry and assembly BVH picking are implemented above. The listed minimal domain features are implemented above. |
| Creative | Mesh/fluid wind solvers, physical volumetric scattering, HDR environment-map import, optical bokeh and continuity of GPU-only particle state after device loss. The listed minimal domain features are implemented above. |
| Renderer/assets | Clustered Forward+ multi-light shading, shadows/IBL/textures, GPU culling/skinning, animation/morphs/compression, renderer spatial culling, dynamic geometry and measured memory budgets across hardware. |
| Distribution/validation | Release policy, wider browser/GPU/React version coverage, performance comparisons with matched workloads and image quality. |

The remaining rows describe future work; current domain features have working implementations and bounded limits documented above. Linear sphere culling and cached hierarchy composition are intentional minimal implementations; optimize against measured scenes. This delivery makes no universal performance, full parity or commercial-readiness claim.




## Historical SwiftShader validation

Committed results, recorded on 11 October 2026 at b3987dd on SwiftShader (software WebGPU and WebGL2, no GPU). They describe that commit only: WebGL2 was still in core then (it moved to `@margoengine/webgl` in 1356787) and the core has changed since; setup and machine details are in [benchmarks/README.md](benchmarks/README.md#swiftshader-runs-no-gpu):

- `npm test`: 31 JavaScript tests. `cargo test`: four Rust tests. Strict package declarations and successful Vite/Next production builds.
- Packed standalone ESM/Wasm imports, strict TypeScript consumer declarations and React 18.3.1 SSR/browser lifecycle: [modern-packages.json](benchmarks/swiftshader/modern-packages.json). The fixture is removed after testing; tarballs remain in `test-results/modern-packages/`.
- Eight browser check groups: both API pixels and instancing/culling; actual GPU storage readback for 100,000 particles; React Strict Mode/nesting/Suspense/teardown/no frame re-renders; automatic fallback; Vite domain controls; Vite production/lazy imports/controls/mobile layout; Next SSR/hydration/rendered geometry: [modern-browser.json](benchmarks/swiftshader/modern-browser.json).
- Eight domain GPU groups: stencil caps with mirrored instances, real device destruction with preserved Wasm references, textured particle sorting/obstacles, independent image changes for each FX feature, cap depth preservation, retained pass descriptors and bind groups with one canvas view per frame, and destruction mid-encoding and after submission with continued CPU/RAF updates: [modern-domains.json](benchmarks/swiftshader/modern-domains.json).
- Five finalization groups: integer picking, depth precision (near=1 mm, far=10 km, 0.1 mm separation at 500 m), six-plane caps, the conveyor UI and the 12,014-entity stress scene with reboot. The stress scene kept three batches and 5,373,952 bytes of Wasm memory; its 60 frames measured CPU median 4.7 ms / p95 7.0 ms. GPU completion times on SwiftShader do not describe hardware: [modern-finalization.json](benchmarks/swiftshader/modern-finalization.json).
- Conveyor timing at 20, 200 and 240 rollers (`npm run modern:check:conveyor -- --timing-only`): two instanced geometry batches at every size, shafts coupled to the motor in both directions, static bolts, Wasm-backed Euler views, and 16-byte aligned instance uploads with a 96-byte stride. At 240 rollers (976 entities) the tick mean was 0.108 to 0.120 ms across three runs: [run 1](benchmarks/swiftshader/bench-tick-b3987dd-run1.json), [run 2](benchmarks/swiftshader/bench-tick-b3987dd-run2.json), [run 3](benchmarks/swiftshader/bench-tick-b3987dd-run3.json).
- The full `modern:check:conveyor` run fails at its live picking step on SwiftShader, so its picking latency, drag trace and allocation reports have no committed results: [conveyor-check-picking-failure.txt](benchmarks/swiftshader/conveyor-check-picking-failure.txt).
- Core size, machinery/creative isolation, export snapshots and particle-only tree shaking are enforced by the build and tests; domain packages are absent from core.

Mobile coverage changes desktop viewport dimensions; it is not testing mobile GPU hardware. No committed results cover hardware GPUs, Firefox/Safari, physical driver reset/OOM recovery, allocation or GC behaviour, or comparative performance.

Arbitrary capacities can produce only four-byte-aligned source views, which remain valid under [WebAssembly memory semantics](https://webassembly.github.io/spec/core/exec/instructions.html#memory-instructions).

