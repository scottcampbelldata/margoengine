# TAA history and sample reset

`TAA.reset()` now restarts the eight-sample Halton sequence as well as discarding
history. `reset(viewId)` restarts only that view. The monotonic motion frame
identity stays independent, so resetting samples cannot make an old object
snapshot appear consecutive. Projection changes reset before computing jitter.
No core, stage, shaders, optional imports or package dependencies changed.

## Cause and reproduction

The full J6 product scene had a native WebGPU centre probe at (128,96) of
`[93,58,56,255]` before loss and `[79,75,72,255]` after restoration. Waiting for
the environment's replacement resources did not close the difference. Removing
lighting, the clearcoat extension, contact shadows, DOF or tonemap individually
did not close it. Removing TAA did. Uniform captures identified different
jittered camera rows; sampler descriptors and environment texels matched.
Reset discarded history but kept sample phase; restoration started a fresh
phase, affected by how many frames asynchronous resource setup needed.

The owning regression is `packages/taa/test/view-lifecycle.test.js`, named
`TAA reset restarts the raster sample sequence in every view`. It advances two
views, checks named/global reset projections exactly, then compares replacement
device projections. It fails on the old implementation at the named reset.
Run `npm run build:packages`, then `npm test --workspace @margoengine/taa`.
The eight existing TAA GPU suites remain the package gate, with its compatibility
suite as declared in `packages/taa/package.json`. No speed assertion is added.

## Clean-room basis

- Lei Yang, Shiqiu Liu and Marco Salvi (2020), *A Survey of Temporal Antialiasing
  Techniques*, https://doi.org/10.1111/cgf.14018. Sampling and history validation
  are separate state components; both must have an intentional restart policy.
- Alexander Cech (2023), *Temporal Anti-Aliasing State of the Art*,
  https://www.cg.tuwien.ac.at/research/publications/2023/cech-2023-taa/.
  Compared temporal sample acquisition with history validation and rectification.
- W3C GPU for the Web Working Group (2026), *WebGPU*,
  https://www.w3.org/TR/webgpu/#devices. Replacement devices own new resources;
  a CPU sample counter needs an explicit policy alongside GPU reconstruction.

The independent sample counter is Margo's reset policy, inferred from these
separate state requirements and the exact regression. No companion code or
other engine source was read. This change proves deterministic reset, not
pixel equality across different shading backends or all hardware.
