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
