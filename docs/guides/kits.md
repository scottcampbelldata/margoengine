# Kits

Choose one of three ways in: install core or stage alone, install a domain kit, or install everything.
All packages in a release share one version. npm publication is pending; the checks below use packed private
repository builds and never the unrelated registry placeholder.

| Install | What it gives you |
| --- | --- |
| `npm install @margoengine/core` | Rendering and transforms, no other engine package |
| `npm install @margoengine/stage` | The stage facade plus core, nothing else required |
| `npm install @margoengine/game` | Game systems, rendering, input, animation, worlds, audio and navigation |
| `npm install @margoengine/web` | Product viewers and interactive web scenes |
| `npm install @margoengine/viz` | Scientific figures, compute, spatial data, terrain, points and lines |
| `npm install @margoengine/react-kit react react-dom` | The web profile with React bindings and sky, also used by Next.js |
| `npm install margoengine` | Every engine package |

A kit is a small package of typed re-exports, with a dependency on each member it exposes. It contains no copied
engine implementation. Its root provides common names; its subpaths expose every entry of its members. Existing
`margoengine/game`, `margoengine/web` and `margoengine/viz` imports remain supported by the full install.
Installing a kit never installs `margoengine`. Physics development remains on hold; the game kit exposes the
already-built physics package without changing it.

With a `<canvas id="viewport"></canvas>` in the page, a web profile starts a scene directly:

```ts
import {createStage} from '@margoengine/web';

const stage = await createStage('#viewport');
stage.box({color: '#84d6bd'});
```

For a complete app, `npm create margo@latest my-app -- --template web`, then `cd my-app`, `npm install` and
`npm run dev`. Choose `game`, `viz`, `react` or `next` for the other starters. Each template declares one domain
profile; React and Next use `@margoengine/react-kit`. The full engine is never a template dependency.
`scripts/template-install-check.mjs` runs this actual create command through the private packed registry, installs
and builds all five templates, and checks their exact engine dependency closures. Its separate
`scripts/template-browser-check.mjs` proves a first frame from each production build, including Next's server.

To add a capability outside a profile, install its package at the same release version, for example
`npm install @margoengine/xr@1.0.0`. Import it directly from `@margoengine/xr`.
Optional third-party peers, including React and Rapier, remain app choices and are never silently installed by a kit.

Model loading is a separate one-line import: `import {loadGLTF} from '@margoengine/web/gltf-pro'` (or
`@margoengine/game/gltf-pro`). The loader is installed with the profile, but a page importing only the root emits
no Draco or Basis files. Bundlers discover decoder assets before tree-shaking, so the root deliberately keeps the
loader entry separate. A model app keeps the full glTF/compression support of the existing loader. No loader,
core or stage implementation changed.

## Research and format choice

Reviewed 2026-11-10, public documentation and published package metadata only. Registry versions, dependency
maps and unpacked bytes are frozen in [kits-registry.json](kits-registry.json); no rival implementation was read.

