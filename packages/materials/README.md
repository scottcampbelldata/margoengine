# @margoengine/materials

Textures and materials for meshes you build in code: the counterparts of Three.js `TextureLoader`, `MeshStandardMaterial`, `MeshBasicMaterial`, `MeshNormalMaterial`, `MeshMatcapMaterial`, `CanvasTexture`, `VideoTexture` and `DataTexture`. Meshes draw through `@margoengine/gltf-pro`, so they accept the same shadows, clustered lights and SSAO as a loaded glTF. WebGPU only.

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

Texture transforms follow glTF `KHR_texture_transform` (uv' = offset x rotation x scale x uv, the same rows gltf-pro uses): `new Material({map, uvTransform: {offset: [0.5, 0], scale: [0.5, 0.5], rotation: 0}})` applies to every map except `matcap`; `material.setUVTransform(t, 'normalMap')` changes one slot (or all without a slot) live, `null` restores the identity. Without a transform the GPU calls are byte-identical to the package before transforms existed (checked when they landed; `examples/package-benchmarks/proofs/materials-uv-transform.proof.js` now checks 1,277 calls against `7f1c9c6`, the last intentional change to that output).

Atlases: `packAtlas(images, {padding: 2, maxSize: 4096})` shelf-packs RGBA8 data, ImageData, images, bitmaps or canvases into one `{data, width, height}` image (`new Texture(atlas.image)`) and returns each input's `uvTransform` in `atlas.regions`. Share one texture across materials with `uvTransform: atlas.regions[i]`, or bake the region into geometry with `transformUVs(uvs, region)` and merge static meshes (`@margoengine/geometry` `mergeGeometries`) into one draw: 256 textured boxes go from 256 draws and 8.3 ms CPU per frame to 1 draw and 0.05 ms on the mock GPU (CPU encoding only, `proofs/materials-atlas.proof.js`). Padding repeats edge texels, so the first `log2(padding)` mip levels do not bleed; coarser mips do, and regions cannot `repeat`. Images and canvases are read back through a 2D canvas (premultiplied alpha loses precision at low alpha) and keep `Texture`'s flipY orientation. `@margoengine/animation/vat` crowds take atlas regions per instance.

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

Limits: one material per mesh (geometry `groups` are ignored); UVs and the vertex arrays are packed once per geometry object, so edit a copy rather than the original; shading and render state are fixed at construction (render state goes through gltf-pro's `material.renderState` pipeline hook). Maps are bound by a gltf-pro lighting hook, so they apply to the lit colour only: SSAO normals and shadow alpha cut-outs ignore `normalMap` and `map` alpha. Basic and matcap output skips ACES tone mapping. No Lambert, Phong, depth or physical (clearcoat, transmission) materials, no second UV set, and no WebGL2 path. Shader-node `texture()` reads the raw `uv()`; transform it with nodes.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/materials. Browser check on a real WebGPU adapter: `node packages/materials/test/browser-check.mjs`.
