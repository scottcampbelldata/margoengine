# Biased implicit footprints (2026-11-10)

`textureSampleBias` now emits hardware `texture` or `textureOffset` with a bias,
just as unbiased implicit sampling preserves the hardware footprint. A software
Euclidean derivative estimate can choose a different mip. Shader interpolation
remains for explicit levels and gradients only; the existing explicit interpolation
oracle is unchanged. Bias is compared to the native sampler, whose fractional
filtering precision is implementation dependent.

On the Windows RTX A6000, 20 oblique 4x4 probes per ANGLE backend compare 1280
IEEE-754 words with native WebGPU exactly: nearest/linear filtering, unbiased,
zero, negative and positive fractional biases, with and without offsets. Both
D3D11 and Vulkan pass. The fixture separately asserts that zero bias equals
unbiased sampling and nonzero bias changes the mip. CPU translation regressions
cover 1D, 2D, array, 3D and cube textures. This is a fixture result on this GPU,
not a universal bit-equality guarantee for every GPU, texture or sampler state.

Reproduce after `npm run build:packages`: run the package CPU tests, then
`node scripts/gpu-lock.mjs run --owner=review5-bias --max=5 --wait-max=60 -- node packages/webgl2-compat/test/bias-browser.mjs`.
The registered `test:gpu:bias` writes hardware details and all words to
`test-results/review5-bias-bits.json`. Native runs in a separate browser on the
same adapter because Windows Chromium may expose no native WebGPU adapter when
launched with ANGLE Vulkan. `features-browser.mjs` retains the same-page comparison
on the default backend. No timing assertions or performance claims.

Research compared Alan Baker, Mehmet Oguz Derin and David Neto (editors),
*WebGPU Shading Language* (W3C, 2026),
https://www.w3.org/TR/WGSL/#texturesamplebias ; Robert J. Simpson and John
Kessenich (editors), *The OpenGL ES Shading Language*, 3.00 revision 6 (2016),
section 8.8, https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf ;
and Kai Ninomiya, Brandon Jones and Jim Blandy (editors), *WebGPU* (W3C, 2026),
sampler filtering, https://www.w3.org/TR/webgpu/#dictdef-gpusamplerdescriptor .
WGSL bias modifies implicit LOD; GLSL provides the corresponding biased hardware
lookup; WebGPU leaves precise filter weights implementation dependent. These
standards support preserving the driver footprint rather than reconstructing it.
No other repository code or companion implementation was read or copied.
