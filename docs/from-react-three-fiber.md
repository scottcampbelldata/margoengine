# Coming from React Three Fiber

This guide moves a React Three Fiber (R3F) app, and the helper libraries most R3F apps use (drei, the postprocessing
bindings, the Rapier bindings, the XR bindings), to `@margoengine/react`. The component tree keeps its shape: a
`Canvas`, scene components inside it, and hooks that read the engine. Every Margo name below is in the public API
reports (`api/react*.api.md`); where Margo has no equivalent, the table says so.

One file per common task, Margo code only, is in [`examples/from-react-three-fiber/`](../examples/from-react-three-fiber/).
They type-check against the built packages (`npm run check:examples-types -- --projects=from-react-three-fiber`).

| Task | Example |
| --- | --- |
| A spinning, clickable cube | [spinning-cube.tsx](../examples/from-react-three-fiber/spinning-cube.tsx) |
| Load a glTF model with a progress fallback | [gltf-model.tsx](../examples/from-react-three-fiber/gltf-model.tsx) |
| Orbit controls | [orbit-controls.tsx](../examples/from-react-three-fiber/orbit-controls.tsx) |
| An HDR environment and shadows | [environment-shadows.tsx](../examples/from-react-three-fiber/environment-shadows.tsx) |
| Bloom and antialiasing | [post-processing.tsx](../examples/from-react-three-fiber/post-processing.tsx) |
| A hundred instanced boxes | [instancing.tsx](../examples/from-react-three-fiber/instancing.tsx) |
| An HTML label that follows a mesh | [html-label.tsx](../examples/from-react-three-fiber/html-label.tsx) |
| A ball falling onto a floor | [physics.tsx](../examples/from-react-three-fiber/physics.tsx) |

## Concepts

### The canvas

R3F's canvas makes a renderer, a scene and a camera, sizes them to its parent and renders its children through a
custom reconciler. Margo's `Canvas` (also exported as `MargoCanvas`) makes one engine and its stage, sizes it to the
canvas element, and renders its children with plain React: there is no second reconciler, so React DevTools, context,
Suspense and error boundaries work as in any React tree.

- The camera is a prop: `camera={{ position, target, fov, near, far }}` (the core camera options; defaults are a
  60 degree field of view from `[0, 2, 5]` towards the origin). A separate camera component lives in
  `@margoengine/react/cameras` (`PerspectiveCamera`, `OrthographicCamera`).
- R3F's pixel-ratio range is `maxDpr` (the upper bound); `AdaptiveDpr` in `@margoengine/react/performance` moves the
  pixel ratio between its `min` and `max` with the measured performance.
- `onCreated` receives the stage, `onError` receives any start-up or load failure, `onPointerMissed` fires on a click
  that hits no mesh. `backend` (`'auto' | 'webgpu' | 'webgl2'`), `powerPreference` and `antialias` are engine options.
- There is no `shadows` flag and no renderer-settings prop: mount `<Shadows />` from `@margoengine/react/shadows` to
  turn shadows on, and pick tone mapping with `Tonemap` from `@margoengine/react/tonemap`.
- Without WebGPU, `Canvas` shows `fallbackContent`, or runs the same scene on WebGL2 when the optional
  `@margoengine/webgl2-compat` layer is installed (package README, "Browsers without WebGPU").

### The render loop

`useFrame(callback, priority?)` runs the callback once per rendered frame. The callback receives the engine and the
frame time in seconds, `(engine, delta)`, where R3F passes its state object and the delta. Read the camera, size or
clock from `useMargo()` outside the callback rather than from its first argument. `frameloop="always"` (the default)
renders continuously; `frameloop="demand"` renders only when `useMargo().invalidate()` is called, and each call runs
`useFrame` and the controls for exactly one frame. Margo has no manual-advance mode and no global before and after
effect hooks; order per-frame work with the `priority` argument.

As in R3F, move things in `useFrame` by writing a ref, never by setting React state once a frame
([React: state or the frame loop?](guides/react-state-vs-frame-loop.md)).

