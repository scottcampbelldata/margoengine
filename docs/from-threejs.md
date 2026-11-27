# Coming from three.js

A side-by-side guide for three.js developers. Each section shows the three.js code you already write, then the Margo
code that does the same job. Where Margo has no equivalent yet, the section says so; the full list is in
[Not yet](#not-yet). To look one class up, go to [Name by name](#name-by-name); to see whole scenes running, to
[Side-by-side examples](#side-by-side-examples).

<!-- Every ```ts block in this file is type-checked against the built packages by tests/from-threejs-snippets.test.js.
     ```js blocks are three.js and are not checked. Snippets may use the ambient names engine, canvas, mesh and model. -->

## Contents

- [What is different](#what-is-different)
- [Concepts](#concepts)
- [Units, handedness and colour](#units-handedness-and-colour)
- [Install only what you import](#install-only-what-you-import)
- [Renderer, scene, camera and resize](#renderer-scene-camera-and-resize)
- [Meshes and geometry](#meshes-and-geometry)
- [Materials and textures](#materials-and-textures)
- [Lights and shadows](#lights-and-shadows)
- [Environment, background and fog](#environment-background-and-fog)
- [Loading models](#loading-models)
- [Animation](#animation)
- [Controls](#controls)
- [Raycasting and picking](#raycasting-and-picking)
- [Instancing](#instancing)
- [LOD and imposters](#lod-and-imposters)
- [Post-processing](#post-processing)
- [TSL and node materials](#tsl-and-node-materials)
- [Water, ocean and liquids](#water-ocean-and-liquids)
- [Flocks of birds and fish](#flocks-of-birds-and-fish)
- [Orthographic cameras and top-down views](#orthographic-cameras-and-top-down-views)
- [Large coordinates (floating origin)](#large-coordinates-floating-origin)
- [Lines, points, text and labels](#lines-points-text-and-labels)
- [Math](#math)
- [Render loop and frame pacing](#render-loop-and-frame-pacing)
- [Debugging a frame](#debugging-a-frame)
- [Disposal](#disposal)
- [Pitfalls](#pitfalls)
- [Side-by-side examples](#side-by-side-examples)
- [Name by name](#name-by-name)
- [Not yet](#not-yet)

## What is different

- **WebGPU first.** Core renders with WebGPU. Where it is missing, `await install()` from `@margoengine/webgl2-compat`
  runs the same scene, optional packages included, on WebGL2 (still in development). The much smaller
  `@margoengine/webgl2-compat/preview` draws core meshes only (flat PBR, one light, no textures or effects).
- **The engine is the scene.** One `Engine` owns one canvas, one camera and a default scene (`engine.scene`; more with
  `engine.createScene()`). Meshes are created by the engine (`engine.createMesh()`), and features (shadows, lights,
  post effects, controls) are plugins you attach with one form, `X.attach(engine, options)` (async ones such as `Environment.attach` return a Promise). A loaded model
  joins a feature with `feature.add(model)`. Everything disposable has `dispose()`, and every package object also has
  `[Symbol.dispose]` for `using` (core's `Engine` and meshes and the stage facade have `dispose()` only).
- **Small core, optional packages.** Core plus the `margoengine` stage facade is about 21 kB gzip (`npm run measure:size` prints the exact figure;
  WebGPU only). The smallest lit-box app is about 130 kB gzip with three.js 0.186's WebGLRenderer and
  212 kB with its WebGPURenderer, built the same way ([threejs-size.json](../examples/package-benchmarks/results/threejs-size.json);
  `npm run bench -- size --engines=all` remeasures it from engine-bench). Everything else is a separate
  package that you install and import only when you use it.
- **Tuples, not classes.** Positions, colours and directions are plain arrays (`[x, y, z]`, `'#rrggbb'`). A three.js-style
  math library exists (`@margoengine/math`) and converts with `toArray()`.
- **The camera is a position and a target.** `camera.up` sets screen up (so exact top-down views work) and
  `camera.project` replaces the projection; `@margoengine/cameras` uses both for orthographic views.
- **Resize and pixel ratio are automatic.** The engine sizes its drawing buffer from the canvas's CSS size every frame.
  Desktops render with 4x MSAA at pixel ratio 1, phones single-sampled at up to 2. `@margoengine/quality` measures the
  GPU and picks a lighter tier on slow machines.
- **Colours.** `'#rrggbb'` strings are sRGB and converted to linear, as `new THREE.Color('#...')` does; number arrays are
  linear RGB. Output is tone mapped and sRGB-encoded for you.
- **Two levels of mesh.** Core meshes are position + normal geometry with a constant PBR material, instanced
  automatically. Textured meshes and loaded glTF models are drawn by `@margoengine/gltf/pbr` (through
  `@margoengine/materials` for meshes you build). Shadows, clustered lights and SSAO light core meshes automatically
  and need `add(model)` for gltf/pbr models.

## Concepts

| In three.js | In Margo |
| --- | --- |
| A renderer you create, size and call each frame | `Engine`: the canvas, the GPU device and the frame loop. It sizes itself. |
| A `Scene` you build and pass to `render` | `engine.scene` exists from the start; `engine.createMesh()` puts a mesh in it. |
| `Object3D`, `Mesh`, `Group` | One kind of mesh. Without geometry it is a transform node. |
| Any material on any mesh | Core meshes take core's constant `PbrMaterial`. Textures and the other shading models are `@margoengine/materials`, whose `createMesh` returns an object you move through its `root`. |
| A loader returns an object that you add to the scene | A loaded model is drawn as soon as the promise resolves. `model.root` moves it, `model.dispose()` removes it. |
| Add-ons you construct and update in the render loop | Plugins: `X.attach(engine, options)`. The engine updates, restores and disposes them. |
| A flag on an object (`castShadow`) or on the scene (`environment`) | Each feature has `add(meshOrModel)` for what it should affect. |
| `needsUpdate` | Live properties and setters; textures drawn from a canvas take `texture.update()`. |

## Units, handedness and colour

| Subject | Margo | Compared with three.js |
| --- | --- | --- |
| Axes | Right-handed, +Y up. A camera looks from `position` to `target`. | Same axes. |
| Length | One unit is one metre in glTF, physics, sky and the light units. A file authored in centimetres is 100 times too large: scale `model.root`. | Same convention. |
| Rotation | Radians. `mesh.rotation` is Euler XYZ (X, then Y, then Z about the turned axes); `setQuaternion([x, y, z, w])`. | Same as the default `'XYZ'` order. |
| Field of view | Degrees, vertical. | Same. |
| Light cones | `innerAngle`, `outerAngle` or `angle` with `penumbra`, in radians. | Same `angle` and `penumbra`. |
| Matrices | 16 numbers, column-major. | Same as `Matrix4.elements`. |
| Time | Seconds. The loop clamps a long frame to `engine.maxDelta` (0.1). | `Clock` does not clamp. |
| Pointer positions | Canvas CSS pixels (`engine.pick`, `Raycaster.setFromEngine`). | No conversion to -1 to 1. |
| Colour strings | `'#rrggbb'` is sRGB, converted to linear. | Same. |
| Colour arrays | `[r, g, b]` is linear. | Same as `Color.setRGB` in the working space. |
| Depth buffer (WebGPU) | Reversed: near is 1, far is 0. | Reverse the comparisons in your own shaders. |
| Light intensity | glTF's `KHR_lights_punctual` units: candela for point and spot lights, lux for directional ones, nits for area lights (`@margoengine/clustered/units`). The core sun's strength is `lighting.direction[3]` (default 3) and the ambient strength `lighting.radiance[3]` (default 0.15). | Set the numbers by comparing frames, not by copying them. |

## Install only what you import

There are three ways in: `@margoengine/core` or `@margoengine/stage` alone, a domain install profile, or
`margoengine` for every feature. For a web app, `npm create margo@latest my-app -- --template web` scaffolds a
working scene that depends on `@margoengine/kit-web`; game, viz, React and Next starters also install their own profile.
Publication is pending: the [kits guide](guides/kits.md) documents the verified private tarball route and package
counts. No release command here publishes anything.

Each row below is also available as an independent npm package. The examples later in this guide use full-install
aliases to keep the comparisons readable. With a profile, replace `margoengine/controls/orbit` with
`@margoengine/kit-web/controls/orbit`, or import `@margoengine/controls/orbit` directly if that package is installed.
All packages share a release version. A profile preserves module identity and tree-shaking; it also reduces what
npm installs. See [the starting-path review](guides/kit-migration.md) for the full install-to-frame audit.

```sh
npm install @margoengine/core                      # engine, camera, meshes, constant PBR material
npm install @margoengine/stage                     # facade plus core only
npm install @margoengine/kit-web                       # web domain profile
npm install margoengine                            # every feature package
npm install @margoengine/geometry @margoengine/materials @margoengine/gltf/pbr @margoengine/controls
```

| You use in three.js | Margo package |
| --- | --- |
| `WebGLRenderer`, `PerspectiveCamera`, `Mesh`, `MeshStandardMaterial` (colour only) | `@margoengine/core` |
| WebGL fallback | `@margoengine/webgl2-compat` (every package), `@margoengine/webgl2-compat/preview` (core meshes) |
| `BoxGeometry`, `SphereGeometry`, `ExtrudeGeometry`, `BufferGeometryUtils` | `@margoengine/geometry` |
| `TextureLoader`, `MeshStandardMaterial` with maps and the other mesh materials | `@margoengine/materials` |
| `GLTFLoader` (textured, extensions) | `@margoengine/gltf/pbr` (+ `@margoengine/decoders` for Draco, meshopt, KTX2) |
| `FBXLoader`, `USDZLoader`, `PLYLoader`/`PCDLoader`/`3MFLoader`, `STLLoader`/`OBJLoader` | `@margoengine/fbx`, `@margoengine/usdz`, `@margoengine/loaders` |
| `AnimationMixer`, skinning, morphs | `@margoengine/animation` (+ `@margoengine/animator` for blending) |
| `DirectionalLight` shadows | `@margoengine/shadows` |
| `PointLight`, `SpotLight` (and their shadows) | `@margoengine/clustered` (shadows: `@margoengine/clustered/shadows`) |
| `RectAreaLight` | `@margoengine/clustered/area` |
| `RGBELoader`, `EXRLoader`, `PMREMGenerator`, `scene.background`, `scene.fog` | `@margoengine/environment` |
| Volumetric fog and light shafts (`VolumeNodeMaterial`) | `@margoengine/environment/volumetric` |
| `Sky` add-on | `@margoengine/sky` |
| `OrbitControls`, `TransformControls`, `DragControls`, `FlyControls`, ... | `@margoengine/controls` |
| `Raycaster`, three-mesh-bvh | `@margoengine/bvh` |
| GPU picking, `OutlinePass` | `@margoengine/selection` |
| `LOD` | `@margoengine/lod` |
| `EffectComposer`, `UnrealBloomPass`, `SSAOPass`, `FXAAShader` | `@margoengine/post` |
| `BokehPass` | `@margoengine/dof` |
| `OutputPass`, tone mapping, `LUTPass` | `@margoengine/tonemap` |
| `TAARenderPass` | `@margoengine/taa` |
| TSL, node materials | `@margoengine/shader` |
| `OrthographicCamera` | `@margoengine/cameras` |
| `Line2`, `LineMaterial`, `GridHelper`, `AxesHelper` | `@margoengine/lines` |
| `vector.project(camera)`, `vector.unproject(camera)` | `projectPoint(v, engine.camera, v)`, `unprojectPoint(v, engine.camera, v)` from `@margoengine/math`, plus `worldToScreen` and `screenToWorld` for pixels. A point behind the camera returns null, and on WebGPU depth runs near = 1 to far = 0 |
| `SphericalHarmonics3` | `SH3` from `@margoengine/math` (also `@margoengine/math/sh`); `getAt`, `getIrradianceAt` and `addScaledSH` keep their names, colours are `{r, g, b}` |
| `ColorManagement.convert` | `convertColor(rgb, from, to)` from `@margoengine/math` (also `@margoengine/math/color-space`), with `SRGBColorSpace` and the other named spaces |
| `Capsule` (addons `math/Capsule.js`) | `Capsule` from `@margoengine/math` (also `@margoengine/math/capsule`); `pushOutOfTriangle` gives the move a character needs |
| `Points`, `Sprite` | `@margoengine/points` |
| troika-three-text | `@margoengine/text` |
| `CSS2DRenderer`, `CSS3DRenderer` | `@margoengine/labels` (`@margoengine/html` adds depth occlusion) |
| `Vector3`, `Matrix4`, `Quaternion`, `Color`, `Box3`, `Line3`, `Triangle`, `Cylindrical`, `OBB` (addons `math/OBB.js`) | `@margoengine/math` (each also as its own entry, such as `@margoengine/math/obb`; `Cylindrical` turns into a point with `toVector3(out)`, there is no `Vector3.setFromCylindrical`) |
| stats.js | `@margoengine/stats` |
| `renderer.info`, Spector.js, lil-gui scene inspectors | `@margoengine/inspector` (`@margoengine/inspector/frame`: frame debugger) |
| `ViewHelper` | `@margoengine/viewcube` |
| ContactShadows example (product-shot ground shadow) | `@margoengine/studio` |
| react-three-fiber | `@margoengine/react` |

Feature entries keep bundles smaller still: `@margoengine/post/ssao`, `@margoengine/post/bloom`,
`@margoengine/post/stack`, `@margoengine/post/fxaa`, `@margoengine/animation/vat`, `@margoengine/sky/base` load one feature without the rest of their package.

## Renderer, scene, camera and resize

```js
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({antialias: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 2, 5);
camera.lookAt(0, 0, 0);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop(() => renderer.render(scene, camera));
```

```ts
import {Engine} from '@margoengine/core';
import {webglRenderer} from '@margoengine/webgl2-compat/preview'; // optional: only if you want a WebGL2 fallback

const canvas = document.querySelector('canvas'); // give it a CSS size, e.g. width: 100%; height: 100vh
const engine = await Engine.create(canvas, {
  camera: {position: [0, 2, 5], target: [0, 0, 0], fov: 60, near: 0.1, far: 1000},
  fallback: webglRenderer,
});
engine.start(); // resize, pixel ratio and MSAA are handled per frame
```

Or with the stage facade, which also creates the canvas, attaches CAD-style camera controls and starts rendering:

```ts
import {createStage} from 'margoengine';
const app = await createStage('#scene'); // a container element with a height
app.box({size: [1, 1, 1], color: '#84d6bd'});
```

- `engine.camera` has `position`, `target`, `fov`, `near`, `far` and `up`. Assign a new tuple to move it
  (`engine.camera.position = [4, 3, 6]`); there is no `lookAt`, the target is the look-at point.
- `engine.camera.fitToBoundingBox(min, max, {duration: 0.3})` frames a box, animated. `@margoengine/cameras`'
  `projection.fit(model.bounds)` takes the flat bounds array and also fits orthographic views (by zoom).
- `engine.backend` is `'webgpu'` or `'webgl2'`; `engine.fallbackReason` says why WebGPU was not used.
- `capacity` (default 1,024) is the initial number of meshes and transform nodes an engine holds; `createMesh` doubles it
  when full, up to 8,388,608. Set it for big scenes to skip the doublings: `Engine.create(canvas, {capacity: 50_000})`.
- `engine.views` draws several cameras, scenes or rectangles in one frame (`ArrayCamera`, `setViewport`), and
  `engine.render({camera})` draws one alternate-camera frame. `engine.createScene()` makes further scenes, each with its
  own meshes, lighting and plugins; a view names the one it draws.

A transparent canvas over HTML and CSS, like `new THREE.WebGLRenderer({alpha: true})` with `setClearColor(0x000000, 0)`:

```ts
import {Engine} from '@margoengine/core';
import {TransparentCanvas} from '@margoengine/environment';
import {webglRenderer} from '@margoengine/webgl2-compat/preview';

const overlay = await Engine.create(canvas, {fallback: c => webglRenderer(c, {transparent: true})}); // WebGL fallback: transparent too
TransparentCanvas.attach(overlay); // WebGPU: premultiplied canvas, alpha 0 where nothing is drawn
```

FXAA, Bloom and `PostStack` keep the alpha; Tonemap and SSAO keep it with a faint rim on silhouettes; DOF, TAA,
SceneFade and the other backgrounds make the canvas opaque again (`@margoengine/post` README).

Display P3 and HDR output, like `renderer.outputColorSpace = THREE.DisplayP3ColorSpace` and the WebGPU renderer's
extended tone mapping:

```ts
import {ColorOutput} from '@margoengine/environment';
import {Tonemap} from '@margoengine/tonemap';

const output = ColorOutput.attach(engine, {gamut: 'p3', hdr: true, peak: 4}); // only where the display reports P3 / HDR
Tonemap.attach(engine, {curve: 'neutral'}); // highlights above white and colours outside sRGB come from Tonemap
console.log(output.gamut, output.hdr); // what the canvas really is ('srgb' and false on an sRGB/SDR display)
```

sRGB content looks the same on the P3 canvas (as three.js converts sRGB colours for a P3 output). There is no global
`ColorManagement` switch: colours and textures are sRGB, and `convertColor` of `@margoengine/math` converts between
named spaces (environment README, "Display P3 and HDR output").

## Meshes and geometry

```js
const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({color: '#84d6bd', roughness: 0.3}));
mesh.position.set(0, 0.5, 0);
mesh.rotation.y = Math.PI / 4;
scene.add(mesh);
const group = new THREE.Group();
group.add(mesh);
```

```ts
import {box, PbrMaterial} from '@margoengine/core';

const mesh = engine.createMesh()
  .setGeometry(box(1, 1, 1))
  .setMaterial(new PbrMaterial({color: '#84d6bd', roughness: 0.3, metalness: 0}));
mesh.position.set(0, 0.5, 0);
mesh.rotation.y = Math.PI / 4; // Euler XYZ in radians; setQuaternion([x, y, z, w]) also works
const group = engine.createMesh(); // a mesh without geometry is a transform node
mesh.setParent(group);
mesh.visible = false;
```

Every three.js primitive is in `@margoengine/geometry`, with the same parameters and defaults (vertex
order is our own and not part of the API). They return plain typed arrays; `toGeometry` hands them to core.

```js
const sphere = new THREE.SphereGeometry(1, 32, 16);
const torus = new THREE.TorusKnotGeometry(1, 0.3, 128, 16);
const shape = new THREE.Shape().moveTo(0, 0).lineTo(2, 0).lineTo(2, 1).lineTo(0, 1);
const extruded = new THREE.ExtrudeGeometry(shape, {depth: 0.4, bevelEnabled: false});
```

```ts
import {PbrMaterial} from '@margoengine/core';
import {sphereGeometry, torusKnotGeometry, planeGeometry, Shape, extrudeGeometry, mergeGeometries, toGeometry} from '@margoengine/geometry';

const sphere = toGeometry(sphereGeometry(1, 32, 16));
const torus = toGeometry(torusKnotGeometry(1, 0.3, 128, 16));
const plane = planeGeometry(10, 10); // uvs and tangents stay on the data for @margoengine/materials
const shape = new Shape([[0, 0], [2, 0], [2, 1], [0, 1]]);
const extruded = toGeometry(extrudeGeometry(shape, {depth: 0.4, bevelEnabled: false}));
engine.createMesh().setGeometry(sphere).setMaterial(new PbrMaterial({color: '#f97316'}));
```

Custom geometry: `new Geometry(positions, normals, indices)` from core. Core geometry has no UVs or vertex colours and is
immutable once attached; build a new `Geometry` to change it. For UVs, vertex colours and textures, use
`@margoengine/materials` (next section).

## Materials and textures

Core's `PbrMaterial` is colour, roughness, metalness and `doubleSided`. Textures, transparency and the other shading
models come from `@margoengine/materials`, which draws through gltf/pbr (WebGPU only).

Core materials are live, like three.js's `material.color.set(...)`: `set` changes the given values in place and every
mesh using the material shows them on the next frame (no new material, pipeline or bind group).

```js
mesh.material.color.set('#ff8800');
mesh.material.roughness = 0.2;
```

```ts
import {PbrMaterial} from '@margoengine/core';

const paint = new PbrMaterial({color: '#84d6bd'});
mesh.setMaterial(paint);
paint.set({color: '#ff8800', roughness: 0.2}); // omitted values keep theirs; invalid input throws and changes nothing
```

```js
const map = new THREE.TextureLoader().load('/crate.jpg');
map.colorSpace = THREE.SRGBColorSpace;
map.wrapS = map.wrapT = THREE.RepeatWrapping;
map.repeat.set(2, 2);
const crate = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({map, normalMap, roughness: 0.7}));
const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), new THREE.MeshBasicMaterial({map: new THREE.VideoTexture(video)}));
const glass = new THREE.MeshStandardMaterial({color: '#88ccff', transparent: true, opacity: 0.4, side: THREE.DoubleSide});
```

```ts
import {boxGeometry, planeGeometry} from '@margoengine/geometry';
import {loadTexture, Texture, PbrMaterial, UnlitMaterial, createMesh} from '@margoengine/materials';

const map = await loadTexture('/crate.jpg', {wrapS: 'repeat', wrapT: 'repeat', anisotropy: 8}); // colour maps read sRGB
const normalMap = await loadTexture('/crate-normal.png');                                        // other slots linear
const crate = createMesh(engine, boxGeometry(1, 1, 1), new PbrMaterial({
  map, normalMap, roughness: 0.7,
  uvTransform: {offset: [0, 0], scale: [2, 2], rotation: 0}, // map.repeat / offset / rotation
}));
crate.root.setPosition([0, 0.5, 0]);
const video = document.querySelector('video');
createMesh(engine, planeGeometry(1.6, 0.9), new UnlitMaterial({map: new Texture(video)}));
const glass = new PbrMaterial({color: '#88ccff', transparent: true, opacity: 0.4, side: 'double'});
createMesh(engine, planeGeometry(2, 2), glass, {renderOrder: 1});
glass.opacity = 0.6; // colours, scalars and maps are live
```

One class per three.js mesh material, each a `Material` with its shading fixed (`new Material({shading})` also works):

| three.js | `@margoengine/materials` |
| --- | --- |
| `MeshBasicMaterial` | `UnlitMaterial` |
| `MeshLambertMaterial` | `LambertMaterial` |
| `MeshPhongMaterial` | `PhongMaterial` (`specular`, `shininess`) |
| `MeshStandardMaterial`, `MeshPhysicalMaterial` | `PbrMaterial` (maps and physical options) |
| `MeshNormalMaterial` | `NormalMaterial` |
| `MeshMatcapMaterial` | `MatcapMaterial` (`matcap`) |
| `MeshDepthMaterial`, `MeshDistanceMaterial` | `DepthMaterial`, `DistanceMaterial` |
| `ShadowMaterial` | `ShadowCatcherMaterial` (`color`, `opacity`; sun and clustered local shadows) |

`PbrMaterial` takes core `PbrMaterial`'s options with the same meaning; its defaults match three.js's standard
material (white, roughness 1, metalness 0, front side), so a textured one needs no extra options.

Materials are used like three.js materials after the mesh exists:

```js
mesh.material = other;
mesh.material.color.set(0xff0000);
material.blending = THREE.AdditiveBlending; material.depthWrite = false; material.wireframe = true;
texture.magFilter = THREE.NearestFilter;
mesh.renderOrder = 2;
const copy = material.clone(); material.dispose();
```

```ts
import {boxGeometry} from '@margoengine/geometry';
import {PbrMaterial, PhongMaterial, Texture, createMesh} from '@margoengine/materials';

const atlas = new Texture(new OffscreenCanvas(256, 256));
const paint = new PhongMaterial({color: 0x84d6bd, shininess: 40});
const box = createMesh(engine, boxGeometry(1, 1, 1), paint);
box.material.color.set(0xff0000);  // or paint.color = '#f00': strings and numbers are sRGB, arrays linear
paint.blending = 'additive';        // render state is live: the next frame uses the matching pipeline
paint.depthWrite = false;
paint.wireframe = true;
box.material = new PbrMaterial({map: atlas}); // a live swap: shadows, lights, skin and picking stay
box.renderOrder = 2;
atlas.magFilter = 'nearest';        // sampler options apply next frame; flipY, colorSpace, mipmaps on atlas.update()
const variant = paint.clone();      // same class and values, textures shared
variant.copy(paint);                // same shading: copies every value in place
paint.dispose();                    // frees what no mesh uses; createMesh with it now throws
```

- Maps: `map`, `normalMap`, `metalRoughnessMap` (glTF packing), `aoMap`, `emissiveMap`, `alphaMap` (green channel),
  `bumpMap` with `bumpScale`, `displacementMap` with `displacementScale` and `displacementBias` (shadow maps displace
  too), `lightMap` with `lightMapIntensity` (UV1), and the physical maps below. `emissiveIntensity` scales `emissive`
  (glTF export: `KHR_materials_emissive_strength`). `flatShading: true` shades with face normals.
  `vertexColors` defaults to true here (geometry colours always multiplied); set false to ignore them. `fog: false`
  and `toneMapped: false` work per material on lit shadings (unlit output is never fogged or tone mapped).
  Built in where three.js needs a custom shader: `parallaxMap` (parallax occlusion or relief mapping, `parallaxScale`
  in world units), `triplanar: true` (world-space projection, no UVs needed) and `subsurface` (thick or thin
  subsurface scattering, with `subsurfaceThicknessMap`); each compiles in only while used.
  Render state, live: `transparent`, `alphaTest`, `blending` (`'normal'`, `'additive'`, `'multiply'`, `'none'`),
  `depthWrite`, `depthTest`, `colorWrite`, `polygonOffset*`, the stencil options and `wireframe`.
- A grouped mesh's `mesh.material` is a frozen array; assign a new array of the same length to swap it.
- `Texture` takes an image, bitmap, canvas, video, `ImageData` or `{data, width, height}` (DataTexture). Call
  `texture.update()` after drawing to a canvas (CanvasTexture `needsUpdate`); videos re-upload by themselves.
- UV transforms follow glTF `KHR_texture_transform` (rotation about the UV origin, no `center`). One slot:
  `material.setUVTransform({offset: [0.5, 0], scale: [0.5, 0.5], rotation: 0}, 'normalMap')`.
- Supply a real second UV set as `geometry.uvs1`; omitted UV1 copies UV0. Select it per map with
  `material.setUVTransform({texCoord: 1}, 'aoMap')`. Pass `geometry.groups` (`start`, `count`, `materialIndex`) and a
  material array to `createMesh` or `createInstancedMesh` for multiple materials under one model/root. Ranges count
  indices (vertices for nonindexed geometry), contain complete triangles and cannot overlap; gaps are not drawn.
- Atlases: `packAtlas(images)` returns one image and a `uvTransform` per input, so many textured meshes can share one
  texture or be merged into one draw.
- Transparent meshes sort per mesh like three.js, so overlapping ones can pop as the camera moves. Order-independent
  transparency (weighted blended, an approximation; see `packages/oit/README.md`) fixes that for materials meshes and
  glTF BLEND materials:

```ts
import {OIT} from '@margoengine/oit';
import {planeGeometry} from '@margoengine/geometry';
import {Material, createMesh} from '@margoengine/materials';

const oit = OIT.attach(engine);
const pane = createMesh(engine, planeGeometry(2, 2), new Material({color: '#88ccff', transparent: true, opacity: 0.4, doubleSided: true}));
oit.add(pane);  // and oit.add(model) for a loaded glTF's BLEND primitives
```

- `MeshPhysicalMaterial`: physical options on `PbrMaterial` (`clearcoat`, `clearcoatRoughness`, `sheenColor`,
  `sheenRoughness`, `specularIntensity`, `specularColor`, `anisotropy`, `iridescence`, `ior`, `dispersion`,
  `transmission`, `thickness`, `attenuationColor`, `attenuationDistance`) and their maps (`clearcoatMap`,
  `sheenColorMap`, `transmissionMap`, `thicknessMap`, ...). Set one at any time and that material switches to the
  physical shader; materials that never use them keep the plain one. Glass refracts with
  `Transmission.attach(engine).add(mesh)` from `@margoengine/materials/transmission` (needs an HDR post capture such as
  `PostStack` with `Tonemap`); without it the background shows through tinted.
- `ShaderMaterial` / `onBeforeCompile`: `WgslMaterial` runs your WGSL `fn shade(i: Out, s: Surface) -> Surface`
  (and optionally `fn displace(i: Input) -> vec3f`) inside the PBR shader, with live `uniforms` and `textures`; the
  chosen `shading` still lights it. Node graphs: `NodeMaterial` (`@margoengine/shader`), below.
- Arbitrary named vertex attributes need `RawShaderMaterial` (`@margoengine/shader/raw`); your own per-instance values
  on a built-in material are `instanceAttributes` (`@margoengine/materials/instance-attributes`), read by a material
  plugin.

## Lights and shadows

Core has one directional light plus a constant ambient term, both on `engine.lighting`.

```js
const sun = new THREE.DirectionalLight('#fff4e5', 3);
sun.position.set(3, 5, 4);
sun.castShadow = true;
scene.add(sun, new THREE.AmbientLight('#ffffff', 0.15));
renderer.shadowMap.enabled = true;
mesh.castShadow = mesh.receiveShadow = true;
const lamp = new THREE.PointLight('#ff6020', 20, 12);
lamp.position.set(0, 2, 1);
scene.add(lamp);
```

```ts
import {Shadows} from '@margoengine/shadows';
import {Clustered} from '@margoengine/clustered';

const {lighting} = engine;
lighting.direction.set([3, 5, 4, 3]);        // xyz: direction toward the light, w: intensity
lighting.radiance.set([1, 0.96, 0.9, 0.15]); // rgb: light colour (linear), w: ambient intensity

const shadows = Shadows.attach(engine, {resolution: 2048, distance: 100}); // follows the directional light
shadows.add(mesh);                           // casters; core meshes receive automatically
shadows.add(model);                          // gltf/pbr models cast and receive once added

const lights = Clustered.attach(engine);     // up to 1,024 point and spot lights
lights.setLights([
  {position: [0, 2, 1], range: 12, color: [1, 0.3, 0.1], intensity: 20},
  {position: [2, 3, 0], range: 15, direction: [0, -1, 0], innerAngle: 0.3, outerAngle: 0.7, color: [0.1, 0.3, 1], intensity: 30},
]);
lights.add(model);                           // core meshes are lit automatically
```

- Shadows are four cascades with PCSS soft edges; `shadows.add(mesh, {static: true})` caches casters that never move.
- `setLights` replaces the whole list; call it again to animate lights.
- More directional lights are `DirectionalLights` (`@margoengine/clustered/directional`), `HemisphereLight` and
  `AmbientLight` are in `@margoengine/environment` (without them glTF models get a fixed sky/ground ambient fill),
  and IES profiles are `@margoengine/clustered/ies`. Rect area lights are below; image-based ambient light is the next
  section.

Point and spot light shadows (three.js `lamp.castShadow = true`) are the optional `@margoengine/clustered/shadows` entry.
Flag the lights, attach `LocalShadows` to the clustered lights and add the casters (core meshes included, unlike
directional shadows); everything clustered lights receives the shadows:

```ts
import {Clustered} from '@margoengine/clustered';
import {LocalShadows} from '@margoengine/clustered/shadows';

const lamps = Clustered.attach(engine);
const lampShadows = LocalShadows.attach(engine, {lights: lamps, maxLights: 4, resolution: 512});
lampShadows.add(mesh);                        // casters: core meshes, gltf/pbr models, materials meshes
lampShadows.add(model);
lamps.add(model);                             // receivers, as for unshadowed local light
lamps.setLights([
  {position: [0, 2, 1], range: 12, intensity: 20, castShadow: true},
  {position: [2, 3, 0], range: 15, direction: [0, -1, 0], outerAngle: 0.7, intensity: 30, castShadow: true},
]);
```

- A point light uses six 512² cube-face layers, a spot light one; the first `maxLights` flagged lights get them.
- Maps are cached and re-render only when their light or a caster moves; add skinned models with `{dynamic: true}`.

Rectangle area lights (three.js `RectAreaLight` plus `RectAreaLightUniformsLib.init()`) are the optional
`@margoengine/clustered/area` entry, on top of the clustered lights:

```js
RectAreaLightUniformsLib.init();
const panel = new THREE.RectAreaLight('#fff2e0', 8, 1.6, 0.6); // colour, intensity (nits), width, height
panel.position.set(0, 2.5, 0);
panel.lookAt(0, 0, 0);
scene.add(panel);
```

```ts
import {Clustered} from '@margoengine/clustered';
import {AreaLights} from '@margoengine/clustered/area';

const local = Clustered.attach(engine);
const panels = AreaLights.attach(engine, {lights: local});
panels.setLights([
  {position: [0, 2.5, 0], direction: [0, -1, 0], width: 1.6, height: 0.6, color: [1, 0.95, 0.88], intensity: 8},
  {position: [3, 1, 0], direction: [-1, 0, 0], up: [0, 1, 0], width: 0.4, height: 2, intensity: 4, twoSided: true},
]);
local.add(model);                             // receivers, as for point and spot lights
```

- `direction` is the side the panel lights (three.js's `lookAt` target minus position); `up` turns it about that axis.
- `intensity` is radiance, as three.js's; colours are linear. No shadows from area lights.

The soft ground shadow of product shots (three.js's ContactShadows example: a depth render from below, blurred, on a
plane) is `@margoengine/studio`. It needs no light and works with or without `Shadows`:

```ts
import {ContactShadows} from '@margoengine/studio';

const contact = ContactShadows.attach(engine, {opacity: 0.6, blur: 0.08});
contact.fit(model.bounds); // under the model: ground at its lowest point, plane twice its footprint
contact.add(model);        // gltf/pbr models, materials meshes and core meshes
```

## Environment, background and fog

```js
import {RGBELoader} from 'three/addons/loaders/RGBELoader.js';
const hdr = await new RGBELoader().loadAsync('/studio.hdr');
hdr.mapping = THREE.EquirectangularReflectionMapping;
scene.environment = hdr;
scene.background = hdr;
scene.backgroundBlurriness = 0.2;
// or
scene.background = new THREE.Color('#bcd4e6');
scene.fog = new THREE.Fog('#bcd4e6', 10, 80);
```

```ts
import {Environment, EnvironmentBackground, EnvironmentLighting, ColorBackground, Fog, loadEnvironmentImage} from '@margoengine/environment';

const image = await loadEnvironmentImage('/studio.hdr'); // .hdr, .exr or UltraHDR .jpg
const environment = await Environment.attach(engine, image, {rotation: 0.5});
EnvironmentBackground.attach(engine, environment, {blur: 0.2});
const ibl = EnvironmentLighting.attach(engine, environment); // core meshes
ibl.add(model);                                              // gltf/pbr models

// Or a plain colour and fog:
ColorBackground.attach(engine, {color: '#bcd4e6'});
const fog = Fog.attach(engine, {color: '#bcd4e6', near: 10, far: 80}); // {density: 0.02} for FogExp2
fog.add(model);
fog.far = 120;            // options are live properties
```

Volumetric fog with light shafts (three's `webgpu_volume_lighting` example, `VolumeNodeMaterial`) is the optional
`@margoengine/environment/volumetric` entry. It replaces `Fog` (it throws while an enabled `Fog` is attached) and needs a
post capture such as `Tonemap` for the scene depth:

```ts
import {Tonemap} from '@margoengine/tonemap';
import {Shadows} from '@margoengine/shadows';
import {Clustered} from '@margoengine/clustered';
import {VolumetricFog} from '@margoengine/environment/volumetric';

Tonemap.attach(engine);
const shadows = Shadows.attach(engine);                 // the sun's shadows cut light shafts
const lights = Clustered.attach(engine);                // point and spot lights glow in the fog
VolumetricFog.attach(engine, {density: 0.03, heightFalloff: 0.2, anisotropy: 0.6, shadows, lights});
```

- IBL replaces the constant ambient term with prefiltered specular and spherical-harmonic diffuse. SSAO darkens it.
- A physical sky with sun, clouds, stars and its own fog is `@margoengine/sky`:
  `Sky.attach(engine, {model: 'bruneton', hours: 17})`.

## Loading models

### glTF

```js
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));
const gltf = await loader.loadAsync('/helmet.glb');
scene.add(gltf.scene);
gltf.scene.position.set(0, 1, 0);
```

```ts
import {loadGLTF} from '@margoengine/gltf/pbr';
import {DracoDecoder, KTX2Decoder, MeshoptDecoder} from '@margoengine/decoders';
import {engineRuntime} from '@margoengine/core/extension';

const model = await loadGLTF(engine, '/helmet.glb'); // drawn as soon as it resolves
model.root.setPosition([0, 1, 0]);
const b = model.bounds;
engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);

// Compressed files: pass decoders in, so uncompressed loads pay nothing for them.
const decoders = {draco: new DracoDecoder(), meshopt: MeshoptDecoder, ktx2: new KTX2Decoder({device: engineRuntime(engine).gpu})};
const packed = await loadGLTF(engine, '/gltfpack-output.glb', {decoders});
```

Big files: three.js shows nothing until `GLTFLoader` has the whole file. `loadGLTFProgressive` resolves `ready` as soon as
the JSON is parsed, with one box per part, then streams the real geometry (what is on screen and large first) and the
textures, without frame hitches; `complete` is the same model `loadGLTF` would have built.

```ts
import {loadGLTFProgressive} from '@margoengine/gltf/progressive';

const load = loadGLTFProgressive(engine, '/factory.glb', {onProgress: p => console.log(p.stage, p.primitivesLoaded, p.primitives)});
const model = await load.ready; // boxes with the real bounds: fit and orbit right away
const b = model.bounds;
engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]);
await load.complete;            // every part, texture and byte; load.abort() cancels and disposes
```

- `model.nodes` are the glTF nodes (core meshes you can move or hide), `model.primitives` the drawn parts,
  `model.lights` and `model.cameras` the `KHR_lights_punctual` lights and glTF cameras as data.
- Supported extensions include `KHR_texture_transform`, `KHR_materials_*` (emissive strength, unlit, clearcoat,
  transmission, refracting with `@margoengine/materials/transmission`, IOR, volume, sheen, specular), `KHR_lights_punctual`, `KHR_mesh_quantization`, Draco,
  meshopt, KTX2, WebP and AVIF.
- `@margoengine/gltf` is a smaller loader for untextured constant-colour glTF that also works on WebGL2.

### FBX, USD, OBJ, STL and point clouds

```js
const fbx = await new FBXLoader().loadAsync('/character.fbx');
const usd = await new USDZLoader().loadAsync('/chair.usdz');
const stl = await new STLLoader().loadAsync('/part.stl');
const ply = await new PLYLoader().loadAsync('/scan.ply');
```

```ts
import {loadFBX} from '@margoengine/fbx';
import {loadUSDZ} from '@margoengine/usdz';
import {parsePLY, parseSTL, createMeshes} from '@margoengine/loaders';

const character = await loadFBX(engine, '/character.fbx');  // skins, morphs and clips; a gltf/pbr model
const chair = await loadUSDZ(engine, '/chair.usdz');        // static USDA/USDC/USDZ
const raw = parseSTL(await (await fetch('/part.stl')).arrayBuffer()); // STL as plain typed arrays, like STLLoader
const scan = createMeshes(engine, parsePLY(await (await fetch('/scan.ply')).arrayBuffer()));
```

The stage facade frames what it loads: `await addGLTF(app, '/model.glb')` (`margoengine/stage/gltf`) handles glTF with constant colours. `@margoengine/loaders` also parses 3MF, PCD, XYZ, OFF and legacy VTK. Textured OBJ with its MTL loads in one call with `loadOBJ` from `@margoengine/loaders/mtl`; Collada reads geometry,
materials, the hierarchy, skins, morph targets and animation (`parseDAE`).

### Caching and offline (`THREE.Cache`)

```js
THREE.Cache.enabled = true; // in-memory, this page only
```

```ts
import {AssetCache} from '@margoengine/cache';
import {loadGLTF} from '@margoengine/gltf/pbr';

// IndexedDB: survives reloads, works offline, revalidates with ETag/Last-Modified, LRU within maxBytes.
const cache = new AssetCache({name: 'plant-viewer', version: '2026.10', maxBytes: 2 ** 30});
const line = await loadGLTF(engine, '/line-4.glb', {fetch: cache.fetch});
```

Every loader (gltf/pbr, fbx, usdz, `@margoengine/loaders`) takes the same `fetch` option.

## Animation

```js
const mixer = new THREE.AnimationMixer(gltf.scene);
const walk = mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, 'Walking'));
walk.play();
walk.crossFadeTo(mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, 'Running')), 0.3);
mesh.morphTargetInfluences[0] = 1;
renderer.setAnimationLoop(() => { mixer.update(clock.getDelta()); renderer.render(scene, camera); });
```

```ts
import {Animation} from '@margoengine/animation';
import {Animator} from '@margoengine/animator';

const animation = Animation.attach(model); // skinning and morphs run in a compute pass, advanced by the engine
animation.play('Walking');                 // by name or index; one clip at a time
animation.seek(0.5);
animation.playing = false;
animation.setMorph(0, 0, 1);               // glTF node index, target index, weight

// Cross-fades, blend trees and additive layers:
const animator = Animator.attach(animation, {
  initial: 'move', parameters: {speed: 0, jump: 0},
  states: {move: {parameter: 'speed', samples: [{value: 0, clip: 'Idle'}, {value: 1, clip: 'Walking'}, {value: 3, clip: 'Running'}]}, jump: 'Jump'},
  transitions: [{from: 'move', to: 'jump', when: p => p.jump > 0, duration: 0.2}],
});
animator.parameters.speed = 2;
```

Code written around three.js actions keeps its shape with `AnimationMixer` (`@margoengine/animation/mixer`), which
blends several clips at once. Attached to the engine it is advanced for you; there is no `mixer.update` call:

```ts
import {AnimationMixer, LoopOnce} from '@margoengine/animation/mixer';

const mixer = AnimationMixer.attach(engine, model);
const idle = mixer.clipAction('Idle').play();
const wave = mixer.clipAction('Wave').setLoop(LoopOnce);
wave.clampWhenFinished = true;
wave.play();
idle.crossFadeTo(wave, 0.3);
mixer.timeScale = 0.5;
```

Crowds with vertex animation textures (three.js has no built-in): bake clips once, then draw thousands of animated
copies in one instanced call.

```ts
import {Animation} from '@margoengine/animation';
import {bakeVAT, VATCrowd} from '@margoengine/animation/vat';

const vat = bakeVAT(new Animation(model), {fps: 30, clips: ['Walking', 'Running']});
const crowd = VATCrowd.attach(engine, vat, {roughness: 0.6});
for (let i = 0; i < 1000; i++) {
  crowd.add({matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i % 40) * 2, 0, Math.floor(i / 40) * 2, 1], clip: i % 2, offset: Math.random(), speed: 1});
}
```

Skins and clips come from glTF (or FBX). Clips authored in code (`createKeyframeClip`) take node TRS and morph-weight tracks;
`@margoengine/animation/skeleton-utils` clones and retargets (`cloneModel`, `Retarget`), `AnimationGroup` drives many
models with one clip, and animator has CCD chains and two-bone foot IK.

### Exporting glTF

```js
const exporter = new GLTFExporter();
const glb = await exporter.parseAsync(gltf.scene, {binary: true, animations: gltf.animations, maxTextureSize: 2048});
```

```ts
import {Animation} from '@margoengine/animation';
import {exportModel} from '@margoengine/exporters/model';

const clips = new Animation(model);
const glb = await exportModel(model, {binary: true, animations: [clips], maxTextureSize: 2048}); // Uint8Array
const {text, bin} = await exportModel([model], {embed: false, binUri: 'scene.bin'});          // .gltf + .bin
```

`exportModel` writes gltf/pbr models and `@margoengine/materials` meshes with their current pose, visibility and
material values: skins, morph targets, clips, `EXT_mesh_gpu_instancing`, PBR textures and the KHR material extensions
gltf/pbr draws. Core meshes and plain data go through `exportGLB(engine)` / `exportGLTF(engine)` (static). Cameras and
lights are not written.

## Controls

```js
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.attach(mesh);
gizmo.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; });
scene.add(gizmo.getHelper());
// and orbit.update() every frame
```

```ts
import {OrbitControls, TransformControls, DragControls} from '@margoengine/controls';

const drag = DragControls.attach(engine, [mesh, model]); // create before OrbitControls so a grab stops the orbit
drag.plane = [0, 1, 0];                               // slide on the ground
const orbit = OrbitControls.attach(engine);              // attaches to engine.canvas and updates before each render
orbit.enableDamping = true;
const gizmo = TransformControls.attach(engine, {mode: 'translate', translationSnap: 0.25});
gizmo.attach(mesh);
gizmo.addEventListener('dragging-changed', event => { orbit.enabled = !event.value; });
```

three.js has no CAD navigation presets. Margo's OrbitControls takes one in a call (SolidWorks, AutoCAD, Inventor/Fusion,
Blender, Maya, Onshape, Rhino; `MARGO` is the default), each a separate tree-shakable export; bindings table in
the `@margoengine/controls` README:

```ts
import {OrbitControls, BLENDER} from '@margoengine/controls';
import {ViewCube} from '@margoengine/viewcube';

const nav = OrbitControls.attach(engine).setProfile(BLENDER); // middle orbits, Shift pans, Ctrl zooms
nav.listenToKeyEvents(window);                                // numpad views, numpad 5 persp/ortho, Home fits
nav.addEventListener('fit', () => engine.camera.fitToBoundingBox([-1, -1, -1], [1, 1, 1])); // your bounds
ViewCube.attach(engine, {...BLENDER.viewCube});               // clicking the current view flips to the opposite
```

- Also `MapControls`, `TrackballControls`, `FlyControls`, `FirstPersonControls` and `PointerLockControls`, with three.js
  option names. The stage has `CADCameraControls` (orbit about a pivot, pan, smooth zoom), which `createStage` attaches.
- Without an engine, pass a camera and an element and call `update(delta)` yourself:
  `new FlyControls(engine.camera, canvas)`.
- `ViewCube.attach(engine)` from `@margoengine/viewcube` replaces `ViewHelper` (click a face to turn the view).
- `ArcballControls` (`@margoengine/controls/arcball`) rolls the camera and goes over the poles; the other controls do
  not roll it.

`WalkControls` of `@margoengine/controls` takes `airControl` (default 0.3), about the share of acceleration the
`games_fps` example gives the player in the air.

## Raycasting and picking

```js
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
canvas.addEventListener('pointerdown', event => {
  pointer.set(event.offsetX / canvas.clientWidth * 2 - 1, -(event.offsetY / canvas.clientHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const [hit] = raycaster.intersectObjects(scene.children, true);
  if (hit) console.log(hit.object, hit.point, hit.uv);
});
```

```ts
import {Raycaster} from '@margoengine/bvh';
import {Picking, Selection} from '@margoengine/selection';

// CPU rays against a BVH (three-mesh-bvh built in). Takes canvas CSS pixels.
const raycaster = new Raycaster();
canvas.addEventListener('pointerdown', event => {
  raycaster.setFromEngine(engine, event.offsetX, event.offsetY);
  const [hit] = raycaster.intersectEngine(engine); // core meshes and loaded models, nearest first
  if (hit) console.log(hit.mesh, hit.point, hit.model, hit.uv);
});

// GPU picking: what is drawn under the pixel, including skinned poses. Async.
const picking = Picking.attach(engine);
const selection = Selection.attach(engine, {width: 3, color: [1, 0.5, 0], xray: true}); // OutlinePass; xray: hidden parts dashed
canvas.addEventListener('click', async event => {
  const hit = await picking.pick(event.offsetX, event.offsetY);
  selection.set(hit ? [hit.mesh] : []);
});
```

`raycaster.intersectObjects(engine, [mesh, model])` tests a list. A skinned or morphing model is hit at its current
pose by the same synchronous calls: `Animation` (with `MorphWeightPlayer` weights too), `Skin`, `GeometryCachePlayer`
and `BatchedMesh` pose it on the CPU for the ray, dual quaternion skins included. A deformer with no CPU pose (a `skinning` mode of your own with no `blend`) makes them throw rather than test
the bind pose: `await raycaster.intersectModel(model)` reads the posed surface back, as does GPU picking. Lines are picked by `intersectLines` (`@margoengine/bvh/lines`), or on the GPU after
`LinePicking.attach(picking, lines)` (`@margoengine/lines/pick`); points have `pointsPlugin.pick(x, y)`.

## Instancing

```js
const instanced = new THREE.InstancedMesh(geometry, material, 1000);
for (let i = 0; i < 1000; i++) { matrix.setPosition(i % 40, 0, Math.floor(i / 40)); instanced.setMatrixAt(i, matrix); }
instanced.instanceMatrix.needsUpdate = true;
```

```ts
import {box, PbrMaterial} from '@margoengine/core';

const shared = box(0.5, 0.5, 0.5); // meshes sharing one Geometry are drawn in one instanced call
for (let i = 0; i < 1000; i++) {
  engine.createMesh()
    .setGeometry(shared)
    .setMaterial(new PbrMaterial({color: i % 2 ? '#84d6bd' : '#ffa76c'})) // per-instance material factors are allowed
    .setPosition([i % 40, 0, Math.floor(i / 40)]);
}
```

Core instances automatically: each instance is a full mesh (its own transform, visibility, picking) and counts toward
`capacity`. Textured meshes use `createInstancedMesh`, the counterpart of `InstancedMesh`: one draw, one engine
entity, per-instance matrix, tint and atlas region.

```ts
import {boxGeometry} from '@margoengine/geometry';
import {Material, Texture, createInstancedMesh, packAtlas} from '@margoengine/materials';
import {Matrix4} from '@margoengine/math/matrix4';

const images = ['#c08040', '#4080c0'].map((colour) => {
  const context = new OffscreenCanvas(64, 64).getContext('2d')!;
  context.fillStyle = colour;
  context.fillRect(0, 0, 64, 64);
  return context.getImageData(0, 0, 64, 64);
});
const atlas = packAtlas(images);
const crates = createInstancedMesh(engine, boxGeometry(0.5, 0.5, 0.5), new Material({map: new Texture(atlas.image)}), 1000);
const matrix = new Matrix4();
for (let i = 0; i < 1000; i++) {
  matrix.makeTranslation(i % 40, 0, Math.floor(i / 40));
  crates.instances
    .setMatrixAt(i, matrix.elements)                     // relative to crates.root; uploads on the next frame
    .setColorAt(i, [1, 0.8 + 0.2 * Math.random(), 1])   // linear RGB, multiplies the map like a vertex colour
    .setUVTransformAt(i, atlas.regions[i % images.length]); // per-instance atlas region
}
crates.instances.count = 600; // draw the first 600
// After writing crates.instances.data directly: crates.instances.needsUpdate = true;
```

Shadows, clustered lights, IBL, fog and SSAO take `crates` like any materials mesh; `Raycaster` and `Picking` hits
carry `instanceId`. A loaded model instances the same way (`new PBRInstances(n)` on `primitive.instances`, matrices in
the primitive's node space). Instancing lives in its own entry, `@margoengine/gltf/pbr-instancing`, so apps that never
instance do not load it; `EXT_mesh_gpu_instancing` files load instanced when its reader is passed like a decoder (a
file that requires the extension is rejected without it):

```ts
import {loadGLTF} from '@margoengine/gltf/pbr';
import {PBRInstances, instancing} from '@margoengine/gltf/pbr-instancing';

const city = await loadGLTF(engine, '/instanced-city.glb', {decoders: {instancing}});
const tree = await loadGLTF(engine, '/tree.glb'), forest = new PBRInstances(500);
for (let i = 0; i < 500; i++) forest.setMatrixAt(i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i % 25 * 4, 0, Math.floor(i / 25) * 4, 1]);
for (const primitive of tree.primitives) primitive.instances = forest;
```

Not per instance: frustum culling and sorting of transparent instances (`MeshletMesh` of
`@margoengine/culling/meshlets` culls instances on the GPU). `BatchedMesh`, many different geometries in one draw, is
`BatchedMesh.attach(engine, material, options)` from `@margoengine/materials/batched`.

## LOD and imposters

```js
const lod = new THREE.LOD();
lod.addLevel(high, 0);
lod.addLevel(low, 50);
scene.add(lod);
```

```ts
import {box, Geometry} from '@margoengine/core';
import {LODSystem, Imposter} from '@margoengine/lod';

const high: Geometry = box(), low: Geometry = box();
const lods = LODSystem.attach(engine, {hysteresis: 0.1});
const imposter = Imposter.bake(engine, model); // octahedral imposter, baked once on the GPU
lods.add(mesh, [
  {object: high},                    // Geometry levels swap the mesh's geometry
  {object: low, distance: 50},
  {object: imposter, distance: 150}, // every imposter of one atlas is one instanced draw
  {object: null, distance: 1000},    // hidden beyond 1 km
]);
```

Levels can also be meshes or models (their visibility is toggled) and can switch by `screen` size instead of
distance. Imposters are picked approximately (bounding sphere) and cast no shadows.

## Post-processing

```js
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {SSAOPass} from 'three/addons/postprocessing/SSAOPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {FXAAShader} from 'three/addons/shaders/FXAAShader.js';
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new SSAOPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.4, 0.85));
composer.addPass(new OutputPass());
composer.addPass(new ShaderPass(FXAAShader));
// and composer.render() instead of renderer.render()
```

```ts
import {PostStack} from '@margoengine/post/stack';
import {SSAO} from '@margoengine/post/ssao';
import {Bloom} from '@margoengine/post/bloom';
import {FXAA} from '@margoengine/post/fxaa';
import {DOF} from '@margoengine/dof';
import {Tonemap} from '@margoengine/tonemap';

const ssao = new SSAO({radius: 0.5});
const stack = PostStack.attach(engine, [
  ssao,                             // HDR effects first, SSAO before the others
  new DOF({focalDistance: 6}),
  new Bloom({strength: 0.6}),
  new Tonemap({curve: 'agx'}),      // one display effect (OutputPass)
  new FXAA(),                       // LDR effects last
]);
ssao.add(model);                    // gltf/pbr models join SSAO's normals; core meshes are automatic
```

Changing the chain later: `composer.addPass(pass)` is `stack.addEffect(effect)` (placed after the last effect of its
kind), `insertPass(pass, index)` is `stack.addEffect(effect, index)`, `removePass(pass)` is `stack.removeEffect(effect)`
(it also disposes the effect), and `composer.passes` is `stack.effects`. `stack.moveEffect(effect, index)` reorders
without disposing. Nothing else recompiles: only the added effect builds its pipelines.

Temporal anti-aliasing instead of FXAA: leave `FXAA` out of the stack and wrap the stack with TAA.

```ts
import {PostStack} from '@margoengine/post/stack';
import {Bloom} from '@margoengine/post/bloom';
import {TAA} from '@margoengine/taa';

const stack = PostStack.attach(engine, [new Bloom({strength: 0.6})]);
TAA.attach(engine, {depth: () => stack.depthTexture});
```

Screen-space reflections (three.js `SSRPass`) are an HDR effect in the same stack, after SSAO and before DOF/Bloom:

```js
import {SSRPass} from 'three/addons/postprocessing/SSRPass.js';
composer.addPass(new SSRPass({renderer, scene, camera, width: innerWidth, height: innerHeight}));
```

```ts
import {PostStack} from '@margoengine/post/stack';
import {SSAO} from '@margoengine/post/ssao';
import {SSR} from '@margoengine/post/ssr';
import {Bloom} from '@margoengine/post/bloom';

const ssr = new SSR({maxRoughness: 0.6});   // rougher surfaces keep the environment reflection only
PostStack.attach(engine, [new SSAO(), ssr, new Bloom({strength: 0.6})]);
const stop = ssr.add(model);                // a glTF PBR model (or materials mesh) reflects too; stop() undoes it
ssr.enabled = false;                        // toggles without recompiling; SSR.attach(engine) runs it alone
```

- Glossy core meshes (`PbrMaterial` roughness below `maxRoughness`) reflect what is on screen; with `EnvironmentLighting`
  SSR replaces the IBL specular where a ray hits and keeps it where it misses (off-screen, behind objects). glTF PBR
  models and `@margoengine/materials` meshes reflect once added with `ssr.add(model)` (with their own maps); water and
  terrain are reflected but do not reflect. No `groundReflector`/`selects`: every glossy core mesh and added model reflects.
- The stack captures the scene once in linear HDR and runs the effects in array order. The engine renders it; there is
  no `composer.render()`.
- A single effect can also be attached alone, for example `Bloom.attach(engine, {strength: 0.8})`.
- Custom full-screen effects are `NodePass`es from `@margoengine/shader` (next section).
- `Tonemap` curves are `'agx'`, `'acescg'`, `'neutral'`, `'reinhard'`, `'cineon'` and `'linear'`, with exposure in
  stops and `.cube` LUTs (`setLUT`).
- `AsciiEffect` is `ASCII` in `@margoengine/post/ascii`: `resolution` becomes `cellSize` in pixels, `block` is
  `background: 'scene'`, and `await ascii.text()` gives the characters.
- SMAA (`@margoengine/post/smaa`), GTAO, motion blur, glitch (`/glitch`) and afterimage (`/afterimage`) are in post;
  vignette, RGB shift, chromatic aberration, pixelation, halftone, dot screen, Sobel, sepia and posterize are ready-made
  `NodePass` effects in `@margoengine/shader/effects`.

## TSL and node materials

```js
import {MeshStandardNodeMaterial} from 'three/webgpu';
import {uniform, texture, mix, color, uv, sin, time, positionLocal, normalLocal} from 'three/tsl';
const tint = uniform(new THREE.Color('#ff8800'));
const wave = sin(time.add(uv().y.mul(10))).mul(0.5).add(0.5);
const material = new MeshStandardNodeMaterial({roughness: 0.6});
material.colorNode = mix(color('#2040ff'), tint, uv().y).mul(texture(map).rgb);
material.positionNode = positionLocal.add(normalLocal.mul(wave.mul(0.05)));
```

```ts
import {sphereGeometry} from '@margoengine/geometry';
import {createMesh, loadTexture} from '@margoengine/materials';
import {NodeMaterial, NodePass, uniform, texture, mix, color, uv, sin, time, positionLocal, normalLocal, inputColor, screenUV, smoothstep} from '@margoengine/shader';
import {PostStack} from '@margoengine/post/stack';
import {Tonemap} from '@margoengine/tonemap';

const tint = uniform('#ff8800', {name: 'tint'});   // tint.value = '#00ff00' never recompiles
const wave = sin(time.add(uv().y.mul(10))).mul(0.5).add(0.5);
const map = await loadTexture('/rock.jpg');
const material = new NodeMaterial({
  roughness: 0.6,
  colorNode: mix(color('#2040ff'), tint, uv().y).mul(texture(map).rgb),
  positionNode: positionLocal.add(normalLocal.mul(wave.mul(0.05))),
});
createMesh(engine, sphereGeometry(1, 64, 32), material);

// A post effect: PostProcessing's outputNode becomes a NodePass in a PostStack.
const vignette = new NodePass(inputColor().rgb.mul(smoothstep(0.8, 0.2, screenUV.sub(0.5).length())));
PostStack.attach(engine, [new Tonemap(), vignette]);
```

Most TSL names are the same. Differences: `If`/`Else` is `select(cond, a, b)`; `Loop` is
`loop(count, init, (i, acc) => next)`; `Discard(cond)` is `discard(cond, value)`; compute is
`ComputePass.attach(engine, count, i => buffer.store(i, value))` over `storage(array, 'vec4f')`. Statement-level `If` and `Loop`,
lighting nodes (`@margoengine/shader/lighting`), noise (`@margoengine/shader/noise`) and GLSL functions as nodes
(`@margoengine/shader/glsl`) are there too. The package README has the full TSL table. Output on WebGPU is WGSL.

## Water, ocean and liquids

Margo's water is in `@margoengine/water`: each solver is one `attach`, steps itself and runs its examples from that
package's README.

### Particle liquid (`webgpu_compute_particles_fluid`)

three.js ships the MLS-MPM liquid as an example, `webgpu_compute_particles_fluid`, not as a library: the solver lives
in the example's own code, as storage buffers and compute passes written in TSL that the page dispatches every frame,
with the pointer and the drawing wired up by the page. To use it you copy that code into your project and keep it. In
Margo it is `GPULiquid.attach(engine, {count})` from `@margoengine/water/liquid`: the container is the `box` you pass,
in metres; the pointer is `setPointer`; rigid bodies are `colliders` and report their `forces`; `debug.particles:
'speed'` shows the particles as coloured spheres, and with the debug view off they draw as a refracting liquid surface
(`ParticleLiquid`); `snapshot()` and `restore()` repeat a run exactly; on a browser without WebGPU the WebGL2 layer
runs it on the CPU instead of failing.

### Ripples (`webgl_gpgpu_water`, `webgpu_compute_water`)

| three.js example | Margo |
|---|---|
| A heightmap stepped in the example's own shader (`GPUComputationRenderer` or a compute node) | `Ripples.attach(engine, {surface, size, resolution, speed, damping})`, stepped for you each frame |
| The mouse writes into the heightmap through a uniform | `ripples.disturbRay(origin, direction, radius, strength)` with the pointer's ray, or `disturb(x, z)` |
| Spheres float by reading heights back from the GPU | `cpu: true` and `ripples.sampleHeight(x, z)` this frame, or `seaSurface(ripples)` with `LoadSolver` for real buoyancy |
| Viscosity as one number in the shader | `damping` (per second) and an absorbing strip, so waves leave the grid |
| Walls by editing the shader | `setObstacles([...])`, and `trackBody(body, {obstacle: true})` for moving ones |

### Ocean (`webgpu_ocean`, `webgl_shaders_ocean`, the Water add-on)

| three.js | Margo |
|---|---|
| `new Water(geometry, {waterNormals, sunDirection, distortionScale})` and a `time` uniform you advance | `Water.attach(engine, {size, waves or wind, reflection})`: Gerstner trains, reflection and refraction, its own clock |
| An FFT ocean written in the example's own compute code | `FFTOcean.attach(engine, {spectrum, windSpeed, fetch, choppiness, cascades})` |
| Changing the wind rebuilds the example's spectrum by hand | `ocean.setWind({speed, direction, fetch})`, live, no new buffers |
| Reading a height for a boat means a GPU readback a frame late | `water.sample(x, z)` or `ocean.sample(x, z)` on the CPU now, and `seaSurface(...)` for buoyancy |
| Debugging by editing the shader | `ocean.setDebug({mode: 'jacobian', wireframe: true, lodRings: true})` |

## Flocks of birds and fish

three.js's `webgl_gpgpu_birds` example keeps the birds' positions and velocities in two float textures that
`GPUComputationRenderer` updates with fragment shaders you write (the three rules and the mouse predator, each bird
looking at every other), then draws its own bird geometry whose vertex shader reads those textures;
`webgpu_compute_birds` does the same work with compute nodes over storage buffers. In Margo that whole page is one
attach: the flock's count is `count` instead of a texture size, the rule sliders become the weights `separation`,
`alignment` and `cohesion` and the ranges `separationRadius` and `neighborRadius`, the mouse predator becomes
`setPredators` (see the pointer example in the `@margoengine/vfx` README), and your own bird is `geometry`. Neighbours
come from the hash grid instead of every other bird, so the work grows with the boids near each one rather than with
the square of the count, and the same seed flies the same flock every run.

## Orthographic cameras and top-down views

```js
const camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 1000);
camera.position.set(0, 40, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);
camera.zoom = 2;
camera.updateProjectionMatrix();
```

```ts
import {CameraProjection} from '@margoengine/cameras';

engine.camera.position = [0, 40, 0]; // exactly straight down
const projection = CameraProjection.attach(engine); // orthographic, framed like the perspective view at the target
projection.height = 12;                    // visible world height; or left/right/top/bottom like three.js
projection.zoom = 2;
projection.mode = 'perspective';           // toggle at any time
projection.fit(model.bounds);              // ortho: centre and zoom to the box outline; perspective: core's fit
```

Core's camera exposes the two hooks this package uses: `camera.up` (screen up) and `camera.project` (fill the
projection matrix yourself). Culling, picking, raycasts, controls, SSAO, lines, points, labels and clustered lights all
read the result. Without the package, an exactly vertical view needs `engine.camera.up = [0, 0, -1]`.

## Large coordinates (floating origin)

three.js has no built-in answer: apps subtract an offset from every object by hand (or use a tiles renderer's
relative-to-centre transforms) to stop float32 jitter far from the origin. Margo's `FloatingOrigin` does the bookkeeping:

```ts
import {FloatingOrigin} from '@margoengine/cameras/origin';
import {Raycaster} from '@margoengine/bvh';

const origin = FloatingOrigin.attach(engine);
origin.place(model.root, [512_034.218, 41.5, 5_403_117.904]); // float64 world (e.g. UTM metres)
origin.lookAt([512_034.3, 41.6, 5_403_118.0], [512_034.218, 41.5, 5_403_117.904]);
const [hit] = new Raycaster().setFromEngine(engine, 320, 180).intersectEngine(engine);
if (hit) console.log(origin.toWorld(hit.point));               // bvh hits back to float64 world
```

Root meshes keep float64 positions; core sees them relative to an origin that follows the camera, so a 10 mm part
6,000 km out renders with under 0.05 px of jitter (core alone: tens of pixels at 100 km). Everything else (camera,
controls, picks, section planes) works in local coordinates; see `docs/large-coordinates.md` for measurements and
limits.

## Lines, points, text and labels

```js
import {Line2} from 'three/addons/lines/Line2.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {LineGeometry} from 'three/addons/lines/LineGeometry.js';
import {CSS2DRenderer, CSS2DObject} from 'three/addons/renderers/CSS2DRenderer.js';
const line = new Line2(new LineGeometry().setPositions([-2, 0, 0, 0, 1, 0, 2, 0, 0]), new LineMaterial({color: 0xffaa00, linewidth: 4}));
scene.add(line, new THREE.GridHelper(10, 10), new THREE.AxesHelper(2));
const points = new THREE.Points(geometry, new THREE.PointsMaterial({size: 2, vertexColors: true}));
const label = new CSS2DObject(element); mesh.add(label);
```

```ts
import {Lines, Line, GridHelper, AxesHelper} from '@margoengine/lines';
import {PointsPlugin, PointCloud} from '@margoengine/points';
import {TextRenderer, Text} from '@margoengine/text';
import {LabelRenderer} from '@margoengine/labels';

const lines = Lines.attach(engine);
lines.add(new Line({positions: [-2, 0, 0, 0, 1, 0, 2, 0, 0], color: '#ffaa00', width: 4})); // CSS pixels; worldUnits: true for metres
lines.add(new GridHelper({size: 10, divisions: 10}));
lines.add(new AxesHelper({size: 2}));

const points = PointsPlugin.attach(engine, {pointBudget: 2_000_000});
const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
points.add(new PointCloud({positions, material: {size: 2, shape: 'round'}}));

const text = TextRenderer.attach(engine); // GPU SDF text from any browser font
text.add(new Text({text: 'Hello', fontSize: 0.5, anchorX: 'center', billboard: true, mesh, position: [0, 1, 0]}));

const labels = LabelRenderer.attach(engine); // HTML labels, like CSS2DRenderer
const element = document.createElement('div');
element.textContent = 'Pump 3';
labels.add(element, {mesh, offset: [0, 0.8, 0]});
```

Lines, points and text need WebGPU or the `@margoengine/webgl2-compat` layer. Lines are picked as in
[Raycasting and picking](#raycasting-and-picking). `labels.add3D(element, {mesh})` replaces
`CSS3DObject`. Extruded 3D text comes from TrueType fonts through `textGeometry` in `@margoengine/loaders/font` (typeface JSON
fonts are not read).

## Math

```js
const v = new THREE.Vector3(0, 1, 0).addScaledVector(new THREE.Vector3(1, 0, 0), 2);
mesh.position.copy(v);
mesh.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 4, 0));
```

```ts
import {Vector3, Quaternion, Euler, Box3} from '@margoengine/math';

const v = new Vector3(0, 1, 0).addScaledVector(new Vector3(1, 0, 0), 2);
mesh.setPosition(v.toArray());
mesh.setQuaternion(new Quaternion().setFromEuler(new Euler(0, Math.PI / 4, 0)).toArray());
const bounds = new Box3().setFromArray(model.bounds);
```

Method names follow three.js; methods write into `this` or an `out` argument. Core APIs take tuples, so convert with
`toArray()`. `mesh.position` is a live `{x, y, z}` view with `set` and `setAll`, not a `Vector3`.

## Render loop and frame pacing

```js
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  mesh.rotation.y += delta;
  renderer.render(scene, camera);
});
renderer.setAnimationLoop(null);
```

```ts
const stop = engine.onFrame((_, delta) => { mesh.rotation.y += delta; }); // seconds, clamped to engine.maxDelta (0.1)
engine.start();                               // requestAnimationFrame loop
engine.stop();
stop();                                       // unsubscribes the callback
engine.render({delta: 1 / 60});               // one frame by hand, e.g. render on demand
```

`onFrame` callbacks run from the loop that `start()` runs. `render()` draws one frame and advances the attached plugins
(controls, animation) by `delta`, but calls no `onFrame` callback; in a loop of your own, call your update yourself.

Quality tiers and pacing (`@margoengine/quality`):

```ts
import {Engine} from '@margoengine/core';
import {applyQualityTier, paceEngine, watchQuality, capFrameRate} from '@margoengine/quality';

applyQualityTier();                           // before Engine.create: 'phone', 'light' or 'high'
const engine = await Engine.create(canvas);
paceEngine(engine);                           // caps the light tier at about 60 FPS so 120 Hz panels don't swing 120/40
engine.start();
watchQuality();                               // measures GPU time once and remembers the tier for the next load
capFrameRate(engine, 30);                     // or a fixed cap on any engine
```

The tier comes from measuring the GPU, not from user-agent rules, and is remembered per browser; `?quality=high` or
`?quality=low` force one for testing. Plugin work (controls, animation) runs before the transform update, so it shows
in the frame it changes.

## Debugging a frame

```js
console.log(renderer.info.render.calls, renderer.info.render.triangles, renderer.info.memory.textures);
// Spector.js: install the extension, click "capture" and read the command list in its window.
```

```ts
import {FrameDebugger} from '@margoengine/inspector/frame';

const debug = FrameDebugger.attach(engine);   // panel at the bottom right; attach before loading assets
const report = await debug.capture();          // the next frame the engine renders ({render: true}: render now)
console.log(report.totals.draws, report.totals.triangles, report.memory.textures.bytes);
for (const pass of report.graph) console.log(pass.name, pass.owner, pass.gpuMilliseconds ?? pass.cpuMilliseconds);
console.log(report.warnings);                  // pipelines compiled this frame, 15-16 texture bindings, ...
```

Like `renderer.info` it counts draws, triangles and memory, but per pass and for one captured frame: every frame graph
pass (core's `main`, then each package's passes by plugin name and order), its GPU passes with render targets and
load/store ops, and every draw or dispatch with its pipeline (cull mode, blend, depth, MSAA, texture bindings against
the 16 limit) and bind groups. Like Spector.js it records the real WebGPU calls, but from inside the page and as JSON
(for tests and CI), with GPU time per pass when the engine is created with `features: ['timestamp-query']`. Nothing
is wrapped per frame until `capture()`; an engine that never imports `@margoengine/inspector/frame` pays nothing.

## Disposal

| three.js | Margo |
| --- | --- |
| `geometry.dispose()`, `material.dispose()` | Core frees a `Geometry`'s GPU buffers when its last mesh is gone; `mesh.dispose()`; a materials `Material` has `dispose()` |
| `texture.dispose()` | `texture.dispose()` (materials never dispose shared textures) |
| `scene.remove(gltf.scene)` + traverse and dispose | `model.dispose()` |
| `mixer.uncacheRoot(...)` | `animation.dispose()` (or `model.dispose()`, which removes it) |
| `composer.dispose()`, `pass.dispose()` | `stack.dispose()` (disposes its effects) |
| `controls.dispose()` | `orbit.dispose()`, or nothing: `engine.dispose()` disposes attached controls |
| none | every disposable package object has `[Symbol.dispose]`, so `using fog = Fog.attach(engine)` disposes it when the block ends (core's `Engine`, meshes and the stage: call `dispose()`) |
| `renderer.dispose()` | `engine.dispose()`: disposes every plugin (shadows, lights, effects, controls, models) |

`engine.removePlugin(plugin.name)` removes one feature while the engine keeps running. After a GPU device loss the
engine recreates the device and every plugin rebuilds its GPU state; no reload is needed.

## Pitfalls

What most often goes wrong in a port, with the fix.

| You expect, from three.js | What happens in Margo | Do this |
| --- | --- | --- |
| A new standard material is white, rough and front-sided | Core's `PbrMaterial` defaults to colour `#4f46e5`, roughness 0.5, metalness 0 and `doubleSided: true` | Write the values, or use `PbrMaterial` of `@margoengine/materials`, which has three.js's defaults. |
| One material class for every mesh | There are two `PbrMaterial`s. Core's mesh takes core's; a textured mesh is made by materials' `createMesh` | Import both names from the package whose mesh you build. |
| `mesh.position` on a textured mesh | `createMesh` returns an object, not a core mesh | Move it with `result.root.setPosition(...)`. |
| `color: 0xff0000` | Core takes `'#rrggbb'` or a linear `[r, g, b]`; hex numbers are a materials feature | Write the string for core. |
| `camera.lookAt(p)` | The camera is a position and a target | `engine.camera.target = p`. |
| A flag turns on shadows or environment light | Shadow casters, and non-core receivers, join each feature | `shadows.add(mesh)`, `lighting.add(model)`, `fog.add(model)`, `ssao.add(model)`. |
| Everything attaches at once | `Environment.attach` is asynchronous | `await` it before `EnvironmentLighting.attach`. |
| `render()` runs your frame code | `onFrame` callbacks run only from the started loop | Call `engine.start()`, or run your update before `render`. |
| `scene.background` shows as written under post effects | Under a post effect the colour is linear light in the scene, so the effect's tone map darkens it with the meshes (`#808080` shows as 116, not 128); on the bare canvas it shows as written | Pick the colour under the chain you ship. |
| A raycast on an animated character | Synchronous BVH rays hit the current pose under `Animation` (`MorphWeightPlayer` weights included), `Skin`, `GeometryCachePlayer` and `BatchedMesh`, linear or dual quaternion skins; they throw under a `skinning` mode of your own with no `blend` | `await raycaster.intersectModel(model)` or GPU picking for those. |
| `mixer.update(delta)` in your loop | An attached mixer is already advanced by the engine; calling it too doubles the speed | Delete the call. |
| A depth shader with `less` comparisons | WebGPU depth is reversed (near 1, far 0) | Use `greater`, or `DepthTexture`'s `distance`. |
| `new WebGLRenderer` runs anywhere with WebGL 2 | Core needs WebGPU | `await install()` from `@margoengine/webgl2-compat` first when `navigator.gpu` gives no adapter. |
| A canvas made for you | `Engine.create` takes your canvas and sizes its buffer from its CSS size | Give the canvas a CSS size, or use `createStage` with a container. |

## Side-by-side examples

[`examples/from-threejs/`](../examples/from-threejs/) holds complete scenes. Each file starts by saying how the same
scene is put together in three.js, then is the Margo code. Run `npm run build:packages` and `npm run dev:examples`, then
open `http://127.0.0.1:5173/examples/from-threejs/index.html`. `npm run test:from-threejs` runs every one in a browser
and checks the frame and the behaviour (`-- --compat` on the WebGL2 layer).

| Example | The scene |
| --- | --- |
| [typical-scene.ts](../examples/from-threejs/typical-scene.ts) | A glTF model walking on a ground: HDR environment light, a shadowed sun, ambient occlusion and bloom, orbit controls, click to outline |
| [basics.ts](../examples/from-threejs/basics.ts) | A spinning box on a floor, core only |
| [model-animation.ts](../examples/from-threejs/model-animation.ts) | A glTF model, cross-fading between two clips |
| [instancing-picking.ts](../examples/from-threejs/instancing-picking.ts) | One draw of many boxes, picked by ray and by GPU |
| [post-processing.ts](../examples/from-threejs/post-processing.ts) | Bloom, tone mapping and FXAA |

## Name by name

The public names of three.js's core and common add-ons, and what does the same job in Margo. Every name in the Margo
column is checked against the committed API reports (`api/*.api.md`) by `tests/from-threejs-snippets.test.js`, so a
rename or removal fails that test. `Name.member` is a member of that export, and the third column is the package that
exports it. A row says where the job lives, not that signatures match; the sections above show the calls, and the
[parity matrix](threejs-parity.md) records limits row by row. `none` means there is no counterpart.

### Renderer, scene graph and loop

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `WebGLRenderer`, `WebGPURenderer` | `Engine.create` | `@margoengine/core` | One engine per canvas. |
| `renderer.render` | `EngineKernel.render` | `@margoengine/core` | One frame by hand. |
| `renderer.setAnimationLoop` | `EngineKernel.start`, `EngineKernel.stop`, `EngineKernel.onFrame` | `@margoengine/core` | `onFrame` callbacks run from the started loop. |
| `Clock`, `Timer` | `EngineKernel.onFrame` | `@margoengine/core` | The callback receives the step in seconds. |
| `renderer.setSize`, `setPixelRatio` | `EngineOptions.exactSize` | `@margoengine/core` | Automatic from the canvas's CSS size; the option fixes a size. |
| `renderer.setViewport`, `setScissor`, `ArrayCamera` | `RenderView`, `EngineKernel.views` | `@margoengine/core` | Fractions of the canvas, or pixels. |
| `renderer.dispose`, `forceContextRestore` | `EngineKernel.dispose`, `EngineKernel.rebootDevice` | `@margoengine/core` | A lost device is rebuilt automatically. |
| `renderer.info` | `FrameDebugger` | `@margoengine/inspector/frame` | Per pass, for a captured frame. |
| Stats, GPU timer queries | `Stats`, `GPUProfiler` | `@margoengine/stats` | |
| `Scene` | `Scene`, `EngineKernel.scene`, `EngineKernel.createScene` | `@margoengine/core` | |
| `scene.background` (color) | `Scene.background` | `@margoengine/core` | See [Pitfalls](#pitfalls) before combining it with post effects. |
| `Object3D`, `Group`, `Mesh` | `EngineKernel.createMesh`, `Mesh.setParent` | `@margoengine/core` | A mesh without geometry is a group. |
| `position`, `rotation`, `quaternion`, `scale`, `visible`, `name` | `Mesh.position`, `Mesh.rotation`, `Mesh.setQuaternion`, `Mesh.scale`, `Mesh.visible`, `Mesh.name` | `@margoengine/core` | |
| `Layers` | `setRenderLayers`, `setCameraLayers` | `@margoengine/cameras/layers` | 32-bit masks. |
| `EventDispatcher` | `EventDispatcher` | `@margoengine/controls` | |
| `WebGLRenderTarget` | `HDRRenderTarget` | `@margoengine/creative/targets` | |
| `WebGLCubeRenderTarget`, `WebGLArrayRenderTarget`, `WebGL3DRenderTarget` | `TextureRenderTarget` | `@margoengine/creative/targets` | `kind`: cube, array or 3d. |
| Multiple render targets | `SceneTargets` | `@margoengine/post/mrt` | |
| `renderer.domElement.toDataURL`, `readRenderTargetPixels` for stills | `capture` | `@margoengine/exporters/capture` | |
| Rendering on an `OffscreenCanvas` in a worker | `transferCanvas`, `WorkerCanvas` | `@margoengine/worker` | |
| The WebGL 2 backend | `install` | `@margoengine/webgl2-compat` | Await it before `Engine.create`; still in development. |
| `renderer.xr`, `VRButton`, `ARButton` | `XR.requestSession` | `@margoengine/xr` | Untested on a headset. |
| `XRControllerModelFactory`, `XRHandModelFactory` | `XRModels` | `@margoengine/xr/models` | |

### Cameras

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `PerspectiveCamera` | `Camera`, `CameraOptions` | `@margoengine/core` | `fov` in degrees; aspect follows the canvas. |
| `camera.lookAt` | `Camera.target` | `@margoengine/core` | Assign the point to look at. |
| `camera.up` | `Camera.up` | `@margoengine/core` | |
| Framing a box | `Camera.fitToBoundingBox` | `@margoengine/core` | |
| `OrthographicCamera` | `CameraProjection` | `@margoengine/cameras` | |
| `CubeCamera` | `CubeCamera` | `@margoengine/environment/cube-camera` | |
| `StereoCamera`, `AnaglyphEffect`, `ParallaxBarrierEffect` | `StereoRig` | `@margoengine/cameras/stereo` | |

### Geometry and curves

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `BufferGeometry` (position and normal) | `Geometry` | `@margoengine/core` | |
| `BufferGeometry` (UVs, colours, tangents, groups) | `MeshGeometry` | `@margoengine/materials` | Plain typed arrays. |
| Handing generated arrays to core | `toGeometry` | `@margoengine/geometry` | |
| `BoxGeometry`, `SphereGeometry`, `PlaneGeometry`, `CircleGeometry`, `RingGeometry` | `boxGeometry`, `sphereGeometry`, `planeGeometry`, `circleGeometry`, `ringGeometry` | `@margoengine/geometry` | |
| `CylinderGeometry`, `ConeGeometry`, `CapsuleGeometry`, `TorusGeometry`, `TorusKnotGeometry` | `cylinderGeometry`, `coneGeometry`, `capsuleGeometry`, `torusGeometry`, `torusKnotGeometry` | `@margoengine/geometry` | |
| `PolyhedronGeometry`, `TetrahedronGeometry`, `OctahedronGeometry`, `IcosahedronGeometry`, `DodecahedronGeometry` | `polyhedronGeometry`, `tetrahedronGeometry`, `octahedronGeometry`, `icosahedronGeometry`, `dodecahedronGeometry` | `@margoengine/geometry` | |
| `LatheGeometry`, `TubeGeometry`, `ExtrudeGeometry`, `ShapeGeometry`, `EdgesGeometry` | `latheGeometry`, `tubeGeometry`, `extrudeGeometry`, `shapeGeometry`, `edgesGeometry` | `@margoengine/geometry` | |
| `Shape`, `Path` | `Shape`, `Path` | `@margoengine/geometry` | |
| `CatmullRomCurve3`, `CubicBezierCurve3`, `QuadraticBezierCurve3`, `LineCurve3`, `CurvePath` | `CatmullRomCurve3`, `CubicBezierCurve3`, `QuadraticBezierCurve3`, `LineCurve3`, `CurvePath` | `@margoengine/geometry` | |
| `EllipseCurve`, `SplineCurve` | `EllipseCurve`, `SplineCurve` | `@margoengine/geometry` | |
| `RoundedBoxGeometry`, `ConvexGeometry`, `DecalGeometry`, `ParametricGeometry` | `roundedBoxGeometry`, `convexGeometry`, `decalGeometry`, `parametricGeometry` | `@margoengine/geometry/extras` | |
| `TeapotGeometry` | `teapotGeometry` | `@margoengine/geometry/teapot` | |
| `TextGeometry`, `FontLoader`, `TTFLoader` | `textGeometry` | `@margoengine/loaders/font` | TrueType and OpenType fonts; typeface JSON is not read. |
| `BufferGeometryUtils.mergeGeometries`, `mergeVertices` | `mergeGeometries`, `mergeVertices` | `@margoengine/geometry` | |
| `computeVertexNormals`, `computeTangents` | `computeVertexNormals`, `computeTangents` | `@margoengine/geometry` | |
| `TessellateModifier` | `tessellateGeometry` | `@margoengine/geometry/tessellate` | |
| `SimplifyModifier` | `simplifyMesh` | `@margoengine/mesh-edit/modeling` | |
| `MeshSurfaceSampler` | `MeshSurfaceSampler` | `@margoengine/geometry/sample` | |

### Materials and textures

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `MeshStandardMaterial` (colour, roughness, metalness) | `PbrMaterial` | `@margoengine/core` | Other defaults: see [Pitfalls](#pitfalls). |
| `MeshStandardMaterial`, `MeshPhysicalMaterial` | `PbrMaterial` | `@margoengine/materials` | |
| `MeshBasicMaterial`, `MeshLambertMaterial`, `MeshPhongMaterial`, `MeshToonMaterial` | `UnlitMaterial`, `LambertMaterial`, `PhongMaterial`, `ToonMaterial` | `@margoengine/materials` | |
| `MeshNormalMaterial`, `MeshMatcapMaterial`, `MeshDepthMaterial`, `MeshDistanceMaterial`, `ShadowMaterial` | `NormalMaterial`, `MatcapMaterial`, `DepthMaterial`, `DistanceMaterial`, `ShadowCatcherMaterial` | `@margoengine/materials` | |
| `ShaderMaterial`, `onBeforeCompile` | `WgslMaterial` | `@margoengine/materials` | WGSL, inside the engine's lighting. |
| `RawShaderMaterial` | `RawShaderMaterial`, `RawMesh` | `@margoengine/shader/raw` | Any named attributes. |
| Node materials, TSL `uniform` | `NodeMaterial`, `uniform` | `@margoengine/shader` | |
| `Mesh` with a textured material | `createMesh` | `@margoengine/materials` | |
| `Texture`, `CanvasTexture`, `VideoTexture`, `DataTexture`, `DataArrayTexture`, `Data3DTexture` | `Texture` | `@margoengine/materials` | One class; the source decides. |
| `FrontSide`, `BackSide`, `DoubleSide` | `MaterialOptions.side` | `@margoengine/materials` | `'front'`, `'back'`, `'double'`. |
| `NormalBlending`, `AdditiveBlending`, `MultiplyBlending`, `NoBlending` | `MaterialOptions.blending` | `@margoengine/materials` | `'normal'`, `'additive'`, `'multiply'`, `'none'`. |
| `RepeatWrapping`, `NearestFilter`, `anisotropy`, `flipY`, `colorSpace` | `TextureOptions.wrapS`, `TextureOptions.magFilter`, `TextureOptions.anisotropy`, `TextureOptions.flipY`, `TextureOptions.colorSpace` | `@margoengine/materials` | Strings: `'repeat'`, `'nearest'`. |
| `InstancedBufferAttribute` for your own per-instance values | `instanceAttributes` | `@margoengine/materials/instance-attributes` | Read by a material plugin. |
| `TextureLoader`, `ImageBitmapLoader` | `loadTexture` | `@margoengine/materials` | |
| `CubeTexture`, `CubeTextureLoader` | `CubeTexture`, `loadCubeTexture` | `@margoengine/materials` | |
| `CompressedTexture`, `KTX2Loader` on a material | `loadKTX2Texture` | `@margoengine/materials` | |
| `DepthTexture` | `DepthTexture` | `@margoengine/post/depth` | Reversed depth. |
| `texture.mipmaps` of your own | `mipTexture`, `loadMipTexture` | `@margoengine/materials/mips` | |
| `StorageTexture` | `StorageTexture`, `PingPongTexture` | `@margoengine/shader/compute-texture` | |
| `GPUComputationRenderer`, TSL compute | `ComputePass`, `storage` | `@margoengine/shader` | |
| Order-independent transparency | `OIT` | `@margoengine/oit` | |

### Lights and shadows

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `DirectionalLight` (the sun) | `Scene.lighting`, `EngineKernel.lighting` | `@margoengine/core` | `direction`, `radiance`. |
| More `DirectionalLight`s | `DirectionalLights` | `@margoengine/clustered/directional` | |
| `AmbientLight`, `HemisphereLight` | `AmbientLight`, `HemisphereLight` | `@margoengine/environment` | |
| `PointLight`, `SpotLight` | `Clustered.setLights` | `@margoengine/clustered` | |
| `RectAreaLight`, `RectAreaLightUniformsLib` | `AreaLights` | `@margoengine/clustered/area` | |
| `IESLoader`, `IESSpotLight` | `parseIES`, `IESLights` | `@margoengine/clustered/ies` | |
| `ProjectorLight`, `SpotLight.map` | `ProjectorLights` | `@margoengine/clustered/projector` | |
| `LightProbe`, light probe volumes | `LightProbes` | `@margoengine/environment/probes` | |
| `renderer.shadowMap`, `castShadow`, `receiveShadow`, CSM | `Shadows.attach`, `Shadows.add` | `@margoengine/shadows` | `add` takes `castShadow` and `receiveShadow`. |
| Point and spot light shadows | `LocalShadows` | `@margoengine/clustered/shadows` | |
| ContactShadows example | `ContactShadows` | `@margoengine/studio` | |

### Environment, sky, water and effects in the scene

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `RGBELoader`, `HDRLoader`, `EXRLoader`, `UltraHDRLoader` | `loadEnvironmentImage`, `parseHDR`, `parseEXR`, `decodeUltraHDR` | `@margoengine/environment` | |
| `PMREMGenerator`, `scene.environment` | `Environment.attach`, `EnvironmentLighting.attach` | `@margoengine/environment` | |
| `scene.background` (texture, blurriness, colour in linear light) | `EnvironmentBackground`, `ColorBackground` | `@margoengine/environment` | |
| `Fog`, `FogExp2` | `Fog` | `@margoengine/environment` | |
| Volumetric lighting | `VolumetricFog` | `@margoengine/environment/volumetric` | |
| `Sky` | `Sky` | `@margoengine/sky` | |
| `Reflector` | `Reflector` | `@margoengine/environment/reflector` | |
| `Refractor` | `Refractor` | `@margoengine/environment/refractor` | |
| `Water`, `Water2` | `Water` | `@margoengine/water` | |
| `Lensflare` | `LensFlare` | `@margoengine/post/lens-flare` | |
| Decals as a screen pass | `Decals` | `@margoengine/post/decals` | |
| `MarchingCubes` | `marchingCubes` | `@margoengine/procedural` | |
| `ImprovedNoise`, `SimplexNoise` | `Noise` | `@margoengine/procedural` | |

### Loaders

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `GLTFLoader` | `loadGLTF`, `parseGLTF` | `@margoengine/gltf/pbr` | Constant-colour files also load with `@margoengine/gltf`. |
| Progressive glTF loading | `loadGLTFProgressive` | `@margoengine/gltf/progressive` | |
| `DRACOLoader`, `MeshoptDecoder`, `KTX2Loader` for glTF | `DracoDecoder`, `MeshoptDecoder`, `KTX2Decoder` | `@margoengine/decoders` | Pass them as `decoders`. |
| `FBXLoader` | `loadFBX` | `@margoengine/fbx` | |
| `USDZLoader`, `USDLoader` | `loadUSDZ` | `@margoengine/usdz` | |
| `OBJLoader`, `MTLLoader` | `parseOBJ`, `parseMTL` | `@margoengine/loaders` | |
| `OBJLoader` with its materials, drawn | `loadOBJ` | `@margoengine/loaders/mtl` | |
| `STLLoader`, `PLYLoader`, `PCDLoader`, `XYZLoader`, `VTKLoader` | `parseSTL`, `parsePLY`, `parsePCD`, `parseXYZ`, `parseVTK` | `@margoengine/loaders` | |
| `ColladaLoader`, `3MFLoader` | `parseDAE`, `parse3MF` | `@margoengine/loaders` | |
| `SVGLoader` | `parseSVG` | `@margoengine/loaders/svg` | |
| `BVHLoader` | `parseBVH` | `@margoengine/loaders/mocap` | |
| `MMDLoader` | `parseMMD` | `@margoengine/loaders/mmd` | Rigid bodies are data only. |
| `Rhino3dmLoader` | `parse3DM` | `@margoengine/loaders/3dm` | |
| `TDSLoader` | `parse3DS` | `@margoengine/loaders/3ds` | |
| `AMFLoader` | `parseAMF` | `@margoengine/loaders/amf` | |
| `GCodeLoader` | `parseGCode` | `@margoengine/loaders/gcode` | |
| `KMZLoader` | `parseKMZ` | `@margoengine/loaders/kmz` | |
| `LDrawLoader` | `parseLDraw` | `@margoengine/loaders/ldraw` | |
| `LWOLoader` | `parseLWO` | `@margoengine/loaders/lwo` | |
| `MD2Loader` | `parseMD2` | `@margoengine/loaders/md2` | |
| `PDBLoader` | `parsePDB` | `@margoengine/loaders/pdb` | |
| `VRMLLoader` | `parseVRML` | `@margoengine/loaders/vrml` | |
| `NRRDLoader` | `parseNRRD` | `@margoengine/loaders/nrrd` | |
| `VOXLoader` | `parseVox` | `@margoengine/voxel/vox` | |
| `TGALoader` | `parseTGA` | `@margoengine/decoders/tga` | |
| `DDSLoader` | `parseDDS` | `@margoengine/decoders/dds` | |
| `KTXLoader` | `parseKTX` | `@margoengine/decoders/ktx` | |
| `TIFFLoader` | `parseTIFF` | `@margoengine/decoders/tiff` | |
| `PVRLoader` | `parsePVR` | `@margoengine/decoders/pvr` | |
| `LUTCubeLoader` | `parseCube` | `@margoengine/tonemap` | |
| `LoadingManager` | `LoadingManager` | `@margoengine/cache/manager` | |
| `Cache` | `AssetCache` | `@margoengine/cache` | |
| `AudioLoader` | `loadAudioBuffer` | `@margoengine/audio` | |
| `ObjectLoader`, `scene.toJSON` | none | | Save a scene as glTF, or with `@margoengine/save`. |

### Exporters

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `GLTFExporter` | `exportModel`, `exportGLB`, `exportGLTF` | `@margoengine/exporters` | |
| `OBJExporter`, `STLExporter`, `PLYExporter` | `exportOBJ`, `exportSTL`, `exportPLY` | `@margoengine/exporters` | |
| `USDZExporter` | `exportUSDZ` | `@margoengine/exporters/usdz` | |
| `DRACOExporter` | `compressDraco` | `@margoengine/exporters/draco` | Writes it into a GLB. |
| `KTX2Exporter` | `encodeKTX2` | `@margoengine/exporters/ktx2` | |
| `EXRExporter` | `encodeEXR` | `@margoengine/environment/exr-write` | |

### Animation

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| One playing clip, `SkinnedMesh`, morph targets | `Animation.attach`, `Animation.play`, `Animation.setMorph` | `@margoengine/animation` | |
| `AnimationMixer`, `AnimationAction` | `AnimationMixer.clipAction`, `AnimationAction.crossFadeTo`, `AnimationAction.setLoop` | `@margoengine/animation/mixer` | |
| `LoopOnce`, `LoopRepeat`, `LoopPingPong` | `LoopOnce`, `LoopRepeat`, `LoopPingPong` | `@margoengine/animation/mixer` | |
| State machines and blend trees (not in three.js) | `Animator` | `@margoengine/animator` | |
| `AnimationClip`, `KeyframeTrack` authored in code | `createKeyframeClip` | `@margoengine/animation` | |
| `AnimationObjectGroup` | `AnimationGroup` | `@margoengine/animation` | |
| `Skeleton`, `Bone` | `Skeleton`, `Skin` | `@margoengine/animation` | |
| `SkeletonUtils.clone`, retargeting | `cloneModel`, `Retarget` | `@margoengine/animation/skeleton-utils` | |
| `CCDIKSolver` | `CCDSolver` | `@margoengine/animator` | |
| Instanced animated crowds | `bakeVAT`, `VATCrowd` | `@margoengine/animation/vat` | |

### Post-processing

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `EffectComposer`, `RenderPass`, `addPass` | `PostStack.attach`, `PostStack.addEffect`, `PostStack.removeEffect` | `@margoengine/post/stack` | The scene capture is built in. |
| `ShaderPass` | `NodePass` | `@margoengine/shader` | |
| `OutputPass`, `renderer.toneMapping` | `Tonemap` | `@margoengine/tonemap` | |
| `ACESFilmicToneMapping`, `AgXToneMapping`, `NeutralToneMapping`, `ReinhardToneMapping`, `CineonToneMapping`, `LinearToneMapping` | `TonemapOptions.curve`, `TonemapOptions.exposure` | `@margoengine/tonemap` | `'acescg'`, `'agx'`, `'neutral'`, `'reinhard'`, `'cineon'`, `'linear'`; exposure is in stops. |
| `LUTPass` | `Tonemap.setLUT` | `@margoengine/tonemap` | |
| `UnrealBloomPass`, `BloomPass` | `Bloom` | `@margoengine/post/bloom` | |
| `SSAOPass`, `SAOPass` | `SSAO` | `@margoengine/post/ssao` | |
| `GTAOPass` | `GTAO` | `@margoengine/post/gtao` | |
| `SSRPass` | `SSR` | `@margoengine/post/ssr` | |
| Screen-space global illumination | `SSGI` | `@margoengine/post/ssgi` | |
| `FXAAPass` | `FXAA` | `@margoengine/post/fxaa` | |
| `SMAAPass` | `SMAA` | `@margoengine/post/smaa` | |
| `TAARenderPass` | `TAA` | `@margoengine/taa` | Wraps the stack; not a stack entry. |
| `SSAARenderPass` | `supersample` | `@margoengine/quality/ssaa` | |
| `BokehPass` | `DOF` | `@margoengine/dof` | |
| `OutlinePass` | `Selection` | `@margoengine/selection` | |
| `FilmPass` | `PostProcessing` | `@margoengine/creative/post` | Its `grain` option. |
| `GlitchPass` | `Glitch` | `@margoengine/post/glitch` | |
| `AfterimagePass` | `Afterimage` | `@margoengine/post/afterimage` | |
| `AsciiEffect` | `ASCII` | `@margoengine/post/ascii` | |
| Vignette, RGB shift, pixelation, halftone, dot screen, Sobel, sepia | `vignette`, `rgbShift`, `pixelate`, `halftone`, `dotScreen`, `sobel`, `sepia` | `@margoengine/shader/effects` | |

### Controls and helpers

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `OrbitControls`, `MapControls` | `OrbitControls`, `MapControls` | `@margoengine/controls/orbit` | |
| `TrackballControls`, `ArcballControls` | `TrackballControls`, `ArcballControls` | `@margoengine/controls` | |
| `FlyControls`, `FirstPersonControls`, `PointerLockControls` | `FlyControls`, `FirstPersonControls`, `PointerLockControls` | `@margoengine/controls` | |
| `TransformControls`, `DragControls` | `TransformControls`, `DragControls` | `@margoengine/controls` | |
| `ViewHelper` | `ViewCube` | `@margoengine/viewcube` | |
| `GridHelper`, `PolarGridHelper`, `AxesHelper`, `ArrowHelper` | `GridHelper`, `PolarGridHelper`, `AxesHelper`, `ArrowHelper` | `@margoengine/lines` | |
| `BoxHelper`, `Box3Helper`, `CameraHelper`, `PlaneHelper`, `VertexNormalsHelper`, `SkeletonHelper` | `BoxHelper`, `Box3Helper`, `CameraHelper`, `PlaneHelper`, `VertexNormalsHelper`, `SkeletonHelper` | `@margoengine/lines` | |
| `DirectionalLightHelper`, `PointLightHelper`, `SpotLightHelper`, `HemisphereLightHelper`, `RectAreaLightHelper` | `DirectionalLightHelper`, `PointLightHelper`, `SpotLightHelper`, `HemisphereLightHelper`, `RectAreaLightHelper` | `@margoengine/lines` | |

### Picking and special objects

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `Raycaster` | `Raycaster.setFromEngine`, `Raycaster.setFromCamera`, `Raycaster.intersectObjects`, `Raycaster.intersectEngine` | `@margoengine/bvh` | |
| three-mesh-bvh | `MeshBVH` | `@margoengine/bvh` | |
| GPU picking | `Picking.attach`, `Picking.pick` | `@margoengine/selection` | The drawn surface, posed models included. |
| GPU picking of core meshes | `EngineKernel.pick` | `@margoengine/core` | |
| `InstancedMesh` | `createInstancedMesh` | `@margoengine/materials` | |
| Instanced glTF primitives | `PBRInstances` | `@margoengine/gltf/pbr-instancing` | |
| `BatchedMesh` | `BatchedMesh` | `@margoengine/materials/batched` | |
| `LOD` | `LODSystem` | `@margoengine/lod` | |
| `Points`, `PointsMaterial` | `PointCloud`, `PointsMaterial`, `PointsPlugin` | `@margoengine/points` | |
| `Sprite`, `SpriteMaterial` | `SpriteBatch`, `SpriteMaterial` | `@margoengine/points` | |
| `Line`, `LineSegments`, `LineLoop`, `Line2`, `LineMaterial` | `Lines`, `Line`, `LineMaterial` | `@margoengine/lines` | |
| Picking lines on the GPU | `LinePicking` | `@margoengine/lines/pick` | |
| `CSS2DRenderer`, `CSS3DRenderer` | `LabelRenderer`, `CSS3DObject` | `@margoengine/labels` | |
| troika-three-text | `TextRenderer`, `Text` | `@margoengine/text` | |

### Math

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `Vector2`, `Vector3`, `Vector4`, `Matrix3`, `Matrix4`, `Quaternion`, `Euler` | `Vector2`, `Vector3`, `Vector4`, `Matrix3`, `Matrix4`, `Quaternion`, `Euler` | `@margoengine/math` | |
| `Box3`, `Sphere`, `Ray`, `Plane`, `Frustum`, `Line3`, `Triangle` | `Box3`, `Sphere`, `Ray`, `Plane`, `Frustum`, `Line3`, `Triangle` | `@margoengine/math` | |
| `Color`, `MathUtils`, `Spherical`, `Cylindrical`, `SphericalHarmonics3` | `Color`, `MathUtils`, `Spherical`, `Cylindrical`, `SH3` | `@margoengine/math` | |
| `ColorManagement.convert` | `convertColor` | `@margoengine/math` | |
| `SRGBColorSpace`, `LinearSRGBColorSpace`, `DisplayP3ColorSpace` | `SRGBColorSpace`, `LinearSRGBColorSpace`, `DisplayP3ColorSpace` | `@margoengine/math` | |
| `Capsule`, `OBB` | `Capsule`, `OBB` | `@margoengine/math` | |
| `vector.project`, `vector.unproject` | `projectPoint`, `unprojectPoint`, `worldToScreen` | `@margoengine/math` | |
| `Interpolant`, `LinearInterpolant`, `DiscreteInterpolant` | `Interpolant`, `LinearInterpolant`, `DiscreteInterpolant` | `@margoengine/math/curve` | |

### Audio

| three.js | Margo | Import from | Notes |
| --- | --- | --- | --- |
| `AudioListener`, `Audio`, `PositionalAudio`, `AudioAnalyser` | `AudioListener`, `Audio`, `PositionalAudio`, `AudioAnalyser` | `@margoengine/audio` | |

## Not yet

Remaining gaps and documented limits from [`docs/threejs-parity.md`](threejs-parity.md). The optional-package backlog
does not reopen the core freeze or the closed v1 limits listed there.

Materials already support one class per shading model (unlit, Lambert, Phong, PBR, normal, matcap, depth, distance),
physical factors and maps, iridescence, anisotropy, dispersion, wireframe, front/back/double sides, live swaps and
live render state. Blend/depth controls, polygon offset, color-write suppression and stencil are available
through `Material` and gltf/pbr render state, with optional `StencilBuffer` for a scene stencil attachment. These
features add no core or stage functionality.

| three.js | Status in Margo |
| --- | --- |
| WebXR reflection cube maps (AR light) | Missing. The WebXR Lighting Estimation draft defines it for WebGL only; `@margoengine/xr/ar` gives the room's light as spherical harmonics instead. |
| WebXR VR and AR | PARTIAL: untested on a headset or AR device. AR occlusion from CPU or GPU depth is `AROcclusion` (`@margoengine/xr/occlusion`). |
| WebGL2 for every package | PARTIAL: `@margoengine/webgl2-compat`, still in development. |
| Deferred shading pipeline, SVG output, voxel cone-traced global illumination | NOT PLANNED, by decision (see the rows in [threejs-parity.md](threejs-parity.md)). |

Everything else on the earlier list is COVERED now, each in its row of [threejs-parity.md](threejs-parity.md): rendering in a
worker, layers, cube, array and 3D render targets, compute writing textures, environment blending, KTX2 arrays and cubes,
subsurface blur, shadows from alpha cut-outs, `alphaHash`, object-space normal maps, your own mip levels, picking fat lines,
soft particles, Draco and KTX2 read and write, the long-tail loaders, stereo on a flat screen, triangle-mesh path
tracing, caustics, G-code writing, drawing soft bodies (`@margoengine/gltf/soft-mesh`) and particle liquids
(`@margoengine/physics/dfsph` solves them, `ParticleLiquid` draws them).
