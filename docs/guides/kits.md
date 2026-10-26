# Kits

A kit is one import line with the set of classes an app of one kind usually needs. It is part of `margoengine` (no
extra install), and it costs nothing you do not use: a bundler keeps only the names you import, so
`import {Shadows, createStage} from 'margoengine/game'` bundles the same bytes as importing them from their packages
(`tests/umbrella.test.js` compares the two).

<!-- Every ```ts block in this file is type-checked against the built packages by tests/from-threejs-snippets.test.js.
     Snippets may use the ambient names engine, canvas, mesh and model. -->

| Kit | For | Everything in it, at startup |
| --- | --- | --- |
| `margoengine/game` | Games: models, animation, light and shadow, sky, physics, audio, input, effects | 318,765 B |
| `margoengine/cad` | CAD and engineering: STEP/IGES/STL/OBJ import, CAD navigation, sections, measuring, export | 201,527 B |
| `margoengine/viz` | Data and scientific visualization: figures and GPU compute, points, lines, splats, terrain, labels and text | 277,396 B |
| `margoengine/web` | Product viewers and 3D on web pages: a glTF model, studio light, orbit, HTML on top | 160,399 B |

The last column is min+gzip JavaScript with every name in the kit used, core and stage included (an app that uses
part of a kit pays for that part; core + stage alone is 22,636 B). Wasm decoders, workers and lazily loaded parts
are extra and load only when used. `tests/umbrella.test.js` measures these numbers on every run and fails when one
moves more than 3%.

Each kit also re-exports `createStage` and `Stage`, so a whole app can start from one line. Option types and the
rest of each package stay in that package: `import type {ShadowsOptions} from 'margoengine/shadows'`.

## A game in one import

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import {Physics, Shadows, createStage} from 'margoengine/game';

await RAPIER.init();
const stage = await createStage('#viewport');
const physics = new Physics(stage.engine, {rapier: RAPIER});
const shadows = Shadows.attach(stage.engine, {resolution: 2048});
const floor = stage.box({size: [10, 1, 10], position: [0, -0.5, 0]});
const crate = stage.box({position: [0, 4, 0], color: '#c08040'});
physics.addBody(floor, {type: 'fixed'});
physics.addBody(crate, {colliders: {shape: 'box', restitution: 0.3}});
shadows.add(floor);
shadows.add(crate);
```

## A CAD viewer in one import

```ts
import {SOLIDWORKS, ViewCube, cadControls, createStage} from 'margoengine/cad';

const stage = await createStage('#viewport', {controls: false});
cadControls(stage.engine, {profile: SOLIDWORKS, keys: window});
ViewCube.attach(stage.engine);
await stage.load('/bracket.step');
```

## Which kit

- Most apps start with a kit and add single packages (`margoengine/<package>`) for anything else.
- The kits overlap where apps overlap (orbit controls, the stage, post-processing); the same name is the same class
  in every kit.
- `npm create margo@latest my-game -- --template game` (or `cad`, `viz`) starts an app from a kit.

## Contents

Generated from `scripts/umbrella.mjs` (`node scripts/umbrella.mjs` rewrites this section).

<!-- kits:start -->
### `margoengine/game`

Games: models, animation, light and shadow, sky, physics, audio, input, effects.

| From | Names |
| --- | --- |
| `margoengine` | `createStage`, `Stage` |
| `margoengine/gltf-pro` | `loadGLTF`, `parseGLTF` |
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

### `margoengine/cad`

CAD and engineering: STEP/IGES/STL/OBJ import, CAD navigation, sections, measuring, export.

| From | Names |
| --- | --- |
| `margoengine` | `createStage`, `Stage` |
| `margoengine/machinery/cad` | `loadCAD`, `parseCAD`, `PartInstancer` |
| `margoengine/machinery/section` | `SectionPlanes` |
| `margoengine/machinery/exploded` | `ExplodedView` |
| `margoengine/machinery/dimensions` | `Dimensions` |
| `margoengine/machinery/metrology` | `measureDistance`, `snapFeature` |
| `margoengine/machinery/edges` | `FeatureEdges` |
| `margoengine/controls/orbit` | `cadControls`, `OrbitControls` |
| `margoengine/controls/profiles` | `MARGO`, `SOLIDWORKS`, `AUTOCAD`, `INVENTOR`, `FUSION`, `ONSHAPE`, `RHINO`, `BLENDER`, `MAYA`, `PROFILES` |
| `margoengine/controls/transform` | `TransformControls` |
| `margoengine/viewcube` | `ViewCube` |
| `margoengine/selection` | `Selection`, `Picking` |
| `margoengine/cameras` | `CameraProjection` |
| `margoengine/lines` | `Lines`, `GridHelper`, `AxesHelper` |
| `margoengine/labels` | `Label`, `LabelRenderer` |
| `margoengine/environment` | `EnvironmentLighting` |
| `margoengine/shadows` | `Shadows` |
| `margoengine/post/stack` | `PostStack` |
| `margoengine/post/ssao` | `SSAO` |
| `margoengine/post/fxaa` | `FXAA` |
| `margoengine/exporters` | `exportGLB`, `exportSTL`, `exportOBJ` |

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
| `margoengine/gltf-pro` | `loadGLTF` |
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
| `margoengine/gltf-pro` | `loadGLTF` |
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
