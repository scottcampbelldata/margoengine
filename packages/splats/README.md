# @margoengine/splats

Optional WebGPU Gaussian rendering for 1–3,000,000 world-space splats, subject to adapter storage/memory limits. Compute projects each positive-definite 3D covariance through the camera Jacobian into a 2D ellipse with a 0.3-pixel variance floor. Instanced quads cover three standard deviations; the fragment shader evaluates Gaussian opacity and blends far to near against read-only reversed scene depth.

```ts
import {EngineKernel} from '@margoengine/core';
import {Splats,parseSplat} from '@margoengine/splats';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const response = await fetch('/capture.splat');
if (!response.ok) throw new Error('Failed to load splats: '+response.status);
const cloud = Splats.attach(engine, parseSplat(await response.arrayBuffer()));
engine.start();
// cloud.dispose() when unloading; engine.dispose() releases attached plugins.
```

For generated data, supply `SplatData`: `positions` has three Float32 values per splat; `covariances` has six (xx, xy, xz, yy, yz, zz); `colors` has four (linear RGB and opacity, each 0..1). Construction validates lengths, finite values and positive-definite covariance, then copies the data for ownership/device recovery. Colors are converted to sRGB for ordinary display targets and remain linear in HDR targets.

Optional `sphericalHarmonics` contains 4, 9 or 16 coefficients per splat, with RGB interleaved for each coefficient. Evaluation uses the real SH basis through degree 3, the camera-to-splat direction, and the usual 0.5 offset. SH replaces RGB; `colors` still supplies opacity. Large SH buffers can exceed an adapter's storage binding limit even when the base cloud fits; attachment rejects before allocating. `parseSplat()` decodes the common 32-byte binary layout (xyz, positive xyz scales, byte RGBA, byte quaternion in wxyz order), converts byte sRGB to linear, normalizes quaternions and derives covariance. PLY, compressed SPZ and training are outside this package.

Each frame creates sortable unsigned depth keys on the GPU. Eight stable 4-bit LSD radix passes run per-workgroup histograms, hierarchical exclusive prefix scans, a scan of block totals, and scatter. Workgroup bit masks and population counts preserve input order within equal digits; equal-depth splats retain source order. Off-frustum, transparent and out-of-range centers sort to the end and render no fragments. The runtime performs no CPU sorting, per-splat frame allocation or GPU readback.

Base GPU allocations are approximately 128 bytes per splat (384 MB at three million), plus small histograms/uniforms and optional SH. CPU copies for recovery are additional. Center-depth sorting approximates intersecting ellipsoids; near-plane-crossing centers are culled. Multiple clouds sort independently: combine overlapping clouds into one data set when global order matters. Splats do not write opaque depth, cast directional shadows or receive PBR lighting. They can render alongside shadows, clustered meshes, animation, VFX and TAA; temporal history uses underlying opaque depth. Frame rate and sorting time depend on hardware and fill rate, with no 1–2 ms or locked-60-FPS guarantee.

`gpuState` exposes sorted key/index pairs, projected ellipses and evaluated colors for diagnostics. Ellipse records are eight floats: normalized center xyz and opacity, then two normalized-screen ellipse axes. `dispose()`/`destroy()` releases all owned GPU resources. Device restoration reuploads the copied input and recreates sorting/rendering passes. The package stays outside core/stage and has no dependencies on other optional renderers; parser-only imports discard GPU code. It follows the workspace's `@margoengine/*` naming convention.
