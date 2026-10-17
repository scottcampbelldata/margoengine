# Reading the three.js parity counts

Date: 2026-10-17. The table in [threejs-parity.md](threejs-parity.md) was recounted after the approved core hooks and optional dispersion, depth/distance material modes and back-side rendering: **159 features, 98 COVERED, 36 PARTIAL, 25 MISSING**. Viewport/scissor moved from MISSING to PARTIAL because it now works per core draw, while optional native passes and picking retain their own behavior. The camera and ambient hooks improve existing PARTIAL rows. Core + stage currently measures 20,935 bytes gzip after the separate performance update on main, with 4,064 usable bytes below the strict 25,000-byte ceiling. The back-side change adds no core or stage bytes. [The matrix](threejs-parity.md#what-is-missing-or-partial-and-what-to-do) separates the implemented hooks from the remaining package work.

COVERED can still name a limit. PARTIAL means one common three.js use is absent. MISSING means no package `src/` implements that three.js name. A Margo feature with a different name can exist beside a MISSING row. SDF text does not make `TextGeometry` covered.

Public copy should keep calling Margo an alternative path. The matrix is not a claim that Margo replaces three.js.

## WebGL2 draws core meshes only

That sentence is accurate, and it is a closed decision. HANDOFF records WebGL beyond core as gap 8, closed as won't-do on 2026-10-14: WebGL stays a fallback for plain meshes and a basic preview.

`@margoengine/webgl` implements one `Renderer`. The shader in `packages/webgl/src/index.ts` reads core batch attributes (position, normal, instance matrix, color, roughness/metalness factors) and one directional light. It has no texture samplers. An app opts in:

```ts
import { Engine } from '@margoengine/core';
import { webglRenderer } from '@margoengine/webgl';

const engine = await Engine.create(canvas, { backend: 'auto', fallback: webglRenderer });
```

Without `fallback`, `backend: 'auto'` rejects when WebGPU is missing. `backend: 'webgl2'` always uses the fallback. Apps that ship WebGPU only leave the package out. With the ambient/rectangle compatibility updates, its built root entry measures 2,727 bytes min+gzip in this verification; those optional bytes are separate from core + stage.

On that path, core meshes and anything that becomes a core mesh can draw. The matrix names constant-color `@margoengine/gltf` (the small loader, not glTF-pro), plus bvh, controls, labels, viewcube, and lod distance or screen levels. glTF-pro, materials, animation, shadows, clustered lighting, post, lines, points, text, environment, selection, sky, water, shader, and XR need WebGPU. `engine.pick` is not on the WebGL2 path.

The row stays PARTIAL because three.js's WebGLRenderer draws the whole scene. Closing it would mean a second renderer for every WebGPU package, inside the frozen core budget or as a parallel stack. v1 does not do that. The public line is: WebGPU is the renderer; WebGL2 is a flat preview of core meshes.

## What the 25 MISSING rows are

| Row | How to treat it |
| --- | --- |
| CubeCamera | `Engine.render({camera})` supplies its camera prerequisite. A dynamic environment capture helper is still absent and belongs in `@margoengine/environment`. |
| GTAOPass | Left out of the parity push. `@margoengine/post` has SSAO. |
| SSGI, denoise | Left out. |
| BatchedMesh | Left out. Distinct geometries stay separate draws. `mergeGeometries` can bake static meshes. |
| IESSpotLight, ProjectorLight | Left out. |
| Motion blur | Left out. TAA already builds a velocity buffer and does not blur with it. |
| TextGeometry, FontLoader, TTFLoader | `@margoengine/text` is SDF text. The three.js font extrude stays absent. |
| MeshLambertMaterial, MeshPhongMaterial | FBX import converts these to PBR. There is no Lambert or Phong shader. |
| Physical light units (candela, lux) | Intensities stay unitless radiance scales. |
| StereoCamera, AnaglyphEffect, ParallaxBarrierEffect | Absent. XR is a separate partial path. |
| ConvexGeometry, DecalGeometry, RoundedBoxGeometry, ParametricGeometry | Absent. Physics builds convex hulls for colliders only. |
| MTLLoader | Absent. OBJ loading is geometry only. |
| ColladaLoader | Absent. |
| SVGLoader | Absent. `Shape` and `extrudeGeometry` do not parse SVG. |
| Long-tail model loaders (LDraw, VRML, 3DS, LWO, AMF, MD2, VOX, PDB, GCode, BVH motion capture, 3DM, KMZ, TDS) | Absent. |
| DRACOExporter, EXRExporter, KTX2Exporter | Absent. |
| SkeletonUtils, AnimationObjectGroup | Absent. |
| GlitchPass, AfterimagePass, Lensflare | Absent. |
| ArcballControls | Absent. Orbit, map, trackball, fly, and first-person exist. |
| Light helpers, SkeletonHelper | Absent. |
| Reflector, Refractor | Absent. Water does its own refraction. |
| XRControllerModelFactory, XRHandModelFactory | Absent. |

The three-hook change does not implement these 25 missing rows. The optional add-ons and loaders remain separate package work; the specific core exception does not authorize more core features or relax the gzip gate.

## What the 36 PARTIAL rows are

One of them is the WebGL2 row above. It stays partial on purpose.

These limits remain after the three hooks:

- One engine is one canvas and one implicit scene.
- `Engine.render({camera})` supports sequential second-camera captures into the existing target path and restores primary culling before returning. It does not create another scene, permit nested rendering, or isolate temporal histories.
- Core draw calls accept viewport and scissor rectangles. Optional native passes and picking do not inherit them; clears still cover the whole attachment.
- One directional light per engine.
- Layers filter raycasts only.
- Clipping caps apply to core meshes. A node material can discard fragments. Shadows still see the uncut surface.

These partials are narrower APIs that already have a Margo path. They are limits to state, not missing packages:

- Node materials compile typed WGSL. They are not three.js TSL, and there is no raw shader material with its own vertex layout.
- glTF reads the extensions listed on that row. A file that requires `KHR_animation_pointer` throws and names the extension. Export writes no cameras or lights.
- KTX2 works for `KHR_texture_basisu` on a glTF. A standalone `.ktx2` is a raw `GPUTexture` that materials cannot take. Cube maps, arrays, and UASTC HDR are rejected.
- Materials meshes accept independent `uvs1` coordinates and geometry groups with material arrays, including instancing and glTF export. UV1 falls back to UV0 when omitted. Arbitrary named vertex attributes remain absent, so the combined geometry-attributes row stays PARTIAL and the counts remain 98 / 36 / 25.
- Toon shading applies to every core mesh at once, not to a glTF-pro or skinned material.
- Contact shadows are a ground-plane helper, not a shadow-catcher material.
- SSR reflects core meshes and models registered with `ssr.add`. Water and terrain are reflected and do not reflect.
- OBJ loading skips materials. USDZ export rejects textures, vertex colors, and alpha masks.
- WebXR draws core meshes on WebGPU. It has no hit testing and no WebGL XR fallback.
- Screen effects such as vignette are a `NodePass`, not built-in passes. SMAA is not provided. FXAA is.

The remaining partials are the same kind of limit, spelled out on each row: core diffuse ambient now has RGB multipliers, while independent material models keep their own ambient APIs and glTF-pro's hemisphere remains fixed. Color management, cube and data textures, depth textures borrowed from a post pass, cache without a shared loading manager, code-authored clips, and two-bone IK retain their documented limits.

## Sentence that was behind the table

The summary used to say physical materials had no iridescence or anisotropy. The MeshPhysicalMaterial row already said glTF loads both through `@margoengine/gltf-pro/extended`, and `@margoengine/materials` now takes those factors and their maps on meshes you build. The 12 physical map properties cover clearcoat, sheen, specular, transmission, volume, anisotropy and iridescence. Dispersion now works on constructed meshes, native glTF transmission and installed/caller transmission, and survives export. The physical-material, normal/depth/distance and front/back/double-side rows now qualify as COVERED, giving 98 / 36 / 25; screen-space and lighting limits remain documented. This change adds no core or stage features.

## What to say when someone cites 95 / 38 / 26

Those counts predate the three core hooks. Margo now covers 98 of 159 three.js r186 features in the stated form, with 36 narrower implementations and 25 missing names. The camera, ambient RGB and draw-rectangle hooks fit below the same core + stage ceiling. WebGL2 remains the optional flat preview of core meshes. CubeCamera, mirror helpers and the optional-package backlog have not been implemented by this change.
