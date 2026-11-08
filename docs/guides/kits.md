# Kits

A kit is one import line with the set of classes an app of one kind usually needs. It is part of `margoengine` (no
extra install), and it costs nothing you do not use: a bundler keeps only the names you import, so
`import {Shadows, createStage} from 'margoengine/game'` bundles the same bytes as importing them from their packages
(`tests/umbrella.test.js` compares the two).

<!-- Every ```ts block in this file is type-checked against the built packages by tests/from-threejs-snippets.test.js.
     Snippets may use the ambient names engine, canvas, mesh and model. -->

| Kit | For | Everything in it, at startup |
| --- | --- | --- |
| `margoengine/game` | Games: models, animation, light and shadow, sky, physics, audio, input, effects | 341,740 B |
| `margoengine/viz` | Data and scientific visualization: figures and GPU compute, points, lines, splats, terrain, labels and text | 228,204 B |
| `margoengine/web` | Product viewers and 3D on web pages: a glTF model, studio light, orbit, HTML on top | 91,456 B |

The last column is min+gzip JavaScript with every name in the kit used, core and stage included (an app that uses
part of a kit pays for that part; core + stage alone is 23,626 B). Wasm decoders, workers and lazily loaded parts
are extra and load only when used. `tests/umbrella.test.js` measures these numbers on every run and fails when one
moves more than 3%.

Each kit also re-exports `createStage` and `Stage`, so a whole app can start from one line. Option types and the
rest of each package stay in that package: `import type {ShadowsOptions} from 'margoengine/shadows'`.

`loadGLTF` is not in a kit: `import {loadGLTF} from 'margoengine/gltf-pro'`. It reaches the Draco and Basis decoders, and
a bundler copies their Wasm files when it reads the module, before tree-shaking, so a kit that held it would put
720 KB of files in every build, used or not.

## A game in one import

```ts
import {Physics, Shadows, createStage} from 'margoengine/game';

await Physics.load();
const stage = await createStage('#viewport');
const physics = new Physics(stage.engine);
const shadows = Shadows.attach(stage.engine, {resolution: 2048});
const floor = stage.box({size: [10, 1, 10], position: [0, -0.5, 0]});
const crate = stage.box({position: [0, 4, 0], color: '#c08040'});
physics.addBody(floor, {type: 'fixed'});
physics.addBody(crate, {colliders: {shape: 'box', restitution: 0.3}});
shadows.add(floor);
shadows.add(crate);
```

## Which kit

- Most apps start with a kit and add single packages (`margoengine/<package>`) for anything else.
- The kits overlap where apps overlap (orbit controls, the stage, post-processing); the same name is the same class
  in every kit.
- `npm create margo@latest my-game -- --template game` (or `viz`) starts an app from a kit.

## Contents

Generated from `scripts/umbrella.mjs` (`node scripts/umbrella.mjs` rewrites this section).

<!-- kits:start -->
### `margoengine/game`

Games: models, animation, light and shadow, sky, physics, audio, input, effects.

| From | Names |
| --- | --- |
| `margoengine` | `createStage`, `Stage` |
| `margoengine/animation` | `Animation`, `AnimationGroup` |
| `margoengine/animator` | `Animator` |
| `margoengine/materials` | `Material`, `Texture`, `loadTexture`, `createMesh`, `createInstancedMesh` |
| `margoengine/geometry/primitives` | `boxGeometry`, `sphereGeometry`, `planeGeometry`, `cylinderGeometry`, `capsuleGeometry` |
| `margoengine/shadows` | `Shadows` |
| `margoengine/clustered` | `Clustered` |
| `margoengine/environment` | `Environment`, `EnvironmentLighting`, `Fog`, `HemisphereLight`, `AmbientLight` |
| `margoengine/sky` | `Sky` |
| `margoengine/controls/orbit` | `OrbitControls` |
| `margoengine/controls/walk` | `WalkControls` |
| `margoengine/input` | `Input` |
| `margoengine/physics` | `Physics`, `PhysicsBody`, `CharacterController` |
| `margoengine/navmesh` | `NavMesh` |
| `margoengine/audio` | `Audio`, `AudioListener`, `PositionalAudio` |
| `margoengine/vfx` | `VFX` |
| `margoengine/text` | `Text`, `TextRenderer` |
| `margoengine/tween` | `Tween` |
| `margoengine/post/stack` | `PostStack` |
| `margoengine/post/bloom` | `Bloom` |
| `margoengine/post/fxaa` | `FXAA` |
| `margoengine/tonemap` | `Tonemap` |

### `margoengine/viz`

Data and scientific visualization: figures and GPU compute, points, lines, splats, terrain, labels and text.

| From | Names |
| --- | --- |
| `margoengine` | `createStage`, `Stage` |
| `margoengine/points` | `PointsPlugin`, `PointCloud`, `PointsMaterial` |
| `margoengine/sciviz` | `Figure`, `createFigure`, `colormap` |
| `margoengine/compute` | `createCompute` |
| `margoengine/lines` | `Lines`, `Line`, `LineMaterial`, `GridHelper`, `AxesHelper` |
| `margoengine/splats` | `Splats`, `parseSplat` |
| `margoengine/terrain` | `Terrain` |
| `margoengine/text` | `Text`, `TextRenderer` |
| `margoengine/labels` | `Label`, `LabelRenderer` |
| `margoengine/html` | `HTML` |
| `margoengine/controls/orbit` | `OrbitControls`, `MapControls` |
| `margoengine/cameras` | `CameraProjection` |
| `margoengine/environment` | `EnvironmentLighting`, `ColorBackground` |
| `margoengine/tween` | `Tween` |
| `margoengine/stats` | `Stats` |
| `margoengine/post/stack` | `PostStack` |
| `margoengine/post/fxaa` | `FXAA` |
| `margoengine/tonemap` | `Tonemap` |

### `margoengine/web`

Product viewers and 3D on web pages: a glTF model, studio light, orbit, HTML on top.

| From | Names |
| --- | --- |
| `margoengine` | `createStage`, `Stage` |
| `margoengine/environment` | `Environment`, `EnvironmentLighting`, `ColorBackground` |
| `margoengine/controls/orbit` | `OrbitControls` |
| `margoengine/shadows` | `Shadows` |
| `margoengine/html` | `HTML` |
| `margoengine/labels` | `Label`, `LabelRenderer` |
| `margoengine/tween` | `Tween` |
| `margoengine/post/stack` | `PostStack` |
| `margoengine/post/fxaa` | `FXAA` |
| `margoengine/tonemap` | `Tonemap` |
<!-- kits:end -->
