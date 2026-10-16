# Optional React scene layer

The existing `@margoengine/react` entry stays compatible. Add only the subpaths
and optional peers used by your scene. Every native package is imported lazily;
importing these components or rendering a Canvas on the server creates no GPU,
physics world, pointer lock or XR session. `sideEffects` remains `false`.

| Entry | Components and hooks | Optional peers |
| --- | --- | --- |
| `@margoengine/react/kit` | `Gltf`, `Fbx`, `preload`, `Environment`, `Sky`, `ContactShadows`, `Center`, `OrbitControls`, `PointerLock`, `TransformControls`, `Html`, `Text`, `Box`, `Sphere`, `Plane` | Install the corresponding `@margoengine/gltf-pro`, `fbx`, `environment`, `sky`, `shadows`, `controls`, `gizmo`, `html`, `text` or `geometry` package. `Html` also uses `react-dom`. |
| `@margoengine/react/post` | `EffectComposer`, `Bloom`, `SSAO`, `DepthOfField`, `Tonemap`, `TAA` | `@margoengine/post`, `dof`, `tonemap`, `taa`, according to the effects used |
| `@margoengine/react/physics` | `Physics`, `RigidBody`, `CuboidCollider`, `BallCollider`, `usePhysics` | `@margoengine/physics`, `@dimforge/rapier3d-compat` |
| `@margoengine/react/xr` | `XR`, `Controller`, `useXR` | `@margoengine/xr` |

These are Margo components and native plugins. There is no Three.js or
`react-reconciler` dependency. The core and stage source and size ceiling remain
unchanged. PascalCase names and namespace members invoke React components;
bare lowercase JSX still denotes DOM elements.

## Scene helpers

```tsx
import {Suspense} from 'react';
import {Canvas, PbrMaterial} from '@margoengine/react';
import {Box, Center, ContactShadows, Fbx, Html, OrbitControls, Text} from '@margoengine/react/kit';

export function Scene() {
  return <Canvas backend="webgpu" style={{height:400}}>
    <Box args={[1,1,1]} position={[0,1,0]} castShadow onClick={()=>{}}>
      <PbrMaterial color="#84d6bd"/>
      <Html position={[0,1,0]}>A clickable cube</Html>
    </Box>
    <ContactShadows width={10} height={10}/>
    <Suspense fallback={<span>Loading character…</span>}>
      <Center position={[2,0,0]}><Fbx src="/character.fbx"/></Center>
    </Suspense>
    <Text position={[0,2,0]} fontSize={0.3}>Margo</Text>
    <OrbitControls enableDamping/>
  </Canvas>;
}
```

`Gltf` is the existing `Model` component. `Fbx` uses the native FBX loader and the
same transform, material, shadow, event, `onLoad`, `onError`, abort and Suspense
contract. Both cache decoded CPU sources per Canvas and create independently
owned model instances. `preload(src)` selects FBX from `.fbx`, environment images
from `.hdr`/`.exr`, and glTF otherwise; an explicit second argument can be
`'fbx'`, `'environment'` or `'model'`. Before Canvas is ready it queues until an
engine exists. Mount Canvas before awaiting such a preload.

Model events use the active engine picking plugin and its source registration.
The wrappers do not add another raycaster or synthesize deformation hits.

`Box`, `Sphere` and `Plane` accept Mesh props, a native geometry argument tuple
in `args`, `castShadow`, and a mesh ref. They use `@margoengine/geometry`.
`ContactShadows` requests the shared directional shadow map and renders a
transparent ground showing only its occlusion. Its props are Mesh transforms,
`width`, `height`, `opacity` and linear RGB `color`; add casters explicitly with
`castShadow`. It is a shadow receiver, rather than a separate baked AO renderer.

`Center` offsets its children to their world-bounds center while retaining its
outer declared transform. `disableX`, `disableY` and `disableZ` preserve selected
axes. It follows geometry and loaded-model bounds on engine frames. The frozen
stage does not export its private `worldBounds` helper, so this package applies
the same vertex/world-matrix calculation locally.

`Sky` forwards native `SkyOptions` and exposes the plugin through a ref.
`PointerLock` forwards pointer/movement speeds and polar bounds, and requests
lock from a canvas click. Set `lockOnClick={false}` and call its ref's `lock()`
from your own user gesture. `TransformControls` wraps children in a group or
targets an explicit `object` mesh/ref; it supports native modes, spaces, snaps,
axis visibility and control-event callbacks. Both release listeners on unmount.

`Text` accepts native `TextOptions`, string/number children or `text`, and a
native text ref. Text blocks share one renderer per Canvas and track their
parent mesh. `Html`, `Environment` and `OrbitControls` retain their existing
[base-package contracts](README.md).

## Post effects

```tsx
import {EffectComposer, DepthOfField, Tonemap, TAA} from '@margoengine/react/post';

<EffectComposer onError={console.error}>
  <DepthOfField focalDistance={5} aperture={2.8}/>
  <Tonemap curve="agx" exposure={0.5}/>
  <TAA historyWeight={0.9}/>
</EffectComposer>;
```

