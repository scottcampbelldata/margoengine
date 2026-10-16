# Clearcoat, transmission, volume, and node materials

Date: 2026-10-16. Add the four material features that the Three.js comparison asks for. Core and the stage facade stay frozen. None of this enters the 20,000-byte gzip measurement.

The current PBR shader is `packages/gltf-pro/src/shader.ts`. `Surface` is base color, normal, roughness, metal, occlusion, and emissive. The frame uniform is packed through `coordsB`. Group 1 already uses texture bindings 0 through 9. There is no spare `vec4` and no spare sampler in that shader. New lobes do not get wedged into `Frame`.

## Where it goes

`@margoengine/gltf-pro` gains one extension slot. `@margoengine/materials` fills it. A model with no extension keeps today's shader, today's five textures, and today's uniform buffer.

The slot is three things, all inside `gltf-pro`:

1. Lighting stays at group 2. `addLighting()` already splices WGSL with group index 2 and creates bind group layout 2. Material extensions use group 3. That assignment is fixed. An unextended primitive, including one with lighting, does not declare `@group(3)` and does not create a third bind group. Its shader string and its group 0 and group 1 bindings stay the ones it has today.
2. `MaterialExtension` on a primitive: optional WGSL inserted after `surface()` returns, optional extra `vec4` factors, and optional extra textures. `draw()` uploads that block and adds those group 3 bindings only for primitives that have an extension.
3. The pipeline key already includes the full shader string. Extended and unextended primitives must not share a pipeline. An extension that changes blend mode uses the existing `settings[0] === 2` blend path.

`@margoengine/materials` depends on `gltf-pro`. It is `sideEffects: false`. It is not imported by core, the stage, or `gltf-pro`. The loader signatures stay unchanged. A file that uses these features calls `materials.install(model)` after `loadGLTF` or `parseGLTF`. `gltf-pro` does not import the materials package to discover them.

`npm run measure:size` stays the completion check for every step. The result stays under 20,000 bytes gzip.

## What each feature means

These are the glTF extensions, not a copy of Three.js nodes.

| Feature | glTF extension | Shader behavior |
| --- | --- | --- |
| Clearcoat | `KHR_materials_clearcoat` | A second GGX lobe. Factor, roughness, and an optional coat normal. The base lobe is unchanged underneath. Factor `0` is the current shader. |
| Transmission | `KHR_materials_transmission` and `KHR_materials_ior` | The surface transmits the opaque color already rendered this frame. Factor, IOR, and an optional texture. This is a background sample, not a ray trace. |
| Volume | `KHR_materials_volume` | Thickness and attenuation color and distance, applied along the transmitted view. Volume without transmission is rejected. This is not participating-media scattering. |
| Node materials | None | A small TypeScript graph that compiles into the same extension slot. It is not a glTF file format and it is not Three.js TSL. |

Sheen, iridescence, anisotropy, and specular-color use this same slot later. They are not part of this file's work, and they do not need a second hook.

## Clearcoat

Read `materials.clearcoat.factor`, `roughnessFactor`, `clearcoatTexture`, `clearcoatRoughnessTexture`, and `clearcoatNormalTexture`. Missing factor means `0`. Missing roughness means `0`.

The coat lobe uses the same GGX, Smith, and Schlick terms as the base lobe in `fragment`. Coat F0 is `0.04`, not the metal base color. A coat normal replaces the shading normal for that lobe only. The base normal is unchanged.

The coat does not write a different g-buffer normal. SSAO and shadows keep the base normal. Document that next to the extension.

Tests: factor `0` matches an unextended primitive within one 8-bit color step. Factor `1` and roughness `0.05` on a flat quad brightens the specular peak against the same quad with factor `0`. A missing texture does not allocate a sampler.

## Transmission and volume

Render opaque and masked primitives first. That order already exists: `draw()` sorts blended primitives after opaque ones. Copy the opaque color into a texture the transmissive fragment can sample. The copy is a `gltf-pro` pass created by the materials package, not a core pass.

