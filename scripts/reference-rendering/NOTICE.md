# Batch 160 outside reference data

Nothing below is shipped with Margo or copied into this repository.

MetalRoughSpheresNoTextures: Khronos glTF-Sample-Assets commit
8f492390ddc7a2ae221a1369ef560589cf8c70fb,
https://github.com/KhronosGroup/glTF-Sample-Assets/tree/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/MetalRoughSpheresNoTextures.
CC0-1.0; Krill Gavrilov, 2019; model generated with Open CASCADE Technology (asset credit).
Original GLB SHA-256: 5e677f260ec0f366967a6e9545de2f3dab2a160e307b9bcb9d050cd2028f63f8.
The source model, its legal README, matched GLB and reference pictures stay under
engine-bench/batch-160; result hashes are in docs/whitepaper/results/batch-160-metallic-roughness.json.

The Khronos Sample Viewer runs at https://github.khronos.org/glTF-Sample-Viewer-Release/.
It is MIT-licensed; no viewer implementation is copied, inspected as source or distributed.
Only the public UI, rendered output, context attributes and resource identifiers are observed.
Its PNG depicts the CC0 sample under Margo's authored camera/light setup.

Additional existing gltf-pro GPU checks read outside copies under batch-160/gltf-gpu-samples:
FlightHelmet (CC0-1.0), ScatteringSkull (CC0-1.0), EnvironmentTest (Adobe Stock License),
from the same glTF-Sample-Assets commit, and CesiumGS/cesium GaussianSplats tower/0/0.glb
(Apache-2.0, Cesium GS, Inc.; SHA-256 9ef9d8d0756d1f423cd6aa8bd99f7dd26957f96df03dcbcec6e37103e39350b4).
Their original legal READMEs and download URL/hash manifest are beside the outside files;
their repository fixture notices already document the tests. No renderer source is read.

packages/gltf-pro/tests/fixtures/pointer-show.glb is Margo-authored test data, not third-party content.

## Clearcoat, job 2

ClearCoatTest is pinned at the same glTF-Sample-Assets commit as job 1, SHA-256
c3a1cbe318cd043b937130af4eb83ec2ea0b03613387b1b7d769dfab4ac15948. CC-BY-4.0,
2020 Analytical Graphics, Inc., Ed Mackey. The original legal README, unmodified model,
matched-camera model and hosted Sample Viewer pictures stay outside in engine-bench/batch-160.
The full 27-primitive scene includes texture masks, roughness and independent base/coat normals.

The skip audit downloader reads only test assets: Khronos glTF-Test-Assets-Interactivity f99d9b6
(CC-BY-4.0, The Khronos Group); Niantic SPZ 11312e4ad836ed06e3da2f3d5b633688d17ebebb
(MIT, Niantic Labs, 2024); the already-documented Cesium tower; and eoineoineoin/glTF_Physics
9dc61cb3474ff9a51f58d3592f79d5c9e572056a (no stated licence, retained outside only).
The outside skip-audit-provenance.json records every downloaded URL and SHA-256.

Job 3: Khronos SheenTestGrid at 8f492390ddc7a2ae221a1369ef560589cf8c70fb, source GLB
SHA-256 b3d82dde0ae6b93bef1a8085ec05540b21139f9917bfe771135c5aed9ba1c101.
CC0-1.0, Eric Chadwick, 2023. Original GLB/legal README, matched GLB and rendered reference
remain outside under engine-bench/batch-160; the result records their hashes.

Job 6: AnisotropyStrengthTest, CC0-1.0, Ed Mackey, 2023, pinned 8f492390ddc7a2ae221a1369ef560589cf8c70fb. GLB SHA-256 306321ff8214727b145188ceb56d96d2882b393d0b596fa089fd20b07e959834. Iridescence is packed clean room from its original glTF, binary and PNG without modifying geometry/materials/nodes; exact input hashes are in cases.mjs. Original assets/legal notices and pictures remain outside under engine-bench/batch-160.

Job 6: IridescenceMetallicSpheres, CC0-1.0, UX3D, 2022, pinned 8f492390ddc7a2ae221a1369ef560589cf8c70fb. GLB SHA-256 2a590ca0724fab992f1bdb189ea59098d6cc3e308aba5cab566c25a1ae5fd895. Iridescence is packed clean room from its original glTF, binary and PNG without modifying geometry/materials/nodes; exact input hashes are in cases.mjs. Original assets/legal notices and pictures remain outside under engine-bench/batch-160.

Job 7 reuses job 1 MetalRoughSpheresNoTextures without changing any mesh/material. Mitsuba 3.9.1 (BSD-3-Clause) is an outside black-box reference, https://www.mitsuba-renderer.org/ and https://mitsuba.readthedocs.io/. Only its public scene/mesh/render APIs and output are used. No implementation was read or copied. Binary, dependencies, EXRs, float32 output and derived PNGs stay outside under engine-bench; JSON hashes/provenance only are committed.

Job 8 reuses the existing Margo-authored Cornell numerical fixture and its source/licence statement in packages/lightmap/tests/CORNELL-NOTICE.md and THIRD-PARTY-NOTICES.md. Cornell's published measurement facts/specification have no separate SPDX licence stated. No external scene/renderer file or photograph is imported. Mitsuba binary/dependencies/output remain outside, with the same BSD-3-Clause/public-API provenance as job 7.

Batch 160 dedicated determinism probe: IORTestGrid, CC0-1.0, Eric Chadwick, 2023,
at Khronos glTF-Sample-Assets commit 8f492390ddc7a2ae221a1369ef560589cf8c70fb.
Source: https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/IORTestGrid/glTF-Binary/IORTestGrid.glb
SHA-256 863cf24d0e48892ec830a7c712e4eb8bf5c0fd6cc2ae2f34d213b216f0bd6c12.
The complete standard GLB remains outside in engine-bench/batch-160/IORTestGrid.
The probe retains the selected sphere's 1,280 triangles in order and expands its
vertices to assign finite constant tints per triangle. This is a blend-state
repeatability control. Jobs 4/5's complete reference scenes and budgets are unchanged.
Standalone Dawn Node 0.6.2 uses the existing webgpu development dependency through
its public API; no Dawn, ANGLE, driver or reference-renderer implementation was read.

Job 4: TransmissionTest, glTF-Sample-Assets 8f492390ddc7a2ae221a1369ef560589cf8c70fb.
CC0-1.0, Adobe, 2020. Original GLB SHA-256 dd9732dae5517f8605ad4324d78b077b969c3e8357c056280d0a4e4b67797d15.
Original GLB/legal README, matched GLB, Sample Viewer PNG and Cycles EXR/linear/PNG files stay
outside in engine-bench/batch-160/transmission; result JSON records the frozen hashes.

Job 4: AttenuationTest, glTF-Sample-Assets 8f492390ddc7a2ae221a1369ef560589cf8c70fb.
CC-BY-4.0, Analytical Graphics, Inc., Ed Mackey, 2021. Original GLB SHA-256 7ca161b7f8a9e4b2ac1f7f75816b5848bb31f3b4c226c4cb731b487c8809b756.
Original GLB/legal README, matched GLB, Sample Viewer PNG and Cycles EXR/linear/PNG files stay
outside in engine-bench/batch-160/volume; result JSON records the frozen hashes.
