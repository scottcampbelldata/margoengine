# MToon materials

Batch 213 job 2 adds `@margoengine/rigging/mtoon`. `MToon.attach(model)` installs
VRMC_materials_mtoon 1.0 materials on a loaded PBRModel and also reads the VRM
0.x material records retained by `loadVRM0`. Pass a VRM controller's `expressions`
in the options when it drives material colours and texture transforms. The model
stays caller-owned. Disposing the effect restores its original material records;
disposing the model first disposes the effect. `Symbol.dispose` is supported.
Importing the entry registers nothing and allocates no GPU resources.

The material uses gltf-pro's skinning, morphs, instances, lighting hooks, view
selection and render states. The new optional `gltf-pro/material-draw` entry
installs a synchronous adapter on a model, including already-created isolated
renderers. Each adapter receives the actual source or replica primitive records
and delegates each layer to the original draw. A one-call bypass permits nested
views without recursion. A second adapter rejects; removers are idempotent,
model disposal removes it, and promise-returning adapters reject. No core or
stage source changes are involved. `model.image(index, true)` permits optional
lookup of decoded alternative image sources without weakening required lookup.

## Authored controls and defaults

The Lambert extension mixes independent lit and shade colours across the full
negative-to-positive light cosine range. It supports normal maps, HDR emission,
all glTF alpha modes, double-sided surfaces, transparent depth writes, matcap,
parametric rim, world/screen inverted-hull outlines and per-map UV transforms.
Metallic, roughness, occlusion and vertex colours do not change MToon shading.

| Control | Default and range |
| --- | --- |
| Shade RGB | black, each linear component 0 through 1 |
| Shading shift / shift-map scale | 0 / 1, finite float32 |
| Toony / GI equalization | 0.9 / 0.9, 0 through 1 |
| Matcap factor | white; an absent matcap map contributes zero |
| Parametric rim RGB / power / lift | black / 5 / 0; power nonnegative, lift finite |
| Rim lighting mix | 1, 0 through 1 |
| Outline mode / width | none / 0; world widths in metres, screen widths relative to view height |
| Outline RGB / lighting mix | black / 1, colour and mix components 0 through 1 |
| UV scroll X/Y / rotation | 0 / 0 / 0; UV units per second and radians per second |
| Transparent depth writing / queue offset | false / 0; integer -9 through 9 with the specification's alpha-mode sign restrictions |
| Texture coordinates | TEXCOORD_0; also 1, 2 and 3, including KHR_texture_transform overrides |

The specification prose says black for the default shade, while its JSON schema
says white. The current public reference material constructor also returns
black. This implementation follows the prose and observed behaviour. Missing
shade/rim/width/animation maps are white; the missing shift map is black.
Shift, outline-width and animation masks read R, G and B respectively. Animation
rotates around the UV centre, then scrolls, before KHR_texture_transform.
Matcap does not animate. Tangent frames follow the animated normal-map UVs.
Decoded WebP/AVIF/Basis alternatives, mip chains and streamed views follow their
retained model images. Owned textures retire with the correct device lifetime.

Within a model, opaque, MASK, depth-writing blend and ordinary blend groups run
in authored order; equal-queue transparent primitives retain native distance
sorting. Legacy explicit queues retain their 0 through 5000 values; -1 selects
the mode's default. Separate models retain the native graph's ordering. Custom
material resources retain gltf-pro's existing same-device restriction for
isolated renderers; load on a target device before rendering there.

## Legacy migration

The Consortium's migration removes four legacy controls: shadow receive
multiplier, lit/shade mixing multiplier, light-colour attenuation and outline
maximum distance. Original data remains in the avatar metadata. Missing shade
textures inherit the lit texture as the migration guidance requires. Original
permissions and source bytes remain unchanged.

The adapter solves the old transition endpoints into the new symmetric band,
converts stored colour constants with gamma 2.2, retains unbounded representable
HDR emission, reverses legacy V scroll and converts outline widths by 0.01.
Expression colour targets remain linear and are not gamma-converted. These
choices are checked against observed public runtime properties of all twelve
Alicia materials and controlled input probes. Queue 2550 and other explicit
legacy queue values are preserved instead of being forced into the 1.0 offset
range. No reference implementation source was inspected or copied.

## Evidence and remaining integration limits

Tests cover seven independent direct-light cases, an isolated renderer created
before attachment, a two-colour matcap orientation oracle, TEXCOORD_2, a linear
B-channel animation mask combined with a scaled KHR transform, material colour
and HDR-emission expressions, local-light rim illumination, G-buffer replay and
perspective world/screen outline widths at two distances. Float16 colour errors
must remain below 0.001; the outline oracle allows 1.5 pixels for rasterization.
The fixture creates its offscreen targets after the canvas's initial resize;
G-buffer replay loads the beauty depth rather than clearing its equality test.

