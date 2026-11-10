# Live glTF volume attenuation

KHR_animation_pointer updates the runtime material, including every quantity
derived from KHR_materials_volume. Animation now updates tint, attenuation,
opticalDepth and the hooked transmission volume together when attenuationColor,
thicknessFactor or attenuationDistance changes. The authored asset is unchanged.

Parsed opticalDepth is a coherent cache of the attenuation channels used by the
native tint draw. Editing an attenuation channel invalidates that channel's
cached depth; replacing the array invalidates all three. Unchanged channels
retain the authored logarithmic depth, including finite values whose
transmittance underflows to zero. Explicit opticalDepth assignments remain
supported, and setting it to undefined retains the existing attenuation-only
fallback. The draw samples the coherent depth once per material upload.

A write of the same numeric attenuation value cannot be distinguished from no
change. To replace an underflowed zero with an explicitly opaque channel, replace
the attenuation array or assign infinite opticalDepth for that channel. Zero
thickness and white channels retain zero depth; absorbing black retains the
existing finite shader marker for infinite depth. No tolerances or floors change.

Progressive loading preserves material property descriptors in its temporary
factor-only material. In-place channel edits and precise depth survive the later texture swap.
These changes are confined to gltf-pro/model, gltf-pro/progressive and
animation/pointer. No core, stage, unrelated entry dependency or backend code is
added. The existing mesh-slab estimate and the range limits documented in
[native-volume-range.md](native-volume-range.md) still apply.

## Clean-room basis

The comparison used public descriptions, without reading companion code:

- Tobias Haeussler, Bastian Sdorra and Khronos contributors,
  *KHR_materials_volume* (2021),
  https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_volume/README.md:
  defines mesh thickness, attenuation distance and color.
- Alexey Knyazev, Ben Houston and Khronos contributors,
  *KHR_animation_pointer* (2024),
  https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_animation_pointer/README.md:
  requires a mutable property to reflect sampled animation values.
- Matt Pharr, Wenzel Jakob and Greg Humphreys,
  *Physically Based Rendering*, fourth edition, section 11.2 (2023),
  https://www.pbr-book.org/4ed/Volume_Scattering/Transmittance:
  the homogeneous Beer law uses exponential optical depth.
- Markus Kettunen, Eugene d'Eon, Jacopo Pantaleoni and Jan Novak,
  *An unbiased ray-marching transmittance estimator* (2021),
  https://arxiv.org/abs/2102.10294:
  evaluates more general spatially varying extinction. This repair needs only
  the homogeneous closed form, so it introduces no estimator or marching work.

The standards determine which material values change and their units; the
transmittance references support retaining logarithmic precision until the path
length is known. Neither is evidence of a speed improvement.

## Reproduction

After npm run build:packages, run with node --test --test-timeout=120000:
packages/animation/tests/volume-pointer.test.js,
packages/gltf-pro/tests/attenuation-live.test.js,
packages/gltf-pro/tests/beer-distance.test.js and
packages/gltf-pro/tests/progressive.test.js. The first two fail on the parent for
the reported stale attenuation and stale optical-depth values. They check all
three volume pointer properties, backward seeks, black/white, zero thickness,
underflow, channel edits, array replacement and actual tint uniform lanes.

Run packages/gltf-pro/scripts/test-native-volume.mjs with node, then again with
--compat, under scripts/gpu-lock.mjs run --gpu=volume-slab-pixel-readback, using
--wait-max=10 and --max=8. Its unchanged 28 slab cases plus 20 live edit/animation
cases compare 1x1 RGBA pixels exactly to an independent Beer/sRGB oracle, on both
instancing paths and both mirrors. New cases cover attenuation edits, animated
color, thickness and distance, and animated thickness 1200 shortened by scale
1/1200. This is an authored slab correctness fixture, not arbitrary mesh quality
or a performance comparison.

Optional entry size acceptance: a same-worktree build of the parent measured animation/pointer at 6,988 gzip bytes and the USDZ worker at 135,931; the repaired code measures 7,164 and 136,160 respectively. The increases are 176 and 229 bytes. The pointer ceiling moves from 7,146 to 7,420, and the worker ceiling from 135,992 to 140,245, including the existing gate headroom. The state repair is synchronous with parsing/animation/drawing; a lazy split would add an asynchronous boundary or an extra public state API. Shared accessors avoid per-material getter functions, with the existing materials material-version regression enforcing their identity. No core/stage change or new optional-package dependency is involved.