Effects require WebGPU and forward their native options. `onReady` receives the
native effect. `EffectComposer enabled={false}` disposes its effects and can be
re-enabled. Mutable options update the existing effect; changing Tonemap's fixed
source reattaches that effect. `Tonemap` also accepts a native/string `lut`.
SSAO and TAA register current and subsequently loaded models. DOF's HDR output
automatically feeds Tonemap, and the selected capture effect's depth feeds TAA.

The existing native effects impose capture limits: **Bloom, SSAO and
DepthOfField are mutually exclusive**. Bloom already tone maps and cannot be
combined with Tonemap. SSAO plus Tonemap requires an explicit HDR `source`.
The three-effect Bloom/SSAO/DepthOfField example in the scene plan therefore
cannot run with the current native APIs; the composer reports this before
attaching effects. It does not bypass native ownership checks or claim that
conflicting effects compose. TAA can accompany one capture effect, and
DepthOfField + Tonemap is supported as shown above.

## Physics

```tsx
import {Canvas, BoxGeometry, Mesh} from '@margoengine/react';
import {Physics, RigidBody} from '@margoengine/react/physics';

<Canvas>
  <Physics gravity={[0,-9.81,0]}>
    <RigidBody position={[0,3,0]}>
      <Mesh><BoxGeometry/></Mesh>
    </RigidBody>
  </Physics>
</Canvas>;
```

`Physics` initializes Rapier lazily, or accepts an initialized module/promise in
`rapier`. It forwards native world options, steps through the engine in always
and demand modes, and exposes the world through `onReady` and `usePhysics()`
(`null` during initialization). Gravity, paused state and time scale update in
place. Unmount disposes the world and removes its plugin.

`RigidBody` drives a transform group, preserving child-local transforms and
transformed parents. Its default and `colliders="cuboid"` fit a box to descendant
geometry or loaded-model bounds, including models whose CPU position arrays are
unavailable. `colliders="hull"` uses retained positions when available and bounds
corners otherwise. The wrappers never read vertex buffers back from the GPU.
`colliders="trimesh"` requires retained CPU positions and indices; unavailable
geometry produces this deliberate diagnostic:

> RigidBody: automatic trimesh collider generation requires retained CPU geometry. Provide an explicit &lt;CuboidCollider&gt; or configure loader geometry retention.

You can also pass native collider options/arrays, `colliders={false}`, or child
collider components. `CuboidCollider` uses half-extents in `args`, and
`BallCollider` uses a radius. Collider children suppress automatic fitting while
present. An explicit collider can exist before a visual
asset finishes loading:

```tsx
import {Fbx} from '@margoengine/react/kit';
import {RigidBody, CuboidCollider} from '@margoengine/react/physics';

<RigidBody colliders={false} position={[0,2,0]}>
  <CuboidCollider args={[0.5,1,0.5]}/>
  <Fbx src="/character.fbx"/>
</RigidBody>;
```

Body construction options and changed position/rotation/scale recreate the body
at the requested pose; `onReady` exposes native body APIs for live impulses and
other operations. Removing a body releases its colliders without disposing its
siblings. Removing a collider child releases only that collider.
Changing a collider child's position, rotation, scale or shape options replaces
its collider while keeping the body alive.

## XR

```tsx
import {Html} from '@margoengine/react/kit';
import {XR, Controller, useXR} from '@margoengine/react/xr';

function EnterXR() {
  const xr=useXR();
  return <Html><button disabled={!xr.ready} onClick={()=>void xr.enter()}>
    Enter VR
  </button></Html>;
}

<XR mode="immersive-vr">
  <EnterXR/>
  <Controller handedness="left" onSelect={()=>{}}/>
  <Controller handedness="right"/>
</XR>;
```

`XR` prepares the optional native manager. It requests no session on mount.
`useXR()` exposes `manager`, `ready`, `session`, `enter(mode?, options?)`, and
`exit()`. Call `enter()` directly from a user gesture after `ready`; native
WebXR/WebGPU capability checks remain in force. `onSessionStart`,
`onSessionEnd`, `onFrame` and `onError` observe its lifecycle.

`Controller` tracks an input by handedness/index and follows its grip pose
(falling back to the target ray), or `pose="targetRay"`. Children inherit the
controller transform. It forwards connection, frame, select and squeeze events,
and hides when no pose exists. Immersive frames advance React `useFrame` and
clock; inline XR keeps the desktop frame loop. Session exit restores Canvas
demand mode. Unmount detaches events and disposes the manager/session.

## Verification

Run `npm run build:packages`, `npm run modern:test:react`, `npm run typecheck`,
`npm run test:modules:packages`, and `npm run measure:size` from the workspace.
`npm run test:browser --workspace @margoengine/react` exercises the scene
components with real WebGPU and Rapier. Unit tests cover StrictMode, Suspense,
optional imports, source ownership, parent transforms, post limits and mocked
XR sessions. Packaging tests exercise strict public subpath consumers and prove
the base bundle's static dependency graph excludes optional scene subpaths.
