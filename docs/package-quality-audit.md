# Shared package quality audit

Date: 2026-10-12. Target: the existing lightweight, procedural engine, with optional
packages carrying additional rendering capabilities. The core and stage facade
remain feature-frozen for v1.0.0. Gzip figures in this note are from 12 October 2026. The current build measures core at 18,876 bytes gzip and core plus stage at 21,107 bytes gzip. The gate rejects 25,000 or above.

## Coverage

The inventory covers all 64 directories in `packages`: 61 public ESM packages and
three internal/retired directories. Every public package was built, packed into a
separate consumer fixture, checked for its declared export files, imported without
browser globals, and included in strict TypeScript checks under both Bundler and
NodeNext resolution. These checks verify the distribution contract; they do not
exercise every public API or certify every browser/device.

| Area | Packages covered | Review and verification |
| --- | --- | --- |
| Foundation | `core`, `margoengine`, `geometry` | Core/stage gzip ceiling, public/extension consumers, transforms, primitive normals, UV/tangent streams and geometry tests. Core lighting received numerical bug fixes only. |
| Models and interchange | `blender`, `bvh`, `decoders`, `exporters`, `fbx`, `gltf`, `gltf-pro`, `ifc`, `loaders`, `usdz`, `usdz-export` | Packed exports, strict consumers, parser/geometry/asset unit tests. The packed game and interop fixtures now include their geometry dependency. PBR shader edge cases were corrected. |
| Animation and gameplay | `animation`, `animator`, `cinematic`, `controls`, `ecs`, `fsm`, `input`, `navigation`, `navmesh`, `physics`, `splines`, `tween` | Existing transition, movement, rigging, collision/navigation and lifecycle unit checks; sandbox uses shared locomotion, camera clearance and procedural character posing. |
| Natural scenery | `environment`, `procedural`, `scatter`, `scenery`, `sky`, `terrain`, `vfx`, `water` | Mesh/heightfield normals, nested grass LOD, smooth rock shading, shared wind and shadows, sun/moon/ambient synchronization, cloud projection/filtering, coastal water and HDR finite-value checks. |
| Lighting and effects | `clustered`, `creative`, `dof`, `post`, `shadows`, `splats`, `taa`, `tonemap`, `toon`, `transitions` | Existing shader compilation, rendered pixels, temporal history, shadow/local-light integration and restoration checks. Corrected unstable lighting/rim/planet math and the bloom depth expectation. |
| UI and draw helpers | `audio`, `gizmo`, `html`, `inspector`, `labels`, `lines`, `points`, `react`, `selection`, `stats`, `text`, `video` | Existing validation/lifecycle tests, packed declarations and runtime imports. GPU module checks cover overlays, selection, video pixels and debug UI at mobile viewport size. Video pipelines now match scene MSAA. |
| Other optional systems | `machinery`, `net`, `road`, `wfc`, `xr` | Existing solver/state/data-boundary tests and all-export consumer checks. These retain their documented capabilities; this pass does not add simulation or XR features. |
| Internal directories | `kernel`, `shared`, `vexel` | Rust transform kernel and shared numerical/GPU helpers are exercised by consumers; `vexel` has no package manifest or runtime implementation. Added the missing declaration for the existing shared ACES shader. |

## Fixes and reusable behavior

### Vegetation and rocks

- `procedural.generateGrassMesh(3/2/1)` now removes blades from one ordered set.
  Surviving geometry, normals, UVs and tangents do not rotate at an LOD switch.
- `scatter.Scatter` and `ScatterInstances` accept optional rooted GPU wind.
  Spatially varying gusts bend positions and transform normals consistently;
  fixed-instance color and shadow rendering use the same time in all cascades.
  Validation rejects invalid directions/strengths and GPU culling includes the
  bend's conservative displacement bound.
- The sandbox's grass and trees consume that shared wind. Moving trees use dynamic
  shadow registration. Grass uses a double-sided PBR material.
- Opaque GPU scatter now draws before the sky and water, allowing scene depth and
  refraction to include the scattered geometry.
- Existing migrated rock helpers keep averaged normals across split vertices.
  Smooth polyhedron LODs, matching origins/radii and the shared 25/60/120 distance
  defaults with complementary Bayer fading address the original rock pop.

### Terrain, sky and water

