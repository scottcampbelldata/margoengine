# Gaussian cloud export

`@margoengine/exporters/splats` provides asynchronous `exportGaussianGLB` and
`exportSplat`. Both take the owning splats package's SplatData. Its optional peer
is loaded on demand; there is no import-time GPU or browser access. Source
arrays are retained, maxBytes defaults to the GLB limit and AbortSignal is
optional. The splats validator enforces 1..3,000,000 finite Gaussians with
positive-definite covariance and 0..1 RGBA.

The GLB entry writes the ratified `KHR_gaussian_splatting` ellipse kernel with
`lin_rec709_display` color, POINTS topology, POSITION bounds, normalized xyzw
rotation, nonnegative linear scale, opacity and contiguous degree 0..3 SH bands.
The owning covariance decomposition supplies the axes. SH stays in the source's
linear space: no display-space approximation or higher-band loss is introduced.
Linear COLOR_0 supplies a point-cloud fallback. `required` defaults to false;
true declares splat support required. Name and root extras are optional; the
generator defaults to `Margo Engine Gaussian exporter`. No transform bake or
compression extension is introduced.

Raw .splat output delegates to `@margoengine/splats/data`'s existing `encodeSplat`:
Float32 position and axis scale, byte sRGB RGBA, byte wxyz rotation, 32 bytes per
splat, no SH bands. This is the format's accepted quantization, not a precision
claim about the GLB path.

Research compared the training representation, standard color-space rules and
portable web-viewer record layout. No rival or companion implementation read:

- Bernhard Kerbl, Georgios Kopanas, Thomas Leimkuhler and George Drettakis,
  *3D Gaussian Splatting for Real-Time Radiance Field Rendering*, 2023,
  https://arxiv.org/abs/2308.04079. Covariance, opacity and independent SH color
  motivate retaining the full attributes in GLB.
- Khronos Group, *KHR_gaussian_splatting*, 2026,
  https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_gaussian_splatting/README.md.
  The current ratified namespaced semantics, required kernel/colorSpace fields,
  contiguous bands and linear fallback override the older draft conventions.
- OpenJS Foundation, *SPLAT, KSPLAT, SPZ, and RAD format documentation*, 2026,
  https://loaders.gl/docs/modules/splats/formats/splats. Public format table only;
  the existing clean-room owning codec implements the same 32-byte layout.

Evidence: `packages/exporters/tests/splats-entry.test.js` round-trips through the
independent gltf-pro reader, including every SH band and required/optional flags.
The real raccoon capture subset uses the fixture and source/license notice in
`packages/splats/test/fixtures/NOTICE.md`, without adding another asset. Existing
owning-codec tests cover the .splat quantization. No speed claim is made.

Entry size: 2,800 B minified gzip, newly optional (previously absent), ceiling
3,056 B. The optional peer's data codec is downloaded only on a call; its
existing package has its own recorded sizes. Core and stage are unchanged.
