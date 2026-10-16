# Three.js replacement: gaps and launch requirements

Date: 2026-10-16. This note is about claiming Margo as an engine someone can use instead of Three.js. It is not a feature-parity plan. Core and the stage facade stay frozen.

Three's surface is the examples, the loader extensions, and years of material addons. Matching that is a different product. Launch needs the path a stranger actually hits, and a page that says what this version refuses.

## What already covers a typical scene

A typical Three scene is a camera, a mesh, orbit controls, a glTF, metallic-roughness, an HDR environment, one clip, and a dispose call. That path exists here, split across packages:

| Job | Package |
| --- | --- |
| Stage, camera, mesh, dispose | `margoengine` and `@margoengine/core` |
| Metallic-roughness glTF | `@margoengine/gltf-pro` |
| Clearcoat, sheen, specular color, anisotropy, iridescence, transmission, IOR, volume, and authored node materials | [`@margoengine/materials`](../packages/materials/README.md), installed explicitly through the optional material extension slot |
| HDR environment and image-based lighting | `@margoengine/environment` |
| Orbit controls | `@margoengine/controls` |
| One skin and morph clip, four or eight influences | `@margoengine/animation` |
| Crossfades, blend trees, additive layers | `@margoengine/animator` |
| Directional cascaded shadows | `@margoengine/shadows` |
| Up to 1,024 point and spot lights, with opt-in local shadows | `@margoengine/clustered` |
| Bloom, AgX, SSAO | `@margoengine/post` |
| Depth of field, tone mapping, TAA | `@margoengine/dof`, `@margoengine/tonemap`, `@margoengine/taa` |
| React bindings | `@margoengine/react` |
| Triangle BVH | `@margoengine/bvh` |
| Draco, meshopt and KTX2 inside glTF | `@margoengine/gltf-pro` calls `@margoengine/decoders` automatically, retaining texture mips and releasing temporary workers. |

`clustered` supports opt-in point and spot shadow maps for registered core and PBR casters, with core/PBR/terrain receivers. A bounded atlas and fixed comparison filter stay separate from the directional cascades in `@margoengine/shadows`. Custom-only clipmap terrain casters and area-light penumbrae remain unsupported.

The React README already says PBR models, HDR image-based lighting, and shadows require WebGPU. Legacy meshes and neutral studio lighting support the WebGL2 fallback.

### Resolved: Draco and meshopt loading

**Resolved on 2026-10-16.** `@margoengine/gltf-pro` now calls its `@margoengine/decoders` dependency automatically for `KHR_draco_mesh_compression` and `EXT_meshopt_compression`. No decoder registration is required for normal browser loading.

| API | Input and compression support |
| --- | --- |
| `await loadGLTF(engine, url, options)` | Downloads `.gltf` or `.glb`, resolves external buffers/images, and decodes Draco primitives, meshopt buffer views and KTX2 textures automatically. |
| `await parseGLTFAsync(engine, input, buffers, images, options)` | Parses in-memory glTF JSON, a document object, or GLB bytes, with supplied buffers/images as needed. Supports Draco, meshopt and embedded KTX2. |
| `parseGLTF(engine, input, buffers, images)` | Preserves synchronous parsing for uncompressed and meshopt assets. Draco input requires one of the async APIs. |

Both async APIs accept optional `{signal, draco, ktx2}` options. The default Draco decoder starts browser module workers and Wasm only when needed, then disposes its workers after success, failure or cancellation. A supplied reusable `draco` decoder remains owned by its caller.

Draco attributes and indices populate the original accessors even when no backing buffer views are declared. Meshopt views are decoded and cached before accessor reads, including URI-less fallback placeholders. Real Draco Box and Avocado fixtures pass with 24 vertices/36 indices and 406 vertices/2,046 indices respectively; Avocado retains its UV and tangent streams. Production browser checks cover automatic loading of compressed `.gltf` and `.glb` files with bundled workers and Wasm.

KTX2/BasisU textures preserve mip levels and negotiate enabled GPU formats. `KHR_texture_transform` supports offset, rotation, scale and UV overrides across PBR and optional material maps. UV1 retains the fixed vertex layout; nonidentity transforms use group 3. Unknown required extensions still fail, and PBR rendering requires WebGPU.

## What Three.js has that this repo does not

These are the gaps a porter will find. They are not a build list.

