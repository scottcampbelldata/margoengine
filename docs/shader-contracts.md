# Shader contracts between packages

Packages extend each other's WGSL in three ways. Prefer them in this order.

1. **Declared hooks.** The package that owns a shader composes other packages' WGSL at named points it guarantees.
   gltf-pro's PBR shader has lighting hooks (`LightingEffect.pbr`, see `packages/gltf-pro/README.md`, "Lighting hooks");
   shadows, clustered and environment (IBL, fog) use them. Tests in gltf-pro and in each user check the contract.
2. **Pipeline-overridable constants** (`override`) for small toggles inside a package's own pipelines. They work only
   where the package creates the pipeline itself: core builds the mesh pipeline from `PassContext.shader`, so a patch of
   core's shader cannot use them.
3. **Text anchors.** Core's mesh shader (`packages/core/src/shaders.ts`) is frozen for 1.0 and has no hooks, so packages
   that change core meshes (shadows, sections, IBL, fog, tone mapping, TAA, SSAO, toon, picking, scatter, terrain colors)
   rewrite its text through `PassContext.shader`. Each anchor they rely on is listed in `tests/shader-contracts.test.js`,
   which fails, naming the package, if the anchor no longer occurs exactly once in the shader it targets, or if the
   package stops using it. Most of these patches also throw at runtime when the anchor is missing (shadows, clustered,
   environment, sky lighting, sections' caps, materials, shader nodes, LOD baking).

Text anchors in core's shader (the full list, with the package file using each, is the test's `contracts` table):

| Anchor | Used by |
| --- | --- |
| `let facing=` | machinery SectionPlanes (clip loop before it) |
| `let linear=direct*`, `let linear=…;` | shadows, clustered, environment IBL, scatter, terrain colors (also mirrored in terrain's own shader) |
| `frame.radiance.w` | sky lighting (sky ambient), environment IBL (zeroes the constant ambient) |
| `let mapped=linear/…return vec4f(…);` | tonemap, post stack/bloom/SSAO capture, creative post, dof: the HDR capture returns `vec4f(linear,1)` |
| `let mapped=linear/(1.0+linear);`, `return vec4f(linear,1);` | environment Fog (on the canvas, or after an HDR capture) |
| `let direct=…return vec4f(…);`, `i.color*(1.0-i.material.y)*frame.radiance.w` | post SSAO ambient replay |
| `let margoAmbient=` | convention: environment IBL names its term so; post SSAO occludes it on core meshes |
| `let direct=…return vec4f(…);`, fragment signature `->@location(0) vec4f`, `n`/`v`/`i.color`/`i.material` | post SSR material replay (three targets: IBL specular + roughness, split-sum weight, normal); with `margoAmbient` it also calls environment's `iblBrdfTerms`/`iblPrefiltered` (`packages/environment/src/ibl.ts`) |
| `o.clip=frame.camera*p` | taa (jittered camera) |
| `let v=normalize(frame.eye.xyz-i.position);…let linear=…;` | creative ToonShading |
| `@location(3) material:vec4f`, `o.color=i.color.rgb`, fragment signature | selection picking (id MRT), scatter, terrain colors |
| `struct Frame/Input/Output {…}`, `let p=model*vec4f(i.position,1);`, `@vertex fn vertex(…)`, `@fragment fn fragment(…){` | scatter (wind, LOD fade) |

`packages/shared/gpu.js` `meshVertex` is a copy of core's vertex inputs for packages that draw core meshes with their own
fragment (selection, toon outline); the test checks it still matches core's `Frame`/`Input` layout and transform.

Every hook or patch adds its bindings to one fragment stage, which WebGPU limits to 16 sampled textures and 16 samplers
by default. The per-combination counts are in the gltf-pro README ("Texture bindings"); physical materials with
shadows, IBL and LocalShadows use all 16, and gltf-pro throws naming the combination when a shader exceeds the device.

gltf-pro text patches that remain (materials' map multiply and shading modes, shader-node `NodeMaterial`, LOD imposter
baking) target anchors documented in the gltf-pro README and listed in the same test.
