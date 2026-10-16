# Box and complete Draco Avocado fixtures

The Box regression uses the checked-in Khronos file at
`packages/exporters/tests/fixtures/Box.glb`, including its authored parent matrix.

`pbr-box-assets.js` caches the complete, unmodified Avocado Draco model, buffer,
and all three PNG textures from Khronos `glTF-Sample-Assets` commit
[`edc7c9e67c639d230715049ee31f9a96a6babbbe`](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/edc7c9e67c639d230715049ee31f9a96a6babbbe/Models/Avocado/glTF-Draco).
Sizes and SHA-256 hashes are pinned in the helper. Every run verifies cached bytes;
missing or corrupt files download from that exact revision. Larger files stay in
the ignored `test-results/pbr-box-avocado/` directory.

The model, geometry and images are CC0-1.0, according to the upstream
[Avocado license](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/edc7c9e67c639d230715049ee31f9a96a6babbbe/Models/Avocado/LICENSE.md).
The browser regression loads its original JSON and texture references through
`loadGLTF`; it does not strip materials or substitute textures. Its Draco decoder
and worker use the package's production path.
