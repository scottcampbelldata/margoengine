# Three.js parity after the material extensions

Date: 2026-10-16. This list starts after clearcoat, transmission, volume, and the node slot in `docs/materials-extensions.md` have landed. None of it belongs in `@margoengine/core` or the stage facade. The 20,000-byte gzip gate stays on core plus stage.

The remaining gap is the rest of a production glTF file, then a few lighting and picking limits.

## File parity

Add these in order. Each one is a file that fails today.

1. **Done: KTX2 textures on a glTF.** `gltf-pro` now calls the existing `@margoengine/decoders` transcoder lazily for `KHR_texture_basisu`, uploads all mip levels in a device-supported format, and disposes loader-owned workers. Ordinary images retain their existing path; caller-supplied decoders remain caller-owned.

2. **Done: `KHR_texture_transform` and a second UV set.** Offset, rotation, scale and UV overrides work across base PBR and optional material textures. UV0/UV1 retain the fixed vertex layout. Nonidentity transforms append affine rows to group 3, preserving caller factors and the exact baseline shader for ordinary UV0 meshes. Normal mapping and alpha-masked directional shadows use the transformed coordinates.

3. **Done: The remaining glTF material lobes, on group 3.** `@margoengine/materials` supports sheen (`KHR_materials_sheen`), specular color (`KHR_materials_specular`), anisotropy (`KHR_materials_anisotropy`), and iridescence (`KHR_materials_iridescence`) through explicit installation or caller factories. Factors, textures, UV overrides/transforms, KTX2, composition with clearcoat/transmission, and device restoration share the existing isolated slot. Core, stage, the baseline PBR shader, and unextended bindings are unchanged.

4. **Done: Eight joint influences.** `@margoengine/animation` accepts paired `JOINTS_1` and `WEIGHTS_1`, normalizes all eight weights, and uses a separate 64-byte influence layout and compute pipeline. Four-influence assets retain their original shader and 32-byte records. Sets beyond eight reject explicitly; single-clip playback reuses sample and palette storage.

## Scene parity

These are smaller than the four file gaps.

5. **Done: Shadows from point and spot lights.** Opt-in `ClusteredOptions.shadows` adds bounded depth-array maps and `shadow:true` or per-light near/bias settings. Point lights render six perspective faces; spots render their cone. Explicit caster registration supports core and glTF Pro geometry, alpha masks, transformed UV1 and deformed vertex buffers. Core, PBR and terrain receive the shadows. Lighting bindings 16–18 avoid TAA/sky/terrain resources and leave the material slot at group 3. Directional cascades in `@margoengine/shadows` remain unchanged.

6. **Done: Picking on a skinned or morphed mesh.** Explicit `Picking.add(model)` and `Selection.add(model)` registrations consume glTF Pro's current draw buffers. Picks encode fresh skin/morph deformation, then combine core and PBR IDs in one micro-frustum depth target. Outlines replay the current geometry against scene depth. `Raycaster.intersectModel(model)` asynchronously snapshots the same GPU output and refits a CPU BVH. Bind-pose bounds cannot reject deformed geometry; core and stage remain frozen.

## Leave out of this push

A closed node graph still will not be Three.js TSL or `ShaderMaterial`. SSR, SSGI, GTAO, rect-area lights, IES profiles, `BatchedMesh`, and CSS3D are example-library features.

Crossfades, blend trees, and additive layers already live in `@margoengine/animator`. The README should keep saying that. The base animation package plays one clip. Treating that as a missing mixer brings the comment back after the materials ship.

## Verification of file items 1–4

