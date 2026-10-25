# Which import do I need?

One install covers everything:

```bash
npm i margoengine
```

Then import what you use. Every package is a subpath of `margoengine`: `margoengine/shadows` is the package
`@margoengine/shadows`, the same module and the same classes. An app bundles only what it imports, however many
packages are installed. For a ready-made set, import a [kit](kits.md) instead (`margoengine/game`, `/cad`, `/viz`,
`/web`).

<!-- Every ```ts block in this file is type-checked against the built packages by tests/from-threejs-snippets.test.js.
     Snippets may use the ambient names engine, canvas, mesh and model. -->

## Start

`margoengine` itself is the stage: a canvas, camera controls and rendering in one call, plus everything the core
engine exports (`Engine`, `Mesh`, `PbrMaterial`, `box`, ...).

```ts
import {createStage} from 'margoengine';

const stage = await createStage('#viewport');
const cube = stage.box({color: '#84d6bd'});
stage.onTick((delta) => {
  cube.rotation.y += delta;
});
```

## I want to...

| Task | Import |
| --- | --- |
| Show a scene with orbit controls | `createStage` from `margoengine` |
| Use the engine without the stage | `Engine` from `margoengine` (or `margoengine/core`) |
| Load a glTF/GLB model with PBR materials | `loadGLTF` from `margoengine/gltf-pro` |
| Load a static glTF model, smallest code | `loadGLTF` from `margoengine/gltf` |
| Load FBX, USDZ, OBJ, STL, PLY, Collada ... | `margoengine/fbx`, `margoengine/usdz`, `margoengine/loaders` |
| Load STEP, IGES (CAD) | `loadCAD` from `margoengine/machinery/cad` |
| Export glTF, STL, OBJ, USDZ | `margoengine/exporters` |
| Image-based lighting, fog, backgrounds | `margoengine/environment` |
| Many point, spot and area lights | `Clustered` from `margoengine/clustered` |
| Shadows from the sun | `Shadows` from `margoengine/shadows` |
| A physical sky with day and night | `Sky` from `margoengine/sky` |
| Materials: textures, toon, clearcoat, node graphs | `margoengine/materials`, `margoengine/shader` |
| Orbit, walk, fly or a transform gizmo | `margoengine/controls/orbit`, `/controls/walk`, `margoengine/controls`, `/controls/transform` |
| CAD navigation (SolidWorks, Inventor, Fusion ... mouse) | `cadControls` from `margoengine/controls/orbit` |
| Skeletal animation and morph targets | `Animation` from `margoengine/animation`, `Animator` from `margoengine/animator` |
| Rigid-body physics | `Physics` from `margoengine/physics`, and `npm i @dimforge/rapier3d-compat` |
| Bloom, SSAO, depth of field, anti-aliasing | `PostStack` from `margoengine/post/stack`, effects from `margoengine/post/<effect>`, `margoengine/dof` |
| Tone mapping | `Tonemap` from `margoengine/tonemap` |
| Particles | `VFX` from `margoengine/vfx` |
| Text and labels | `margoengine/text`, `margoengine/labels`, `margoengine/html` |
| Lines, grids and helpers | `margoengine/lines` |
| Point clouds and Gaussian splats | `margoengine/points`, `margoengine/splats` |
| Sound | `margoengine/audio` |
| Keyboard, mouse, gamepad and touch | `Input` from `margoengine/input` |
| Voxel worlds | `margoengine/voxel`, `margoengine/voxel-edit`, `margoengine/voxel-net` |
| React components | `margoengine/react`, and `npm i react react-dom` |
| A WebGL2 fallback for browsers without WebGPU | `margoengine/webgl` |

Every package and entry is in the [package catalog](../README.md). A package's README shows its entries; each
`@margoengine/<name>/<entry>` there is `margoengine/<name>/<entry>` here.

## Several packages together

```ts
import {createStage} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf-pro';
import {EnvironmentLighting} from 'margoengine/environment';
import {Shadows} from 'margoengine/shadows';

const stage = await createStage('#viewport', {backend: 'webgpu'});
await EnvironmentLighting.load(stage.engine, '/studio.hdr');
const helmet = await loadGLTF(stage.engine, '/DamagedHelmet.glb');
const shadows = Shadows.attach(stage.engine, {resolution: 2048});
shadows.add(helmet);
```

## Short names

Namespace imports work and tree-shake the same as named imports in Vite, webpack, esbuild and Rollup: only the members
you use are kept.

```ts
import * as M from 'margoengine';
import * as Post from 'margoengine/post/stack';
import * as Bloom from 'margoengine/post/bloom';

const stage = await M.createStage('#viewport');
const meshes: M.Mesh[] = [stage.sphere({color: '#ffcc66'})];
Post.PostStack.attach(stage.engine, [new Bloom.Bloom({strength: 0.6})]);
console.log(meshes.length);
```

## Rules

- Import only the entries listed in the package READMEs. There are no deep imports into `dist/`: the `exports` maps
  allow only the published entries, with their types.
- Every entry is free of side effects. Nothing runs at import time; nothing is registered globally.
- `margoengine/<name>` and `@margoengine/<name>` are the same module. Mixing them in one app is fine; there is only
  ever one copy of each class.
- A heavier feature can load when it is first used: `await import('margoengine/physics')`.

## Coming from three.js

| three.js | Margo Engine |
| --- | --- |
| `npm i three` | `npm i margoengine` |
| `import * as THREE from 'three'` | `import * as M from 'margoengine'` |
| `three/addons/loaders/GLTFLoader.js` | `margoengine/gltf-pro` (`loadGLTF`) |
| `three/addons/controls/OrbitControls.js` | `margoengine/controls/orbit` |
| `three/addons/postprocessing/EffectComposer.js` | `margoengine/post/stack` |
| `three/addons/exporters/GLTFExporter.js` | `margoengine/exporters` (`exportGLB`) |

More in [from-threejs.md](../from-threejs.md).
