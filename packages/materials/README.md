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
// crate.destroy() removes a mesh; map.dispose() frees the texture (meshes never dispose shared textures).
```

`Material` options: `shading` (`'standard'` PBR, `'basic'` unlit, `'normal'`, `'matcap'`), `color` (`'#rrggbb'` sRGB or linear `[r,g,b(,a)]`), `opacity`, `roughness`, `metalness`, `emissive`, `map`, `metalRoughnessMap` (glTF packing: G roughness, B metalness), `normalMap`, `normalScale`, `aoMap`, `aoMapIntensity`, `emissiveMap`, `matcap`, `transparent`, `alphaTest`, `doubleSided`, `blending` (`'normal'`, `'additive'`, `'multiply'`, `'none'`), `depthWrite`, `depthTest`. Geometry is any `{positions, normals, uvs?, indices?, tangents?, colors?}`, so `@margoengine/geometry` output fits directly; vertex colours (RGB/RGBA floats or bytes) always multiply the base colour.

`Texture` accepts an ImageBitmap, image, canvas, OffscreenCanvas, video, VideoFrame, ImageData or `{data, width, height}` RGBA8 bytes, with `colorSpace`, `wrapS`/`wrapT` (`'clamp'` default, `'repeat'`, `'mirror'`), `magFilter`/`minFilter`, `mipmaps`, `anisotropy` and `flipY`. Images flip like Three.js (`flipY` true) and raw data does not. Without `colorSpace`, `map`, `emissiveMap` and `matcap` read sRGB and other slots linear. One GPU copy is shared by every material. Videos re-upload when `currentTime` changes; call `texture.update()` after drawing to a canvas or changing data. `loadTexture` fetches http(s), blob: or data: URLs (64 MiB, 4096 x 4096 pixels).

Sorting matches Three.js: all material meshes draw in one pass, opaque first, then transparent back to front, each group by `renderOrder`.

Limits: one material per mesh (geometry `groups` are ignored); UVs and the vertex arrays are packed once per geometry object, so edit a copy rather than the original; shading and render state are fixed at construction. Maps are bound by a gltf-pro lighting hook, so they apply to the lit colour only: SSAO normals and shadow alpha cut-outs ignore `normalMap` and `map` alpha. Basic and matcap output skips ACES tone mapping. No Lambert, Phong, depth or physical (clearcoat, transmission) materials, no texture transforms or second UV set, and no WebGL2 path.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/materials. Browser check on a real WebGPU adapter: `node packages/materials/test/browser-check.mjs`.
