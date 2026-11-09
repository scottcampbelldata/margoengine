# @margoengine/react

React 18 and 19 components and hooks for Margo Engine: a native canvas, pointer events, Suspense, stable mesh refs and
frame callbacks. There is no custom reconciler: `<Canvas>` creates one engine, and its children are ordinary React
components that edit it.

Import it as `margoengine/react` (from the `margoengine` package, the bindings in one import; `Model`, `Fbx`, `Animation`,
the `materials` components and physics come from `margoengine/react/gltf-pro`, `/fbx`, `/animation`, `/materials` and
`/physics`, so a page without them builds without the Draco and Basis Wasm) or from this package
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
main README for Git LFS and Node.js: 22.12+ to use the package, 24.18+ to build it from the repository).

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
import { Canvas, Stage, Mesh, BoxGeometry, PbrMaterial } from 'margoengine/react';
import { Model } from 'margoengine/react/gltf-pro';

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

React treats bare lowercase tags such as `<mesh>` and `<group>` as DOM elements, even when their names are imported. Namespace members such as `<Margo.mesh>` and `<Margo.group>` (or uppercase import bindings) invoke these components. All existing PascalCase exports remain available. To keep react-three-fiber's bare tags, compile with Margo's JSX runtime (next section).

### Lowercase tags and extend

Set `jsxImportSource` to `@margoengine/react` (or `margoengine/react`) and bare tags draw Margo components inside a
`<Canvas>`, so react-three-fiber code moves over without renames. Per file, put the pragma comment on top as below; for
the whole app, set `"jsxImportSource": "@margoengine/react"` in `tsconfig.json` (`compilerOptions`, with
`"jsx": "react-jsx"`) or in your bundler's JSX options. The runtime is React's own: every other element is exactly what
`react/jsx-runtime` makes, and nothing changes outside a Canvas, so an SVG `<line>` stays an SVG line.

```tsx
/** @jsxImportSource @margoengine/react */
import { Canvas, extend } from '@margoengine/react';
import { SphereGeometry } from '@margoengine/react/geometry';

// <sphereGeometry> from here on: each key, first letter lowercased, becomes a tag.
extend({ SphereGeometry });
declare module '@margoengine/react' {
  interface MargoElements {
    sphereGeometry: import('react').ComponentProps<typeof SphereGeometry>;
  }
}

export function App() {
  return (
    <Canvas style={{ height: 400 }}>
      <directionalLight position={[3, 5, 4]} intensity={3} />
      <group position={[0, 1, 0]}>
        <mesh rotation={[0, 0.5, 0]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#84d6bd" />
        </mesh>
        <mesh position={[2, 0, 0]}>
          <sphereGeometry args={[0.5, 32, 16]} />
          <meshStandardMaterial color="#e0a458" roughness={0.3} />
        </mesh>
      </group>
    </Canvas>
  );
}
```

| Tag | Margo component | Notes |
| --- | --- | --- |
| `<mesh>`, `<group>` | `Mesh`, `Group` | Same props, `ref` is the engine mesh. |
| `<boxGeometry args>` | `BoxGeometry` | |
| `<meshStandardMaterial>` | `PbrMaterial` | `color`, `roughness`, `metalness`. |
| `<directionalLight position>` | `Sun` | Shines from `position` towards the origin (default `[0, 1, 0]`); `intensity` defaults to 3, the `Sun` default. |
| anything else | `extend({ Name: Component })` | Values are React components, for example `SphereGeometry` and `PlaneGeometry` from `/geometry` or `AmbientLight` from `/environment`. |

`extend` takes React components, not engine classes as react-three-fiber's does: wrap an engine object in a component
(an effect that creates and disposes it) and extend with that. The tags are shared by the page, and a later `extend` of
the same tag replaces it. Add the prop types of your tags by augmenting `MargoElements`, as above. Under the
`react-server` condition (Next.js server components) the runtime is React's unchanged: write Margo tags in client
components, below the `<Canvas>`. A tag `extend` never named, such as `<pointLight>`, is still a DOM element and the
development hint below names the component to use.

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

Use `Box`, `Sphere` and `Plane` for floors, blocks and prototypes with a plain colour or one texture. Use `Mesh` with
children when you need a material component other than the standard one (as above) or a geometry other than a box,
sphere or plane.

### Textured Box, Sphere and Plane