- Shared terrain heightfield/heightmap/color helpers are used by the sandbox.
  Mesh slope normals are recomputed from terrain heights; clipmap lighting now
  guards half-vector normalization and saturates dot products before powers.
- `sky` has an optional four-octave procedural cloud sheet, disabled by default.
  It shares its field and clock with the borrowed sky reflection, shades for day
  and night, and filters noise according to the target's angular footprint.
- The cloud/sea streak was caused by clamping the cloud-plane intersection angle.
  Rays now intersect the elevated layer using their actual elevation. Clouds fade
  into the horizon over a low-elevation band, and cameras above the sheet cannot
  sample it as an overhead layer. GPU probes check clear horizon rays even at full
  coverage, plus day/night motion and cameras above the layer.
- Background night fading no longer depends on enabling scene moon lighting.
  Existing shared moonlight, RGB ambient, reflection and PCSS synchronization are
  consumed by the sandbox, with shared HDR window emission and local porch light.
- Existing shared water fixes remain in `water`: directional wave trains spread
  into curved Gerstner components, analytical/filtered normals, depth/connectivity
  shore blending, conservative shallow flow around every shore, refraction edge
  blending, an independent water-surface depth target, and safe Fresnel/reflection
  math. The black-rectangle regression checks finite grazing-angle values and
  reflection rays above the dark ground hemisphere.

### Shader and distribution correctness

- Core GLSL/WGSL, terrain, glTF PBR and clustered lighting avoid normalizing a
  zero half vector and clamp lighting cosines before Fresnel/BRDF powers.
  Environment BRDF integration and toon rim lighting receive the same bounded
  cosine treatment.
- Creative planet lighting now uses ordered `smoothstep` edges for its terminator.
  An actual GPU probe checks night, day and twilight weights.
- Shared video overlays recreate their pipeline when scene sample count changes,
  following the scene's MSAA descriptor. Unit tests cover 1/4/4/1 samples and the
  module browser test checks displayed video pixels.
- The all-package checker now discovers every manifest, checks every declared
  export, type-checks all export entry points, and performs SSR-safe runtime
  imports from the packed fixture. CI runs it and the new nature GPU probes.

## Verification

Commands run against the working checkout:

| Check | Result / evidence |
| --- | --- |
| Full package build | Passed; optional sky/scatter/video also rebuilt after their final edits. |
| Full Node unit suite | Passed; detailed output in `test-results/package-audit-unit.log`. |
| `npm run test:modules:packages` | All 61 packages, every declared export, strict Bundler/NodeNext declarations and browser-global-free imports passed. |
| Packed game, interop and postfx consumers | Passed, including standalone README examples and offline fixture dependencies. |
| `tests/nature.browser.mjs` | Physical NVIDIA Ampere and AMD RDNA 2: rooted wind, spatial/time variation, finite-difference normals, zero wind, cloud motion/night/horizon/above-layer behavior, finite PBR and planet terminator. Reports: `test-results/nature-*.json`. |
| Sandbox shared-module browser check | Physical NVIDIA and AMD: 1M initial/restored particles, day/moon lighting, four shadow cascades, camera clearance, clustered porch light, four shores, finite HDR and device restoration. Day/dusk cloud horizon screenshots are in `test-results/gameplay-sandbox/shared-modules/`. |
| GPU module browser check | Passed on NVIDIA: sky models, water, toon, selection, scatter, transitions, HTML occlusion, external video, combined modules, debug UI and restoration. Report: `test-results/margo-modules.json`. |
| GPU game integration | Passed on NVIDIA: 60 shader modules plus PBR/terrain/shadow/local-light/post/temporal/splat integration. |
| Scatter LOD GPU check | Passed on NVIDIA: diffuse/PBR ring emission, complementary fade masks and restoration. |
| Coastal water GPU check | Passed on NVIDIA: 14 coastal/normal/refraction/restoration/Fresnel/reflection checks. Earlier water flow/surface checks passed on both physical adapters. |
| Core + stage budget | 19,998 gzip bytes after the MSAA/mobile fixes, below the strict 20,000-byte ceiling. CI rejects 20,000 bytes or more. |

## House and vegetation comparison follow-up

