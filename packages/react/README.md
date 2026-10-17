# @margoengine/react

React 18/19 integration with a native canvas, pointer events, Suspense, stable mesh refs and frame callbacks. There is no custom reconciler.

Scene helpers, post effects, physics and XR are available from one
`@margoengine/react` import. The [`kit`, `post`, `physics` and `xr` subpaths](SCENE.md)
remain available. Unused bindings are tree-shaken, and optional native peers
load only when their components need them.

Package name: `@margoengine/react`, version `0.1.0`. Build from source or install a local tarball until the renamed package is published.

From a repository checkout, run `npm ci` and `npm run build:packages`.
`npm run pack:packages` creates local tarballs in `test-results/` for use outside
the workspace. See [SCENE.md](SCENE.md) for the optional peers each component
uses. Registry installation commands will accompany a verified release.

```tsx
import { Suspense } from 'react';
import { Canvas, Stage, Mesh, BoxGeometry, PbrMaterial, Model } from '@margoengine/react';

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
import * as Margo from '@margoengine/react';

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
import { MargoCanvas, Model, Environment, OrbitControls } from '@margoengine/react';

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

`Canvas` remains an alias for `MargoCanvas`; existing geometry components and mesh refs remain available. `useMargo()` returns `{ stage, ready, canvas, camera, size, gl, clock, invalidate }`. `camera` and `gl` are the stage's camera and engine; `size` reads the canvas client width and height; `clock` is elapsed frame time in seconds as a number. `onCreated(stage)` receives the existing `Stage` facade from `margoengine` after sizing and camera setup, before rendering starts. There is no `useThree` export.

With `<Canvas frameloop="demand">`, the engine does not start an animation loop. Each `invalidate()` call advances `useFrame` and OrbitControls and renders exactly one frame. The default `frameloop="always"` renders continuously. Read `clock` from the hook value when needed; its getter advances without causing React renders.

`useMargoStage()` retains its existing portable `EngineKernel` return value (`createMesh`, `camera`, frame callbacks and plugins). Children mount after asynchronous stage creation. Hooks outside the provider throw. Use an effect to create imperative objects and return their disposal function:

```tsx
import { useEffect } from 'react';
import { box, PbrMaterial as Material } from '@margoengine/core';
import { useMargoStage } from '@margoengine/react';

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

`OrbitControls` binds the active camera and canvas, updates from one stable frame subscription, and removes its listeners and subscription on unmount. Props are `autoRotate` (false), `autoRotateSpeed` (2), `enableDamping` (false), `minDistance` (0) and `maxDistance` (Infinity). `shadows` opts the canvas into `@margoengine/shadows`; model casting and receiving are independently opt-in. PBR models, HDR IBL and shadows require WebGPU; legacy meshes and neutral studio lighting support the WebGL fallback.

`useFrame((engine, deltaSeconds) => ...)` updates meshes without React renders or re-subscribing when the callback changes. The canvas serializes initialization, disposes superseded engines, and disconnects ResizeObserver during cleanup. It handles StrictMode, HMR effect replacement, late initialization after unmount, and `capacity`/`backend` changes. Camera changes update the existing engine. Errors reach `onError` and an accessible alert.

SSR emits an accessible canvas without accessing GPU APIs. The ESM output preserves `use client` and includes TypeScript declarations. Peer ranges accept the current core 0.1.x workspace and the requested core 1.x release, plus React 18/19.

Run `npm run build:packages` followed by `npm run modern:test:react` for React Testing Library/JSDOM lifecycle tests, including the canonical target snippet, StrictMode events, Suspense, cancellation, cache reuse and demand rendering. `npm run typecheck`, `npm run test:modules:packages`, and `npm run measure:size` verify package types, imports, and the core + stage ceiling of 25,000 bytes gzip; the current measurement is 21,107 bytes gzip. Run `npm run dev --workspace @margoengine/react-viewer` for the resizable Vite example. The adapter uses standard hooks, never `react-reconciler`. Frame dispatch forwards `(engine, deltaSeconds)` without building per-frame state objects or callback arrays.

See the [React API and lifecycle guide](https://github.com/scottcampbelldata/margoengine/blob/main/MODERN-ENGINE.md).

MIT licensed.