`map` gives `Box`, `Sphere` and `Plane` a base colour texture on the shape's own UVs: a URL, fetched through the Canvas
asset cache so `useProgress` counts it, or the PNG or JPEG bytes (`ArrayBuffer`, a typed array or a `Blob`). The map is
multiplied by `color`, which is white when a map is set. Install the optional peer `@margoengine/gltf` (npm i
@margoengine/gltf): the shape is built as a one-primitive glTF in memory and drawn by its `textured` entry, so it stays a
core mesh that moves, picks and casts shadows with the component.

```tsx
import { Canvas } from '@margoengine/react';
import { Box, Plane } from '@margoengine/react/geometry';

export function Crates() {
  return (
    <Canvas style={{ height: 400 }}>
      <Plane args={[10, 10]} rotation={[-Math.PI / 2, 0, 0]} map="/textures/floor.jpg" />
      <Box position={[0, 0.5, 0]} map="/textures/crate.png" roughness={0.8} onClick={() => console.log('crate')} />
    </Canvas>
  );
}
```

| Prop | Default | Effect |
| --- | --- | --- |
| `map` | none | PNG or JPEG: a URL or the bytes. A new value rebuilds the shape. |
| `color` | `'#ffffff'` with a map | Multiplies the map. |

A textured shape needs WebGPU and draws in the Canvas default scene: inside `<Scene name>` it sends a `MargoError` (code
`unsupported`) to `onError`. Other formats (KTX2, WebP) and other maps (normal, roughness) belong in a glTF `Model`.
Pointer events on it have the drawn child mesh as `target` and the component's mesh as `currentTarget`.

### Pointer events and picking

Pointer handlers on `Mesh`, `Model`, `Box`, `Sphere`, `Plane`, `RigidBody`, `TransformControls` and the XR
`Controller` come from GPU picking, not from the DOM: `onClick`, `onDoubleClick`, `onContextMenu`, `onPointerDown`,
`onPointerUp`, `onPointerMove`, `onPointerOver`, `onPointerOut`, `onPointerEnter`, `onPointerLeave`, `onWheel` and
`onPointerMissed`. The Canvas takes `onPointerMissed` too. These rules come from the code in `src/events.ts` and apply to
every handler:

- **Picking is asynchronous.** The pointer event asks the GPU which mesh is under the pixel, and the handler runs after
  the answer, a frame or two later. Code and tests that read the state your handler sets must wait for it. Presses,
  releases and clicks keep their order. A burst of moves, or of wheel turns, collapses to the latest one.
- **The mesh in front gets the event.** If two meshes overlap under the pointer, the one drawn nearest the camera is
  hit. A child that overlaps its parent wins over the parent. A mesh in front with no handlers still takes the hit, and
  the event bubbles from it.
- **Events bubble, as DOM events do.** The event goes to the hit mesh, then to each parent `Mesh`, `Group` or model
  with handlers, until a handler calls `event.stopPropagation()`. `target` is the hit mesh, `currentTarget` (also
  `eventObject`) the mesh whose handler runs; inside a model it is the model's root, and the model hears an event once.
  `onPointerOver` and `onPointerOut` bubble. `onPointerEnter` and `onPointerLeave` do not: they fire once on each mesh
  the pointer comes into or leaves, counting the meshes below it, so moving between two children of a group gives the
  group out and over, never leave and enter.
- **A click goes to what the press and the release both hit**: the nearest mesh both hit, or their nearest shared
  parent, with the release's hit as `target`. It needs the pointer to move no more than 3 CSS pixels between press and
  release (an orbit drag is not a click), and only the primary button counts. `onPointerMissed` on a mesh fires for a
  click that did not reach it; on the Canvas, for a click that hit no mesh.
- **Pointer capture.** `event.setPointerCapture()` in `onPointerDown` sends the pointer's later events to that mesh
  without picking, until the release or `event.releasePointerCapture()`, as for a drag handle.
- **On the WebGL2 fallback.** Handlers fire when the engine has `webglPicking`, and the plain way to give it that is
  `<Canvas loadFallback={() => import('margoengine/webgl/pick')}>`: that entry holds the renderer and the picking. With a
  `fallback` prop, attach it yourself in `onCreated`. Only core meshes are picked there. Without it no handler fires,
  and nothing counts as missed: in development the Canvas prints one `MargoError` (code `unsupported`) the first time a
  handler is registered, and nothing in a production build.
- **Handlers get** `type` (the DOM event name), `nativeEvent`, `object` (also `mesh` and `target`: the hit mesh),
  `currentTarget` and `eventObject`, `x` and `y` (canvas pixels), `clientX` and `clientY`, `delta` (CSS pixels moved
  since the press), `stopPropagation()`, `stopped`, and `setPointerCapture()`, `releasePointerCapture()` and
  `hasPointerCapture()`.