Reviewed the procedural cabin, scene palette, packed vertex stream and fixed
vegetation/shadow path against [Unity's occlusion guidance](https://docs.unity3d.com/6000.0/Documentation/Manual/StandardShaderMaterialParameterOcclusionMap.html),
[Unity's material validation](https://docs.unity3d.com/6000.0/Documentation/Manual/material-validator-validate.html),
[Unity's SpeedTree wind quality tiers](https://docs.unity3d.com/6000.0/Documentation/Manual/SpeedTreeImporter-Model.html)
and [NVIDIA's Crysis vegetation techniques](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis).

| Guidance / finding | Shared change or retained limitation |
| --- | --- |
| AO belongs to indirect illumination rather than the material albedo. | Geometry packs AO in vertex alpha; scatter applies it to ambient light and preserves direct sun, clustered porch light and emission. RGB remains material tint. Manually packed RGB AO needs migration to alpha. |
| Dielectric building materials retain dielectric reflection. | The scene's slate and glass now use metalness 0. Wood and stone already did. Palette values are scene authoring; the PBR/AO implementation is shared. |
| Whole-tree sway and detail movement are separate wind components. | Fixed shared scatter adds optional `windDetail`, with radial stiffness and two spatially varying frequencies for branch/foliage ripple. Beauty and all shadow cascades share positions and clock; normals use the analytic deformation Jacobian. GPU grass retains its cheaper whole-blade bend. |
| The circled cabin dashes persisted with directional shadows disabled. | Shared cabin plank gaps are closed, hidden plank caps are omitted, flush frames overlap the cut edges, corner trim stands proud and overlapping roof courses have different planes. CPU ray picking identified the remaining vertical ticks as subpixel outer frame edges; flush casings remove those protrusions while preserving the recessed panes. This removes pinholes and coplanar surface competition without adding a shader or downloaded assets. |
| Full leaf animation relies on appropriate leaf meshes and authored weights. | Existing canopies are solid procedural lobes. Detail wind approximates branch/foliage motion; it does not claim individual leaves, branch physics or leaf collision. |

The cabin retains recessed panes, split corner normals, rough wood/stone,
directional PCSS shadows, warm HDR windows/lantern and an actual porch point light.
No baked GI, interior refraction, leaf transmission or shadowed point-light system
was added. Those would be separate optional capabilities beyond this lightweight
comparison. Verification adds seam/opening/roof-plane geometry tests, ambient vs
direct GPU pixel probes, finite-difference detail normals and bounded deformation
probes. Day/night cabin captures are in the sandbox shared-module report.

## Deliberate lightweight limits

- Cloud rendering is one elevated sheet, without volume traversal or cloud shadows.
  Atmospheric tables and 64x32 sky reflection can retain coarse angular banding.
- The sky preset shares one blended directional source for sun/moon shadows and
  uses a fixed moon direction about 12° above the horizon. `scenery` separately provides a phase-aware
  stylized moon and stars. These are visual presets, not lunar ephemerides.
- Vegetation uses rooted bends plus optional branch/foliage ripple, without branch skeletons, leaf collisions or
  physical transmission. Fixed `ScatterInstances` draws every instance; large
  populations should use the separate GPU-culling LOD path.
- Water uses a local Gerstner spectrum and shallow heightfield flow, without FFT
  ocean simulation, overturning wave volumes, erosion or nearby-object reflections.
  Its horizon extension is fixed around the origin, and the default shallow-flow
  preset expects heightmap cells around 0.5 m or larger.
- Real XR headsets, mobile GPU/browser calibration, a fresh FBX external fixture
  and the complete 500-session release stress matrix were not run for this pass.
- Only 2 gzip bytes remained under the core/stage ceiling at measurement. Future
  capabilities must remain in optional packages; remeasure after core bug fixes.

## Reference guidance

The implementation takes compact GPU techniques from primary sources while
keeping the existing package architecture and procedural assets:

- [NVIDIA: effective water simulation](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models).
- [Unity: HDRP water overview](https://unity.com/blog/engine-platform/new-hdrp-water-system-in-2022-lts-and-2023-1).
- [NVIDIA: waving grass](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-7-rendering-countless-blades-waving-grass).
- [NVIDIA: procedural wind for trees](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees).
- [Unity: simple cloud layer](https://github.com/Unity-Technologies/Graphics/blob/master/Packages/com.unity.render-pipelines.high-definition/Documentation~/create-simple-clouds-cloud-layer.md).
- [WGSL numeric built-ins](https://www.w3.org/TR/WGSL/).
