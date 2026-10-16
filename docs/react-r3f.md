# Tighter React integration for the R3F audience

Date: 2026-10-16. This follows the shipped `<Canvas>`, `<Stage>`, and `<Mesh>` work in `docs/react-integration.md`. Everything here stays in `@margoengine/react`. Core and the stage facade stay frozen. There is still no `react-reconciler`, so a bare `<mesh>` remains a DOM tag. Use `<Mesh>` or `<Margo.mesh>`.

The package already has the R3F-shaped tree: `<Canvas>`, `<Stage>`, `<Mesh>`, `<Model>`, `<Environment>`, `<OrbitControls>`, and `useFrame`. The next gap is events, Suspense, and a `useThree`-shaped hook.

## Pointer events

`engine.pick(x, y)` already returns the mesh under a canvas pixel. `<Mesh>` and `<Model>` do not accept `onClick`, `onPointerOver`, or `onPointerOut`.

Add those props on `Mesh` and `Model` in `packages/react/src/components.tsx`. The canvas listens once. On pointer up, if the pointer moved only a few pixels, call `stage.engine.pick` and dispatch to the mesh that was hit. Hover uses the same pick, and the last hit is cached so `onPointerOut` fires when the id changes. Orbit controls already own drag and wheel. A click is a pointer-up that did not drag. Do not add a second raycaster.

## Suspense

`<Model>` loads inside `useEffect` and returns `null`. An R3F file wraps the model in `<Suspense fallback={...}>` and expects the fallback to stay up until the glTF is ready.

Make `Model` and `Environment` throw the load promise while the file is in flight, and cache that promise by URL on the canvas. `preload(src)` starts the same promise. Unmount still aborts. A failed load still reaches `onError`. This is React's own Suspense, not a new loader.

## One hook with the R3F names

`useMargo()` returns `{ stage, ready, canvas }`. `useMargoStage()` returns the engine. R3F tutorials call `useThree()` and read `camera`, `size`, `gl`, and `clock`.

Add those fields to the value `useMargo()` already returns:

| Field | Source |
| --- | --- |
| `camera` | `stage.engine.camera` |
| `size` | The canvas client width and height |
| `gl` | The engine |
| `clock` | The elapsed time `useFrame` already receives |

Keep `useMargoStage()`. Do not export a function named `useThree`.

## The small set of missing tags

| R3F tag | Where it comes from |
| --- | --- |
| `<group>` | A `<Mesh>` with no geometry. The parent registry already re-parents children. |
| `<Html>` | Optional peer `@margoengine/html`, using the same dynamic import `Environment` uses. |
| `frameloop="demand"` | `engine.start` and `engine.stop` already exist. Demand mode does not call `start`. `invalidate()` from `useMargo()` renders one frame. |

`<Physics>` can wait. `@margoengine/physics` is there, and it is not what the first R3F question asks.

## What not to add

A `react-reconciler` dependency would make a bare `<mesh>` work and would throw away the dispose tests that already pass. More geometry components beyond `<group>` do not change the reaction.

## The snippet this has to render

```tsx
import { Canvas, Stage, Mesh, BoxGeometry, PbrMaterial, Model } from '@margoengine/react';
import { Suspense } from 'react';

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

## Proof

1. A StrictMode test clicks the mesh and asserts `onClick` runs once, and a drag does not.
2. A Suspense test shows the fallback until the glTF promise resolves, then removes it. Unmount aborts the load.
3. `useMargo()` exposes `camera`, `size`, `gl`, and `clock` inside `<Canvas>`.
4. `npm run measure:size` still reports core plus stage under 20,000 bytes gzip.