A group that hears the clicks of its parts, a part that keeps its own, and a click on empty space:

```tsx
import { useState } from 'react';
import { Canvas, Mesh } from '@margoengine/react';
import { Box, Sphere } from '@margoengine/react/geometry';

export function Bubbling() {
  const [log, setLog] = useState('nothing yet');
  return (
    <>
      <p>{log}</p>
      <Canvas style={{ height: 400 }} onPointerMissed={() => setLog('missed')}>
        <Mesh onClick={(event) => setLog(event.target === event.currentTarget ? "the group itself" : "group heard a click on a part")}>
          <Box position={[-1, 0, 0]} />
          <Sphere
            position={[1, 0, 0]}
            onClick={(event) => {
              event.stopPropagation();
              setLog('the sphere kept its click');
            }}
          />
        </Mesh>
      </Canvas>
    </>
  );
}
```

In a Playwright test, click and then wait for the state:

```ts
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5173/');
await page.mouse.click(320, 240);
await page.waitForFunction(() => document.querySelector('#selected')!.textContent === 'crate');
await browser.close();
```

## Models and environment

A model, its lighting and the orbit controls, directly under the canvas:

```tsx
'use client';
import { Suspense } from 'react';
import { MargoCanvas, Environment, OrbitControls, Shadows } from 'margoengine/react';
import { Model } from 'margoengine/react/gltf-pro';

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

`<BatchedMesh maxItems maxVertices>` draws many different geometries in one draw call per pass; put a `<BatchedItem geometry position rotation scale color visible>` (or `matrix`) per object inside. Moving, tinting or hiding an item updates the batch in place with no React render of the batch; capacity and `material` are fixed. `<DepthTexture>` and `<SceneTargets outputs={{ albedo: 'albedo', normal: 'normal' }}>` render the scene's depth or several targets in one pass for your own shaders; their ref is the live plugin (`depth.texture`, `targets.texture('normal')`), and the Canvas's PBR models are added for you. All three need WebGPU.

```tsx
import { Canvas } from '@margoengine/react';
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
    </Canvas>
  );
}
```

`<RenderView>` draws the Canvas through a camera into part of it (split screen, a four-view layout, a minimap) or into a texture: `camera` (a core `Camera`; default the Canvas camera), `viewport` (fractions from the top left), `scissor`, `clear`, `layers`, `target`, `id` and `order`. With one or more views the Canvas draws only those; picking follows the view under the pointer. `<Scene name>` holds meshes drawn only by the views that name it (`<RenderView scene="hud">`), such as a HUD overlay or an item preview; `background={null}` keeps what is below. `<Mesh layers={mask}>` (a `layerMask(...)` from `@margoengine/cameras/layers`) limits which views draw a mesh. Views and scenes work on WebGPU and WebGL2.

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

## UI, audio, 2D sprites and charts

`@margoengine/react/ui` binds four packages to the Canvas engine. Each loads its package when it mounts, so install
only the ones you use (`@margoengine/ui`, `@margoengine/audio`, `@margoengine/sprites`, `@margoengine/sciviz`).

- **`GameUi`** is `UiRoot` of `@margoengine/ui/react` with the Canvas engine filled in. Nest that package's widgets
  (`Panel`, `Label`, `Button`, `HealthBar`, `Inventory`, ...) inside; they draw on the canvas.
- **`Sound`** plays a URL or an `AudioBuffer` through one `AudioListener` per Canvas, which follows the camera. Inside a
  `<Mesh>` it is positional and moves with the mesh. `playing` (default true) plays and pauses; `volume`, `loop`,
  `playbackRate`, `refDistance`, `maxDistance`, `rolloffFactor` and `distanceModel` update in place. Browsers start
  audio after the first click or key press. The ref is the `Audio`.
- **`SpriteLayer`** and **`Sprite`** draw 2D sprites at exact pixels: the layer takes the `@margoengine/sprites`
  options (`atlas` swaps in place; `camera`, `snap` and `ySort` are live), each `Sprite` its fields (`x`, `y`, `rect`,
  `tint`, `flipX`, ...), updated in place.
- **`Figure`** with **`ScatterPlot`**, **`LinePlot`** and **`SurfacePlot`** draws a `@margoengine/sciviz` figure with
  the Canvas camera. Options are compared by value; a new `data` (or `z`) object rebuilds its layer, so keep it in
  `useMemo` or state. `onReady` fires once axes and labels are drawn. WebGPU only.

```tsx
import { useMemo } from 'react';
import { BoxGeometry, Canvas, Mesh } from '@margoengine/react';
import { Figure, GameUi, ScatterPlot, Sound, Sprite, SpriteLayer } from '@margoengine/react/ui';
import { HealthBar, Panel } from '@margoengine/ui/react';

