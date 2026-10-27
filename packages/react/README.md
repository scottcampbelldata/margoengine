# @margoengine/react

Install `npm i margoengine` and import `margoengine/react` (or this package alone: `npm i @margoengine/react`, imported as `@margoengine/react`; the two are the same module).

With Vite, installing this package alone (plus the peers your components use, such as `@margoengine/controls` for
`OrbitControls`) keeps the build to what you import: a cube page with orbit controls loads 95,338 B gzip (70% of it React and React DOM) and emits no
Wasm. `margoengine` installs every package, so the build also writes the lazy loaders the stage can reach (glTF
decoders, CAD import with OpenCascade's Wasm) to `dist`; the page never requests them. Webpack and Turbopack (Next.js)
need `margoengine` ([limits.md](../../docs/limits.md), React app budget).

React 18/19 integration with a native canvas, pointer events, Suspense, stable mesh refs and frame callbacks. There is no custom reconciler.

Scene helpers, controls, post effects and XR are available from one
`@margoengine/react` import; physics comes from `@margoengine/react/physics`, so an app without it never needs
Rapier installed (bundlers resolve every `import()` they reach). The [`kit`, `post`, `physics` and `xr` subpaths](SCENE.md)
remain available. Unused bindings are tree-shaken, and optional native peers
load only when their components need them.

Package name: `@margoengine/react`, version `0.1.0`. Build from source or install a local tarball until the renamed package is published.

From a repository checkout, run `npm ci` and `npm run build:packages`.
`npm run pack:packages` creates local tarballs in `test-results/` for use outside
the workspace. See [SCENE.md](SCENE.md) for the optional peers each component
uses. Registry installation commands will accompany a verified release.

```tsx
import { Suspense } from 'react';
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
```

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

Optional model, lighting and control components can be used directly under the canvas:

```tsx
'use client';
import { Suspense } from 'react';
import { MargoCanvas, Model, Environment, OrbitControls } from 'margoengine/react';

export default function App() {
  return <MargoCanvas backend="webgpu" camera={{ position: [0, 2, 5] }} shadows style={{ height: 400 }}>
    <Suspense fallback={<span>Loading scene…</span>}>
      <Model src="/model.glb" position={[0, 0, 0]} materials={{ Upper: { baseColor: [0.52, 0.84, 0.74] } }} castShadow receiveShadow />
      <Environment src="/studio.hdr" exposure={1} background />
    </Suspense>
    <OrbitControls enableDamping minDistance={1} maxDistance={20} />
  </MargoCanvas>;
}
```

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

`Model` loads glTF/GLB through `@margoengine/gltf-pro`. Position, Euler rotation (radians), scale and named material overrides update the existing model; removing an override restores the loaded material. Supported shallow overrides are `baseColor` (linear RGB or RGBA), `roughness`, `metalness`, `emissive`, `normalScale`, `occlusionStrength`, `alphaCutoff` and `doubleSided`. `onLoad(mesh)` receives the model's root mesh after initial props have been applied. Only changing `src` selects another asset. Unmount unregisters lighting and shadows and disposes the instance's PBR plugin, meshes, textures and buffers.

Wrap `Model` and file-backed `Environment` components in React `Suspense` to show a fallback while loading. Loads begin after the first commit so unmount cleanup can abort an unfinished load. The canvas caches pending promises and resolved CPU source data by URL; concurrent mounts and remounts reuse that source while owning independent model transforms, materials and disposable GPU resources. The last pending consumer unmount aborts its request. Canvas teardown releases the cache. Load failures reach the component's optional `onError` and the canvas's `onError`/accessible alert.

`preload(src)` warms the same cache on active canvases. It infers environment assets from `.hdr` and `.exr` URL paths; use `preload(src, 'environment')` for an environment endpoint without that extension. Before a canvas is ready, the returned promise queues until an engine exists, since the optional glTF loader requires an engine. Render the canvas before awaiting a queued preload. A preloaded asset remains hidden until mounted.

`Environment` loads HDR/EXR through `@margoengine/environment` and attaches diffuse/specular IBL to sibling `Model` components, regardless of loading order. Exposure is a nonnegative linear lighting multiplier; it also controls HDR background intensity. `background` defaults to true and only affects an HDR background. Without `src`, the component configures neutral studio directional and ambient lighting; teardown restores the previous lighting. Exposure and background changes do not reload the map. Use one `Environment` per canvas.

`Html` dynamically imports optional `@margoengine/html` and `react-dom` peers and projects React DOM children into a shared overlay. Nested inside a `Mesh` or `Group`, its `position` is a local offset; otherwise it is a world position. It accepts `className`, `style`, and an `occlude` boolean (true by default), and removes its label and overlay resources on unmount.

`OrbitControls`, `MapControls`, `CadControls` and `ArcballControls` bind the active camera and canvas, update from the Canvas frame loop (so `frameloop="demand"` and `invalidate()` move them too), and remove their listeners on unmount. Every public field of the controls is a prop (`enableDamping`, `dampingFactor`, `rotateSpeed`, `zoomToCursor`, `minDistance`, `maxPolarAngle`, ...); a prop removed again restores the controls' default. `target` sets the orbit point when it changes. `onChange`, `onStart` and `onEnd` receive the controls' events, and the ref is the live controls object. `CadControls` navigates like a CAD tool: `profile` is `'margo'` (default), `'solidworks'`, `'autocad'`, `'inventor'`, `'fusion'`, `'blender'`, `'maya'`, `'onshape'` or `'rhino'`, and keyboard shortcuts are on (`keyEvents={false}` turns them off). `OrbitControls` takes the same `profile` and `keyEvents` props.

```tsx
import { Canvas, CadControls, Shadows, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';

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
``` `shadows` opts the canvas into `@margoengine/shadows`; model casting and receiving are independently opt-in. PBR models, HDR IBL and shadows require WebGPU; legacy meshes and neutral studio lighting support the WebGL fallback.

`<BatchedMesh maxItems maxVertices>` draws many different geometries in one draw call per pass; put a `<BatchedItem geometry position rotation scale color visible>` (or `matrix`) per object inside. Moving, tinting or hiding an item updates the batch in place with no React render of the batch; capacity and `material` are fixed. `<SectionPlanes planes={[[1, 0, 0, 0]]}>` cuts the scene with up to six planes and caps closed solids; plane values update live. `<DepthTexture>` and `<SceneTargets outputs={{ albedo: 'albedo', normal: 'normal' }}>` render the scene's depth or several targets in one pass for your own shaders; their ref is the live plugin (`depth.texture`, `targets.texture('normal')`), and the Canvas's PBR models are added for you. All four need WebGPU.

```tsx
import { Canvas, BatchedMesh, BatchedItem, SectionPlanes } from '@margoengine/react';
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
import { Canvas, RenderView, Scene, Box } from '@margoengine/react';

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
import { Canvas, Sun, HemisphereLight, Fog, Model } from '@margoengine/react';

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
import { Canvas, Voxels, useBlockTextures } from '@margoengine/react';

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

`useFrame((engine, deltaSeconds) => ...)` updates meshes without React renders or re-subscribing when the callback changes. The canvas serializes initialization, disposes superseded engines, and disconnects ResizeObserver during cleanup. It handles StrictMode, HMR effect replacement, late initialization after unmount, and `capacity`/`backend` changes. Camera changes update the existing engine. Errors reach `onError` and an accessible alert.

## Next.js

Both the App Router and the Pages Router work, with webpack and with Turbopack, and need no `transpilePackages`. Keep the
page a server component and put the `Canvas` in a small client component:

```tsx
// app/scene.tsx
'use client';
import { Canvas, Box, OrbitControls } from '@margoengine/react';

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

SSR emits an accessible canvas without accessing GPU APIs. The ESM output preserves `use client` and includes TypeScript declarations. Peer ranges accept the current core 0.1.x workspace and the requested core 1.x release, plus React 18/19.

Run `npm run build:packages` followed by `npm run modern:test:react` for React Testing Library/JSDOM lifecycle tests, including the canonical target snippet, StrictMode events, Suspense, cancellation, cache reuse and demand rendering. `npm run typecheck`, `npm run test:modules:packages`, and `npm run measure:size` verify package types, imports, and the core + stage ceiling of 25,000 bytes gzip; the current measurement is 22,781 bytes gzip. Run `npm run dev --workspace @margoengine/react-viewer` for the resizable Vite example. The adapter uses standard hooks, never `react-reconciler`. Frame dispatch forwards `(engine, deltaSeconds)` without building per-frame state objects or callback arrays.

See the React API and lifecycle guide.

Apache-2.0 licensed.