| Three.js | This repo |
| --- | --- |
| Extended PBR materials | [`@margoengine/materials`](../packages/materials/README.md) adds clearcoat, sheen, specular color, anisotropy, iridescence, transmission, IOR, and Beer-law volume through group 3. The lobes affect directional lighting and fixed hemispherical ambient; clustered and environment lighting retain their base response. Refraction samples the opaque screen color once; there is no ray tracing or participating media. The Blender loader still rejects extended materials. |
| Shadowed point and spot lights, rect-area lights, IES profiles | Point and spot shadows are optional in `@margoengine/clustered`; rect-area lights and IES profiles remain unsupported. |
| `AnimationMixer` on the same object as the skin | `@margoengine/animation` plays one clip, with four or eight influences, and does not crossfade. Crossfades, 1D and 2D blend trees, and masked additive layers are in `@margoengine/animator`. |
| `ShaderMaterial` and node materials | `materials.nodeMaterial()` compiles a closed TypeScript graph to `MaterialExtension`; it accepts no arbitrary WGSL, node-graph file format, or Three.js TSL. Custom WGSL uses `MaterialExtension` directly, and custom draws use the core extension API. |
| `EffectComposer` with SSR, SSGI, GTAO, SMAA, outline | The post packages are bloom, AgX, SSAO, depth of field, and TAA. They are separate packages, not one composer stack. |
| `Raycaster` against skinned and morphed meshes | Explicit picking/selection registrations use current PBR deformation buffers. `engine.pick` combines visible core/PBR depth; asynchronous `Raycaster.intersectModel()` reads that GPU pose for geometric CPU triangle queries. |
| `THREE.LOD`, `BatchedMesh`, CSS3D, more than eight joint influences | `@margoengine/scatter` has its own GPU LOD. The animation package bounds influences at eight. |

The native FBX importer has landed. `docs/native-fbx.md` and `packages/fbx/README.md` describe it. `@margoengine/fbx` has no Three.js runtime dependency. A CC0 Blender rig now has headless numeric checks and a required rendered playback and seek check, recorded in `docs/code-to-nine.md`. Broader DCC certification is still separate. The file a stranger tries first is still a glTF. A compressed glTF now has a path through `loadGLTF`. KTX2 textures, texture transforms and eight-influence character meshes now have that path too.

## What has to be true before launch

Five launch requirements remain separate from the implemented optional materials and local-light shadows, cubic FBX curves, and broader DCC certification.

1. **The install command is true.** `npm install margoengine` works, or the root README does not tell people to run it. The catalog still marks the packages unpublished while the README shows `npm install @margoengine/core@0.1.0` and the matching React, glTF, machinery, and creative lines.

2. **The first paragraph is one claim.** One gzip figure from `npm run measure:size`, one demo, and the six packages that are the product: the stage, `core`, `react`, `gltf`, `gltf-pro`, and `machinery`. The verified result on 2026-10-16 is 19,999 bytes gzip against the 20,000-byte gate. Use that figure for the current release. Earlier benchmark reports cite 19,874 bytes, and sandbox notes describe an older 20,480-byte gate; those historical figures belong to their recorded builds. One command, one number, one commit.

3. **WebGPU is named where the features need it.** The first paragraph says WebGPU is required for PBR, image-based lighting, and shadows, and that the WebGL2 path is the basic mesh. The React README already says this. The root README has to say it before someone files the fallback as a bug.

4. **A real glTF loads — compression hook resolved.** `loadGLTF` and `parseGLTFAsync` automatically decode Draco, meshopt and KTX2, with real-fixture and production browser coverage. `parseGLTF` remains synchronous for uncompressed and meshopt input. Name the loader path used by the launch demo and retain the texture-transform and eight-influence regression checks.

5. **A short replacement map sits above the catalog.** One row each for camera, mesh, orbit, glTF, environment, one animation clip, and dispose, with the import that does it. Beside that map, state the material limits: screen-space refraction, no participating media or node-graph file format, and transmissive surfaces do not cast shadows or receive cascaded shadows. Name the explicit opt-in and caster registration for local-light shadows, along with unsupported rect-area lights, IES profiles and Three.js `ShaderMaterial` source/TSL. `@margoengine/animator` is named as the place clip crossfades live, so the base animation package is not mistaken for a missing mixer.

## What can wait

Do not hold the launch for these. Document them as absent.

- Ray-traced or multi-bounce transmission and participating media; extended lobes in clustered or environment lighting.
- Rect-area lights, IES profiles, area-light penumbrae, and custom-only clipmap terrain casters for local lights.
- Three.js TSL and node-graph file formats, SSR, SSGI, GTAO, and a single EffectComposer clone.
- Arbitrary vertex WGSL and PBR section clipping in GPU picking; alpha-texture rejection in CPU triangle raycasts.
- Cubic FBX curves, extra inheritance modes, progressive morphs, and broader DCC certification beyond the checked-in Blender rig. The native reader is already the runtime. Three.js is no longer an FBX dependency.
- `THREE.LOD`, `BatchedMesh`, CSS3D, and more than eight joint influences.

Draco, meshopt and KTX2 loading, texture transforms, eight influences and the optional materials slot are implemented; keep their regression checks passing. Core and the stage remain frozen at **19,999 bytes gzip**. See the [materials implementation record](materials-extensions.md) for the supported lobes and verification.
