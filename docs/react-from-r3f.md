# Coming from react-three-fiber

This maps the react-three-fiber (R3F) and drei names found in their public documentation to `@margoengine/react`. The
tree has the same shape (a `Canvas` with components and hooks inside), but there is no custom reconciler. Lowercase JSX
tags such as `<mesh>` are DOM elements in plain React; compile with `jsxImportSource: '@margoengine/react'` and they draw
Margo components inside a `Canvas` (`<mesh>`, `<group>`, `<boxGeometry>`, `<meshStandardMaterial>`, `<directionalLight>`
built in, more through `extend`; see "Lowercase tags and extend" in the package README). Without it, write `<Mesh>` (or
`import * as Margo` and write `<Margo.mesh>`). Geometry and material are child components, as in R3F.

## Names

| R3F or drei | Margo | Notes |
| --- | --- | --- |
| `<Canvas>` | `<Canvas>` | `frameloop="always" \| "demand"`, `shadows`, `camera`, `onCreated`, `onError`. |
| `<mesh>`, `<group>` | `<Mesh>`, `<Group>` | `position`, `rotation`, `scale`, `castShadow`, every pointer handler (`onClick`, `onPointerDown`, `onPointerOver`, ...), `ref`. |
| `<boxGeometry args>` | `<BoxGeometry args>` | `Box`, `Sphere` and `Plane` bundle geometry and material for the common case. |
| `<meshStandardMaterial>` | `<PbrMaterial>` | glTF metallic-roughness: `color`, `roughness`, `metalness`. |
| `<directionalLight>` | `<Sun direction color intensity>` | `direction` points towards the light. |
| `<ambientLight>` | `<AmbientLight color intensity>` | |
| `<hemisphereLight>` | `<HemisphereLight sky ground intensity>` | |
| `<fog>` / `<fogExp2>` | `<Fog color near far density>` | |
| `useFrame((state, delta) => ...)` | `useFrame((engine, delta) => ...)` | Same cleanup rules; runs on `invalidate()` in demand mode. |
| `useThree()` | `useEngine()`, `useCamera()`, `useMargo()` | `useMargo()` also has `invalidate`, `size`, `clock`, `canvas`. |
| `useLoader(Loader, url)` | `useLoader(load, url)` | `load` is `(url, { engine, signal, fetch }) => Promise`; suspends; shared per Canvas. |
| `useProgress()` | `useProgress()` | `{ active, loaded, total, progress, item, errors }`. |
| `useGLTF(url)` + `<primitive>` | `<Model src>` / `<Gltf src>` (`@margoengine/react/gltf-pro`) | Suspends, cached per Canvas, disposed on unmount. `Gltf.preload(src)` warms the cache (`useGLTF.preload`). |
| `useAnimations` | `<Animation clip>` inside `<Model>` | `ref` gives `names`, `time`, `seek`, `animation`, `animator`. |
| `<OrbitControls>`, `<MapControls>` | same names | Every public control field is a prop. `<CadControls profile>` adds CAD presets. |
| `<Environment files>` | `<Environment src>` | `background`, `rotation`, `blur`, `exposure`. |
| `<Html>` | `<Html>` | `anchor`, `distanceScale`, `sort`, `frustumCulling`. |
| `<Text>` | `<Text>` | SDF text from a browser font. |
| `<ContactShadows>` | `<ContactShadows>` | Needs `castShadow` casters. |
| `<View>` | `<RenderView>` | `View` is taken in Margo by the view cube's view direction. Use `<Scene name>` for a separate set of meshes. |
| `<EffectComposer>` (postprocessing) | `<EffectComposer>` | Effects are children: `Bloom`, `SSAO`, `GTAO`, `SSR`, `TAA`, `Tonemap`, ... |
| `<Physics>`, `<RigidBody>`, `<CuboidCollider>` (rapier) | same names from `@margoengine/react/physics` | Plus the other collider shapes, `onContactStart`, `useJoint`, `useBeforePhysicsStep`. |

## Differences that matter

- **Units and conventions.** Real-world units (metres) and glTF conventions: Y up, right-handed, metallic-roughness
  materials.
- **Events.** The same handler names (`onClick`, `onDoubleClick`, `onContextMenu`, `onPointerDown`, `onPointerUp`,
  `onPointerMove`, `onPointerOver`, `onPointerOut`, `onPointerEnter`, `onPointerLeave`, `onWheel`, `onPointerMissed`),
  and events bubble from the hit mesh through its parents until `event.stopPropagation()`. `event.object` and
  `event.target` are the mesh that was hit, `event.eventObject` the mesh whose handler runs. There is no separate
  raycaster: picking is a GPU read of the pixel, so only the nearest mesh is hit (no `event.intersections` list), and a
  handler runs a frame or two after the DOM event. A click is a pointer-up with at most three CSS pixels of movement.
- **Refs.** A mesh ref is a stable handle; it never points at a disposed mesh across Strict Mode or Suspense.
- **Optional features are subpaths.** Controls, shadows, post effects and loaders are optional packages: import their
  components from `@margoengine/react/<package>` (`/controls`, `/shadows`, `/post`, `/gltf-pro`, ...) and install that
  package; each loads when its component mounts, so an app only ships what it uses. `<Canvas shadows>` is
  `<Shadows />` from `@margoengine/react/shadows`.
- **`extend()` takes components.** `extend({ SphereGeometry })` (with Margo's JSX runtime) gives `<sphereGeometry>`, but
  the values are React components, not engine classes. For an engine plugin, write a component that calls
  `engine.use(plugin)` in an effect (`useEngine()`), and extend with that.

## A scene, side by side

R3F:

```jsx
<Canvas shadows camera={{ position: [0, 2, 5] }}>
  <ambientLight intensity={0.4} />
  <directionalLight position={[3, 5, 4]} intensity={3} castShadow />
  <mesh castShadow position={[0, 1, 0]}>
    <boxGeometry args={[1, 1, 1]} />
    <meshStandardMaterial color="#84d6bd" />
  </mesh>
  <OrbitControls />
</Canvas>
```

Margo:

```tsx
import { Canvas, Sun, Mesh, BoxGeometry, PbrMaterial } from '@margoengine/react';
import { OrbitControls } from '@margoengine/react/controls';
import { AmbientLight } from '@margoengine/react/environment';
import { Shadows } from '@margoengine/react/shadows';

export function Scene() {
  return (
    <Canvas camera={{ position: [0, 2, 5] }}>
      <Shadows />
      <AmbientLight intensity={0.4} />
      <Sun direction={[3, 5, 4]} intensity={3} />
      <Mesh castShadow position={[0, 1, 0]}>
        <BoxGeometry args={[1, 1, 1]} />
        <PbrMaterial color="#84d6bd" />
      </Mesh>
      <OrbitControls />
    </Canvas>
  );
}
```

Hooks that read the engine:

```tsx
import { useCamera, useEngine, useFrame, useMargo } from '@margoengine/react';

export function Probe() {
  const engine = useEngine();
  const camera = useCamera();
  const margo = useMargo();
  useFrame(() => {
    camera.position = [Math.sin(margo.clock) * 5, 2, Math.cos(margo.clock) * 5];
  });
  return <button onClick={() => margo.invalidate()}>{engine.backend}</button>;
}
```
