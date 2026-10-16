# Complete glTF regression assets

`node scripts/gltf-production-assets-tests.js` downloads complete, unmodified
assets from Khronos glTF Sample Assets into `test-results/gltf-production-assets/`.
The committed helper pins commit `edc7c9e67c639d230715049ee31f9a96a6babbbe`, each
file's byte count, and SHA-256 digest. Existing cache files must match those
digests. The binaries are not redistributed in this repository or npm packages.

| Asset | Credit and license | Test coverage |
| --- | --- | --- |
| [TextureTransformMultiTest](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/edc7c9e67c639d230715049ee31f9a96a6babbbe/Models/TextureTransformMultiTest/README.md) | Ed Mackey, Analytical Graphics, Inc., 2020; CC BY 4.0 | The original complete GLB requires `KHR_texture_transform`, exercises both UV sets, and includes optional clearcoat. |
| [AnisotropyBarnLamp](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/edc7c9e67c639d230715049ee31f9a96a6babbbe/Models/AnisotropyBarnLamp/README.md) | Eric Chadwick, Wayfair, LLC, 2023; CC BY 4.0 | The complete 3ds Max / Max2Babylon export includes JSON, geometry, and all four KTX2 textures. Only `KHR_texture_basisu` is required. |

The browser test loads each original file through `loadGLTF` and renders the
engine's complete frame graph. `materials.install()` enables supported optional
clearcoat, transmission, and volume metadata. This does not claim anisotropy,
emissive-strength, or unlit-material support, and those optional declarations
are left in the original assets. Screenshots and pixel coverage checks establish
complete-file loading and visible rendering, not visual certification against a
reference renderer. Base-color and emissive UV0/UV1 tiles also compare with the
asset's independently authored sample column, both numerically and through the
rendered checkmark shape. The authored sample has a 0.006 V bias; the numerical
gate allows 0.01, and the image gate allows 10% boundary/sample differences.
These checks caught the wrong rotation direction despite the original synthetic
tests matching their own baked UV reference. Synthetic regression tests separately
check the remaining channels, UV selection, and texture formats.

Reports include texture dimensions/mips/formats, required/used declarations,
worker creation and termination, pixel coverage, device restoration, and
resource disposal. The original assets' primary READMEs above provide the
license and author attribution. The test outputs retain this attribution in
`source-manifest.json`.