Transmission reads `transmissionFactor`, `transmissionTexture`, and `ior` from `KHR_materials_ior`. Default IOR is `1.5`. The sample direction is the refracted view at that IOR. The sample is the opaque color at the refracted pixel. There is no second bounce.

Volume reads `thicknessFactor`, `thicknessTexture`, `attenuationColor`, and `attenuationDistance`. Apply Beer's law along `thickness` in the view direction, then composite with the transmitted sample. A volume extension on a material with transmission factor `0` throws `KHR_materials_volume requires transmission`. Attenuation distance `Infinity` or a missing distance leaves the color unattenuated.

Transmissive primitives blend and do not write depth. `shadowPrimitives` already omits `settings[0] === 2`, so they do not cast shadows. They also do not receive the cascaded shadow map in the first version. Say that in the package README.

Tests: a red opaque quad behind a transmission-1, IOR-1 quad reproduces the red within one 8-bit step, because IOR 1 does not bend. The same quad with a short attenuation distance moves the red toward the attenuation color. Factor `0` matches the opaque shader.

## Node materials

A node graph in `@margoengine/materials` compiles to one `MaterialExtension`. The vertex format stays the five attributes the shader already consumes: position, normal, tangent, uv, color. A node that asks for a new attribute throws.

The closed set:

| Node | Output |
| --- | --- |
| `color` | constant `vec4` |
| `scalar` | constant `f32` |
| `texture` | sample of a bound texture at UV0 or UV1 |
| `mul`, `add`, `mix` | component-wise |
| `normalMap` | tangent-space normal in the existing frame |
| `metalRough` | roughness and metal |
| `clearcoat` | the clearcoat lobe above |
| `transmission` | the transmission and volume path above |
| `emit` | writes the fragment color |

`emit` is required and unique. Cycles throw. A graph that uses `clearcoat` or `transmission` uses the same WGSL as the glTF extensions, not a second implementation.

This is the authoring path for a material that did not come from a glTF file. It does not load Three.js node JSON. It does not accept arbitrary WGSL. A caller who needs a custom piece writes a `MaterialExtension` by hand and skips the graph.

Tests: `color` into `emit` matches `PbrMaterial` for that color with metal `0` and roughness `1`. A cycle throws. A `clearcoat` node with factor `0` matches the no-extension shader.

## Order

