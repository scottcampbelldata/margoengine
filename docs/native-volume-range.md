# Native volume attenuation range

The native glTF tint route used to store transmittance at the authored mesh
thickness, then raise that value to its world-space refracted slab ratio. An
intermediate zero cannot recover when the transform shortens the slab. At
thickness 200 and Z scale 1/200, the parent draws [0,0,255,255] instead of
[137,188,255,255] for attenuation colour [0.25,0.5,1] and distance 1. Thickness
1200 also underflows before binary32 upload.

Parsed `PBRMaterial.opticalDepth` retains three natural optical depths:
`-log(attenuationColor) * thicknessFactor / attenuationDistance`. The native
tint multiplies that depth by its existing world-space refracted slab ratio
before exponentiation. Zero thickness, infinite attenuation distance and white
channels have depth zero; a black absorbing channel has infinite depth, encoded
as a finite negative marker in the shader uniform. This marker represents the
exact opaque limit. No epsilon, colour floor, retry or tolerance is introduced.
Materials constructed with only the existing `attenuation` field derive depth
from that field, preserving its meaning. The legacy `tint`, `attenuation` and
`volume` arrays retain their existing public values.

The repair preserves the existing mesh slab estimate and its transform,
refraction, instancing and grazing-ray conventions. It does not add native
thickness maps, mesh boundary tracing or arbitrary precision. Optical depths
and transforms still reach GPU arithmetic as binary32. The separate hooked
transmission route still stores per-world-unit transmittance; this native tint
repair does not establish its extreme-range equivalence.

Regression evidence: `beer-distance.test.js` checks parsed depths and boundary
limits. `native-volume-path.test.js` evaluates the shipped shader with binary32
arithmetic, including scale recovery. `physical-map-renderer.test.js` checks
uniform upload and legacy fallback. `test-native-volume.mjs` retains all twenty
existing exact slab pixels and adds eight underflow cases, with both mirrors
and instancing modes. All 28 pixels must match the independent Beer/sRGB oracle
exactly on native WebGPU and WebGL2 compatibility. The underflow case fails on
the parent. These are numerical correctness checks, with no speed claim.

Clean-room research compared Khronos Group contributors, *KHR_materials_volume*
(2021), https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_volume/README.md
(mesh-space thickness, world-space attenuation distance and Beer law), with Marco
Matricardi, *Practical implementation of Radiative Transfer for operational NWP*
(ECMWF, 2024), https://events.ecmwf.int/event/375/contributions/4250/attachments/2306/4035/Matricardi_TC_2024.pdf
(transmittance and optical-depth sections). The first defines glTF units and
the second motivates retaining additive optical depth until the path is known.
No companion implementation, foreign engine source or other-repository file
was used. The Khronos Sample Viewer presentation was found but its oversized
PDF could not be retrieved and is not relied on.

Reproduce after building packages: run the three named CPU test files with
`node --test --test-timeout=300000`, then run
`node packages/gltf-pro/scripts/test-native-volume.mjs`, and again with
`--compat`, each under the shared GPU lock.
