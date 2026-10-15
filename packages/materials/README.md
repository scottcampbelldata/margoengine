# @margoengine/materials

Textures and materials for meshes you build in code: the counterparts of Three.js `TextureLoader`, `MeshStandardMaterial`, `MeshBasicMaterial`, `MeshNormalMaterial`, `MeshMatcapMaterial`, `CanvasTexture`, `VideoTexture` and `DataTexture`. Meshes draw through `@margoengine/gltf-pro`, so they accept the same shadows, clustered lights, SSAO and SSR (`ssr.add(mesh)`: glossy meshes reflect) as a loaded glTF. WebGPU only.

```ts
import {createStage} from 'margoengine';
import {boxGeometry, planeGeometry} from '@margoengine/geometry';
import {loadTexture, Texture, Material, createMesh} from '@margoengine/materials';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const map = await loadTexture('/crate.jpg', {wrapS: 'repeat', wrapT: 'repeat', anisotropy: 8});
const normalMap = await loadTexture('/crate-normal.png');           // non-colour slots read linear
const crate = createMesh(stage.engine, boxGeometry(1, 1, 1), new Material({map, normalMap, roughness: 0.7}));
crate.root.setPosition([0, 0.5, 0]);
const screen = createMesh(stage.engine, planeGeometry(1.6, 0.9), new Material({shading: 'basic', map: new Texture(videoElement)}));
const glass = new Material({color: '#88ccff', transparent: true, opacity: 0.4, doubleSided: true});
createMesh(stage.engine, planeGeometry(2, 2), glass, {renderOrder: 1});
glass.opacity = 0.6;                                                // live: color, emissive, scalars and map slots
// crate.dispose() removes a mesh; map.dispose() frees the texture (meshes never dispose shared textures).
```

`createMesh` returns a `MaterialMesh`: the gltf-pro `PBRModel` plus `mesh.material`, the live `Material` it draws with (`@margoengine/exporters` `exportModel` reads its textures to write glTF).

`Material` options: `shading` (`'standard'` PBR, `'basic'` unlit, `'normal'`, `'matcap'`), `color` (`'#rrggbb'` sRGB or linear `[r,g,b(,a)]`), `opacity`, `roughness`, `metalness`, `emissive`, `map`, `metalRoughnessMap` (glTF packing: G roughness, B metalness), `normalMap`, `normalScale`, `aoMap`, `aoMapIntensity`, `emissiveMap`, `matcap`, `transparent`, `alphaTest`, `doubleSided`, `blending` (`'normal'`, `'additive'`, `'multiply'`, `'none'`), `depthWrite`, `depthTest`. Geometry is any `{positions, normals, uvs?, indices?, tangents?, colors?}`, so `@margoengine/geometry` output fits directly; vertex colours (RGB/RGBA floats or bytes) always multiply the base colour.

`Texture` accepts an ImageBitmap, image, canvas, OffscreenCanvas, video, VideoFrame, ImageData or `{data, width, height}` RGBA8 bytes, with `colorSpace`, `wrapS`/`wrapT` (`'clamp'` default, `'repeat'`, `'mirror'`), `magFilter`/`minFilter`, `mipmaps`, `anisotropy` and `flipY`. Images flip like Three.js (`flipY` true) and raw data does not. Without `colorSpace`, `map`, `emissiveMap` and `matcap` read sRGB and other slots linear. One GPU copy is shared by every material. Videos re-upload when `currentTime` changes; call `texture.update()` after drawing to a canvas or changing data. `loadTexture` fetches http(s), blob: or data: URLs (64 MiB, 4096 x 4096 pixels).

Physical options (three.js `MeshPhysicalMaterial` names, glTF `KHR_materials_*` meaning) make a `standard` material physical: `clearcoat`, `clearcoatRoughness`, `sheenColor`, `sheenRoughness`, `specularIntensity`, `specularColor`, `ior`, `transmission`, `thickness`, `attenuationColor` and `attenuationDistance`. The mesh then draws gltf-pro's physical shader (its factor-only variant: the five maps above, no extension maps), so it renders exactly like the same glTF material: on a real GPU a materials sphere and the equivalent glTF sphere gave identical frames (HDR and 8-bit) for glass, clearcoat car paint and sheen fabric (`examples/package-benchmarks/physical-gpu.mjs`, [results](../../examples/package-benchmarks/results/physical-gpu.json)). Which options exist is fixed at construction; their values stay live (`paint.clearcoat = 0.5`). `transmission` makes the mesh transmissive (drawn after opaque meshes, no depth write); `thickness` and the attenuation need it. An exported mesh (`@margoengine/exporters`) names the extensions it uses.

