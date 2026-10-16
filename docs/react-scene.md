# A complete Margo React scene layer

Date: 2026-10-16. This is Margo's own version of the React Three Fiber surface: the canvas, the helpers, post, physics, and XR. It does not wrap Fiber, and it does not add `react-reconciler`. A Fiber file is rewritten. A Margo app does the same jobs with these components.

Core and the stage facade stay frozen. The layer lives under `@margoengine/react`, with subpath exports so a clickable cube does not download physics or post. `sideEffects` stays `false`. Each subpath peers the engine package it binds. Nothing here imports Three.js.

## Subpaths

| Subpath | What an R3F app gets from Fiber or Drei | What it binds |
| --- | --- | --- |
| `@margoengine/react` | `<Canvas>`, `<Mesh>`, `useFrame`, events, Suspense | The stage the canvas already creates |
| `@margoengine/react/kit` | Loaders, lights, `<Html>`, `<Text>`, gizmos, environment, sky | `gltf-pro`, `fbx`, `environment`, `html`, `text`, `gizmo`, `sky`, `shadows` |
| `@margoengine/react/post` | Effect composer passes | `post`, `dof`, `tonemap`, `taa` |
| `@margoengine/react/physics` | Rigid bodies | `physics` |
| `@margoengine/react/xr` | Immersive session | `xr` |

`docs/react-r3f.md` is the first subpath: pointer events through `engine.pick`, Suspense for `<Model>` and `<Environment>`, `camera`, `size`, `gl`, and `clock` on `useMargo()`, `<group>`, `<Html>`, and `frameloop="demand"`. Ship that before the kit.

## Kit

The kit is one component per job the engine already implements.

- **Loaders.** `<Gltf>`, `<Fbx>`, `preload(src)`, and a cache keyed by URL. Suspense throws the same promise `preload` starts.
- **Staging.** `<Environment>`, `<Sky>`, `<ContactShadows>` as a shadow-only ground, and `<Center>` using `worldBounds` from the stage.
- **Controls.** `<OrbitControls>` exists. Add `<PointerLock>` and `<TransformControls>` from `@margoengine/controls` and `@margoengine/gizmo`.
- **Screen.** `<Html>` from `@margoengine/html`. `<Text>` from `@margoengine/text`.
- **Shapes.** `<Box>`, `<Sphere>`, and `<Plane>` call `@margoengine/geometry` and pass the result to the existing `<Mesh>`. The stage's `sphere()` stays out of this package.

## Post, physics, and XR

These are thin components over plugins that already exist. Each one is a dynamic `import()` of that package, the same way `<Environment>` already loads `@margoengine/environment`. Unmount disposes the plugin. WebGPU-only passes stay WebGPU-only.

```tsx
<EffectComposer>
  <Bloom />
  <SSAO />
  <DepthOfField />
</EffectComposer>
```

```tsx
<Physics>
  <RigidBody><Mesh /></RigidBody>
</Physics>
```

```tsx
<XR>
  <Controller />
</XR>
```

## Wait for the engine, not the React wrapper

A click on a skinned character misses until picking uses the deformed vertices. That work is `docs/three-parity-next.md`. The React event props should not pretend a skinned hit works before that lands.

`<MeshTransmissionMaterial>` waits for transmission in `docs/materials-extensions.md`. The component is a material attachment, like `<PbrMaterial>`, once that lobe exists.

## What this version does not port

Float, sparkles, scroll-story cameras, and caustics are extras. Component names do not have to match Drei. The complete version is the five subpaths above. Each disposes what it creates. None of them enter the 20,000-byte core plus stage measurement.