1. **Done.** The extension slot is `packages/gltf-pro/src/material-extension.ts`. Lighting stays at group 2. Factors and caller-owned textures use group 3, and only on a primitive that has an extension. An unextended draw keeps the recorded baseline shader `1920d3bb180dbf0fa32fe4d373a3c03bdfccbdc834fb02a26fcb1b8dfeeffa5b` and frame bytes `c6666b8c89280b7915c001d0a92c33ed027dfea50b9c4df247f1c43010fcb313`, with bind groups 0 and 1 only. `node --test tests/modern-material-extension.test.js` passed 10 tests on 2026-10-16: pipeline isolation, the empty group 2 gap when group 3 is used without lighting, factor-buffer ownership, device restore, and a failed upload that recovers on the next draw. Attach with `model.primitives[i].extension` or `model.primitives[i].material.extension` after `loadGLTF` or `parseGLTF`. The extension may assign to `s` because the inserted binding is `var s`. Texture views stay caller-owned. The baseline parity check matched all 830 recorded GPU events and all 196,608 rendered pixels against the pre-change implementation. All 62 packages passed strict typechecks. Core plus stage remained 19,999 bytes gzip.
2. **Done.** `@margoengine/materials` exports `clearcoat(options)` for caller-owned textures and synchronous `install(model)` for optional `KHR_materials_clearcoat` metadata or normalized `material.clearcoat` configuration. Factors and only the supplied textures use group 3. A beauty-only `MaterialExtension.direct` hook applies the coat lobe after base direct lighting, while the public `model.image(index)` accessor borrows retained decoded images for installation-owned uploads. Base ambient lighting and the g-buffer normal remain unchanged. Synthetic-quad GPU tests matched all 16,384 pixels exactly at factor `0`; factor `1` with roughness `0.05` raised the specular peak from 51 to 255. Tests cover factor red and roughness green channels, UV0/UV1 selection, coat normal maps and scale, resource cleanup, and device restoration. Missing textures allocate no sampler. Installation recreates its owned glTF uploads after restoration; caller-owned resources require replacement. Explicit installation handles optional clearcoat metadata; baseline loaders still reject clearcoat in `extensionsRequired`. All 63 packages passed strict typechecks and packed runtime import checks. Core and stage were unchanged, and their combined size remained 19,999 bytes gzip.
3. **Done.** `@margoengine/materials` installs optional transmission, IOR, and volume metadata through the same group 3 slot, composing with clearcoat when present. Positive transmission acquires one shared opaque-color snapshot per engine. A generic opt-in opaque phase in `gltf-pro` defers every model's blended primitives until all opaque and masked geometry has rendered; the snapshot then precedes the deferred draws. The capture borrows an existing scene target or owns a same-format target, resolves 4x MSAA when needed, and copies through a sampler-free fullscreen pass without requiring `COPY_SRC` on the scene attachment. Transmission blends without depth writes and skips the lighting/shadow hook. Volume applies Beer's law with thickness green, transmission factor uses red, and volume without positive transmission throws. Factor-zero metadata keeps the baseline shader, bindings, depth mode, and allocation path. The caller-owned `transmission(options)` factory supports an explicit opaque-color view. Hardware WebGPU checks passed 28 captures: factor-zero output matched all 16,384 pixels exactly, and IOR-1 matched the opaque background exactly at 1x, 4x, and with a borrowed HDR target. Shorter attenuation distances increased absorption; missing or infinite distances and zero thickness preserved transmission. Tests also cover independent UV sets, sampler-free maps, clearcoat coexistence, shared capture ownership, resize/format/MSAA changes, partial allocation rollback, and recovery after a deferred draw failure. All 975 Node tests passed on Node 24, and all 63 packages passed strict typechecks and packed runtime import checks. Core and stage sources remain frozen; their combined gzip size is still 19,999 bytes (zero increase).
4. **Done.** `nodeMaterial(graph, options?)` compiles a closed, typed TypeScript object graph into one `MaterialExtension`; `installNodeMaterial(model, graph)` supplies the shared opaque-color capture when transmission needs it. Nodes reference existing nodes directly and retain the five-attribute vertex format. The compiler validates every listed node and its dependencies, rejects cycles, requires exactly one `emit`, and rejects unsupported fields, arbitrary WGSL, custom attributes, and incompatible input types. `emit` enters the existing PBR lighting with graph color, metal `0`, roughness `1`, zero emissive, and full occlusion by default; normal maps and `metalRough` override those inputs. Clearcoat and transmission nodes call the same WGSL generators as the glTF extensions. All 994 Node 24 tests passed. The combined existing and new browser regressions passed, including 42 node-material GPU captures for PBR color parity, factor-zero parity, texture/arithmetic/normal inputs, shared lobes, transmission, and restoration. All 63 packages passed strict typechecks and packed runtime imports. Core and stage sources remain frozen at **19,999 bytes gzip**, with zero increase.
5. **Done.** The root README and `docs/three-replacement.md` now describe implemented clearcoat, transmission, IOR, volume, and the closed TypeScript node graph, with links to the optional materials package. They state the limits: screen-space refraction with one opaque-color sample, no participating media or node-graph file format, and transmissive surfaces do not cast shadows or receive cascaded shadows. Remaining unsupported material lobes and Three.js TSL are named separately. The README records all 63 packages, 994 passing Node 24 tests, 42 node-material GPU captures, and the unchanged **19,999-byte gzip** frozen core/stage bundle. KTX2 glTF loading, texture transforms, and more than four joint influences remain separate work.

Each step is its own change. Step 4 does not start before step 3's tests pass, because the graph calls that WGSL instead of inventing it.

## What this still refuses

- Ray-traced or multi-bounce transmission.
- Participating media, subsurface scattering as a profile, and volume without transmission.
- Three.js TSL, `ShaderMaterial` source strings, and custom vertex attributes.
- Sheen, iridescence, anisotropy, and specular-color until a later pass uses this slot.
- Any change under `packages/core` or the stage facade.