| Project | Public packaging behaviour | Decision for Margo |
| --- | --- | --- |
| [three.js installation](https://threejs.org/manual/pages/installation.html) | One install contains the engine and separately imported addons; matching versions/CDNs are recommended | Keep the full umbrella and familiar subpath imports, add actual install profiles |
| [Babylon npm packages](https://doc.babylonjs.com/setup/frameworkPackages/npmSupport/) | Scoped core, loaders, GUI and other ES modules install independently | Retain independent scoped packages beneath profiles |
| [PlayCanvas standalone](https://developer.playcanvas.com/user-manual/engine/standalone/) | Engine install and create CLI; React is separate | Keep one-line scaffolding and a separate React profile |
| [Bevy profiles](https://docs.rs/bevy/latest/bevy/#profiles) | Disable defaults and choose 2d, 3d, ui; individual crates remain available | Use domain dependency sets, without a JS runtime feature switch |
| [Pixi v8 migration](https://pixijs.com/8.x/guides/migrations/v8) | Returned from separate packages to one package because mixed versions conflicted with shared caches | One release version and cross-kit singleton checks. `@pixi/core` stops at 7.4.3 because v8 consolidated into `pixi.js`, currently 8.22.0 in the snapshot |
| [Godot build profiles](https://docs.godotengine.org/en/latest/engine_details/development/compiling/optimizing_for_size.html) | Custom export builds disable unused domains | Domain selection is useful; no custom engine build should be needed to install a Margo kit. Godot is an export target, not the web parity bar |
| [Phaser installation](https://www.phaser.io/oss/docs/phaser/getting-started/installation) | One package or a create CLI template | Preserve the short starting path |
| [Vite guide](https://vite.dev/guide/) | Separate tool and template scaffolder, third-party plugins | Keep create-margo separate from runtime profiles |
| [Angular releases](https://angular.dev/reference/releases) | Related framework packages follow coordinated releases | Keep the existing single release version |
| [Nx release policy](https://nx.dev/docs/reference/releases) | nx and scoped plugins release together in lockstep | Check every published package and template range together |
| [Lodash per-method packages](https://lodash.com/per-method-packages) | Per-method installs duplicate shared internals, unlike the main package | Re-export the original modules; never bundle copies into each kit |

The design combines information hiding from David L. Parnas, *On the Criteria To Be Used in Decomposing Systems
into Modules* (1972), [paper record](https://doi.org/10.1184/r1/6607958), with declarative product membership from
Don Batory, *Feature Models, Grammars, and Propositional Formulas* (2005),
[paper](https://www.cs.utexas.edu/ftp/techreports/tr05-14.pdf), and the npm contributors'
[package exports, dependencies and optional peers specification](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
(2026). Domain profiles choose dependencies; subpaths choose loaded code. React merits a fourth profile because
its peer/runtime and server-boundary requirements differ from plain web applications. A separate 2D-only kit is
not claimed: the game profile already exposes the built sprites, tilemaps, pixel and 2D lighting entries.

## Measured installs and correctness

The unchanged legacy bundle profiles below are min+gzip startup JavaScript when every root name is used.
They describe browser bundles, separately from npm install bytes. Lazy parts and decoder assets are extra.
`tests/umbrella.test.js` checks these existing budgets within 3 percent.

| Kit | For | Everything in it, at startup |
| --- | --- | --- |
| `margoengine/game` | Games | 365,936 B |
| `margoengine/viz` | Visualization | 264,713 B |
| `margoengine/web` | Web scenes | 95,846 B |

`node scripts/kit-install-check.mjs` packs the checkout, serves a read-only local registry, installs in new folders
inside this lane's ignored test-results directory with an isolated cache, and compares every installed engine
package to the exact required transitive closure. It rejects version drift and any engine download outside our
tarballs. Tooling is excluded from the measurement; React/React DOM are included for the React profile only.
Bytes are actual file bytes in node_modules, including its generated lock metadata, not disk allocation or browser
transfer. Packed bytes sum engine tarballs only. These numbers are a snapshot, not a speed claim or a size ceiling.

<!-- install-sizes:start -->
| Profile | Engine packages | Installed B | Packed engine B |
| --- | --- | --- | --- |
| core | 1 | 152,779 | 54,848 |
| stage | 2 | 273,999 | 94,057 |
| game | 70 | 24,506,552 | 7,764,823 |
| web | 40 | 19,773,382 | 6,321,003 |
| viz | 42 | 22,561,981 | 7,181,870 |
| react-kit | 42 | 29,121,993 | 6,611,210 |
| together | 83 | 32,273,316 | 10,251,352 |
| all | 98 | 55,744,429 | 16,206,128 |
<!-- install-sizes:end -->

CPU tests check every kit subpath's binding identity, declared imports, current generation, optional boundaries,
and root tree-shaking. The GPU check draws an actual packed application on native WebGPU, with core alone and
stage plus core; each kit also draws with the separately installed WebGL2 compatibility package. The compatibility
package is added only after recording the base install. No symlink to workspace engine code participates.

Reproduce: build packages; run `node scripts/kit-install-check.mjs`; then run
`node scripts/gpu-lock.mjs run --owner=kit-check --wait-max=60 --max=4 --gpu=packed-kit-first-frames -- node scripts/kit-browser-check.mjs`.
The packed-install CPU check is part of local CI's verify. Lanes run the fast gate only. README examples are owed
in [readme-owed.md](../work-lists/readme-owed.md) during the build phase.

## Contents

Generated from `scripts/umbrella.mjs` (`node scripts/umbrella.mjs` rewrites this section).

<!-- kits:start -->
### Install profile `@margoengine/game`

`stage`, `core`, `animation`, `animator`, `materials`, `geometry`, `shadows`, `clustered`, `environment`, `sky`, `controls`, `input`, `physics`, `navmesh`, `audio`, `vfx`, `text`, `tween`, `post`, `tonemap`, `ecs`, `fsm`, `net`, `netcode`, `behavior`, `save`, `cutscene`, `cinematic`, `cameras`, `terrain`, `water`, `weather`, `biomes`, `scenery`, `creative`, `procedural`, `wfc`, `road`, `splines`, `tilemap`, `sprites`, `pixel`, `lighting2d`, `ui`, `rigging`, `ragdoll`, `mixer`, `transitions`, `toon`, `lod`, `culling`, `oit`, `cache`, `scene`, `worker`, `gltf`, `gltf-pro`, `decoders`, `loaders`, `bvh`, `selection`, `quality`, `stats`, `staging`, `lightmap`, `shader`, `compute`. Every exported subpath of each member is available as `@margoengine/game/<member>[/<entry>]`.

### Install profile `@margoengine/web`

`stage`, `core`, `environment`, `controls`, `shadows`, `html`, `labels`, `tween`, `post`, `tonemap`, `geometry`, `materials`, `gltf`, `gltf-pro`, `decoders`, `animation`, `loaders`, `exporters`, `selection`, `staging`, `cameras`, `quality`, `stats`, `text`, `video`, `transitions`, `shader`, `lod`, `culling`, `oit`, `cache`, `scene`, `worker`, `bvh`, `lightmap`. Every exported subpath of each member is available as `@margoengine/web/<member>[/<entry>]`.

### Install profile `@margoengine/viz`

`stage`, `core`, `points`, `sciviz`, `compute`, `lines`, `splats`, `terrain`, `text`, `labels`, `html`, `controls`, `cameras`, `environment`, `tween`, `stats`, `post`, `tonemap`, `geometry`, `materials`, `loaders`, `exporters`, `gltf`, `gltf-pro`, `decoders`, `selection`, `viewcube`, `bvh`, `lod`, `culling`, `oit`, `cache`, `scene`, `worker`, `tiles`, `splines`. Every exported subpath of each member is available as `@margoengine/viz/<member>[/<entry>]`.

### Install profile `@margoengine/react-kit`

`stage`, `core`, `environment`, `controls`, `shadows`, `html`, `labels`, `tween`, `post`, `tonemap`, `geometry`, `materials`, `gltf`, `gltf-pro`, `decoders`, `animation`, `loaders`, `exporters`, `selection`, `staging`, `cameras`, `quality`, `stats`, `text`, `video`, `transitions`, `shader`, `lod`, `culling`, `oit`, `cache`, `scene`, `worker`, `bvh`, `lightmap`, `react`, `sky`. Every exported subpath of each member is available as `@margoengine/react-kit/<member>[/<entry>]`.

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