const atlas = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) };

export function Everything({ hp }: { hp: number }) {
  const points = useMemo(() => ({ x: [0, 1, 2], y: [2, 0, 1], z: [0, 1, 2] }), []);
  return (
    <Canvas style={{ height: 400 }}>
      <GameUi>
        <Panel anchor="top-left" margin={16} padding={8}>
          <HealthBar value={hp} max={100} width={200} />
        </Panel>
      </GameUi>
      <Mesh position={[2, 0, 0]}>
        <BoxGeometry />
        <Sound src="/sounds/engine.ogg" loop refDistance={2} />
      </Mesh>
      <SpriteLayer atlas={atlas}>
        <Sprite x={16} y={16} rect={[0, 0, 1, 1]} scaleX={32} scaleY={32} />
      </SpriteLayer>
      <Figure titles={{ x: 'x', y: 'y', z: 'z' }}>
        <ScatterPlot data={points} options={{ size: 4 }} />
      </Figure>
    </Canvas>
  );
}
```

A component outside its parent (`Sprite` outside `SpriteLayer`, a plot outside `Figure`, a positional `Sound` outside a
`Mesh`) throws a `MargoError` (code `state`) that names the parent to add.

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

Physics is a separate entry, so an app without it never loads a solver. Import it from `@margoengine/react/physics`:
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

A Next.js page is larger than the Vite page: about 194 KB gzip of JavaScript. Its build output also holds the Basis and
Draco decoders; they are emitted but never requested at load or while orbiting.

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

## Browsers without WebGPU

`loadFallback` fetches the WebGL2 renderer only when the browser has no WebGPU, and `fallbackContent` is what the
canvas shows when no renderer is usable (like a Suspense fallback, it can be an SVG, a skeleton or a pre-rendered image).
WebGPU visitors never run the loader, so they download none of `@margoengine/webgl`.

```tsx
import { Canvas } from '@margoengine/react';

export function Viewer() {
  return (
    <Canvas
      loadFallback={() => import('@margoengine/webgl')}
      fallbackContent={<img src="/scene.png" alt="Pre-rendered view of the scene" />}
      onError={(error) => console.warn(error)}
    />
  );
}
```

| Prop | Default | Effect |
| --- | --- | --- |
| `loadFallback` | none | `(signal: AbortSignal) => Promise<factory \| { webglRenderer }>`. Called once per engine, only without WebGPU (or with `backend="webgl2"`); `signal` aborts on unmount. A rejection reaches `onError` as a `MargoError` with code `unsupported`. Ignored when `fallback` or `backend="webgpu"` is set. |
| `loadCompat` | none | `() => Promise<{ install() }>`, the WebGL2 compatibility layer. Installed before the engine is made, only without WebGPU, so packages the preview refuses still draw: one engine, one `onCreated`, and listeners stay on the canvas. If the browser's WebGL2 is too old to carry it, `loadFallback` runs, or `onError` gets the refusal. |
| `fallbackContent` | the plain "needs a browser with WebGPU" text | Shown in place of the text for the `unsupported` error; `onError` still receives it. |

A scene that uses more than plain meshes wants `loadCompat`: the preview draws core meshes only, and the layer carries the packages. It is a larger download, and only visitors without WebGPU fetch it.

```tsx
import { Canvas } from '@margoengine/react';

export function Viewer() {
  return <Canvas loadCompat={() => import('@margoengine/webgl2-compat')} loadFallback={() => import('@margoengine/webgl')} />;
}
```

## Pixel ratio and GPU choice

`maxDpr` lowers the canvas pixel ratio below the engine's own cap of 2. Core has no per-canvas option, so the Canvas uses
the engine's light tier, the `globalThis.margoLow` pixel-ratio cap. That has three consequences: MSAA is off while it
applies, it covers every canvas on the page while a Canvas with `maxDpr` is mounted (the lowest value wins and the
previous setting returns after the last one unmounts), and a value of 2 or more changes nothing. A `margoLow` you set
yourself still counts. Changing `maxDpr` recreates the engine, and a value that is not a number above 0 reaches
`onError` as a `RangeError`. The default is no cap beyond the engine's: 2, with MSAA on desktop.

```tsx
import { Canvas } from '@margoengine/react';