### Refs

A ref on `Mesh` (`MeshRef`) is the engine mesh itself, not a scene-graph object: `position`, `rotation` and `scale`
are live views with `x`, `y` and `z` fields, so `ref.current.rotation.y += delta` works as you expect. The handle
stays valid across Strict Mode double mounts and Suspense, and never points at a disposed mesh. Refs on other
components give their own handles: `OrbitControls` its controls, `Text` its text block, `Html` nothing (it is DOM).

### Events

`Mesh`, `Model`, the shapes and `Instance` take the same handler names as R3F: `onClick`, `onDoubleClick`,
`onContextMenu`, `onPointerDown`, `onPointerUp`, `onPointerMove`, `onPointerOver`, `onPointerOut`,
`onPointerEnter`, `onPointerLeave`, `onWheel` and `onPointerMissed`. Events bubble from the mesh that was hit
through its parents until `event.stopPropagation()`. `event.object` (also `mesh` and `target`) is the mesh that was
hit and `event.eventObject` (also `currentTarget`) the mesh whose handler runs; `x` and `y` are canvas-local CSS
pixels and `nativeEvent` is the DOM event.

The difference is how the hit is found. R3F casts a ray on the CPU against every object's geometry; Margo reads the
object id under the pointer from the GPU. So only the nearest mesh is reported (there is no list of every
intersection, no hit point or face, and no `raycaster` or `events` prop to replace), large scenes cost nothing
extra to pick, and the handler runs a frame or two after the DOM event. A click is a pointer-up with at most three
CSS pixels of movement, so an orbit drag never clicks.

### Suspense and loading

R3F's loader hook suspends the component until the file is loaded. In Margo the components that load files suspend
themselves: `Model` (`@margoengine/react/gltf`), `Fbx` (`@margoengine/react/fbx`), `Environment` with `src`, and the
texture hooks. Wrap them in `<Suspense fallback>`; the fallback may be DOM, since the tree is plain React. Loads are
cached per Canvas by URL, shared by every component that asks for the same file, aborted when the last user unmounts
before the load finishes, and disposed with the Canvas. `Model.preload(src)` and `Environment.preload(src)` warm the
cache.

For any other file, `useLoader(load, url)` takes a function `(url, { engine, signal, fetch }) => Promise<T>` instead
of a loader class; it suspends and caches the same way, and `clearLoader(load, url?)` drops a cached result.
`useProgress()` returns `{ active, loaded, total, progress, item, errors }` with `progress` from 0 to 100; it needs
the optional `@margoengine/cache` package and otherwise stays idle.

### Optional features are entries

Controls, shadows, post effects, loaders, physics and XR are separate entries of `@margoengine/react`
(`/controls`, `/shadows`, `/post`, `/gltf`, `/physics`, `/xr` and so on) backed by optional engine packages. Install
the package behind an entry you use; an app ships only what it imports, and each entry loads its package when its
component first mounts.

## Names

`R3F` is React Three Fiber itself; the other rows name the helper library the component usually comes from. An entry
path such as `/controls` means `@margoengine/react/controls`; no path means the root `@margoengine/react`.

### Core

