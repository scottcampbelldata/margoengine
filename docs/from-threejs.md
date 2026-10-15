# Coming from three.js

A side-by-side guide for three.js developers. Each section shows the three.js code you already write, then the Margo
code that does the same job. Where Margo has no equivalent yet, the section says so; the full list is in
[Not yet](#not-yet).

<!-- Every ```ts block in this file is type-checked against the built packages by tests/from-threejs-snippets.test.js.
     ```js blocks are three.js and are not checked. Snippets may use the ambient names engine, canvas, mesh and model. -->

## Contents

- [What is different](#what-is-different)
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
- [Orthographic cameras and top-down views](#orthographic-cameras-and-top-down-views)
- [Large coordinates (floating origin)](#large-coordinates-floating-origin)
- [Lines, points, text and labels](#lines-points-text-and-labels)
- [Math](#math)
- [Render loop and frame pacing](#render-loop-and-frame-pacing)
- [Disposal](#disposal)
- [Not yet](#not-yet)

## What is different

- **WebGPU first.** Core renders with WebGPU. The WebGL2 fallback is the optional `@margoengine/webgl` package and
  draws core meshes only (flat PBR, one light, no textures or effects). Most optional packages need WebGPU.
- **No `Scene` object.** One `Engine` owns one canvas, one camera and one implicit scene. Meshes are created by the
  engine (`engine.createMesh()`), and features (shadows, lights, post effects, controls) are plugins you attach with
  one form, `X.attach(engine, options)` (async ones such as `Environment.attach` return a Promise). A loaded model
  joins a feature with `feature.add(model)`. Everything disposable has `dispose()`, and every package object also has
  `[Symbol.dispose]` for `using` (core's `Engine` and meshes and the stage facade have `dispose()` only).
- **Small core, optional packages.** Core plus the `margoengine` stage facade is under 20 kB gzip (19,577 bytes at
  `e2cc4c5`, WebGPU only). The smallest lit-box app is about 130 kB gzip with three.js 0.186's WebGLRenderer and
  212 kB with its WebGPURenderer, built the same way (`npm run measure:threejs`,
  [threejs-size.json](../examples/package-benchmarks/results/threejs-size.json)). Everything else is a separate
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
  automatically. Textured meshes and loaded glTF models are drawn by `@margoengine/gltf-pro` (through
  `@margoengine/materials` for meshes you build). Shadows, clustered lights and SSAO light core meshes automatically
  and need `add(model)` for gltf-pro models.

## Install only what you import

Each row is a separate npm package (not published yet: until then, build from source with `npm ci && npm run build:packages`). Install the ones you import; bundlers drop the rest.

```sh
npm install @margoengine/core                      # engine, camera, meshes, constant PBR material
npm install margoengine                            # optional facade: createStage('#app'), app.box(), app.load(url)
npm install @margoengine/geometry @margoengine/materials @margoengine/gltf-pro @margoengine/controls
```

| You use in three.js | Margo package |
| --- | --- |
| `WebGLRenderer`, `PerspectiveCamera`, `Mesh`, `MeshStandardMaterial` (colour only) | `@margoengine/core` |
| WebGL fallback | `@margoengine/webgl` |
| `BoxGeometry`, `SphereGeometry`, `ExtrudeGeometry`, `BufferGeometryUtils` | `@margoengine/geometry` |
| `TextureLoader`, `MeshStandardMaterial` with maps, `MeshBasicMaterial`, `MeshMatcapMaterial` | `@margoengine/materials` |
| `GLTFLoader` (textured, extensions) | `@margoengine/gltf-pro` (+ `@margoengine/decoders` for Draco, meshopt, KTX2) |
| `FBXLoader`, `USDZLoader`, `PLYLoader`/`PCDLoader`/`3MFLoader`, `STLLoader`/`OBJLoader` | `@margoengine/fbx`, `@margoengine/usdz`, `@margoengine/loaders`, `@margoengine/machinery` |
| `AnimationMixer`, skinning, morphs | `@margoengine/animation` (+ `@margoengine/animator` for blending) |
| `DirectionalLight` shadows | `@margoengine/shadows` |
| `PointLight`, `SpotLight` (and their shadows) | `@margoengine/clustered` (shadows: `@margoengine/clustered/shadows`) |
| `RGBELoader`, `EXRLoader`, `PMREMGenerator`, `scene.background`, `scene.fog` | `@margoengine/environment` |
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
| `Points`, `Sprite` | `@margoengine/points` |
| troika-three-text | `@margoengine/text` |
| `CSS2DRenderer`, `CSS3DRenderer` | `@margoengine/labels` (`@margoengine/html` adds depth occlusion) |
| `Vector3`, `Matrix4`, `Quaternion`, `Color`, `Box3` | `@margoengine/math` |
| stats.js | `@margoengine/stats` |
| `ViewHelper` | `@margoengine/viewcube` |
| ContactShadows example (product-shot ground shadow) | `@margoengine/staging` |
| react-three-fiber | `@margoengine/react` |

Feature entries keep bundles smaller still: `@margoengine/post/ssao`, `@margoengine/post/bloom`,
`@margoengine/post/stack`, `@margoengine/post/fxaa`, `@margoengine/animation/vat`, `@margoengine/sky/base` and
`@margoengine/machinery/cad` load one feature without the rest of their package.

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
import {webglRenderer} from '@margoengine/webgl'; // optional: only if you want a WebGL2 fallback

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
- `capacity` (default 1,024, at most 100,000) is the fixed number of meshes and transform nodes an engine holds. Raise
  it for big scenes: `Engine.create(canvas, {capacity: 50_000})`.
- Several scenes or viewports per canvas are not available.

A transparent canvas over HTML and CSS, like `new THREE.WebGLRenderer({alpha: true})` with `setClearColor(0x000000, 0)`:

```ts
import {Engine} from '@margoengine/core';
import {TransparentCanvas} from '@margoengine/environment';
import {webglRenderer} from '@margoengine/webgl';

const overlay = await Engine.create(canvas, {fallback: c => webglRenderer(c, {transparent: true})}); // WebGL fallback: transparent too
TransparentCanvas.attach(overlay); // WebGPU: premultiplied canvas, alpha 0 where nothing is drawn
```

FXAA, Bloom and `PostStack` keep the alpha; Tonemap and SSAO keep it with a faint rim on silhouettes; DOF, TAA,
SceneFade and the other backgrounds make the canvas opaque again (`@margoengine/post` README).

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

Every three.js primitive is in `@margoengine/geometry`, with the same parameters, defaults and vertex order (tested
against three.js r180). They return plain typed arrays; `toGeometry` hands them to core.

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

Core's `PbrMaterial` is colour, roughness, metalness and `doubleSided`. Textures, transparency, unlit and matcap
shading come from `@margoengine/materials`, which draws through gltf-pro (WebGPU only).

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
import {loadTexture, Texture, Material, createMesh} from '@margoengine/materials';

const map = await loadTexture('/crate.jpg', {wrapS: 'repeat', wrapT: 'repeat', anisotropy: 8}); // colour maps read sRGB
const normalMap = await loadTexture('/crate-normal.png');                                        // other slots linear
const crate = createMesh(engine, boxGeometry(1, 1, 1), new Material({
  map, normalMap, roughness: 0.7,
  uvTransform: {offset: [0, 0], scale: [2, 2], rotation: 0}, // map.repeat / offset / rotation
}));
crate.root.setPosition([0, 0.5, 0]);
const video = document.querySelector('video');
createMesh(engine, planeGeometry(1.6, 0.9), new Material({shading: 'basic', map: new Texture(video)}));
const glass = new Material({color: '#88ccff', transparent: true, opacity: 0.4, doubleSided: true});
createMesh(engine, planeGeometry(2, 2), glass, {renderOrder: 1});
glass.opacity = 0.6; // colours, scalars and maps are live
```

- `shading`: `'standard'` (MeshStandardMaterial), `'basic'` (MeshBasicMaterial), `'normal'`, `'matcap'` (with `matcap`).
- Maps: `map`, `normalMap`, `metalRoughnessMap` (glTF packing), `aoMap`, `emissiveMap`. Render state: `transparent`,
  `alphaTest`, `blending` (`'normal'`, `'additive'`, `'multiply'`, `'none'`), `depthWrite`, `depthTest`.
- `Texture` takes an image, bitmap, canvas, video, `ImageData` or `{data, width, height}` (DataTexture). Call
  `texture.update()` after drawing to a canvas (CanvasTexture `needsUpdate`); videos re-upload by themselves.
- UV transforms follow glTF `KHR_texture_transform` (rotation about the UV origin, no `center`). One slot:
  `material.setUVTransform({offset: [0.5, 0], scale: [0.5, 0.5], rotation: 0}, 'normalMap')`.
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

- Not available: Lambert, Phong, physical (clearcoat, transmission) on your own meshes, a second UV set, geometry groups
  (one material per mesh). glTF files do get clearcoat, sheen, transmission and specular (see Loading models).

## Lights and shadows

Core has one directional light plus a constant ambient term. They live on the engine's runtime object, reached through
the explicit `@margoengine/core/extension` entry.

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
import {engineRuntime} from '@margoengine/core/extension';
import {Shadows} from '@margoengine/shadows';
import {Clustered} from '@margoengine/clustered';

const {lighting} = engineRuntime(engine);
lighting.direction.set([3, 5, 4, 3]);        // xyz: direction toward the light, w: intensity
lighting.radiance.set([1, 0.96, 0.9, 0.15]); // rgb: light colour (linear), w: ambient intensity

const shadows = Shadows.attach(engine, {resolution: 2048, distance: 100}); // follows the directional light
shadows.add(mesh);                           // casters; core meshes receive automatically
shadows.add(model);                          // gltf-pro models cast and receive once added

const lights = Clustered.attach(engine);     // up to 1,024 point and spot lights
lights.setLights([
  {position: [0, 2, 1], range: 12, color: [1, 0.3, 0.1], intensity: 20},
  {position: [2, 3, 0], range: 15, direction: [0, -1, 0], innerAngle: 0.3, outerAngle: 0.7, color: [0.1, 0.3, 1], intensity: 30},
]);
lights.add(model);                           // core meshes are lit automatically
```

- Shadows are four cascades with PCSS soft edges; `shadows.add(mesh, {static: true})` caches casters that never move.
- `setLights` replaces the whole list; call it again to animate lights.
- One directional light per engine. No hemisphere, rect-area or IES lights (glTF models get a fixed sky/ground ambient
  fill). For image-based ambient light use the next section.

Point and spot light shadows (three.js `lamp.castShadow = true`) are the optional `@margoengine/clustered/shadows` entry.
Flag the lights, attach `LocalShadows` to the clustered lights and add the casters (core meshes included, unlike
directional shadows); everything clustered lights receives the shadows:

```ts
import {Clustered} from '@margoengine/clustered';
import {LocalShadows} from '@margoengine/clustered/shadows';

const lamps = Clustered.attach(engine);
const lampShadows = LocalShadows.attach(engine, {lights: lamps, maxLights: 4, resolution: 512});
lampShadows.add(mesh);                        // casters: core meshes, gltf-pro models, materials meshes
lampShadows.add(model);
lamps.add(model);                             // receivers, as for unshadowed local light
lamps.setLights([
  {position: [0, 2, 1], range: 12, intensity: 20, castShadow: true},
  {position: [2, 3, 0], range: 15, direction: [0, -1, 0], outerAngle: 0.7, intensity: 30, castShadow: true},
]);
```

- A point light uses six 512² cube-face layers, a spot light one; the first `maxLights` flagged lights get them.
- Maps are cached and re-render only when their light or a caster moves; add skinned models with `{dynamic: true}`.

The soft ground shadow of product shots (three.js's ContactShadows example: a depth render from below, blurred, on a
plane) is `@margoengine/staging`. It needs no light and works with or without `Shadows`:

```ts
import {ContactShadows} from '@margoengine/staging';

const contact = ContactShadows.attach(engine, {opacity: 0.6, blur: 0.08});
contact.fit(model.bounds); // under the model: ground at its lowest point, plane twice its footprint
contact.add(model);        // gltf-pro models, materials meshes and core meshes
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
ibl.add(model);                                              // gltf-pro models

// Or a plain colour and fog:
ColorBackground.attach(engine, {color: '#bcd4e6'});
const fog = Fog.attach(engine, {color: '#bcd4e6', near: 10, far: 80}); // {density: 0.02} for FogExp2
fog.add(model);
fog.far = 120;            // options are live properties
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
import {loadGLTF} from '@margoengine/gltf-pro';
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

- `model.nodes` are the glTF nodes (core meshes you can move or hide), `model.primitives` the drawn parts,
  `model.lights` and `model.cameras` the `KHR_lights_punctual` lights and glTF cameras as data.
- Supported extensions include `KHR_texture_transform`, `KHR_materials_*` (emissive strength, unlit, clearcoat,
  transmission without refraction, IOR, volume, sheen, specular), `KHR_lights_punctual`, `KHR_mesh_quantization`, Draco,
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
import {loadCAD} from '@margoengine/machinery/cad';
import {parsePLY, createMeshes} from '@margoengine/loaders';

const character = await loadFBX(engine, '/character.fbx');  // skins, morphs and clips; a gltf-pro model
const chair = await loadUSDZ(engine, '/chair.usdz');        // static USDA/USDC/USDZ
const part = await loadCAD(engine, '/part.stl');            // STL, OBJ (geometry only), STEP and IGES in a worker
const scan = createMeshes(engine, parsePLY(await (await fetch('/scan.ply')).arrayBuffer()));
```

The stage facade loads by extension: `await app.load('/part.step')` handles glTF (constant colours), STL, OBJ, STEP and
IGES and frames the result. `@margoengine/loaders` also parses 3MF, PCD, XYZ, OFF and legacy VTK. OBJ materials and UVs
(MTL) and Collada are not supported.

### Caching and offline (`THREE.Cache`)

```js
THREE.Cache.enabled = true; // in-memory, this page only
```

```ts
import {AssetCache} from '@margoengine/cache';
import {loadGLTF} from '@margoengine/gltf-pro';
import {loadCAD} from '@margoengine/machinery/cad';

// IndexedDB: survives reloads, works offline, revalidates with ETag/Last-Modified, LRU within maxBytes.
const cache = new AssetCache({name: 'plant-viewer', version: '2026.10', maxBytes: 2 ** 30});
const line = await loadGLTF(engine, '/line-4.glb', {fetch: cache.fetch});
const gearbox = await loadCAD(engine, '/gearbox.step', {fetch: cache.fetch});
```

Every loader (gltf-pro, fbx, usdz, machinery `loadCAD`, `@margoengine/loaders`) takes the same `fetch` option.

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

Skins and clips come from glTF (or FBX). There are no clips authored in code (`KeyframeTrack`), no `SkeletonUtils`
retargeting and no general CCD IK (animator has two-bone foot IK).

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

`exportModel` writes gltf-pro models and `@margoengine/materials` meshes with their current pose, visibility and
material values: skins, morph targets, clips, `EXT_mesh_gpu_instancing`, PBR textures and the KHR material extensions
gltf-pro draws. Core meshes and plain data go through `exportGLB(engine)` / `exportGLTF(engine)` (static). Cameras and
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
Blender, Maya, Onshape, Rhino; `THREE_ORBIT` is the default), each a separate tree-shakable export; bindings table in
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
  option names. Core has `CADCameraControls` (orbit about a pivot, pan, smooth zoom), which the stage facade uses.
- Without an engine, pass a camera and an element and call `update(delta)` yourself:
  `new FlyControls(engine.camera, canvas)`.
- `ViewCube.attach(engine)` from `@margoengine/viewcube` replaces `ViewHelper` (click a face to turn the view).
- No `ArcballControls`. Controls do not roll the camera.

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

`raycaster.intersectObjects(engine, [mesh, model])` tests a list. Rays hit skinned models in their bind pose (use GPU
picking for posed hits). Lines are not hit; points have `pointsPlugin.pick(x, y)`.

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

declare const images: ImageData[];
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
the primitive's node space). Instancing lives in its own entry, `@margoengine/gltf-pro/instancing`, so apps that never
instance do not load it; `EXT_mesh_gpu_instancing` files load instanced when its reader is passed like a decoder (a
file that requires the extension is rejected without it):

```ts
import {loadGLTF} from '@margoengine/gltf-pro';
import {PBRInstances, instancing} from '@margoengine/gltf-pro/instancing';

const city = await loadGLTF(engine, '/instanced-city.glb', {decoders: {instancing}});
const tree = await loadGLTF(engine, '/tree.glb'), forest = new PBRInstances(500);
for (let i = 0; i < 500; i++) forest.setMatrixAt(i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i % 25 * 4, 0, Math.floor(i / 25) * 4, 1]);
for (const primitive of tree.primitives) primitive.instances = forest;
```

Not per instance: frustum culling and sorting of transparent instances. `BatchedMesh` has no equivalent.

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
ssao.add(model);                    // gltf-pro models join SSAO's normals; core meshes are automatic
```

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
ssr.enabled = false;                        // toggles without recompiling; SSR.attach(engine) runs it alone
```

- Glossy core meshes (`PbrMaterial` roughness below `maxRoughness`) reflect what is on screen; with `EnvironmentLighting`
  SSR replaces the IBL specular where a ray hits and keeps it where it misses (off-screen, behind objects). glTF-pro
  models and water are reflected but do not reflect yet. No `groundReflector`/`selects`: every glossy core mesh reflects.
- The stack captures the scene once in linear HDR and runs the effects in array order. The engine renders it; there is
  no `composer.render()`.
- A single effect can also be attached alone, for example `Bloom.attach(engine, {strength: 0.8})`.
- Custom full-screen effects are `NodePass`es from `@margoengine/shader` (next section).
- `Tonemap` curves are `'agx'`, `'acescg'` and `'neutral'`, with exposure in stops and `.cube` LUTs (`setLUT`).
- Not available: SMAA, GTAO, motion blur, glitch and the simple screen-effect passes (write them as a `NodePass`).

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
`ComputePass.attach(engine, count, i => buffer.store(i, value))` over `storage(array, 'vec4f')`. The package README
has the full TSL table. Output is WGSL only; there are no light, shadow or noise nodes and no statement-level `If`.

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

Lines, points and text are WebGPU only. Lines are not pickable. `labels.add3D(element, {mesh})` replaces
`CSS3DObject`. Extruded 3D text (`TextGeometry`) is not available.

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
const stop = engine.onFrame((_, delta) => { mesh.rotation.y += delta; }); // seconds, clamped to 0.1
engine.start();                               // requestAnimationFrame loop
engine.stop();
stop();                                       // unsubscribes the callback
engine.render({delta: 1 / 60});               // one frame by hand, e.g. render on demand
```

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

## Disposal

| three.js | Margo |
| --- | --- |
| `geometry.dispose()`, `material.dispose()` | Core frees a `Geometry`'s GPU buffers when its last mesh is gone; `mesh.dispose()` |
| `texture.dispose()` | `texture.dispose()` (materials never dispose shared textures) |
| `scene.remove(gltf.scene)` + traverse and dispose | `model.dispose()` |
| `mixer.uncacheRoot(...)` | `animation.dispose()` (or `model.dispose()`, which removes it) |
| `composer.dispose()`, `pass.dispose()` | `stack.dispose()` (disposes its effects) |
| `controls.dispose()` | `orbit.dispose()`, or nothing: `engine.dispose()` disposes attached controls |
| none | every disposable package object has `[Symbol.dispose]`, so `using fog = Fog.attach(engine)` disposes it when the block ends (core's `Engine`, meshes and the stage: call `dispose()`) |
| `renderer.dispose()` | `engine.dispose()`: disposes every plugin (shadows, lights, effects, controls, models) |

`engine.removePlugin(plugin.name)` removes one feature while the engine keeps running. After a GPU device loss the
engine recreates the device and every plugin rebuilds its GPU state; no reload is needed.

## Not yet

From [`docs/threejs-parity.md`](threejs-parity.md). Each would be an optional package or needs a core change.

| three.js | Status in Margo |
| --- | --- |
| Several scenes or viewports, render to texture from a second camera, `CubeCamera` | Missing; needs core changes |
| WebGL2 for optional packages | Missing: core meshes, controls, labels, viewcube, bvh, LOD distance levels and the small glTF loader run on WebGL2; the rest needs WebGPU |
| More than one directional light, coloured ambient, configurable `HemisphereLight`, `RectAreaLight`, IES lights | Missing; point and spot lights via clustered, a fixed hemisphere fill in glTF-pro |
| `ShadowMaterial` on any mesh | Missing (`@margoengine/staging` ContactShadows is a ground shadow catcher for product shots) |
| glTF `KHR_animation_pointer`, iridescence, anisotropy, dispersion, material variants; applying glTF cameras | Missing (files that require them are rejected; cameras are exposed as data) |
| `MeshPhysicalMaterial`, Lambert, Phong, depth materials on your own meshes | Missing (glTF physical extensions are approximated; transmission does not refract) |
| Second UV set, geometry groups and custom attributes on your own meshes | Missing |
| Standalone KTX2 or float/3D/array data textures on your own meshes | Missing (KTX2 works inside glTF; materials takes RGBA8 data) |
| SMAA, GTAO, SSGI, motion blur, lens flare, glitch, afterimage | Missing (FXAA, TAA, SSAO, SSR, bloom, DOF are there) |
| Built-in screen effects (vignette, RGB shift, pixelation, halftone, Sobel) | Not built in; a few nodes in a shader `NodePass` |
| Clipping planes on glTF-pro models and textured meshes | Missing (machinery sections cap core meshes; shader `discard` slices without caps or shadows) |
| `BatchedMesh`, render layers | Missing (bvh has raycast layers only) |
| Reflector, Refractor, decals | Missing (water has its own refraction) |
| `TextGeometry`, SVGLoader, Collada, MTL, LDraw and other long-tail loaders | Missing |
| Clips authored in code, `SkeletonUtils`, CCD IK | Missing (two-bone IK only) |
| `ArcballControls`, roll in the controls, light and skeleton helpers | Missing (core `camera.up` can roll; no control drives it) |
| glTF export of cameras and lights, Draco/KTX2/EXR export, USDZ export with textures | Missing (glTF export with animation, skins, morphs and textures exists, plus OBJ, STL, PLY and static USDZ) |
| WebXR hit test, controller and hand models, glTF-pro models in XR | Missing (VR sessions and controller poses exist) |