Real standard assets are DWANGO Alicia Solid 0.51 and the Consortium Seed-san
VRM 1.0 sample, already credited in THIRD-PARTY-NOTICES.md. Both exercise GPU
skinning, expressions, exact neutral restoration and authored outlines on native
WebGPU and the complete WebGL2 compatibility layer. These are RTX A6000 proofs,
not cross-vendor, headset or speed claims. Public-runtime observations and their
provenance are stored beside the whitepaper results. They are numeric outputs,
not downloaded implementation files. The reference ran only in external
engine-bench, from a version-pinned public module and an in-memory harness.

Independent model queue offsets do not reorder the whole scene across model
boundaries. Optional shadow-caster alpha shaders do not yet apply spatially
masked MToon UV animation; the body, normal, emission and outline paths do.
Those optional-package integration refinements remain follow-ups. No shader
fallback, missing rim or omitted outline is used to pass an assertion.
README examples are deferred to docs/work-lists/readme-owed.md.

## Sources compared

- Sumi Masataka and Obuchi Yutaka, *VRMC_materials_mtoon 1.0*, 2022,
  https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md.
  Defines the colour band, GI, rim, outline, UV order and colour spaces.
- Adam Lake, Carl Marshall, Mark Harris and Marc Blackstein, *Stylized Rendering
  Techniques For Scalable Real-Time 3D Animation*, NPAR 2000,
  https://www.markmark.net/npar/npar2000_lake_et_al.pdf.
  Painter/inker separation motivates keeping band shading and the hull layer distinct.
- Ramesh Raskar and Michael Cohen, *Image Precision Silhouette Edges*, I3D 1999,
  https://web.media.mit.edu/~raskar/RaskarPapers/99silhouetteI3D.pdf.
  Back-face expansion provides geometric outlines without an image-space edge pass.
- VRM Consortium, *Upgrade compatibility*, 2022,
  https://vrm.dev/en/univrm1/migrate_vrm0/feature/.
  Supplies the four retired controls and missing-shade-texture migration.
- Khronos 3D Formats Working Group, *glTF 2.0.1*, 2021,
  https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html.
  Supplies material alpha, texture coordinates and retained asset ownership.
- W3C GPU for the Web Working Group, *WebGPU*, editor's draft consulted 2026,
  https://www.w3.org/TR/webgpu/.
  Static entry-point resource usage controls body versus outline bind groups.
- Unity Technologies, *Material.renderQueue*, 2022.3 documentation,
  https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Material-renderQueue.html.
  Used only for the legacy serialized queue range and -1 sentinel, not as a parity target.
- pixiv, *MToonMaterial public API*, current 3.5.5 runtime observed 2026-11-10,
  https://pixiv.github.io/three-vrm/docs/classes/three-vrm.MToonMaterial.html.
  Public field observations calibrate legacy migration, not implementation source.

## Gate result

Review 3 (2026-11-10): mixed models retain ordinary PBR/unlit primitives in
their opaque, mask or blend queue while MToon body and outline layers run.
The previous adapter hid ordinary primitives in every beauty draw. A two-material
input therefore drew only its MToon primitive. The regression records the actual
fragment pipelines for all three alpha modes and outlines, and compares an unlit
foreground pixel before/after attachment on both backends. Material records are
restored synchronously after each queue.

The package's MToon GPU command sets the repository serving root and its first
fixture creates the output directory. Constraints,
VRMA and pose-tracking fixtures also select that root before opening a browser.
This fixes their confirmed HTTP failures when launched from the package directory
by check:gpu-packages, without changing the shared browser or shutdown helpers.

Clean-room correction sources compared: Khronos 3D Formats Working Group,
*glTF 2.0.1* (2021),
https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html (per-primitive materials
and alpha coverage); VRM Consortium, *VRM material overview* (2026),
https://vrm.dev/en/vrm/material/ (PBR, unlit and MToon may coexist); Alan Baker,
Mehmet Oguz Derin and David Neto (editors), *WebGPU Shading Language* (2026),
https://www.w3.org/TR/WGSL/#discard-statement (discarded fragments do not reach
the color target). The fix preserves queue isolation while selecting ordinary
materials exactly once. No external implementation source was read.

The selected changed/dependent CPU run passes 5,554 assertions, with README work excluded by Scott's build-phase instruction. Both new eleven-case MToon browser runs and the original seventeen-check rigging suite pass on native and compatibility. gltf-pro shader equivalence, complete extension coverage, viewer/device restoration and volume pixel checks also pass on both backends. The extension suite needs MARGO_COMPAT=1 rather than the --compat positional filter.

The existing physical-material shader-composition fixture passes native and all 160 BRDF numeric cases on compatibility, but its two worst-case 16-texture compatibility pipelines exceed MAX_TEXTURE_IMAGE_UNITS(16). No MToon adapter or PBRModel draw participates in that direct shader fixture. Parent-identical input hashes are in whitepaper/results/batch213-physical-compat-existing-failure.json; this separate optional compatibility defect remains in known-bugs under the build-phase scope rule. No test, assertion or tolerance was weakened.