```ts
import {createStage} from 'margoengine';
import {sphereGeometry} from '@margoengine/geometry';
import {Material, createMesh} from '@margoengine/materials';
import {Transmission} from '@margoengine/materials/transmission';
import {PostStack} from '@margoengine/post';
import {Tonemap} from '@margoengine/tonemap';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const paint = new Material({color: [0.55, 0.02, 0.03], metalness: 0.6, roughness: 0.45, clearcoat: 1, clearcoatRoughness: 0.05});
const velvet = new Material({color: '#1a1f5a', sheenColor: [0.9, 0.7, 0.8], sheenRoughness: 0.4});
const glass = new Material({color: [0.95, 1, 0.95], roughness: 0, transmission: 1, ior: 1.5, thickness: 0.8, attenuationColor: [0.6, 0.9, 1], attenuationDistance: 2});
PostStack.attach(stage.engine, [new Tonemap()]);                  // refraction reads the HDR scene capture
const transmission = Transmission.attach(stage.engine);
transmission.add(createMesh(stage.engine, sphereGeometry(1, 64, 32), glass)); // a gltf-pro model works too
for (const [material, x] of [[paint, -2.5], [velvet, 2.5]] as const) createMesh(stage.engine, sphereGeometry(1, 64, 32), material).root.setPosition([x, 0, 0]);
paint.clearcoat = 0.5;                                              // live
```

Without `Transmission` a transmissive surface shows the background tinted, as gltf-pro draws glTF transmission. `transmission.add(model)` (a materials mesh or any gltf-pro `PBRModel`; returns a remover) makes it refract instead, through gltf-pro's transmission hook: once per frame, only when a transmissive surface draws, the opaque scene (after the sky, at frame-graph order 3) is copied into an rgba16float mip chain, and each transmissive pixel adds the light read along its refracted ray (`refract(-v, n, 1/ior)` for `thickness` mesh units, so 0 is thin-walled and shows what is directly behind), blurred to mip level log2(width) × roughness × clamp(2 ior − 2, 0, 1), attenuated by `attenuationColor`^(path / `attenuationDistance`) and weighted by base colour × transmission × (1 − Fresnel), under the clearcoat and sheen layers (the Khronos glTF PBR transmission BTDF, approximated in screen space like the Khronos sample renderer). On a real GPU the added light matches a CPU model of those terms within a mean of 0.0003 (p95 0.001) linear HDR over a checkerboard, against 0.17 for the same pixels without refraction. It needs an HDR scene capture (a `PostStack` with an HDR or display effect, such as `Tonemap` or `Bloom`); without one it throws a named error. The pass adds one texture to the transmissive shader: a physical materials mesh has 10, so 11 with refraction and 14 with shadows, IBL and LocalShadows too.