export function LightViewer() {
  return <Canvas maxDpr={1} style={{ height: 400 }} />;
}
```

| Prop | Default | Effect |
| --- | --- | --- |
| `maxDpr` | none | Pixel ratio cap below 2, for example `1`. Page-wide while mounted; turns MSAA off. |

There is no `powerPreference` prop. The WebGPU renderer asks for its adapter inside core (high performance, except on
Windows where the browser chooses), and core takes no option for it, so a prop here would only pretend.

## Development hints

In development the Canvas prints each of these once as a `MargoError`. Development means your bundler or Node gives
`process.env.NODE_ENV` a value other than `'production'`; the page needs no global `process`, so the Vite dev server
counts. A production bundle contains none of them. Plain ES modules with no bundler print none either.

```tsx
import {Canvas} from '@margoengine/react';

// Under `vite dev` the console names the component to use instead of <mesh>.
export const App = () => (
  <Canvas>
    {/* @ts-expect-error: the wrong name on purpose, this is what the warning is for. */}
    <mesh />
  </Canvas>
);
```

- **A lowercase R3F tag** such as `<mesh>`, `<group>` or `<boxGeometry>` inside the Canvas. React renders it as an unknown
  DOM element, so nothing draws. The message names the Margo component to use (`<Mesh>`, `<Group>`, `<BoxGeometry>`,
  `<PbrMaterial>`, `<Sun>`) or the namespace form `<Margo.mesh>`.
- **Pointer handlers on the WebGL2 fallback**: see [Pointer events and picking](#pointer-events-and-picking).

## Build warnings

A production Vite build of the cube page prints no warnings; `npm run modern:test:bundlers` checks it from the installed packages on every merge check and fails on any warning. Only the generated `rsc/` entries carry `'use client'` (the
`react-server` export condition maps to them), so a server component can import `Canvas`. `sideEffects` is `false`, so
unused exports are dropped. Next.js builds with webpack and Turbopack run in `npm run modern:test:bundlers`.

## Choosing the GPU

On a laptop with an integrated and a discrete GPU, `powerPreference` picks one: `'low-power'` saves battery,
`'high-performance'` asks for the discrete GPU. The Canvas passes it to `Engine.create`, and the engine asks for the
same GPU again when the device is restored.

```tsx
import { Canvas } from '@margoengine/react';

