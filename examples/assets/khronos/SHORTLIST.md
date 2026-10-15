# Khronos sample-asset shortlist (for Scott's approval)

Built 2026-10-15 from each model's `metadata.json` in the official
[Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) repo (150 models checked: 82 CC0,
57 CC-BY 4.0, 4 CC0+CC-BY, 7 restricted). Every model below is **CC0 or CC-BY 4.0** (CC-BY = credit the author on the
demo/site and in the third-party notices). Purpose: the visual-regression suite and the "real assets render
correctly" launch gate. Nothing below is downloaded until Scott approves the list.

## Tier 1 - recommended (compliance + showcase)

### PBR feature comparisons (all CC0) - the strongest compliance evidence
CompareBaseColor, CompareMetallic, CompareRoughness, CompareNormal, CompareAmbientOcclusion, CompareAlphaCoverage,
CompareEmissiveStrength, CompareClearcoat, CompareSheen, CompareSpecular, CompareTransmission, CompareVolume,
CompareIor, CompareIridescence, CompareAnisotropy, CompareDispersion

### Core correctness
| Model | Licence | Tests |
|---|---|---|
| MetalRoughSpheres | CC-BY 4.0 | metal/rough grid |
| AlphaBlendModeTest | CC-BY 4.0 | OPAQUE/MASK/BLEND |
| NormalTangentMirrorTest | CC-BY 4.0 | tangents, mirrored UVs |
| TextureTransformTest (verify licence on download) | - | KHR_texture_transform |
| MultiUVTest | CC-BY 4.0 | second UV set |
| OrientationTest | CC-BY 4.0 | node rotations |
| NegativeScaleTest | CC-BY 4.0 | mirrored transforms (our culling path) |
| MeshPrimitiveModes | CC0 | points/lines/strips |
| BoxVertexColors | CC0 | vertex colours |
| InterpolationTest | CC0 | STEP/LINEAR/CUBICSPLINE |
| MorphStressTest | CC-BY 4.0 | many morph targets |
| RiggedFigure, CesiumMan | CC-BY 4.0 | skinning |
| Fox | CC0 + CC-BY 4.0 | skinned animation clips |
| MultipleScenes, Cameras | CC0 | scenes, glTF cameras |
| DirectionalLight, PointLightIntensityTest, LightsPunctualLamp | CC0 / CC0 / CC-BY 4.0 | KHR_lights_punctual |
| MeshoptCubeTest | CC0 | EXT_meshopt_compression |
| NodePerformanceTest | CC0 | many nodes |

### Showcase (also fills demos)
| Model | Licence | Shows |
|---|---|---|
| FlightHelmet | CC0 | **downloaded** - transmission glass, detailed PBR; the public helmet demo since 2026-10-15 |
| SciFiHelmet | CC0 | detailed PBR helmet (CC0 alternative to DamagedHelmet) |
| ToyCar | CC0 | clearcoat, sheen, transmission |
| SheenChair | CC0 | sheen fabric |
| ABeautifulGame | CC-BY 4.0 (ASWF) | chess set, transmission/volume |
| CarConcept | CC-BY 4.0 | automotive clearcoat (CAD-adjacent) |
| ChronographWatch | CC-BY 4.0 | complex product PBR |
| MaterialsVariantsShoe | CC-BY 4.0 (Shopify) | KHR_materials_variants (product configurator) |
| IridescenceLamp | CC-BY 4.0 | iridescence |
| AnisotropyBarnLamp | CC-BY 4.0 | anisotropy |
| SunglassesKhronos | CC-BY 4.0 | transmission + IOR |
| DiffuseTransmissionTeacup | CC0 | diffuse transmission |
| CommercialRefrigerator | CC-BY 4.0 | product visualisation |
| Lantern, BoomBox, Corset, AntiqueCamera | CC0 | classic PBR test props |

## Do not use
| Model | Reason |
|---|---|
| Sponza | Cryengine Limited License Agreement (Crytek) |
| PlaysetLightTest | CC-BY-NC-SA 4.0 (non-commercial) |
| DamagedHelmet | earlier model CC-BY-NC 4.0 (theblueturtle_) - public demo/site replaced by FlightHelmet (2026-10-15); kept only in internal tests/benchmarks |
| BrainStem, Duck, EnvironmentTest, VirtualCity | licence not CC0/CC-BY in metadata (Smith Micro, Sony, Adobe, 3DRT) |

## Process once approved
Download from the official repo (GLB variant where available) into `examples/assets/khronos/<Model>/` (Git LFS),
validate each with the Khronos glTF-Validator, record licence/credit in `README.md` here and in the site's third-party
notices, then add each to `npm run visual:check` with baselines.
