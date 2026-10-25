# React cookbook

Short recipes for `@margoengine/react`, each a complete file you can paste. Every snippet is type-checked against the
packed package by `npm run modern:test:packages`. Reference for each component is in the
[package README](../packages/react/README.md) and [SCENE.md](../packages/react/SCENE.md).

## A spinning cube

```tsx
import { useRef } from 'react';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame, type MeshRef } from '@margoengine/react';

function Cube() {
  const mesh = useRef<MeshRef>(null);
  useFrame((_, delta) => {
    if (mesh.current) mesh.current.rotation.y += delta;
  });
  return (
    <Mesh ref={mesh}>
      <BoxGeometry />
      <PbrMaterial color="#84d6bd" roughness={0.3} />
    </Mesh>
  );
}

export function App() {
  return (
    <Canvas style={{ height: 400 }}>
      <Cube />
    </Canvas>
  );
}
```

`useFrame` runs once per rendered frame with the engine and the seconds since the previous frame. With `frameloop="demand"` it runs
only when something calls `invalidate()` (from `useMargo()`), so an idle scene costs nothing.

## Light the scene

```tsx
import { Canvas, Sun, HemisphereLight, Fog, Box } from '@margoengine/react';

export function Lit() {
  return (
    <Canvas>
      <Sun direction={[1, 2, 1]} color="#fff4e0" intensity={3} />
      <HemisphereLight sky="#bcd8ff" ground="#403020" intensity={0.6} />
      <Fog color="#bcd8ff" near={20} far={120} />
      <Box color="#84d6bd" />
    </Canvas>
  );
}
```

Each light component sets its light while mounted and restores the previous one when it unmounts.

## Load a model, with a loading state

```tsx
import { Suspense } from 'react';
import { Canvas, Model, Environment, OrbitControls, useProgress } from '@margoengine/react';

function Loading() {
  const { progress } = useProgress();
  return <p>Loading {Math.round(progress)}%</p>;
}

export function Viewer() {
  return (
    <Suspense fallback={<Loading />}>
      <Canvas style={{ height: 480 }}>
        <Suspense fallback={null}>
          <Model src="/model.glb" onClick={(event) => console.log(event.object)} />
          <Environment src="/studio.hdr" background />
        </Suspense>
        <OrbitControls enableDamping />
      </Canvas>
    </Suspense>
  );
}
```

`Model` and `Environment` suspend while their file loads and abort the request if they unmount first.

## Play an animation

```tsx
import { useRef } from 'react';
import { Canvas, Model, Animation, type AnimationHandle } from '@margoengine/react';

export function Character() {
  const handle = useRef<AnimationHandle>(null);
  return (
    <Canvas>
      <Model src="/character.glb">
        <Animation
          ref={handle}
          clip="Walk"
          speed={1.25}
          blend={0.3}
          onReady={(animation) => console.log(animation.names)}
        />
      </Model>
    </Canvas>
  );
}
```

Change `clip` to crossfade over `blend` seconds. `loop={false}` plus `onFinished` runs code when a one-shot clip ends.

## Orbit, or navigate like a CAD tool

```tsx
import { Canvas, CadControls, Shadows, Box, Plane } from '@margoengine/react';

export function Cad() {
  return (
    <Canvas>
      <Shadows distance={60} />
      <Box castShadow position={[0, 0.5, 0]} />
      <Plane args={[20, 20]} />
      <CadControls profile="solidworks" />
    </Canvas>
  );
}
```

`profile` also takes `'autocad'`, `'inventor'`, `'fusion'`, `'blender'`, `'maya'`, `'onshape'` and `'rhino'`.

## Physics

```tsx
import { Canvas, Box } from '@margoengine/react';
import { Physics, RigidBody, CuboidCollider, BallCollider } from '@margoengine/react/physics';

export function Pile() {
  return (
    <Canvas>
      <Physics>
        <RigidBody type="fixed" colliders={false}>
          <CuboidCollider args={[10, 0.5, 10]} position={[0, -0.5, 0]} />
        </RigidBody>
        <RigidBody
          position={[0, 4, 0]}
          colliders={false}
          onContactStart={(event) => console.log('landed', event.type)}
        >
          <BallCollider args={[0.5]} />
          <Box />
        </RigidBody>
      </Physics>
    </Canvas>
  );
}
```

## Post-processing

```tsx
import { Canvas, Box, EffectComposer, Bloom, Tonemap } from '@margoengine/react';

export function Glow() {
  return (
    <Canvas>
      <Box color="#ff8844" />
      <EffectComposer>
        <Bloom strength={0.6} />
        <Tonemap curve="agx" exposure={0.5} />
      </EffectComposer>
    </Canvas>
  );
}
```

## Two views of one scene

```tsx
import { Canvas, RenderView, Box } from '@margoengine/react';

export function Split() {
  return (
    <Canvas>
      <Box />
      <RenderView viewport={[0, 0, 0.5, 1]} />
      <RenderView viewport={[0.5, 0, 0.5, 1]} />
    </Canvas>
  );
}
```

## Next.js

The page stays a server component; only the file that holds the `Canvas` needs `'use client'`.

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

```tsx
// app/page.tsx
import { Suspense } from 'react';
import { Scene } from './scene';

export default function Page() {
  return (
    <Suspense fallback={<p>Loading 3D scene...</p>}>
      <Scene />
    </Suspense>
  );
}
```

No `transpilePackages` is needed: the packages ship compiled ESM and the React entry is marked `'use client'`. The Pages
Router works the same way, and both routers build with webpack and Turbopack (see `examples/next`, and the bundler
matrix in `npm run modern:test:bundlers`). Physics comes from `@margoengine/react/physics`, so a page without it never
pulls in Rapier.