| R3F and friends | Margo | Notes |
| --- | --- | --- |
| `Canvas` (R3F) | `Canvas` / `MargoCanvas` | See "The canvas". |
| lowercase `mesh`, `group` (R3F) | `Mesh`, `Group` | `position`, `rotation` (Euler radians), `scale`, `castShadow`, `receiveShadow`, `layers`, the event handlers and `ref`. Lowercase tags: see "Pitfalls". |
| `boxGeometry` and the other geometry tags (R3F) | `BoxGeometry` (root); `SphereGeometry`, `PlaneGeometry`, `CylinderGeometry`, `TorusGeometry` and the rest in `/geometry` | Children of a `Mesh`, with `args` as there. |
| `meshStandardMaterial` (R3F) | `PbrMaterial` | `color`, `roughness`, `metalness`. With a map or `emissive`, use `MappedPbrMaterial` (`/textures`) or wrap the meshes in `TextureProvider`. |
| `meshPhysicalMaterial` transmission (R3F) | `MeshTransmissionMaterial` (`/materials`) | |
| `meshBasicMaterial`, `meshLambertMaterial`, `meshPhongMaterial`, `meshToonMaterial`, `meshNormalMaterial`, `meshMatcapMaterial`, `meshDepthMaterial` (R3F) | `UnlitMaterial`, `LambertMaterial`, `PhongMaterial`, `ToonMaterial`, `NormalMaterial`, `MatcapMaterial`, `DepthMaterial` (`/textures`) | The shading models of `@margoengine/materials`; the mesh needs UV geometry. `shaderMaterial`: pass a `WgslMaterial` (`@margoengine/materials`) to `TextureMaterial` (`/textures`) as `material`. |
| `directionalLight` (R3F) | `Sun` | `direction` points towards the light; one sun per scene. |
| `ambientLight`, `hemisphereLight` (R3F) | `AmbientLight`, `HemisphereLight` (`/environment`) | `HemisphereLight` takes `sky` and `ground` colours. |
| `pointLight`, `spotLight`, `rectAreaLight` (R3F) | `PointLight`, `SpotLight`, `RectAreaLight` (`/clustered`) | The clustered lights of `@margoengine/clustered`, WebGPU only. `SpotLight` takes `direction` instead of a target; `RectAreaLight` takes `direction` and `up` instead of a rotation. |
| `fog` (R3F) | `Fog` (`/environment`) | |
| `primitive object={...}` (R3F) | `MeshNode node={mesh}` | Mounts an engine mesh made outside React (`engine.createMesh()`, a model's node); its children attach under it. The caller keeps owning it unless `dispose` is passed. `GeometryResource` mounts a core `Geometry`. |
| `extend` (R3F) | `extend` | Takes React components, not engine classes. |
| `createPortal` (R3F) | `ScenePortal` (`/portals`) | `scene` is a `<Scene name>` or a core scene, `node` an existing mesh to attach under. For a drawn overlay or texture use `Hud` or `RenderTexture`. |
| `View` (drei) | `RenderView` | `View` is not a Margo component. |
| `useFrame` (R3F) | `useFrame` | `(engine, delta)`, optional priority. |
| `useThree` (R3F) | `useMargo`, `useEngine`, `useCamera` | `useMargo()` gives `stage`, `gl` (the engine), `camera`, `canvas`, `size`, `clock`, `ready`, `invalidate`. |
| `useThree` viewport (R3F) | `useViewport`, `useAspect` (`/helpers`) | |
| `useLoader` (R3F) | `useLoader`, `clearLoader` | A load function instead of a loader class. |
| `useGraph` (R3F) | `useModelParts` (`/gltf`) | Inside `<Model>` children, or given a loaded `PBRModel`: `{ nodes, materials }` by name, typed with `useModelParts<'Wheel', 'Paint'>()`. |
| `invalidate` (R3F) | `useMargo().invalidate()` | With `frameloop="demand"`. |
| `advance`, `addEffect`, `addAfterEffect` (R3F) | No equivalent | Use `useFrame` priorities. |

### Loading and assets

| R3F and friends | Margo | Notes |
| --- | --- | --- |
| `useGLTF` + `primitive` (drei) | `Model` or `Gltf` (`/gltf`) | `src`, transform, `materials` overrides, `castShadow`, `receiveShadow`, `onLoad`. |
| `useGLTF.preload` (drei) | `Model.preload` / `Gltf.preload` | |
| `useFBX` (drei) | `Fbx` (`/fbx`) | |
| `useAnimations` (drei) | `Animation` (`/animation`) inside `Model` | `clip`, `playing`, `loop`, `blend`, `speed`. |
| `useTexture`, `useKTX2`, `useVideoTexture` (drei) | same names (`/textures`) | |
| `useProgress` (drei) | `useProgress` | `progress` is 0 to 100. |
| `Loader` overlay (drei) | No equivalent | Build it from `useProgress`. |
| `Preload` (drei) | `Preload` (`/helpers`) | |
| `Clone` (drei) | `Clone` (`/helpers`) | |
| `Splat` (drei) | `Splat` (`/splats`) | |
| `Svg` (drei) | `Svg` (`/geometry`) | |

### Controls

| R3F and friends | Margo | Notes |
| --- | --- | --- |
| `OrbitControls`, `MapControls`, `TrackballControls`, `ArcballControls`, `FlyControls`, `FirstPersonControls`, `CameraControls` (drei) | same names (`/controls`) | `OrbitControls` takes `target`, `enableDamping`, `dampingFactor`, the enable and speed props, distance and angle limits, `autoRotate`, and `profile` for CAD and DCC mouse presets; `CadControls` takes the same props. |
| `PointerLockControls` (drei) | `PointerLock` (`/controls`) | |
| `TransformControls`, `PivotControls`, `DragControls` (drei) | same names (`/controls`) | |
| `KeyboardControls`, `useKeyboardControls` (drei) | same names (`/controls-extra`) | |
| `ScrollControls`, `Scroll`, `useScroll` (drei) | same names (`/controls-extra`) | |
| `PresentationControls` (drei) | `PresentationControls` (`/controls-extra`) | |
| `MotionPathControls` (drei) | `MotionPathControls` (`/controls-extra`) | |
| `GizmoHelper` (drei) | `GizmoHelper` (`/viewcube`) | |

### Environment, light and shadows

| R3F and friends | Margo | Notes |
| --- | --- | --- |
| `Environment` (drei) | `Environment` (`/environment`) | `src` (HDR or EXR), `exposure`, `background`, `rotation`, `blur`; without `src` it sets neutral studio light; children render into the map. |
| `Lightformer`, `CubeCamera` (drei) | same names (`/environment`) | |
| `Sky` (drei) | `Sky` (`/sky`) | |
| `Stars`, `Sparkles`, `Trail` (drei) | same names (`/effects-extra`) | |
| `Cloud`, `Clouds` (drei) | same names (`/clouds`) | |
| canvas shadows flag (R3F) | `Shadows` (`/shadows`) | Mounting it turns shadows on; `castShadow` and `receiveShadow` stay per mesh. |
| `ContactShadows`, `SoftShadows`, `BakeShadows` (drei) | same names (`/shadows`) | |
| `AccumulativeShadows`, `RandomizedLight` (drei) | same names (`/accumulative-shadows`) | |
| `Caustics` (drei) | `Caustics` (`/caustics`) | |
| `MeshReflectorMaterial` (drei) | `MeshReflectorMaterial` (`/materials`) | |
| `MeshWobbleMaterial`, `MeshDistortMaterial` (drei) | No equivalent | |

### Text, HTML and UI

| R3F and friends | Margo | Notes |
| --- | --- | --- |
| `Text` (drei) | `Text` (`/text`) | SDF text; the string is `text` or the children. |
| `Text3D` (drei) | `Text3D` (`/text`) | Extruded text from a font. |
| `Html` (drei) | `Html` (`/html`) | `position` (a local offset inside a `Mesh`), `anchor`, `distanceScale`, `occlude`, `sort`, `frustumCulling`, `pointerEvents`. |
| `Billboard` (drei) | `Billboard` (`/helpers`) | |
| `PositionalAudio` (drei) | `Sound` (`/ui`) inside a `Mesh` | |
| `Stats` (drei) | `Stats` (`/devtools`) | |

### Layout and helpers

| R3F and friends | Margo | Notes |
| --- | --- | --- |
| `Center` (drei) | `Center` | `disableX`, `disableY`, `disableZ`. |
| `Bounds`, `useBounds` (drei) | same names (`/helpers`) | |
| `Float`, `CameraShake` (drei) | same names (`/helpers`) | |
| `useCursor`, `useIntersect` (drei) | same names (`/helpers`) | |
| `Stage` (drei, the presentation helper) | No equivalent | Margo's `Stage` is a different thing: it sets the canvas camera for its children. Combine `Environment`, `ContactShadows` and `Center` instead. |
| `Backdrop` (drei) | `Backdrop` (`/geometry`) | |
| `Box`, `Sphere`, `Plane`, `RoundedBox` and the other shapes (drei) | same names (`/geometry`) | A mesh with its geometry and a default material in one tag. |
| `Line`, `Segments`, `Grid` (drei) | `Line`, `Segments`, `Segment`, `Grid` (`/lines`) | |
| `Points` (drei) | `Points` (`/points`) | |
| `Edges`, `Decal`, `Wireframe` (drei) | same names (`/effects-extra`) | |
| `Outlines` (drei) | `Outlines` (`/outlines`) | |
| `Mask`, `useMask` (drei) | same names (`/materials`) | |
| `Detailed` (drei) | `Detailed` (`/lod`) | |
| `useFBO`, `useDepthBuffer`, `RenderTexture`, `Hud` (drei) | same names (`/portals`) | |
| `Sampler`, `useSurfaceSampler` (drei) | same names (`/sampler`) | |
| `PerformanceMonitor`, `AdaptiveDpr`, `AdaptiveEvents` (drei) | same names (`/performance`) | |
| `MarchingCubes` (drei) | `MarchingCubes` (`/marching-cubes`) | |
| `useHelper` (drei) | No equivalent | |

### Instances

| R3F and friends | Margo | Notes |
| --- | --- | --- |
| `instancedMesh` (R3F) | `Instances` (`/instances`) | Or the core instancing API through `useEngine()`. |
| `Instances`, `Instance` (drei) | same names (`/instances`) | One shared geometry and material as children; each `Instance` keeps its own transform, `color`, `visible`, ref and handlers. |
| `Merged` (drei) | `Merged` (`/instances`) | |
| batched mesh (R3F) | `BatchedMesh`, `BatchedItem` (`/materials`) | |

### Post-processing

| postprocessing bindings | Margo | Notes |
| --- | --- | --- |
| `EffectComposer` | `EffectComposer` (`/post`) | Effects are its children. WebGPU only. |
| `Bloom`, `SSAO`, `SMAA`, `FXAA`, `Glitch`, `LensFlare` | same names (`/post`) | Margo's own options (for `Bloom`: `strength`, `threshold`, `radius`, `exposure`). |
| `N8AO` | `GTAO` (`/post`) | Ground-truth ambient occlusion. |
| `SSR`, motion blur, afterimage | `SSR`, `MotionBlur`, `Afterimage`, `SSGI` (`/post`) | |
| `DepthOfField` | `DepthOfField` (`/dof`) | |
| `ToneMapping` | `Tonemap` (`/tonemap`) | |
| temporal antialiasing | `TAA` (`/taa`) | |
| `Selection`, `Select`, `Outline` | `Outline` (`/selection`) | The selected meshes are a `selection` prop (meshes or refs), not wrapper components. |
| `Vignette`, `Noise`, `ChromaticAberration`, `DotScreen`, `Pixelation` | `Vignette`, `FilmGrain`, `ChromaticAberration`, `DotScreen`, `Pixelate` (`/post`) | `Vignette`, `FilmGrain` and `ChromaticAberration` set options of the composer's `Tonemap` (`amount`, and for `Vignette` `radius`, `softness`, `color`), so keep a `Tonemap` in the same `EffectComposer`. `DotScreen` and `Pixelate` are stages after it. |

### Physics

| Rapier bindings | Margo | Notes |
| --- | --- | --- |
| `Physics` | `Physics` (`/physics`) | `gravity`, `fixedTimestep`, `paused`, `timeScale`, `interpolate`. Runs Margo's own physics kernel. |
| `RigidBody` | `RigidBody` (`/physics`) | `type`, the velocity, damping and lock props, `ccd`, `colliders` (`'cuboid'`, `'hull'`, `'trimesh'` or `false`), `onContactStart`, `onContactEnd`, `onIntersectionStart`, `onIntersectionEnd`. |
| `CuboidCollider`, `BallCollider`, `CapsuleCollider`, `CylinderCollider`, `ConeCollider`, `ConvexHullCollider`, `TrimeshCollider`, `HeightfieldCollider` | same names (`/physics`) | `args` as there; `friction`, `restitution`, `density`, `sensor`, `collisionGroups`, `solverGroups`. |
| `MeshCollider` | the `colliders` prop of `RigidBody` | |
| `useRapier` | `usePhysics` | |
| `useBeforePhysicsStep`, `useAfterPhysicsStep` | same names (`/physics`) | |
| the joint hooks (fixed, spherical, revolute, prismatic, rope, spring) | `useJoint(bodyA, bodyB, options)` (`/physics`) | One hook; `options.type` is `'fixed'`, `'spherical'`, `'revolute'`, `'prismatic'`, `'rope'`, `'spring'`, `'pinSlot'`, `'cone'` or `'generic'`. |
| `InstancedRigidBodies` | `RigidBodyInstances` (`/physics`) | `instances` lists each body's pose, tint and overrides; the children are the shared geometry and material, drawn as one instanced mesh. `onReady(body, index)`. |
| `debug` view | No equivalent | |

### XR

| XR bindings | Margo | Notes |
| --- | --- | --- |
| `XR` with a store | `XR` (`/xr`) | `mode`, `options`, `onSessionStart`, `onSessionEnd`, `onFrame`. |
| entering a session from a button | `useXR().enter(mode?, options?)` | And `exit()`, `session`, `ready`. |
| controllers | `Controller` (`/xr`) | `handedness`, `pose`, `onSelect`, `onSqueeze` and their start and end events. |
| pointer events on meshes in XR | `XRPointerEvents` (`/xr-pointer`) | |
| `XROrigin` | `TrackingOrigin` (`/xr`) | The node the camera and controllers are posed from; moving it moves the player. Scale is ignored, and a move applies from the next XR frame. |
| hand models, teleport helpers | No equivalent | |

## Units and handedness

Margo uses the glTF conventions R3F apps already follow: right-handed coordinates, Y up, the camera looking down
negative Z, real-world units of one metre, rotations in Euler radians, and metallic-roughness materials. Models and
scenes move over without rescaling or flipping. Light intensities are Margo's own: start from the defaults (`Sun`
intensity 3) rather than copying numbers across.

