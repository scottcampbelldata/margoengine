# Batch 159 workload diagnosis, 2026-11-10

All 36 previously empty slower-row diagnosis cells now link their observed work
to its implementation and owning batch in `bench/parity-causes.json`. The Markdown
matrix contains the same causes; the normal report generator uses that JSON on
the quiet refresh. Existing elapsed-time numbers and verdicts are unchanged.

The [full preflight inventory](results/bp-159-preflight.json) attempts all 151
catalog cases on all three engines, 453 pairs, with `--runs=1`. It retains 424
successful pairs, 23 explicit unsupported pairs and six real errors. Every
successful pair called its full task or frame once. Unsupported pairs cannot
execute absent code; they are visible gaps, not successful smoke tests. This
inventory does **not** certify that tonight's refresh is ready.

The source snapshot is `fb8ac941d` plus the smoke tooling landed as `225f33c0a`.
During the inventory the worktree rebased, but the browser used the already built
scene bundle. The [eight CPU task profiles](results/bp-159-task-profiles.json)
were collected after the tooling landing. They contain sampled functions and
output counts, no elapsed times. Repeat them from the repository root after
building packages:

```sh
node scripts/parity-task-profile.mjs
```

Use `--cases=p-math,p-geometry-utils` for a subset, and `--out=<path>` to retain
the result elsewhere. A wrapping test runner must apply a hard time limit; this
CPU-only script never requests a GPU slot. It profiles exactly one unchanged
catalog operation after adapter setup, with Node's inspector at a 100 microsecond
sampling interval. Sampling counts vary with load, optimization and GC. They
identify code paths, not speed ratios. The checked tests verify single execution,
inspector cleanup on failure, and exclusion of timing fields.

Native GPU API counts in the preflight are **first-operation** counts, with setup
listed separately. Deferred pipeline/texture initialization can still occur in the
operation. Do not relabel those counts as steady-frame work, or use them alone to
explain the old CPU/GPU timing ratios. The new causes identify work and concrete
workload mismatches; where first-call evidence cannot isolate the old steady cost,
the row explicitly leaves quiet pass attribution open. No first-call count is a
new faster/slower verdict, and no remaining loss is closed as an accepted difference.

The following failures remain for the next complete jobs:

| Pair | Observed cause and next work |
| --- | --- |
| Margo compute | The old adapter rejects storage-buffer drawing, although shader/raw now exposes storage inputs. Build the adapter using that supported API. |
| Margo light probe | The scene supplies nine SH coefficients; the current adapter only knows baked LightProbes. Add the missing coefficient-source API in environment if no supported input fits. |
| Margo grading | The adapter rejects hue rotation although shader utilities and tonemap/hue now supply hue operations. Wire the matching grading arithmetic and verify output. |
| Margo lens flare | The adapter needs a point position and four configurable screen-size elements; the existing sun-direction/fixed-ghost API does not satisfy that job. Build in post, never core. |
| Margo meshopt | Fixed in round 2: the owning gltf-pro parser and async resolver now apply the fallback contract to EXT and KHR. See the regression and reproduction below. |
| Reference depth material, WebGPU | The black-box adapter reports MeshDepthMaterial incompatible. Repair its supported material mapping without reading engine source. |
| Reference USDZ, both | Both black-box calls fail reading `isVector3`. Establish the adapter's loader input/scene contract before measuring. |
| Reference texture formats, both | The DDS parser rejects FourCC zero. Match the fixture contract while retaining coverage of the current uncompressed DDS case; do not remove work to get a ratio. |

Rows owned by batches 161-166, 169 and 170 receive diagnosis only here. No code
optimization is claimed. Batch 159 still owes the missing adapters/APIs, reference
adapter repairs, Draco/KTX2 export measurement cases and matched controls for the
unowned diagnosed mismatches before it can be marked DONE. The quiet refresh must
run on current main; these old snapshot counts are not that refresh.

Research compared: Kai Ninomiya, Brandon Jones and Jim Blandy (editors), W3C,
*WebGPU* (2026), command encoding, queue writes and mapping,
https://www.w3.org/TR/2026/CRD-webgpu-20260915/; Khronos 3D Formats Working Group,
*glTF 2.0.1 Specification* (2021), buffers/accessors/GLB,
https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html; Arseny Kapoulkine and
Khronos contributors, *EXT_meshopt_compression* (2021), fallback buffer contract,
https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md;
Node.js contributors, *Inspector*, CPU profiler API (living documentation, accessed
2026-11-10), https://nodejs.org/api/inspector.html#cpu-profiler. The standards
separate native queue work from CPU parsing; the inspector supplies CPU call-path
evidence without a benchmark campaign. No external implementation or companion
code was read or copied.

## Round 2: meshopt fallback parsing

The parser used the EXT name for fallback-buffer validation and download decisions,
although view decoding already accepted both extension names. A valid KHR placeholder
was therefore treated as a truncated buffer, or its optional fallback file was fetched.
The shared extension lookup now serves both buffers and views, rejects dual declarations,
and checks that marked fallback references use that marker's extension. Core, stage,
the packer and decoder output are unchanged. There is no speed claim or new API.

`packages/gltf-pro/tests/meshopt-fallback.test.js` fails on the parent build and tests
explicit and implicit placeholders, byte-identical EXT/KHR accessors, cached views,
the external fallback download contract, invalid marker types, mixed/dual declarations,
references to fallback storage and source/decoded bounds. Reproduce after building:

```sh
node --test --test-timeout=120000 packages/gltf-pro/tests/meshopt-fallback.test.js
node scripts/gpu-lock.mjs run --owner=meshopt-smoke --max=15 --wait-max=15 -- node scripts/parity-smoke-browser.mjs --runs=1 --cases=p-meshopt --engines=margo
```

Research compared: Arseny Kapoulkine, Jasper St. Pierre, Alexey Knyazev and Don McCurdy,
*KHR_meshopt_compression* (2026 release candidate),
https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_meshopt_compression/README.md;
Arseny Kapoulkine and Khronos contributors, *EXT_meshopt_compression* (2021),
https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md;
Khronos 3D Formats Working Group, *glTF 2.0.1 Specification* (2021),
https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html.
Both extension specifications permit the same fallback layout, while KHR prohibits
declaring both names on one object. The base specification still governs buffer-view
bounds. These specifications, not companion code, informed the fix.
