# Three.js replacement: gaps and launch requirements

Date: 2026-10-16. This note is about claiming Margo as an engine someone can use instead of Three.js. It is not a feature-parity plan. Core and the stage facade stay frozen.

Three's surface is the examples, the loader extensions, and years of material addons. Matching that is a different product. Launch needs the path a stranger actually hits, and a page that says what this version refuses.

## What already covers a typical scene

A typical Three scene is a camera, a mesh, orbit controls, a glTF, metallic-roughness, an HDR environment, one clip, and a dispose call. That path exists here, split across packages:

| Job | Package |
| --- | --- |
| Stage, camera, mesh, dispose | `margoengine` and `@margoengine/core` |
| Metallic-roughness glTF | `@margoengine/gltf-pro` |
| Clearcoat, transmission, IOR, volume, and authored node materials | [`@margoengine/materials`](../packages/materials/README.md), installed explicitly through the optional material extension slot |
| HDR environment and image-based lighting | `@margoengine/environment` |
| Orbit controls | `@margoengine/controls` |
| One skin and morph clip, four influences | `@margoengine/animation` |
| Crossfades, blend trees, additive layers | `@margoengine/animator` |
| Directional cascaded shadows | `@margoengine/shadows` |
| Up to 1,024 point and spot lights | `@margoengine/clustered` |
| Bloom, AgX, SSAO | `@margoengine/post` |
| Depth of field, tone mapping, TAA | `@margoengine/dof`, `@margoengine/tonemap`, `@margoengine/taa` |
| React bindings | `@margoengine/react` |
| Triangle BVH | `@margoengine/bvh` |
| Draco and meshopt inside glTF, KTX2 decoders | `@margoengine/gltf-pro` calls `@margoengine/decoders` for Draco and meshopt. KTX2 decoding exists and is not accepted on a glTF texture. |

`clustered` states that local lights do not cast shadows. Shadows are the directional cascades in `@margoengine/shadows`.

The React README already says PBR models, HDR image-based lighting, and shadows require WebGPU. Legacy meshes and neutral studio lighting support the WebGL2 fallback.

### Resolved: Draco and meshopt loading

**Resolved on 2026-10-16.** `@margoengine/gltf-pro` now calls its `@margoengine/decoders` dependency automatically for `KHR_draco_mesh_compression` and `EXT_meshopt_compression`. No decoder registration is required for normal browser loading.

| API | Input and compression support |
| --- | --- |
| `await loadGLTF(engine, url, options)` | Downloads `.gltf` or `.glb`, resolves external buffers/images, and decodes Draco primitives and meshopt buffer views automatically. |
| `await parseGLTFAsync(engine, input, buffers, images, options)` | Parses in-memory glTF JSON, a document object, or GLB bytes, with supplied buffers/images as needed. Supports both Draco and meshopt. |
| `parseGLTF(engine, input, buffers, images)` | Preserves synchronous parsing for uncompressed and meshopt assets. Draco input requires one of the async APIs. |

Both async APIs accept optional `{signal, draco}` options. The default Draco decoder starts browser module workers and Wasm only when needed, then disposes its workers after success, failure or cancellation. A supplied reusable `draco` decoder remains owned by its caller.

Draco attributes and indices populate the original accessors even when no backing buffer views are declared. Meshopt views are decoded and cached before accessor reads, including URI-less fallback placeholders. Real Draco Box and Avocado fixtures pass with 24 vertices/36 indices and 406 vertices/2,046 indices respectively; Avocado retains its UV and tangent streams. Production browser checks cover automatic loading of compressed `.gltf` and `.glb` files with bundled workers and Wasm.

KTX2 textures on a glTF remain unsupported. Unknown required extensions still fail, and PBR rendering still requires WebGPU.

## What Three.js has that this repo does not

These are the gaps a porter will find. They are not a build list.