- 1,189 tests pass on Node 24, with no failures or skips. Strict typechecks and packed runtime imports cover all 63 packages.
- `npm run modern:test:extensions` includes the original PBR/material regressions and the new `modern:test:gltf-parity` browser checks.
- 82 texture captures verify PBR and optional material transforms against baked UVs. Transformed alpha-mask shadow depths match across all four directional cascades. Ordinary shader/frame hashes and identity-transform pixels remain exact.
- Real ETC1S/UASTC textures upload all mips through RGBA fallback and native BC7 paths. A production Vite consumer emits and fetches Basis workers/Wasm, renders, and disposes every worker and texture.
- Complete, pinned Khronos `TextureTransformMultiTest` and `AnisotropyBarnLamp` files load, render, restore without pixel changes, and dispose. The transform model's authored sample UVs and checkmark shapes independently guard rotation direction.
- The original Babylon octopus rig exercises both influence sets on 48,222 vertices and 91 joints. GPU deformation matches an independent CPU reference within 1.79e-7; truncating secondary weights changes the result. Four-versus-eight records with zero secondary weights match exactly, and 120 playback ticks allocate no sample arrays or GPU resources.
- 59 additional-lobe captures verify exact zero/neutral parity in beauty, normal, ambient and HDR outputs, the specular-zero dielectric response, anisotropic highlight rotation and continuity at tiny strengths, all seven texture roles with transformed UV1, sRGB color decoding, and clearcoat/transmission composition. Ten thin-film GPU cases match independent numerical CIE integration within 7.4e-7.
- Complete Khronos `SheenChair`, `SpecularTest`, `CompareIridescence` and `AnisotropyBarnLamp` assets exercise authored factors and positive-versus-neutral renders. All four restore bit for bit; all 489 tracked GPU resources and both Basis workers are released. These checks run on an NVIDIA RTX A6000 through WebGPU without software fallback.
- Core and stage sources are unchanged: **47,983 bytes raw / 19,999 bytes gzip**, zero size delta.

Fixture sources, pinned hashes and attribution are recorded in [the production asset guide](../scripts/support/gltf-production-assets.README.md), [the material-lobe asset guide](../scripts/support/MATERIAL-LOBE-ASSETS.md), and [the skinning fixture guide](../packages/animation/tests/fixtures/README.md). Larger binaries stay in the ignored test cache.

## Verification of local-light shadows

- `npm run modern:test:local-shadows` exercises 45 actual frame captures, core/PBR/terrain receivers, point and spot motion, independent unshadowed lights, alpha-mask transforms, TAA composition and both directional registration orders.
- All six point faces match independent analytic depth values within 1.3e-7; GPU sampling independently reports lit and occluded reference points on every face. Disabled maps, removed casters, registration order and device restoration preserve exact pixels.
- All 39 shader modules compile without errors, and all 288 tracked GPU resources are destroyed. The hardware run uses an NVIDIA RTX A6000 without software fallback; the same checks also pass with bundled Chromium and SwiftShader. A face-boundary test proves normal bias selects the correct point face and prevents a lit seam.
- Clustered unit regressions retain the original unshadowed shader hashes and bindings. Steady shadow frames reuse buffers, bind groups, pipelines, shaders and typed-array views. Limits, invalid replacements, setup/draw failures and restoration have cleanup checks.
- Directional shadow sources and frozen core/stage sources are unchanged. Local shadows use a fixed comparison filter; custom-only terrain casters and area-light penumbrae remain outside this implementation. Terrain receives shadows.

## Verification of deformed picking

- `npm run modern:test:deformed-picking` passes 46 real frame captures on both an NVIDIA RTX A6000 and bundled Chromium/SwiftShader, across 4× MSAA and single sampling. All 96 shader modules compile, with no validation errors; all 590 tracked GPU resources are destroyed per adapter.
- Skin, morph, combined poses and eight influences pick correctly outside bind-pose bounds, including seeks and direct weight edits without an intervening beauty frame. CPU BVH hits and GPU positions match independent analytic references.
- Core/PBR depth competition, both outline algorithms, mirrored winding, UV1 alpha transforms and implicit mip filtering pass. A minified-alpha reference catches the incorrect forced-LOD-0 path. Unregistered beauty output stays bit exact.
- Pending readbacks, source removal, reused slots, animation disposal, restoration and failed maps release resources and reject stale results. Ordinary core MRT/culling and unextended PBR shader/frame regression checks remain in place.
- Registration is explicit. GPU picking handles rendered alpha and occlusion; asynchronous CPU BVH queries test triangles. Arbitrary vertex WGSL, PBR section clipping and TAA-jittered outline matching remain outside the replay.

## Done when

All six items are implemented. The limits above remain explicit.

- A glTF with a KTX2 texture, a texture transform, and eight influences loads through `loadGLTF` and `@margoengine/animation`.
- Sheen, specular, anisotropy, and iridescence attach through group 3. Zero sheen/aniso/iridescence and neutral specular match baseline pixels exactly; glTF specular factor 0 correctly removes dielectric reflection instead.
- One point light and one spot light cast a shadow without changing the directional cascade path.
- `engine.pick` hits a skinned mesh, and `@margoengine/selection` can include that draw.
- `npm run measure:size` still reports core plus stage under 20,000 bytes gzip.