## Pitfalls

- **Lowercase tags.** In plain React `<mesh>` is a DOM element. Write `<Mesh>`, or `import * as Margo` and write
  `<Margo.mesh>`, or compile with `jsxImportSource: '@margoengine/react'`, which turns `mesh`, `group`, `boxGeometry`,
  `meshStandardMaterial` and `directionalLight` into Margo components inside a `Canvas` (more through `extend`).
- **Shadows need a component.** Setting `castShadow` draws nothing until `<Shadows />` is mounted.
- **`directionalLight` position is not `Sun` direction.** `direction` is the vector towards the light; there is no
  target to move.
- **Mapped materials.** `PbrMaterial` with `map`, any other texture map, `emissive` or `envMap` throws a coded error
  unless it is inside `TextureProvider`; use `MappedPbrMaterial` from `/textures`, which brings the texture code.
- **`useFrame`'s first argument is the engine.** Read size, camera and clock from `useMargo()`.
- **Only the nearest mesh is picked**, a frame or two after the DOM event. Code that walks the intersection list
  needs a different design, for example handlers on the parent and `event.object` to tell the child.
- **`Stage` means something else.** Margo's `Stage` sets the canvas camera for its children; the presentation helper of
  the same name has no Margo twin.
- **WebGPU first.** PBR models, HDR image light, shadows and `EffectComposer` need WebGPU; on WebGL2 the compatibility
  layer covers the rest.
- **One `Environment` per canvas.**

## Hooks that read the engine

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