export function BatteryFriendlyViewer() {
  return <Canvas powerPreference="low-power" style={{ height: 400 }} />;
}
```

| Prop | Default | Effect |
| --- | --- | --- |
| `powerPreference` | unset: `'high-performance'`, nothing on Windows | `'low-power'` or `'high-performance'`. Read when the engine is created; a new value applies to the next engine. |

Chrome and Edge on Windows ignore a set value and log a console warning; there, the GPU is chosen per browser in
Windows Settings > System > Display > Graphics.

## Testing and size

Run `npm run build:packages`, then `npm run modern:test:react` for the React Testing Library and JSDOM lifecycle tests:
the first-scene snippet, StrictMode events, Suspense, cancellation, cache reuse and demand rendering. `npm run typecheck`
and `npm run test:modules:packages` check the package types and imports. `npm run test:docs:browser` runs the React guides
in a real WebGPU browser. The adapter uses standard hooks, never `react-reconciler`. Frame dispatch forwards
`(engine, deltaSeconds)` without building per-frame state objects or callback arrays.

What the numbers mean, by scope. None of them is "the size of your app":

- **Core and stage together:** 23,626 B gzip (`npm run measure:size`, the entry measurement; the build fails at 25,000 B).
  It does not include React, this package or any optional package.
- **A Vite React page with the cube and orbit controls:** 102,335 B gzip of JavaScript, 70% of it React and React DOM
  (measured, table in limits.md). `PbrMaterial` is core's material and pulls in no other package. A textured `<Model>`
  adds 1,750 B to the entry and fetches glTF support (56,074 B gzip) when it mounts.
- **A React page with PBR models loaded, in an independent study:** about 563 KB decoded, 193 KB gzip, including React and
  the shared scene infrastructure. A Next.js page is about 194 KB gzip.

The measured breakdown of a React build, package by package, is in [docs/limits.md](../../docs/limits.md#react-page).

## Troubleshooting

- **The canvas is blank and has no height.** Give `<Canvas>` a height: `style={{ height: 400 }}`.
- **No WebGPU, graceful fallback.** `<Canvas loadFallback={() => import('margoengine/webgl')} fallbackContent={<img src="/scene.png" alt="Scene preview" />}>`: the Canvas checks `navigator.gpu` and `requestAdapter()` itself before creating the engine and calls `loadFallback` only when WebGPU is missing, so WebGPU visitors download none of `@margoengine/webgl` (it is a separate chunk). The loader gets an `AbortSignal` (aborted on unmount) and may resolve the renderer factory or a module with `webglRenderer`; a rejection reaches `onError` as a `MargoError` with code `unsupported`. When no renderer is usable, `fallbackContent` (an SVG, skeleton or image) replaces the default text, a bit like a Suspense fallback, and `onError` still gets the coded error. `fallback` (a factory you import yourself) works as before and wins over `loadFallback`.
- **"WebGPU unavailable".** The browser has no WebGPU. Pass an `onError` handler to show your own message.
- **A component does nothing.** React treats a bare lowercase `<mesh>` as a DOM element. Use `<Mesh>`, or the
  namespace form `<Margo.mesh>`. In development the Canvas prints a warning that names the component to use.
- **A hook throws a `state` error.** `useMargo`, `usePhysics` and `useXR` work only inside their provider (`<Canvas>`, `<Physics>`, `<XR>`).
- **The scene re-renders constantly.** Per-frame values belong in refs: see [State vs the frame loop](#state-vs-the-frame-loop).
- **A click handler never runs, or a test sees the old state.** Picking is asynchronous: see [Pointer events and picking](#pointer-events-and-picking). The WebGL2 fallback needs `webglPicking`.
- **Textures on `Box`, `Sphere` or `Plane`.** Pass `map` and install `@margoengine/gltf`: see [Textured Box, Sphere and Plane](#textured-box-sphere-and-plane). For more maps than base colour, use a glTF `Model`.
- **Next.js error about hooks in a server component.** Put the `Canvas` in a file that starts with `'use client'`.

Apache-2.0 licensed.

## Helpers and development panels

```tsx
import {Canvas, Mesh} from '@margoengine/react';
import {Billboard, Bounds, Float, useBounds} from '@margoengine/react/helpers';
import {Box} from '@margoengine/react/geometry';
import {Grid} from '@margoengine/react/lines';
import {DevTools} from '@margoengine/react/devtools';

function Part() {
  const bounds = useBounds();
  return <Box position={[2, 0, 0]} onClick={(event) => bounds.fit(event.object)} />;
}

export function App() {
  return (
    <Canvas>
      <DevTools />
      <Grid size={20} divisions={20} />
      <Bounds fit clip observe margin={1.3}>
        <Part />
        <Float speed={2} floatingRange={[0, 0.3]}>
          <Mesh position={[-2, 0, 0]} />
        </Float>
        <Billboard lockX position={[0, 2, 0]}>
          <Box args={[1, 1, 0.1]} />
        </Billboard>
      </Bounds>
    </Canvas>
  );
}
```

- `Bounds` frames its content when it first has geometry, keeping the viewing direction, and `useBounds().fit(mesh)` frames
  one mesh. `clip` also sets the camera's near and far. Defaults: margin 1.2, duration 0.3 s.
- `Billboard` keeps +Z towards the camera, whatever its parents do. `lockX` keeps it upright, `lockY` stops it turning sideways.
  It assumes parents without shear.
- `Float` adds its motion inside its own group, so `position` and `rotation` stay yours. It moves on frames, so it stands still
  with `frameloop="demand"` until something asks for a frame.
- `Grid` needs `@margoengine/lines`, and lets go of its plugin on unmount.
- `DevTools` needs `@margoengine/inspector` and `@margoengine/stats`, loaded only when it opens, and is off in a production
  build unless you pass `enabled`, including one with no global `process`, which is every browser build. In React 19 development builds a mesh without a `name` shows the components that made it,
  such as "Box in Part". Safari and other WebKit browsers drop a component that ends in `return <Mesh ... />` from that name, as
  their engine replaces the frame of a tail call: give the mesh a `name`, or assign the element first
  (`const mesh = <Mesh ... />; return mesh;`).

Strict consumers can use `skipLibCheck: false` with optional engine peers absent.
Declaration packaging keeps parameter annotations while removing implementation
binding patterns; installing a peer restores its full option checking.
