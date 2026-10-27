# @margoengine/react

React 18 and 19 components and hooks for Margo Engine: a native canvas, pointer events, Suspense, stable mesh refs and
frame callbacks. There is no custom reconciler: `<Canvas>` creates one engine, and its children are ordinary React
components that edit it.

Import it as `margoengine/react` (from the `margoengine` package, every binding in one import) or from this package
alone: `@margoengine/react` holds the bindings that need no optional package (`Canvas`, `Mesh`, geometry, materials,
hooks, views, `Sun`, `Center`), and a binding that needs `@margoengine/<name>` comes from `@margoengine/react/<name>`
(`OrbitControls` from `/controls` with `@margoengine/controls` installed, `Gltf` from `/gltf-pro`, `Shadows` from
`/shadows`; the full list is in [SCENE.md](SCENE.md)). Optional parts load only when a component needs them, so an
unused feature costs nothing.

Installed alone (plus the packages your subpaths name, such as `@margoengine/controls` for `OrbitControls`), it builds
with Vite, webpack, Turbopack (Next.js), Rollup and esbuild and keeps the build to what you import. The cube page with orbit controls requests 94,251 B gzip at load
and 101,202 B once `OrbitControls` mounts, and emits no Wasm. React and React DOM are about 66% of that; Margo's part
(core, stage, bindings) is 25,949 B gzip. The breakdown is in [limits.md](../../docs/limits.md#react-page).


**What you get from this page:** a React app with a lit mesh in about five minutes, then the components, hooks,
controls, physics, XR and Next.js notes, the rule for React state against the frame loop, and a troubleshooting list.
For a textured, shadowed scene with click-to-select, follow the [React first scene guide](../../docs/guides/react-first-scene.md).

Contents: [Install](#install), [First scene](#first-scene), [Components](#components), [Models and environment](#models-and-environment),
[Batching, views, lights and voxels](#batching-views-lights-and-voxels), [Hooks](#hooks), [Controls](#controls),
[Physics](#physics), [XR](#xr), [Next.js](#nextjs), [State vs the frame loop](#state-vs-the-frame-loop),
[Build warnings](#build-warnings), [Testing and size](#testing-and-size), [Troubleshooting](#troubleshooting).

## Install

Package name: `@margoengine/react`, version `1.0.0`. **It is not on npm yet**, so `npm install @margoengine/react` does
not work today. Two routes do. Both start from a clone of the repository (see [Install](../../README.md#install) in the
main README for Git LFS and Node.js 22.12+).

**Route 1: a Vite app of your own, from local tarballs.** In the clone:

```sh
npm ci
npm run pack:packages
```

`pack:packages` builds every package and writes one `.tgz` file each to `test-results/`. Then, in a new folder next to
the clone (shown for a shell that expands `*.tgz`, such as Git Bash, macOS or Linux):

```sh
mkdir my-react-app && cd my-react-app
npm init -y
npm pkg set type=module
npm install ../margoengine/test-results/*.tgz react react-dom vite @vitejs/plugin-react typescript @types/react @types/react-dom
```

On the machine that wrote this page, packing took about a minute and the install 8 seconds. Add an `index.html` with
`<div id="root"></div>` and `<script type="module" src="/src/main.tsx"></script>`, put the first scene below in
`src/main.tsx` (add the `createRoot` line at the end), and run `npx vite`.

**Route 2: use the examples inside the clone.** `npm ci`, `npm run build:packages`, then
`npm run dev --workspace @margoengine/react-viewer` for the resizable Vite example.

**TypeScript with this package alone.** The types check under a strict `tsconfig.json` (`"skipLibCheck": false`)
without the optional peers; options typed by a peer you have not installed are `any` until you install it.

**After 1.0.0 is published**, `npm install margoengine react react-dom` replaces the tarballs and nothing else changes.
[SCENE.md](SCENE.md) lists the optional peers each component uses.

## First scene

A box lit by the default sun, with a click handler:

```tsx
import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, Stage, Mesh, BoxGeometry, PbrMaterial, Model } from 'margoengine/react';

export function App() {
  return (
    <Canvas style={{ height: 400 }}>
      <Stage camera={{ position: [0, 2, 5] }}>
        <Mesh position={[0, 1, 0]} onClick={() => {}}>
          <BoxGeometry args={[1, 1, 1]} />
          <PbrMaterial color="#84d6bd" />
        </Mesh>
        <Suspense fallback={null}>
          <Model src="/model.glb" />
        </Suspense>
      </Stage>
    </Canvas>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
```

The `Model` line needs a `.glb` file at `public/model.glb`; delete it for a scene with only the box.

## Components

`Stage` configures the existing canvas stage and renders its children once that stage is available. Its `camera` prop updates the active camera; `shadows` uses the canvas's existing optional `@margoengine/shadows` lifecycle. Install that peer when enabling shadows. Canvas still creates and disposes the single engine and stage.

`Mesh` and `Model` accept `onClick`, `onPointerOver`, and `onPointerOut`. The canvas dispatches hits from its existing `engine.pick`; a click requires no more than three CSS pixels of total pointer movement, so OrbitControls drags do not click. Handlers receive `nativeEvent`, the hit mesh as `object`, `mesh`, and `target`, canvas-local `x`/`y`, and `clientX`/`clientY`.

`Group` is a geometry-free `Mesh` for parent transforms. Lowercase exports are aliases of the same hook-based components: `mesh === Mesh`, `group === Group`, `boxGeometry === BoxGeometry`, and `meshStandardMaterial === PbrMaterial`. Use a namespace in JSX:

```tsx
import * as Margo from 'margoengine/react';

<Margo.Canvas style={{ height: 400 }}>
  <Margo.Stage camera={{ position: [0, 2, 5] }}>
    <Margo.group position={[0, 1, 0]}>
      <Margo.mesh>
        <Margo.boxGeometry args={[1, 1, 1]} />
        <Margo.meshStandardMaterial color="#84d6bd" />
      </Margo.mesh>
    </Margo.group>
  </Margo.Stage>
</Margo.Canvas>;
```

React treats bare lowercase tags such as `<mesh>` and `<group>` as DOM elements, even when their names are imported. Namespace members such as `<Margo.mesh>` and `<Margo.group>` (or uppercase import bindings) invoke these components. All existing PascalCase exports remain available.

### Which primitive style?

`Box`, `Sphere` and `Plane` are convenience components: one element gives a mesh with a standard material, and they take
the `Mesh` props plus `args`, `color`, `roughness` and `metalness`. `Mesh` with a geometry child and a material child is
the explicit form.

```tsx
import { BoxGeometry, Mesh } from '@margoengine/react';
import { Box } from '@margoengine/react/geometry';
import { MeshTransmissionMaterial } from '@margoengine/react/materials';

export function Both() {
  return (
    <>
      <Box args={[1, 1, 1]} color="#84d6bd" position={[-1, 0.5, 0]} />
      <Mesh position={[1, 0.5, 0]}>
        <BoxGeometry args={[1, 1, 1]} />
        <MeshTransmissionMaterial />
      </Mesh>
    </>
  );
}
```

Use `Box`, `Sphere` and `Plane` for floors, blocks and prototypes with a plain colour. Use `Mesh` with children when you
need a material component other than the standard one (as above) or a geometry other than a box, sphere or plane.

### Pointer events and picking

`onClick`, `onPointerOver` and `onPointerOut` on `Mesh`, `Model`, `Box`, `Sphere` and `Plane` come from GPU picking, not
from the DOM. These rules come from the code in `src/components.tsx` and apply to every handler:

- **Picking is asynchronous.** The pointer event asks the GPU which mesh is under the pixel, and the handler runs after
  the answer, a frame or two later. Code and tests that read the state your handler sets must wait for it. Clicks keep
  their order. A burst of hover events collapses to the latest one.
- **The mesh in front gets the event.** If two meshes overlap under the pointer, the one drawn nearest the camera is
  hit. A child that overlaps its parent wins over the parent. A mesh in front with no handlers blocks the mesh behind
  it: nothing fires.
- **Events do not bubble.** A `Group` or parent `Mesh` does not receive the click of its children. Put the handler on
  the mesh that is drawn, and use one handler function for several meshes if they share behaviour.
- **An orbit drag is not a click.** A click needs the pointer to move no more than 3 CSS pixels between press and
  release, and only the primary button counts.
- **WebGPU only.** On the WebGL2 fallback no handler fires.
- **Handlers get** `nativeEvent`, `object` (also `mesh` and `target`: the hit mesh), `x` and `y` (canvas pixels) and
  `clientX` and `clientY`.

In a Playwright test, click and then wait for the state:

```js
await page.mouse.click(x, y);
await page.waitForFunction(() => document.querySelector('#selected').textContent === 'crate');
```

## Models and environment

A model, its lighting and the orbit controls, directly under the canvas:

```tsx
'use client';
import { Suspense } from 'react';
import { MargoCanvas, Model, Environment, OrbitControls, Shadows } from 'margoengine/react';

export default function App() {
  return <MargoCanvas backend="webgpu" camera={{ position: [0, 2, 5] }} style={{ height: 400 }}>
    <Shadows />
    <Suspense fallback={<span>Loading scene…</span>}>
      <Model src="/model.glb" position={[0, 0, 0]} materials={{ Upper: { baseColor: [0.52, 0.84, 0.74] } }} castShadow receiveShadow />
      <Environment src="/studio.hdr" exposure={1} background />
    </Suspense>
    <OrbitControls enableDamping minDistance={1} maxDistance={20} />
  </MargoCanvas>;
}
```

`Model` loads glTF/GLB through `@margoengine/gltf-pro`. Position, Euler rotation (radians), scale and named material overrides update the existing model; removing an override restores the loaded material. Supported shallow overrides are `baseColor` (linear RGB or RGBA), `roughness`, `metalness`, `emissive`, `normalScale`, `occlusionStrength`, `alphaCutoff` and `doubleSided`. `onLoad(mesh)` receives the model's root mesh after initial props have been applied. Only changing `src` selects another asset. Unmount unregisters lighting and shadows and disposes the instance's PBR plugin, meshes, textures and buffers.

Wrap `Model` and file-backed `Environment` components in React `Suspense` to show a fallback while loading. Loads begin after the first commit so unmount cleanup can abort an unfinished load. The canvas caches pending promises and resolved CPU source data by URL; concurrent mounts and remounts reuse that source while owning independent model transforms, materials and disposable GPU resources. The last pending consumer unmount aborts its request. Canvas teardown releases the cache. Load failures reach the component's optional `onError` and the canvas's `onError`/accessible alert.

`Model.preload(src)` (also `Gltf.preload`), `Fbx.preload(src)` and `Environment.preload(src)` warm the same cache on active canvases; each belongs to the component that loads that kind of file, so a page that preloads only models never reaches the FBX or environment loaders. Before a canvas is ready, the returned promise queues until an engine exists, since the optional glTF loader requires an engine. Render the canvas before awaiting a queued preload. A preloaded asset remains hidden until mounted.

`Environment` loads HDR/EXR through `@margoengine/environment` and attaches diffuse/specular IBL to sibling `Model` components, regardless of loading order. Exposure is a nonnegative linear lighting multiplier; it also controls HDR background intensity. `background` defaults to true and only affects an HDR background. Without `src`, the component configures neutral studio directional and ambient lighting; teardown restores the previous lighting. Exposure and background changes do not reload the map. Use one `Environment` per canvas.

`Html` dynamically imports optional `@margoengine/html` and `react-dom` peers and projects React DOM children into a shared overlay. Nested inside a `Mesh` or `Group`, its `position` is a local offset; otherwise it is a world position. It accepts `className`, `style`, and an `occlude` boolean (true by default), and removes its label and overlay resources on unmount.

`<Shadows />` (`margoengine/react/shadows`, or `@margoengine/react/shadows` with `@margoengine/shadows` installed) turns the canvas shadows on; mesh and model casting and receiving are independently opt-in and draw nothing without it. PBR models, HDR IBL and shadows require WebGPU; legacy meshes and neutral studio lighting support the WebGL fallback.

## Batching, views, lights and voxels

`<BatchedMesh maxItems maxVertices>` draws many different geometries in one draw call per pass; put a `<BatchedItem geometry position rotation scale color visible>` (or `matrix`) per object inside. Moving, tinting or hiding an item updates the batch in place with no React render of the batch; capacity and `material` are fixed. `<SectionPlanes planes={[[1, 0, 0, 0]]}>` cuts the scene with up to six planes and caps closed solids; plane values update live. `<DepthTexture>` and `<SceneTargets outputs={{ albedo: 'albedo', normal: 'normal' }}>` render the scene's depth or several targets in one pass for your own shaders; their ref is the live plugin (`depth.texture`, `targets.texture('normal')`), and the Canvas's PBR models are added for you. All four need WebGPU.

```tsx
import { Canvas } from '@margoengine/react';
import { SectionPlanes } from '@margoengine/react/machinery';
import { BatchedMesh, BatchedItem } from '@margoengine/react/materials';
import { boxGeometry } from '@margoengine/geometry';

const cube = boxGeometry();
export function Crates({ count }: { count: number }) {
  return (
    <Canvas>
      <BatchedMesh maxItems={count} maxVertices={count * 24}>
        {Array.from({ length: count }, (_, i) => (
          <BatchedItem key={i} geometry={cube} position={[i * 1.5, 0, 0]} color={i % 2 ? '#84d6bd' : '#e45630'} />
        ))}
      </BatchedMesh>
      <SectionPlanes planes={[[0, 0, 1, 0]]} />
    </Canvas>
  );
}
```

`<RenderView>` draws the Canvas through a camera into part of it (split screen, a four-view CAD layout, a minimap) or into a texture: `camera` (a core `Camera`; default the Canvas camera), `viewport` (fractions from the top left), `scissor`, `clear`, `layers`, `target`, `id` and `order`. With one or more views the Canvas draws only those; picking follows the view under the pointer. `<Scene name>` holds meshes drawn only by the views that name it (`<RenderView scene="hud">`), such as a HUD overlay or an item preview; `background={null}` keeps what is below. `<Mesh layers={mask}>` (a `layerMask(...)` from `@margoengine/cameras/layers`) limits which views draw a mesh. Views and scenes work on WebGPU and WebGL2.

```tsx
import { Camera } from '@margoengine/core';
import { Canvas, RenderView, Scene } from '@margoengine/react';
import { Box } from '@margoengine/react/geometry';

const top = new Camera({ position: [0, 20, 0.01], target: [0, 0, 0] });
export function SplitScreen() {
  return (
    <Canvas>
      <RenderView viewport={[0, 0, 0.5, 1]} />
      <RenderView viewport={[0.5, 0, 0.5, 1]} camera={top} />
      <RenderView viewport={[0.75, 0.75, 0.25, 0.25]} scene="hud" order={1} clear={{ color: false }} />
      <Box castShadow />
      <Scene name="hud" background={null}>
        <Box color="#e45630" />
      </Scene>
    </Canvas>
  );
}
```

Lights: `<Sun direction color intensity>` sets the directional sun light every mesh, model and shadow uses (any backend; inside a `<Scene>`, that scene's). `<AmbientLight color intensity>` and `<HemisphereLight sky ground intensity>` light core meshes and models from every direction, and `<Fog color near far density heightFalloff height>` fogs them in their shaders, transparent models included; all three come from `@margoengine/environment`, take live props and need WebGPU. `<Environment>` also takes `rotation` (radians about +Y, lighting and background together) and `blur` (background, 0 to 1). `<Html>` takes the label options `anchor`, `distanceScale`, `sort`, `frustumCulling`, `followVisibility`, `visible` and `pointerEvents`, all live.

```tsx
import { Canvas, Sun } from '@margoengine/react';
import { HemisphereLight, Fog } from '@margoengine/react/environment';
import { Model } from '@margoengine/react/gltf-pro';

export function Valley() {
  return (
    <Canvas>
      <Sun direction={[1, 2, 1]} color="#fff4e0" intensity={3} />
      <HemisphereLight sky="#bcd8ff" ground="#5a4a3a" intensity={0.6} />
      <Fog color="#bcd8ff" near={20} far={120} />
      <Model src="/valley.glb" />
    </Canvas>
  );
}
```

`<Voxels world textures>` draws a `VoxelWorld` from `@margoengine/voxel`: chunks are meshed in workers and lit by `@margoengine/voxel/light` (on by default, updated from the Canvas frame loop). Edit the world with `world.setBlock` and the change shows two frames later with no React render; `daylight`, `blockLightColor` and `lightmap` are live. `useBlockTextures(urls)` loads the block textures, one layer per URL, and suspends until they are ready. Needs WebGPU and Web Workers.

```tsx
import { Suspense, useMemo } from 'react';
import { BlockTypes, VoxelWorld } from '@margoengine/voxel';
import { Canvas } from '@margoengine/react';
import { Voxels, useBlockTextures } from '@margoengine/react/voxel';

function Island() {
  const textures = useBlockTextures(['/stone.png', '/grass-top.png']);
  const world = useMemo(() => {
    const blocks = new BlockTypes(),
      stone = blocks.define('stone'),
      island = new VoxelWorld({ blocks });
    for (let x = -8; x < 8; x++) for (let z = -8; z < 8; z++) island.setBlock(x, 64, z, stone);
    return island;
  }, []);
  return <Voxels world={world} textures={textures} daylight={0.8} />;
}
export function Game() {
  return (
    <Canvas camera={{ position: [12, 72, 12], target: [0, 64, 0] }}>
      <Suspense fallback={null}>
        <Island />
      </Suspense>
    </Canvas>
  );
}
```

## Hooks

`Canvas` remains an alias for `MargoCanvas`; existing geometry components and mesh refs remain available. `useMargo()` returns `{ stage, ready, canvas, camera, size, gl, clock, invalidate }`. `camera` and `gl` are the stage's camera and engine; `size` reads the canvas client width and height; `clock` is elapsed frame time in seconds as a number. `onCreated(stage)` receives the existing `Stage` facade from `margoengine` after sizing and camera setup, before rendering starts.

With `<Canvas frameloop="demand">`, the engine does not start an animation loop. Each `invalidate()` call advances `useFrame` and OrbitControls and renders exactly one frame. The default `frameloop="always"` renders continuously. Read `clock` from the hook value when needed; its getter advances without causing React renders.

`useMargoStage()` retains its existing portable `EngineKernel` return value (`createMesh`, `camera`, frame callbacks and plugins). Children mount after asynchronous stage creation. Hooks outside the provider throw. Use an effect to create imperative objects and return their disposal function:

```tsx
import { useEffect } from 'react';
import { box, PbrMaterial as Material } from 'margoengine/core';
import { useMargoStage } from 'margoengine/react';

function ImperativeCube() {
  const engine = useMargoStage();
  useEffect(() => {
    const mesh = engine.createMesh();
    mesh.setGeometry(box()).setMaterial(new Material({ color: '#84d6bd' }));
    return () => mesh.dispose();
  }, [engine]);
  return null;
}
```

## Controls

`OrbitControls`, `MapControls`, `CadControls` and `ArcballControls` bind the active camera and canvas, update from the Canvas frame loop (so `frameloop="demand"` and `invalidate()` move them too), and remove their listeners on unmount. Every public field of the controls is a prop (`enableDamping`, `dampingFactor`, `rotateSpeed`, `zoomToCursor`, `minDistance`, `maxPolarAngle`, ...); a prop removed again restores the controls' default. `target` sets the orbit point when it changes. `onChange`, `onStart` and `onEnd` receive the controls' events, and the ref is the live controls object. `CadControls` navigates like a CAD tool: `profile` is `'margo'` (default), `'solidworks'`, `'autocad'`, `'inventor'`, `'fusion'`, `'blender'`, `'maya'`, `'onshape'` or `'rhino'`, and keyboard shortcuts are on (`keyEvents={false}` turns them off). `OrbitControls` takes the same `profile` and `keyEvents` props.

```tsx
import { Canvas, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { CadControls } from '@margoengine/react/controls';
import { Shadows } from '@margoengine/react/shadows';

export function Part({ onViewChanged }: { onViewChanged: () => void }) {
  return (
    <Canvas>
      <CadControls profile="solidworks" enableDamping onEnd={onViewChanged} />
      <Shadows distance={60} filter="pcf" />
      <Mesh castShadow position={[0, 1, 0]}>
        <BoxGeometry />
        <PbrMaterial color="#84d6bd" />
      </Mesh>
    </Canvas>
  );
}
```

`<Shadows>` turns on the Canvas's cascaded shadows while it is mounted and sets their live options (`resolution`, `distance`, `lambda`, `lightSize`, `bias`, `normalBias`, `casterMargin`, `filter`, `bounds` or `frustum`). `<Mesh castShadow>` (and `receiveShadow={false}`) adds a mesh to them, like `Box`, `Sphere`, `Plane` and `Model`.

Hooks: `useEngine()` returns the Canvas engine and `useCamera()` its camera. `useLoader(loader, url)` loads any file and suspends until it is ready: the loader is `(url, { engine, signal, fetch }) => Promise<T>`, each Canvas shares one load per loader and URL, and a failed load throws to the nearest error boundary (call `clearLoader(loader, url)` before retrying). `useProgress()` reports `{ active, loaded, total, progress, item, errors }` across `Model`, `Fbx`, `Environment` and `useLoader` loads for a loading bar; it needs the optional `@margoengine/cache`.

```tsx
import { load, parsePLY, type LoadedGeometry } from '@margoengine/loaders';
import { useLoader, useProgress, type Loader } from '@margoengine/react';

// Defined once, outside components: the loader is the cache key.
const ply: Loader<LoadedGeometry> = (url, { fetch, signal }) => load(url, parsePLY, { fetch, signal });
function ScanInfo() {
  const scan = useLoader(ply, '/scan.ply');
  return <p>{scan.positions.length / 3} points</p>;
}
function LoadingBar() {
  const { active, progress } = useProgress();
  return active ? <progress max={100} value={progress} /> : null;
}
```

## Physics

Physics is a separate entry, so an app without it never needs Rapier. Import it from `@margoengine/react/physics`:
`Physics`, `RigidBody`, the colliders (`CuboidCollider`, `BallCollider`, `CapsuleCollider`, `CylinderCollider`,
`ConeCollider`, `ConvexHullCollider`, `TrimeshCollider`, `HeightfieldCollider`), `useJoint`, `usePhysics`,
`useBeforePhysicsStep` and `useAfterPhysicsStep`. `Physics` creates the world; each `RigidBody` owns the meshes inside
it. A complete example is in the [cookbook](../../docs/react-cookbook.md#physics). `usePhysics` works only inside
`<Physics>`.

## XR

`XR`, `Controller` and `useXR` come from `@margoengine/react/xr` (and `margoengine/react`). `useXR` works only inside
`<XR>`.

## Next.js

Both the App Router and the Pages Router work, with webpack and with Turbopack, and need no `transpilePackages`. Install
`margoengine` (`npm i margoengine react react-dom next` once it is published) and import from `margoengine/react`,
the one-install route; or install `@margoengine/react` alone with the packages its subpaths name
(`npm i @margoengine/react @margoengine/controls react react-dom next`) and import `OrbitControls` from
`@margoengine/react/controls`. Both build with webpack and Turbopack (the bundler matrix builds the cube page with
`@margoengine/react` alone, and with `/controls` added). Keep the page a server component and put the `Canvas` in a small client component:

```tsx
// app/scene.tsx
'use client';
import { Canvas, Box, OrbitControls } from 'margoengine/react';

export function Scene() {
  return (
    <Canvas style={{ height: '70vh' }} label="Product viewer">
      <Box color="#84d6bd" />
      <OrbitControls enableDamping />
    </Canvas>
  );
}
```

Import `Scene` from a server `page.tsx` behind `<Suspense fallback={...}>`. Next.js example: `examples/next`. More recipes are
in the [React cookbook](../../docs/react-cookbook.md); moving from react-three-fiber is in
[Coming from react-three-fiber](../../docs/react-from-r3f.md).

A Next.js page is larger than the Vite page: about 194 KB gzip of JavaScript. Its build output also holds the OpenCascade
Wasm (7,604,031 B) and the Basis and Draco decoders; they are emitted but never requested at load or while orbiting.

SSR emits an accessible canvas without accessing GPU APIs. The ESM output preserves `use client` and includes TypeScript declarations. Peer ranges accept core `^1.0.0` and React 18 or 19.

## State vs the frame loop

Pick the home for each value by how often it changes. Motion that changes every frame belongs in the frame loop. Values
a person reads or edits belong in React state.

| Value | Where it lives | Why |
| --- | --- | --- |
| Initial position, rotation, colour (JSX props) | Props | React sets them once and when they change. |
| Running motion: spin, follow the mouse, a physics step | A ref written in `useFrame` | No React render per frame. |
| UI: selected item, a colour picker, a loading flag, inspector fields | `useState` or your store | The UI must re-render when they change. |
| Anything you save or send | A plain document in state (see the [scene document guide](../../docs/guides/react-scene-document.md)) | Engine objects cannot be serialised. |

The hooks for this are public: `useFrame((engine, deltaSeconds) => ...)` runs once per rendered frame and re-renders
nothing, `useEngine()` returns the engine, and a `ref` on `Mesh` is the live mesh (`MeshRef`) you move. The package also
uses internal helpers (`useLiveRef`, `useCommit`, `useResourceEffect`, `useMesh`) to keep refs and GPU objects correct
through StrictMode; they are not exported, so build on `useFrame`, `useEngine` and refs.

Bad: `setState` every frame. Good: a ref and `useFrame`.

```tsx
import { useRef, useState } from 'react';
import { BoxGeometry, Mesh, type MeshRef, PbrMaterial, useFrame } from '@margoengine/react';

function Bad() {
  const [angle, setAngle] = useState(0);
  useFrame((_, delta) => setAngle((a) => a + delta)); // React re-renders every frame
  return <Mesh rotation={[0, angle, 0]}><BoxGeometry /><PbrMaterial /></Mesh>;
}

function Good() {
  const mesh = useRef<MeshRef>(null);
  useFrame((_, delta) => { if (mesh.current) mesh.current.rotation.y += delta; }); // no render
  return <Mesh ref={mesh}><BoxGeometry /><PbrMaterial /></Mesh>;
}
```

The [state vs frame loop guide](../../docs/guides/react-state-vs-frame-loop.md) runs both in a browser and counts React
commits per second for each. The canvas serialises initialisation, disposes superseded engines and disconnects its
`ResizeObserver` on cleanup. It handles StrictMode, HMR effect replacement, late initialisation after unmount, and
`capacity` and `backend` changes. Camera changes update the existing engine. Errors reach `onError` and an accessible
alert.

## Build warnings

A production Vite build of the cube page prints no warnings; `npm run modern:test:bundlers` checks it from the installed packages on every merge check and fails on any warning. Only the generated `rsc/` entries carry `'use client'` (the
`react-server` export condition maps to them), so a server component can import `Canvas`. `sideEffects` is `false`, so
unused exports are dropped. Next.js builds with webpack and Turbopack run in `npm run modern:test:bundlers`.

## Testing and size

Run `npm run build:packages`, then `npm run modern:test:react` for the React Testing Library and JSDOM lifecycle tests:
the first-scene snippet, StrictMode events, Suspense, cancellation, cache reuse and demand rendering. `npm run typecheck`
and `npm run test:modules:packages` check the package types and imports. `npm run test:docs:browser` runs the React guides
in a real WebGPU browser. The adapter uses standard hooks, never `react-reconciler`. Frame dispatch forwards
`(engine, deltaSeconds)` without building per-frame state objects or callback arrays.

What the numbers mean, by scope. None of them is "the size of your app":

- **Core and stage together:** 21,974 B gzip (`npm run measure:size`, the entry measurement; the build fails at 25,000 B).
  It does not include React, this package or any optional package.
- **A Vite React page with the cube and orbit controls:** 102,335 B gzip of JavaScript, 70% of it React and React DOM
  (measured, table in limits.md). `PbrMaterial` is core's material and pulls in no other package. A textured `<Model>`
  adds 1,750 B to the entry and fetches glTF support (56,074 B gzip) when it mounts.
- **A React page with PBR models loaded, in an independent study:** about 563 KB decoded, 193 KB gzip, including React and
  the shared scene infrastructure. A Next.js page is about 194 KB gzip.
- **The OpenCascade Wasm (7.6 MB):** fetched only by an app that loads STEP or IGES files. In other apps it can be in the
  build output but is never requested.

The measured breakdown of a React build, package by package, is in [docs/limits.md](../../docs/limits.md#react-page).

## Troubleshooting

- **The canvas is blank and has no height.** Give `<Canvas>` a height: `style={{ height: 400 }}`.
- **"WebGPU unavailable".** The browser has no WebGPU. Pass an `onError` handler to show your own message.
- **A component does nothing.** React treats a bare lowercase `<mesh>` as a DOM element. Use `<Mesh>`, or the
  namespace form `<Margo.mesh>`.
- **A hook throws a `state` error.** `useMargo`, `usePhysics` and `useXR` work only inside their provider (`<Canvas>`, `<Physics>`, `<XR>`).
- **The scene re-renders constantly.** Per-frame values belong in refs: see [State vs the frame loop](#state-vs-the-frame-loop).
- **A click handler never runs, or a test sees the old state.** Picking is asynchronous and does not bubble: see [Pointer events and picking](#pointer-events-and-picking). Handlers need WebGPU.
- **Textures on `Box` or `Sphere`.** They take a colour only. Use a glTF `Model`, or `createMesh` from `margoengine/materials` in an effect.
- **Next.js error about hooks in a server component.** Put the `Canvas` in a file that starts with `'use client'`.

Apache-2.0 licensed.
