# Scientific visualization rival controls

Batch 182 volume job, 2026-11-10. No elapsed-time result is published here.

## Reproduce from a clone

Use Node and the repository dependencies specified in package.json. Install VTK.js
38.0.5 as a black box outside this repository, at engine-bench/batch-167:

```powershell
npm install --prefix ../engine-bench/batch-167 --no-save @kitware/vtk.js@38.0.5
npm run build:packages
node --test --test-timeout=120000 packages/sciviz/tests/rival-contract.test.js packages/sciviz/tests/volume-field.test.js packages/sciviz/tests/volume-workcount.test.js
node scripts/gpu-lock.mjs run --gpu=sciviz-volume-image-smoke --owner=volume-smoke --max=8 --wait-max=15 -- node packages/sciviz/scripts/rival-bench.mjs --runs=1 --scene=legacy-64
node scripts/gpu-lock.mjs run --gpu=sciviz-volume-image-smoke --owner=volume-smoke --max=8 --wait-max=15 -- node packages/sciviz/scripts/rival-bench.mjs --runs=1 --scene=isotropic-64
node scripts/gpu-lock.mjs run --gpu=sciviz-volume-image-smoke --owner=volume-smoke --max=8 --wait-max=15 -- node packages/sciviz/scripts/rival-bench.mjs --runs=1 --scene=isotropic-128
```

MARGO_ENGINE_BENCH overrides that external engine-bench root. All logs, images and
JSON outputs stay in the invoking worktree under test-results/bp-182 (override with
--output). The harness uses only the rival's public rendering APIs. Its implementation
is neither read nor copied; Vite serves the external installed package as a black box.
Do not install rival libraries in Margo's dependency tree.

Each smoke performs two warmup frame/read pairs, one alternating pair, then one
repeat of each frame for byte equality. No benchmark clock is read by the scene in
smoke mode. JSON excludes timing samples, minima and winner labels. Public API
counts include the render plus canvas read boundary, not browser-internal work or
shader invocations. Instrumented API entry points do not establish GPU duration.
Every report includes rival version, browser/GPU details, dimensions, field sum,
spacing, bounds, transfer controls, raw call counts, image statistics and SHA-256 of
RGBA bytes. Screenshots are inspection aids; hashes cover the copied RGBA data.
Empty, wrong-size, nondeterministic frames and browser errors fail the run. Inter-engine
MAE and far-8 fraction are observations, not a silently relaxed parity threshold.

## Equal inputs and explicit differences

All scenes use the identical x-fastest float32 radial field on both sides, 256 x 256
pixels, camera [2.6, 1.7, 2.9] targeting the origin, up +Y, vertical FOV 60 degrees,
background #0f141c, linear interpolation and aurora with opacity t squared. The
legacy scene preserves the original anisotropic aspect [1, 1, 0.75], nine transfer
points and shading. Its 64-cube sum remains locked to 32731.121874443877. It is not
a like-for-like sampling/lighting row: Margo's normalized-box step varies in world
length by ray direction, while the rival's world step was computed from mean spacing.

The separate isotropic controls use aspect [1, 1, 1], shading off, 256 transfer points,
quality 1.5, world step 2/(N*1.5), opacity reference distance 2/N, and dimensions
N=64 or 128. The input spans [-1,1] along every scene axis. These preserve the full
data and image workloads. Margo stores normalized scalars as half floats; VTK.js
receives float32. Jitter, voxel boundary coordinates, transfer filtering and output
encoding remain explicit differences. Equal inputs and integration step do not imply
identical shader work or pixels. No image-equivalence claim is made.

## Diagnosis and bounded change

The historical frame loss remains open pending the quiet rerun. Public call counts
on each of the three smoke scenes show Margo performs 9 render-pass starts, 5 draws,
3 buffer writes and 1 bind-group creation per frame; VTK.js performs 1 drawArrays call
and no bufferData/texture-upload calls in that frame. These are API counts, not
like-for-like shader-operation counts. Margo's path captures/presents a scene target,
snapshots opaque depth and composes the scientific pass with the engine's multisample
frame graph. This supports clipping volumes against opaque geometry and other layers.
We retain it and its original depth tests. Removing that work would change supported
composition behavior, so these counts alone do not justify deleting passes or a speed claim.

Source inspection also found two new Float32Array(16) matrix allocations in every
VolumeLayer.prepare. The change reuses two views into the existing uniform buffer,
clearing them before inversion to retain the old singular-transform behavior. The
regression fails on the parent with 8 allocations across 4 prepares, and checks
zero allocations and byte-identical uniform values after the change. It covers
shear, reflection, singular and identity transforms, mutable clipping/mode/quality,
and restoration. This is 128 fewer temporary backing-store bytes per prepare, not
an elapsed-time claim. No optional code, eager dependency or work is added to core,
stage or users who do not import scientific visualization.

## Quiet run tonight

After Scott resumes speed runs, set MARGO_SPEED_PHASE=active and run the same
commands with --exclusive replacing --gpu=sciviz-volume-image-smoke and --runs=7
replacing --runs=1. Keep all scenes, controls, images and call counts. Timings include
one frame and its canvas read; they do not isolate GPU execution. Counts come from the last untimed warmup; instrumentation is restored to original
API methods before collecting timing samples. Publish every sample,
loss, image difference and environment, not only the fastest engine. Until then:
timing pending the quiet rerun. The other seven scenes and five rivals of batch 182 run
through `npm run sciviz:compare`; features, accuracy rows and losses are in
[the sciviz comparison](whitepaper/sciviz-vs-rivals.md).

## Research and clean-room basis

- Marc Levoy, 1988, *Display of Surfaces from Volume Data*,
  https://graphics.stanford.edu/papers/volume-cga88/volume.pdf : separate scalar
  classification, gradients and ray compositing. This motivates distinguishing
  shading from the shared-input integration control.
- Jens Kruger and Rudiger Westermann, 2003, *Acceleration Techniques for GPU-based
  Volume Rendering*, https://www.cs.cit.tum.de/cg/research/publications/2003/acceleration-techniques-for-gpu-based-volume-rendering/ :
  ray integration, early termination and depth-assisted work. Retain the same
  volume work rather than remove composition support to reduce a count.
- Klaus Engel, Martin Kraus and Thomas Ertl, 2001, *High-Quality Pre-Integrated Volume
  Rendering Using Hardware-Accelerated Pixel Shading*,
  https://cgl.ethz.ch/teaching/scivis_common/Literature/Engel2001.pdf : classification
  and sampling are quality/work controls. No preintegration is substituted in this comparison.
- Kitware, *VTK.js VolumeMapper and VolumeProperty public API*, consulted 2026,
  https://kitware.github.io/vtk-js/api/Rendering_Core_VolumeMapper.html and
  https://kitware.github.io/vtk-js/api/Rendering_Core_VolumeProperty.html : explicit
  sample distance, disabled automatic adjustment, scalar opacity unit distance and
  shading. Only API documentation was consulted, never implementation or companion code.
