# Data-scene material extensions

`@margoengine/exporters/materials` exports `exportMaterialGLB`. A MaterialScene uses
the ordinary data scene's geometry, hierarchy, skins, animations, cameras and
lights. Material data adds `extensions`, keyed by the specification's
`KHR_materials_*` names. Payload fields retain glTF names, values and units;
explicit zero and default payloads are retained. This includes clearcoat,
transmission, volume, dispersion, IOR, sheen, specular, iridescence, anisotropy,
emissive strength, unlit, diffuse transmission and the older specular-glossiness
workflow. No renderer implementation is added.

Each texture field contains `{ texture: TextureData }` plus optional `texCoord`,
normal `scale`, and `extensions.KHR_texture_transform`. The existing writer owns
image and sampler serialization, so shared texture and image identities stay
shared across ordinary slots, extension slots and alternate materials. The
effective UV set, including a transform's override, must exist on every primitive
that uses the material. Values must be finite, payloads must be JSON trees and
textures must satisfy the existing PNG/JPEG input contract. Extension-specific
physical ranges remain the caller's glTF payload contract.

Variants are name-to-material records on a single-geometry node or on each
primitive. Optional scene variant definitions pin order and extras; otherwise
names are discovered in scene order. A different mapping on a shared mesh is
written to a distinct mesh record, retaining shared geometry accessors. Alternate
materials, their images, extension declarations and binary lengths are finalized
before GLB size limits are checked. A variant can select a material with no
ordinary PBR extension lobe. Variants require hierarchy mode (`flatten: false`,
the default); nested mappings are checked too. AbortSignal is optional and is
checked before collection and between material writes.

Research, compared before implementation, with no rival or companion source read:

- Khronos Group, *glTF 2.0 Specification*, 2017,
  https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html. Material, texture,
  buffer and extension declaration rules determine serialization.
- Khronos Group, *KHR_materials_variants*, 2020,
  https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_variants/README.md.
  Root variant definitions and primitive-local mappings determine identity and
  isolation for shared default meshes.
- Khronos Group, *PBR in glTF*, 2024,
  https://www.khronos.org/gltf/pbr. Compared the lobe and map inventory with the
  existing loaded-model exporter; the new entry preserves the data-scene payloads
  directly instead of baking them through a renderer's material representation.
- Brent Burley, *Physically-Based Shading at Disney*, SIGGRAPH 2012,
  https://disneyanimation.com/publications/physically-based-shading-at-disney/.
  Compared independent coat, sheen and substrate controls; the exporter preserves
  each independent parameter rather than collapsing them into metallic-roughness.

Evidence: `packages/exporters/tests/materials-entry.test.js` uses the existing
licensed Khronos BoxTextured PNG and the Khronos validator. It checks every lobe,
zero dispersion, shared images, per-primitive mapping isolation, alternate-only
images, texture transforms, binary lengths, bad inputs and cancellation.
No speed claim or new downloaded demo asset is included.