Texture transforms follow glTF `KHR_texture_transform` (uv' = offset x rotation x scale x uv, the same rows gltf-pro uses): `new Material({map, uvTransform: {offset: [0.5, 0], scale: [0.5, 0.5], rotation: 0}})` applies to every map except `matcap`; `material.setUVTransform(t, 'normalMap')` changes one slot (or all without a slot) live, `null` restores the identity. Without a transform the GPU calls are byte-identical to the package before transforms existed (`examples/package-benchmarks/proofs/materials-uv-transform.proof.js`: 1,277 calls, `1970fda` against `700838e` where they landed; with `--current` it checks the working tree against `7f1c9c6`, the last intentional change to that output).

Atlases: `packAtlas(images, {padding: 2, maxSize: 4096})` shelf-packs RGBA8 data, ImageData, images, bitmaps or canvases into one `{data, width, height}` image (`new Texture(atlas.image)`) and returns each input's `uvTransform` in `atlas.regions`. Share one texture across materials with `uvTransform: atlas.regions[i]`, or bake the region into geometry with `transformUVs(uvs, region)` and merge static meshes (`@margoengine/geometry` `mergeGeometries`) into one draw: 256 textured boxes go from 256 draws and 8.3 ms CPU per frame to 1 draw and 0.05 ms on the mock GPU (CPU encoding only, measured at `700838e`, `proofs/materials-atlas.proof.js`; core has since become faster, so a re-run times both lower). Padding repeats edge texels, so the first `log2(padding)` mip levels do not bleed; coarser mips do, and regions cannot `repeat`. Images and canvases are read back through a 2D canvas (premultiplied alpha loses precision at low alpha) and keep `Texture`'s flipY orientation. `@margoengine/animation/vat` crowds take atlas regions per instance.

Instancing (three.js `InstancedMesh`): `createInstancedMesh(engine, geometry, material, capacity, {renderOrder})` is `createMesh` drawn as `capacity` copies in one draw call, with one engine entity. `mesh.instances` (gltf-pro `PBRInstances`, from `@margoengine/gltf-pro/instancing`, which only `createInstancedMesh` pulls in) holds each copy's matrix relative to `mesh.root`, a linear RGB(A) tint that multiplies the base colour like a vertex colour, and a UV offset/scale applied before the material's `uvTransform` (an atlas region, so one material shows different images):

```ts
import {createStage} from 'margoengine';
import {boxGeometry} from '@margoengine/geometry';
import {Material, Texture, createInstancedMesh, packAtlas} from '@margoengine/materials';
declare const images: ImageData[];
const stage = await createStage('#viewport', {backend: 'webgpu'}), atlas = packAtlas(images);
const crates = createInstancedMesh(stage.engine, boxGeometry(1, 1, 1), new Material({map: new Texture(atlas.image)}), 5000);
for (let i = 0; i < 5000; i++) crates.instances
  .setMatrixAt(i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i % 100, 0, Math.floor(i / 100), 1]) // column-major, e.g. Matrix4.elements
  .setColorAt(i, [1, 0.9, 0.8])
  .setUVTransformAt(i, atlas.regions[i % atlas.regions.length]);
crates.instances.count = 3000;                // draw the first 3000; setters upload only the rows they changed
// shadows.add(crates), ssao.add(crates) and the other effects see every instance, as for createMesh
```

5,000 textured boxes: 5,000 draws and 55 ms CPU per frame as separate meshes, 1 draw and 0.7 ms instanced (Intel Arc 140V laptop iGPU, Edge 155, [textured-instancing-gpu.json](../../examples/package-benchmarks/results/textured-instancing-gpu.json); the instanced frame is within 1/255 per channel of the separate meshes'). See gltf-pro's README for instancing limits.

For node-based colour, normal, roughness, emissive, opacity and vertex offsets, `@margoengine/shader`'s `NodeMaterial` extends `Material` through its `shader(source, group)` and `bindings(device, engine)` methods, which subclasses may override.

Sorting matches Three.js: all material meshes draw in one pass, opaque first, then transparent back to front, each group by `renderOrder`. Overlapping transparent meshes can pop as the camera crosses the point where their order flips; `oit.add(mesh)` from `@margoengine/oit` draws a transparent mesh with `blending: 'normal'` order-independently instead (other blendings and `depthWrite`/`depthTest` overrides stay sorted).

Limits: one material per mesh (geometry `groups` are ignored); physical options take factors only (no clearcoat, sheen, specular, transmission or thickness maps) and need `standard` shading; refraction is screen-space (what is off screen or in front of the glass cannot be seen through it, transmissive surfaces do not see each other, punctual lights do not shine through), `thickness` is scaled by the mean of the model's axis scales; UVs and the vertex arrays are packed once per geometry object, so edit a copy rather than the original; shading and render state are fixed at construction (render state goes through gltf-pro's `material.renderState` pipeline hook). Maps are bound by a gltf-pro lighting hook, so they apply to the lit colour only: SSAO normals and shadow alpha cut-outs ignore `normalMap` and `map` alpha. Basic and matcap output skips ACES tone mapping. Added to SSR, `basic`, `normal` and `matcap` meshes reflect by their roughness and metalness like `standard` ones (the default roughness 1 never reflects). No Lambert, Phong or depth materials, no iridescence, anisotropy or dispersion, no second UV set, and no WebGL2 path. Shader-node `texture()` reads the raw `uv()`; transform it with nodes.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/materials. Browser check on a real WebGPU adapter: `node packages/materials/test/browser-check.mjs`.