| Three.js | This repo |
| --- | --- |
| KTX2 textures on a glTF | `@margoengine/decoders` has a standalone KTX2 decoder, but glTF texture loading does not call it. Draco and meshopt geometry loading is resolved above. |
| Extended PBR materials | [`@margoengine/materials`](../packages/materials/README.md) adds clearcoat, transmission, IOR, and Beer-law volume through the optional group 3 slot. Refraction samples the opaque screen color once; there is no ray tracing or participating media. Sheen, iridescence, anisotropy, and specular-color remain unsupported. The Blender loader still rejects extended materials. |
| Shadowed point and spot lights, rect-area lights, IES profiles | Clustered lights do not cast shadows. Shadows are directional cascades. |
| `AnimationMixer` on the same object as the skin | `@margoengine/animation` plays one clip, with four influences, and does not crossfade. Crossfades, 1D and 2D blend trees, and masked additive layers are in `@margoengine/animator`. |
| `ShaderMaterial` and node materials | `materials.nodeMaterial()` compiles a closed TypeScript graph to `MaterialExtension`; it accepts no arbitrary WGSL, node-graph file format, or Three.js TSL. Custom WGSL uses `MaterialExtension` directly, and custom draws use the core extension API. |
| `EffectComposer` with SSR, SSGI, GTAO, SMAA, outline | The post packages are bloom, AgX, SSAO, depth of field, and TAA. They are separate packages, not one composer stack. |
| `Raycaster` against skinned and morphed meshes | `engine.pick` is a GPU id buffer. `@margoengine/selection` covers core mesh geometry and excludes skinned draws. `@margoengine/bvh` is triangles. |
| `THREE.LOD`, `BatchedMesh`, CSS3D, `KHR_texture_transform`, more than four joint influences | Not on the core path. `@margoengine/scatter` has its own GPU LOD. The animation package rejects `JOINTS_1` and `WEIGHTS_1`. |

The native FBX importer has landed. `docs/native-fbx.md` and `packages/fbx/README.md` describe it. `@margoengine/fbx` has no Three.js runtime dependency, and `npm test --workspace @margoengine/fbx` passed 52 tests. A rendered real-DCC fixture is still an open gate. The file a stranger tries first is still a glTF. A compressed glTF now has a path through `loadGLTF`. A KTX2 texture on that glTF does not.

## What has to be true before launch

Five launch requirements remain separate from optional materials, point-light shadows, cubic FBX curves, and broader DCC certification.

1. **The install command is true.** `npm install margoengine` works, or the root README does not tell people to run it. The catalog still marks the packages unpublished while the README shows `npm install @margoengine/core@0.1.0` and the matching React, glTF, machinery, and creative lines.

2. **The first paragraph is one claim.** One gzip figure from `npm run measure:size`, one demo, and the six packages that are the product: the stage, `core`, `react`, `gltf`, `gltf-pro`, and `machinery`. The verified result on 2026-10-16 is 19,999 bytes gzip against the 20,000-byte gate. Use that figure for the current release. Earlier benchmark reports cite 19,874 bytes, and sandbox notes describe an older 20,480-byte gate; those historical figures belong to their recorded builds. One command, one number, one commit.

3. **WebGPU is named where the features need it.** The first paragraph says WebGPU is required for PBR, image-based lighting, and shadows, and that the WebGL2 path is the basic mesh. The React README already says this. The root README has to say it before someone files the fallback as a bug.

4. **A real glTF loads — compression hook resolved.** `loadGLTF` and `parseGLTFAsync` automatically decode Draco and meshopt, with real-fixture and production browser coverage. `parseGLTF` remains synchronous for uncompressed and meshopt input. Say that KTX2 textures are still rejected, and name the loader path used by the launch demo.

5. **A short replacement map sits above the catalog.** One row each for camera, mesh, orbit, glTF, environment, one animation clip, and dispose, with the import that does it. Beside that map, state the material limits: screen-space refraction, no participating media or node-graph file format, and transmissive surfaces do not cast shadows or receive cascaded shadows. Also name unsupported point/spot-light shadows and Three.js `ShaderMaterial` source/TSL. `@margoengine/animator` is named as the place clip crossfades live, so the base animation package is not mistaken for a missing mixer.

## What can wait

Do not hold the launch for these. Document them as absent.

- Sheen, iridescence, anisotropy, and specular-color; ray-traced or multi-bounce transmission and participating media.
- Rect-area lights, IES profiles, and shadows from point or spot lights.
- Three.js TSL and node-graph file formats, SSR, SSGI, GTAO, and a single EffectComposer clone.
- A CPU raycaster that hits skinned and morphed vertices.
- Cubic FBX curves, extra inheritance modes, progressive morphs, and a rendered real-DCC fixture. The native reader is already the runtime. Three.js is no longer an FBX dependency.
- `THREE.LOD`, `BatchedMesh`, CSS3D, texture transforms, and more than four joint influences.

KTX2 on glTF textures is the compression gap that is still open. Draco and meshopt loading and the optional materials slot are implemented; keep their regression checks passing. Core and the stage remain frozen at **19,999 bytes gzip**. See the [materials implementation record](materials-extensions.md) for the supported lobes and verification.
