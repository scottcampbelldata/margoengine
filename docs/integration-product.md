# J6 product viewer integration

The product scene composes gltf-pro, materials clearcoat, environment lighting,
contact shadows, PostStack, DOF, tonemap, TAA, selection, ViewCube and a React
Canvas/mesh mount through public optional entries. Khronos ToyCar and the
existing HDR fixture supply actual model and environment input.

Run `npm run build:packages`, then
`npm run test:integration:browser -- --scene=product`.
Types: `npm run check:examples-types -- --projects=integration-product`.
For the three-backend stored-bit trace, run
`node scripts/integration-product-trace.mjs`; it writes
`test-results/integration-product-trace.json`. It copies each single-sampled
colour attachment/resolve target and bound compute storage texture at its centre,
immediately after that pass, before later passes overwrite it. It records shader
and uniform-byte hashes and sampler descriptors. It changes no shader or sampler.
The original assertions still run. One shared GPU slot and a 150 second scene
limit bound each backend run.

Four scene draws and all four RGBA8 probes survive actual device destruction and
replacement exactly. The centre is [121,33,32,255] on native WebGPU, ANGLE D3D11
and ANGLE Vulkan; other probes are [43,67,83,255]. The normal two-backend runner
retains its existing exact cross-backend assertion. Teardown synchronously
unmounts React, clears the mesh ref, removes Canvas/ViewCube DOM and leaves zero
tracked device allocations, meshes and plugins. Resource accounting has the
limits described in [everything scenes](integration-everything.md).

The original restoration defect was TAA's jitter reset, repaired in 5f1d85b3c
with a failing-before-fix owner regression. Environment reconstruction is async;
the scene's readiness predicate joins its actual replacement-device readiness.
The snapshot resets TAA history and sample phase; it adds no sleep or warm-up.

The remaining red 121 versus 120 defect was in webgl2-compat's GLSL emitter.
The first resolved scene HDR red differed before DOF or tonemapping: native
binary16 0x3329, both ANGLE paths 0x3321. The glTF WGSL was identical. The layer
replaced `textureSample` with a Euclidean derivative LOD estimate followed by
integer-level samples and software mip interpolation. That chooses a different
footprint from the hardware implicit sampler. Selecting the existing hardware
sampling branch alone made the diagnostic scene colour match. The repair keeps
hardware implicit sampling; explicit level, bias and gradient interpolation and
their existing weight/call-count assertions remain unchanged.

The implicit mip-filter oracle samples with the real native sampler because
hardware implicit LOD has finite fraction precision; the layer's job is to match
native. Compatibility implicit output must equal native exactly. Explicit-level
and gradient assertions and the general 1e-6 comparison remain unchanged.

`packages/webgl2-compat/test/glsl.test.js` fails before the repair. The independent
`implicitFootprint` GPU case in `features.html` uses identical oblique UV
expressions, mip texels and sampler settings: native first float bits 0x3e99f89a
(0.3007248044013977), old D3D11 translation 0x3ed98258
(0.4248225688934326). After repair, native and both ANGLE paths return
0x3e99f89a. Run `node packages/webgl2-compat/test/features-browser.mjs` for this
case and the unchanged explicit-weight, call-count and hostile-input cases.

[Stored bits and operation evidence](whitepaper/results/integration-j6-product-diagnosis.json)
include each backend's before/after centre copies. These prove the Margo path
choice, not a shader compiler defect. Some intermediate HDR values still differ,
including a blue binary16 level; no full-HDR or full-image equality claim is made.
No backend-specific probe or tolerance was introduced. This evidence is from one
RTX A6000; it makes no speed or other-device claim.

Clean-room sources compared before the diagnosis and repair:

- W3C GPU for the Web Working Group, *WebGPU* (2026), sampler filtering and resource
  lifetime, https://www.w3.org/TR/webgpu/#dictdef-gpusamplerdescriptor.
- Alan Baker, Mehmet Oguz Derin and David Neto, editors, *WebGPU Shading Language*
  (2026), implicit `textureSample`, derivatives and accuracy,
  https://www.w3.org/TR/WGSL/#texturesample and
  https://www.w3.org/TR/WGSL/#floating-point-accuracy.
- Robert J. Simpson, editor, *The OpenGL ES Shading Language 3.00*, revision 6
  (2016), sections 8.8 and 8.13, implicit sampling and derivatives,
  https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf.
- Tomas Akenine-Moller, Cyril Crassin, Jakub Boksansky, Laurent Belcour, Alexey
  Panteleev and Oli Wright, *Improved Shader and Texture Level of Detail Using
  Ray Cones* (2021, revised 2022), footprint/LOD distinctions,
  https://jcgt.org/published/0010/01/01/.

The standards define the operation to preserve; the paper supplies context for
why a different footprint changes shading. No companion code was read or used.
Package README Works with lines remain owed during the build phase.
