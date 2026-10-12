# @margoengine/react

React 18/19 integration with a native canvas, stable mesh refs and frame callbacks. There is no custom reconciler.

Package name: `@margoengine/react`, version `0.1.0`. Build from source or install a local tarball until the renamed package is published.

```sh
npm install margoengine@0.1.0 @margoengine/core@0.1.0 @margoengine/react@0.1.0 react@^19 react-dom@^19
# Install the optional packages used by your JSX:
npm install @margoengine/gltf-pro@0.1.0 @margoengine/environment@0.1.0 @margoengine/controls@0.1.0 @margoengine/shadows@0.1.0
```

```tsx
'use client';
import { MargoCanvas, Model, Environment, OrbitControls } from '@margoengine/react';

export default function App() {
  return <MargoCanvas backend="webgpu" camera={{ position: [0, 2, 5] }} shadows style={{ height: 400 }}>
    <Model src="/model.glb" position={[0, 0, 0]} materials={{ Upper: { baseColor: [0.52, 0.84, 0.74] } }} castShadow receiveShadow />
    <Environment src="/studio.hdr" exposure={1} background />
    <OrbitControls enableDamping minDistance={1} maxDistance={20} />
  </MargoCanvas>;
}
```

`Canvas` remains an alias for `MargoCanvas`; existing `Mesh`, `BoxGeometry`, `GeometryResource`, `PbrMaterial` and mesh refs remain available. `useMargo()` returns `{ stage, ready, canvas }` with the existing `Stage` facade from `margoengine`. `onCreated(stage)` receives that facade after sizing and camera setup, before rendering starts. Access the portable engine through `stage.engine`. This replaces the former engine argument to `onCreated`.

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

`Model` loads glTF/GLB through `@margoengine/gltf-pro`. Position, Euler rotation (radians), scale and named material overrides update the existing model; removing an override restores the loaded material. Supported shallow overrides are `baseColor` (linear RGB or RGBA), `roughness`, `metalness`, `emissive`, `normalScale`, `occlusionStrength`, `alphaCutoff` and `doubleSided`. `onLoad(mesh)` receives the model's root mesh after initial props have been applied. Only changing `src` reloads the model. Unmount aborts requests, unregisters lighting and shadows, and disposes the PBR plugin, meshes, textures and buffers.

`Environment` loads HDR/EXR through `@margoengine/environment` and attaches diffuse/specular IBL to sibling `Model` components, regardless of loading order. Exposure is a nonnegative linear lighting multiplier; it also controls HDR background intensity. `background` defaults to true and only affects an HDR background. Without `src`, the component configures neutral studio directional and ambient lighting; teardown restores the previous lighting. Exposure and background changes do not reload the map. Use one `Environment` per canvas.

`OrbitControls` binds the active camera and canvas, updates from one stable frame subscription, and removes its listeners and subscription on unmount. Props are `autoRotate` (false), `autoRotateSpeed` (2), `enableDamping` (false), `minDistance` (0) and `maxDistance` (Infinity). `shadows` opts the canvas into `@margoengine/shadows`; model casting and receiving are independently opt-in. PBR models, HDR IBL and shadows require WebGPU; legacy meshes and neutral studio lighting support the WebGL fallback.

`useFrame((engine, deltaSeconds) => ...)` updates meshes without React renders or re-subscribing when the callback changes. The canvas serializes initialization, disposes superseded engines, and disconnects ResizeObserver during cleanup. It handles StrictMode, HMR effect replacement, late initialization after unmount, and `capacity`/`backend` changes. Camera changes update the existing engine. Errors reach `onError` and an accessible alert.

SSR emits an accessible canvas without accessing GPU APIs. The ESM output preserves `use client` and includes TypeScript declarations. Peer ranges accept the current core 0.1.x workspace and the requested core 1.x release, plus React 18/19.

Run `npm run build:packages` followed by `npm run modern:test:react` for React Testing Library/JSDOM lifecycle tests. Run `npm run dev --workspace @margoengine/react-viewer` for the resizable Vite example with declarative and imperative workflows; its entry point disposes its React root during HMR. The adapter uses standard hooks, never `react-reconciler`. Frame dispatch forwards `(engine, deltaSeconds)` directly without building per-frame state objects or callback arrays. Allocations inside user callbacks and underlying render plugins are outside the adapter's frame dispatch contract.

See the [React API and lifecycle guide](https://github.com/scottcampbelldata/vexel/blob/main/MODERN-ENGINE.md).

MIT licensed.
