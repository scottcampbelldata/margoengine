# React, Next.js and react-three-fiber options in Margo: full write-up

Sources: `packages/react/README.md`, `packages/react/SCENE.md`, `packages/react/package.json`,
`docs/react-from-r3f.md`, `docs/react-cookbook.md`, `docs/limits.md` (React page), `examples/next`,
`examples/react-viewer`. Numbers are the ones those files quote; re-run `npm run measure:size` and
`npm run modern:test:bundlers` before using them publicly.

## 1. What it is

`@margoengine/react` (v1.0.0, Apache-2.0, not on npm yet) is the React binding for Margo. It is a react-three-fiber
(R3F) style API with one big difference: there is no custom reconciler and no `react-reconciler` dependency.
`<Canvas>` creates one engine, and its children are ordinary React components that edit it through hooks and effects.

- React 18 and 19.
- Import from `margoengine/react` (one install; models from `margoengine/react/gltf-pro`), or install `@margoengine/react` alone plus the packages
  its subpaths name.
- `sideEffects: false`, ESM, full types, `react-server` export condition on every entry.

## 2. Install routes

| Route | Status |
| --- | --- |
| `npm i margoengine react react-dom` | After 1.0.0 is published. |
| Local tarballs (`npm run pack:packages`, then install `test-results/*.tgz` into your app) | Works today. |
| `examples/react-viewer` (`npm run dev --workspace @margoengine/react-viewer`) | Works today, Vite. |
| `examples/next` | Works today, Next.js 16.4.3 with React 19.3.0: `npm run build` builds it with Turbopack (Next 16's default), `npm run build:webpack` with webpack, and `npm run modern:test:browser` checks the Turbopack build in a browser on a real GPU. |

## 3. Entries (pay only for what you import)

The root holds only bindings that need no optional package. Every optional feature is a subpath named after its
package, installed separately, and loaded when its component mounts.

| Entry | Gives you | Needs |
| --- | --- | --- |
| `@margoengine/react` | `Canvas`, `Stage`, `Mesh`, `Group`, `BoxGeometry`, `PbrMaterial`, `Sun`, `Center`, `Scene`, `RenderView`, `useFrame`, `useMargo`, `useEngine`, `useCamera`, `useLoader`, `useProgress` | nothing more |
| `/controls` | `OrbitControls`, `MapControls`, `CadControls`, `ArcballControls`, `PointerLock`, `TransformControls` | `@margoengine/controls` |
| `/gltf-pro` | `Gltf` (`Model`), `Gltf.preload` | `@margoengine/gltf-pro` |
| `/fbx` | `Fbx`, `Fbx.preload` | `fbx`, `gltf-pro` |
| `/animation` | `Animation` clip inside a `Model` | `animation`, `animator` |
| `/environment` | `Environment`, `AmbientLight`, `HemisphereLight`, `Fog` | `environment` |
| `/shadows` | `Shadows`, `ContactShadows` | `shadows` |
| `/html` | `Html` DOM labels projected into the scene | `html` |
| `/text` | `Text` (SDF text) | `text` |
| `/sky` | `Sky` | `sky` |
| `/geometry` | `Box`, `Sphere`, `Plane` (with `map`: a PNG or JPEG texture), `SphereGeometry`, `PlaneGeometry` | `geometry` (+ `gltf` for `map`) |
| `/ui` | `GameUi`, `Sound`, `SpriteLayer`, `Sprite`, `Figure`, `ScatterPlot`, `LinePlot`, `SurfacePlot` | `ui`, `audio`, `sprites`, `sciviz` (each only if used) |
| `/materials` | `MeshTransmissionMaterial`, `BatchedMesh`, `BatchedItem` | `materials` |
| `/post`, `/dof`, `/tonemap`, `/taa` | `EffectComposer` with `Bloom`, `SSAO`, `GTAO`, `SSR`, `SSGI`, `MotionBlur`, `LensFlare`, `SMAA`, `FXAA`, `Glitch`, `Afterimage`, `DepthTexture`, `SceneTargets`, `DepthOfField`, `Tonemap`, `TAA` | `post` (+ the effect package) |
| `/voxel` | `Voxels`, `useBlockTextures` | `voxel` |
| `/physics` | `Physics`, `RigidBody`, eight collider components, `useJoint`, `usePhysics`, `useBeforePhysicsStep`, `useAfterPhysicsStep` | `physics`, Rapier |
| `/xr` | `XR`, `Controller`, `useXR` | `xr` |

Nothing in the root reaches an optional package, even through a lazy `import()`; `tests/optional-peer-reach.test.js`
enforces it.

## 4. Component and hook options

**Canvas props:** `frameloop="always" | "demand"`, `camera`, `backend` (`webgpu`, `webgl2`, auto), `capacity`, `style`,
`label` (accessible name), `onCreated(stage)`, `onError`, `loadFallback`, `fallbackContent`, `fallback`.
`frameloop="demand"` renders one frame per `invalidate()` and moves `useFrame` and controls with it.
`MargoCanvas` and `Canvas` are the same component.

**Scene primitives:** `Mesh` with `BoxGeometry` and `PbrMaterial` children (explicit form), or `Box`, `Sphere`, `Plane`
(one element, colour only, takes `args`, `color`, `roughness`, `metalness`). Lowercase aliases exist for namespace use
(`<Margo.mesh>`, `<Margo.group>`, `<Margo.boxGeometry>`, `<Margo.meshStandardMaterial>`) because a bare `<mesh>` is a DOM
element in React.

**Events:** `onClick`, `onDoubleClick`, `onContextMenu`, `onPointerDown`, `onPointerUp`, `onPointerMove`,
`onPointerOver`, `onPointerOut`, `onPointerEnter`, `onPointerLeave`, `onWheel` and `onPointerMissed` on `Mesh`, `Model`,
`Box`, `Sphere`, `Plane`, `RigidBody`, `TransformControls` and the XR `Controller`; `onPointerMissed` on the Canvas.
These come from GPU picking, not a raycaster: asynchronous (a frame or two), nearest mesh wins, then the event bubbles
through its parents until `stopPropagation()`; a click is at most 3 CSS px of movement, primary button only; WebGPU,
or the WebGL2 preview with `webglPicking`. Handlers get `type`, `nativeEvent`, `object`/`mesh`/`target`,
`currentTarget`/`eventObject`, `x`, `y`, `clientX`, `clientY`, `delta`, `stopPropagation()` and pointer capture.

**Models and assets:** `Model`/`Gltf` with `materials` overrides (`baseColor`, `roughness`, `metalness`, `emissive`,
`normalScale`, `occlusionStrength`, `alphaCutoff`, `doubleSided`), `castShadow`, `receiveShadow`, `onLoad`, `onError`.
Suspense-aware, cached per Canvas, aborted when the last consumer unmounts, disposed on unmount, with `.preload(src)`.
`useLoader(loader, url)` suspends and shares one load per loader and URL. `useProgress()` drives a loading bar (needs
`@margoengine/cache`).

**Lighting and environment:** `Sun`, `AmbientLight`, `HemisphereLight`, `Fog`, `Environment` (HDR/EXR IBL, `exposure`,
`background`, `rotation`, `blur`), `Shadows` (resolution, distance, lambda, lightSize, bias, normalBias, casterMargin,
filter, bounds/frustum), `ContactShadows`. IBL, PBR models and shadows need WebGPU.

**Hooks:** `useFrame((engine, delta) => ...)` (no React render), `useEngine`, `useCamera`, `useMargo`
(`stage, ready, canvas, camera, size, gl, clock, invalidate`), `useMargoStage` (the portable `EngineKernel` for
imperative code), `useLoader`, `useProgress`, `usePhysics`, `useXR`.

**Controls:** every public field of the controls is a prop; a removed prop restores the default. `CadControls` and
`OrbitControls` take `profile` (`margo`, `solidworks`, `autocad`, `inventor`, `fusion`, `blender`, `maya`, `onshape`,
`rhino`) and `keyEvents`.

**Multi-view:** `RenderView` (viewport, scissor, clear, layers, target, order, camera, scene) and `Scene name` for split
screen, minimaps, HUDs and render-to-texture. Works on WebGPU and WebGL2.

**Batching and voxels:** `BatchedMesh`/`BatchedItem` (many geometries in one draw call, in-place updates without React
renders), `Voxels` with live lighting.

**Physics and XR:** Rapier-backed `Physics`/`RigidBody`/colliders/joints; separate entry so apps without it never load
Rapier. `XR`, `Controller`, `useXR`.

## 5. Next.js

- App Router and Pages Router both work, with webpack and Turbopack. No `transpilePackages` needed (compiled ESM).
- Only the generated `rsc/` entries carry `'use client'` (via the `react-server` export condition), so a server
  component can import `Canvas`. You still put the `Canvas` in a small `'use client'` file and import it from the
  server `page.tsx` behind `<Suspense>`.
- SSR emits an accessible canvas and touches no GPU API.
- Bundler matrix (`npm run modern:test:bundlers`, part of `check:merge`) builds the cube page with Vite 8, Next.js 16
  (webpack and Turbopack), Rollup and esbuild, fails on any warning, and fails if the page requests Wasm or an
  optional package.
- `examples/next` has `app/` (layout, page, scene) and `pages/pages-router.tsx`.
- Size: a Next.js page is about 194 KB gzip of JavaScript. A page that imports `margoengine/react/gltf-pro`, `/fbx`,
  `/animation` or `/materials` also has the Basis (527,333 B) and Draco (192,420 B) decoders in its build output,
  requested only for a model that needs them. `margoengine/react` alone emits neither.

## 6. Coming from react-three-fiber (and drei)

Same tree shape, different spelling. Full table in `docs/react-from-r3f.md`.

| R3F / drei | Margo |
| --- | --- |
| `<mesh>`, `<group>` | `<Mesh>`, `<Group>` |
| `<meshStandardMaterial>` | `<PbrMaterial>` |
| `<directionalLight>` | `<Sun direction>` |
| `useThree()` | `useEngine()`, `useCamera()`, `useMargo()` |
| `useGLTF` + `<primitive>` | `<Model src>` / `<Gltf src>` |
| `useAnimations` | `<Animation clip>` |
| `<View>` | `<RenderView>` |
| `<EffectComposer>` | `<EffectComposer>` with effect children |
| rapier `<Physics>`, `<RigidBody>` | same names, `@margoengine/react/physics` |
| `<Canvas shadows>` | `<Shadows />` child |

Differences that matter: JSX intrinsics (`<mesh>`) and `extend()` need `jsxImportSource: '@margoengine/react'`, and
`extend` takes React components; no event bubbling and no raycaster; WebGPU first; real-world metres and glTF conventions; stable mesh refs
through StrictMode and Suspense; optional features are subpaths you install.

## 7. Browsers without WebGPU

`loadFallback={() => import('@margoengine/webgl')}` fetches the basic WebGL2 preview only when WebGPU is missing
(3,021 B gzip; coloured core meshes, one light, no textures, picking or effects). `fallbackContent` replaces the default
message (image, SVG, skeleton). A failed fallback reaches `onError` as a `MargoError` with code `unsupported`. WebGPU
visitors download none of it. Click handlers, PBR models, IBL and shadows do not run on the fallback.

## 8. State against the frame loop

Per-frame motion lives in a ref written in `useFrame`; UI state lives in `useState` or your store; saved scenes are a
plain document (`docs/guides/react-scene-document.md`). `docs/guides/react-state-vs-frame-loop.md` runs both in a
browser and counts React commits per second.

## 9. Sizes (gzip)

- Core + stage alone: 23,626 B (gate 25,000 B).
- Vite cube page with orbit controls: about 94 KB at load, 101-102 KB once `OrbitControls` mounts. React and React DOM
  are about 66-70% of that. Margo's part (core, stage, bindings) is 25,949 B.
- Textured `<Model>`: +1,750 B in the entry, plus glTF support (56,074 B) fetched when it mounts.
- Page with PBR models loaded (independent study): about 193 KB including React.
- Next.js page: about 194 KB.

## 10. Tests and docs that back it

`npm run modern:test:react` (React Testing Library + JSDOM: StrictMode, Suspense, cancellation, cache reuse, demand
rendering), `npm run test:docs:browser` (guides in a real WebGPU browser), `modern:test:packages` (README examples
type-checked from packed tarballs), `modern:test:bundlers`. Guides: `docs/react-cookbook.md`,
`docs/guides/react-first-scene.md`, `docs/guides/react-scene-document.md`, `docs/guides/react-state-vs-frame-loop.md`.

## 11. Honest gaps to know about

- Not on npm yet (tarballs only).
- WebGPU only for React click events, PBR, IBL, shadows, post; WebGL2 is a basic preview (`engine.pick` needs its `/pick` entry there).
- `Box`, `Sphere`, `Plane` take a colour or one base colour `map` (PNG or JPEG, WebGPU only, needs `@margoengine/gltf`); other maps need a glTF `Model`.
- Lowercase JSX tags and `extend()` need `jsxImportSource: '@margoengine/react'` (2026-11-07); `extend` takes React components, not engine classes. Events bubble from the hit mesh through its parents.
- `Model`, `Fbx`, `Animation` and the `materials` components have their own entries (`margoengine/react/gltf-pro` and so on), so a page without them builds with no Basis or Draco `.wasm`.
