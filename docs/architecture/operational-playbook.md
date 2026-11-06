# Engine architecture and quality reference

## Purpose and authority

This document preserves the engine-specific technical design, validation model, measured limits, and known gaps that
were previously mixed with repository coordination instructions. It does not define task assignment, branches,
integration, publishing, or source-control operations. Those are external workspace responsibilities.

The implementation and focused tests are authoritative when this document disagrees with current code. Most detailed
measurements below were audited at commit `67ca53a5` on 2026-10-29. Later committed records supersede those snapshot
values. Status words mean:

- **Enforced**: executable code or a test rejects a violation.
- **Verified**: the cited implementation or test was inspected.
- **Measured**: a committed result records the value and conditions.
- **Documented**: the contract exists, but this document does not claim a live run.
- **Unverified**: a known evidence gap.

## 1. Deterministic transform kernel

### 1.1 Components and build

| Path | Responsibility |
| --- | --- |
| `packages/kernel/Cargo.toml`, `Cargo.lock` | Rust crate `margoengine-kernel`, built as `cdylib` and `rlib`; release uses `opt-level = 3`, fat LTO, one codegen unit, aborting panics, no overflow checks, stripped symbols. |
| `rust-toolchain.toml` | Pinned minimal Rust toolchain and `wasm32-unknown-unknown` target. |
| `packages/kernel/src/lib.rs` | Layout, transform evaluation, constraints, bounds, culling, exports, and native unit tests. |
| `scripts/build-modern.js` | Cargo build, Binaryen optimization, validation, compression, and generated embedding. |
| `packages/core/src/wasm.ts` | Generated raw-deflate payload encoded as base64. Consumers need no Rust toolchain. |
| `packages/core/src/kernel.ts` | `TransformStore`: instantiate, bind typed-array views, grow, tick, and report errors. |
| `packages/core/src/engine.ts` | Slot allocation, public transform setters, per-frame tick, and instance updates. |
| `scripts/kernel-opt-experiment.js` | Historical optimization experiment. It is currently stale; see known gaps. |

The source build runs Cargo for `wasm32-unknown-unknown` with SIMD enabled, then `wasm-opt` with `-Oz`,
`-ocimfs 300`, SIMD, bulk memory, non-trapping float-to-int support, stripped metadata, and convergence. The normal
package build can instead decode the checked-in payload. Both paths validate the module, enforce raw Wasm under
30 KiB, compress with raw deflate at level 9, and verify a lossless round trip. At the audit snapshot the payload was
9,011 bytes raw and 3,435 bytes before base64 after deflate.

`npm run modern:build` rebuilds from Rust. `npm run build:packages` uses the checked-in payload. `npm run test:kernel`
runs `cargo test --locked`. The `rlib` target lets native tests execute the same algorithms with owned vector storage.

### 1.2 Linear-memory contract

One Wasm instance owns one fixed-capacity kernel. The kernel allocates a float region followed by a byte region at an
aligned `__heap_base`; tick performs no allocation. Capacity is limited to `2^23` so the layout remains below the
wasm32 4 GiB address space.

Constants at the audited layout:

- `TAIL = 24`, `DATA_LANES = 86`, `FLAG_LANES = 7`.
- Float lanes: translation 0-2, quaternion 3-6, scale 7-9, parent 10, world matrix 11-26, local sphere 27-30,
  world-sphere structure-of-arrays 31-34, planes and Euler storage 35-37, limits 38-49, scratch matrix 50-65,
  scratch sphere 66-69, and snapshot 70-85.
- Flag lanes: active 0, visible 1, constrained 2, hidden 3, hierarchy depth and inherited-hidden bit 4, tick state 5,
  changed 6.
- The constraint mask uses bits 0-2 for translation and bits 3-5 for Euler rotation (`ROTATION = 56`).

| Region | Indexing and shape | Producer |
| --- | --- | --- |
| Translation, quaternion, scale | `lane * capacity + id`, one structure-of-arrays lane each | JS setters; rotation sync may rewrite quaternion |
| Parents | `10 * capacity + id`, parent id stored as f32, `-1` for none | JS hierarchy setter |
| World matrices | `11 * capacity + id * 16 + element`, column-major | Kernel publish pass |
| Local spheres | `27 * capacity + id * 4 + component` | Geometry-bound setup |
| World spheres | Four structure-of-arrays lanes at 31-34 | Kernel publish pass; suited to four-wide SIMD culling |
| Frustum planes | First 24 values of the lane-35 region | Camera update |
| Euler XYZ | After the 24 plane values, `id * 3 + axis` | JS rotation setter; constraints |
| Limits | After the same tail, 12 values per entity: min/max for translation and Euler axes | JS constraints |
| Scratch matrix and sphere | Per-entity blocks | Kernel staging only |
| Snapshots | 16 values per entity | Kernel bitwise change detection |

The layout costs 351 bytes per slot: 86 f32 lanes plus 7 flag bytes. A committed measurement recorded 352.1 bytes
per slot at 1,048,576 slots. Core adds approximately 5 bytes per slot for the host-side seen and slot arrays. The
mixed layout is deliberate: streamed values and culling spheres are structure-of-arrays, while records copied whole
are per-entity blocks.

`kernel_new` is the only allocator. On wasm32 it owns one static kernel per instance, grows linear memory by pages,
zeros storage, initializes parents to `-1`, and returns null on invalid capacity or allocation failure. `kernel_data`
and `kernel_flags` expose byte offsets; JS constructs all typed views from those offsets. Bounds checks are omitted
only where the layout proves safety. Value, hierarchy, capacity, and finiteness checks remain.

The numeric layout constants are duplicated in Rust and TypeScript. There is no direct generated or compile-time
comparison between those lists; behavioral tests are the current drift detector.

### 1.3 Slot allocation and growth

Removed ids enter a LIFO free list and are reused before the monotonic `next` id advances. A new slot resets
translation to zero, quaternion and scale to identity, parent to `-1`, constraints and hidden state to zero, and Euler
values to zero. Geometry later supplies bounds.

When an id reaches capacity, the store doubles up to `2^23`:

1. Copy every current view out of Wasm memory.
2. Drop the static kernel instance.
3. Bind a larger kernel at the same base address, growing linear memory if required.
4. Recreate every typed view and restore each old view as a prefix.
5. Rebind every live mesh matrix subarray.
6. If the larger bind fails, rebind the old capacity, restore all copies, and rethrow.
7. Mark the new kernel for one full recomputation.

Old views must never be retained across growth. A memory grow detaches their buffer; without a memory grow they still
alias a layout whose column offsets changed. Growth copies about 351 bytes per existing slot and has no isolated
committed timing.

### 1.4 Change detection, hierarchy, and atomic publication

There are no descendant dirty lists. Each entity has a 16-lane bit snapshot containing translation, quaternion,
scale, parent, local sphere, and hidden state. Comparing bits means signed zero and NaN payload changes are visible.
All four four-lane groups are visited even if an earlier group changed.

A tick proceeds as follows:

1. With culling enabled, validate all 24 frustum-plane floats.
2. Validate every constrained value and min/max pair; all must be finite and `min <= max`.
3. Clamp constrained axes. If an Euler axis changed, synchronize its quaternion through the kernel's one XYZ
   expansion.
4. Clear per-tick state.
5. Visit active ids in order. Resolve a parent recursively before its child, memoize completed work, reject cycles,
   reject invalid or inactive parents, and enforce depth at most 64.
6. Recompute when the snapshot changed, the full flag is set, or the parent was recomputed. Write only to scratch.
7. If every active hierarchy succeeds, copy changed scratch matrices and spheres to published regions and set sticky
   changed bytes. A failure publishes nothing and sets the next tick to full.
8. Set initial visibility from local and inherited hidden state, then optionally cull.

Parent composition uses the parent's scratch matrix, which always contains its last computed value. Local TRS is
validated for finite values, nonzero scale, and nonzero quaternion. Quaternion normalization and affine composition
accumulate in f64 and publish f32. The final matrix and transformed sphere must be finite.

World-sphere centers are transformed normally. Radius uses `r * sqrt(norm1 * normInfinity)` of the world matrix's
3x3 part, a conservative spectral-norm bound under non-uniform scale and shear. Culling tests six planes and keeps a
sphere that touches a plane. SIMD handles groups of four, with a scalar remainder. The implementation remains linear
in active entity count; no spatial index is present.

Euler XYZ radians share the tail region after the planes. The kernel owns the single `qX * qY * qZ` expansion and a
deterministic sine approximation: range reduction by tau plus an 11-term f64 Taylor series. A direct Euler write and
a constraint clamp therefore produce the same quaternion bits. One unverified edge remains: native `f64::round`
and Wasm `nearest` differ at exact half-way turn reductions.

`kernel_tick` returns 0 on success, `id + 1` for an invalid entity, and `capacity + 1` for an invalid frustum. The
host converts these to coded range errors. Scratch-first publication and the full-after-failure flag make updates
atomic.

### 1.5 Host bridge and frame loop

Public transform setters validate before writing directly into Wasm-backed arrays. Translation, scale, quaternion,
parent, and visibility setters make no per-entity tick calls. Euler writes call `kernel_sync_rotation`; a multi-axis
`.set` synchronizes once. Quaternion writes normalize without array iteration or `map`, then update Euler lanes in JS.

Each rendered frame:

1. Runs plugin pre-update, resize, and camera update.
2. Copies 24 camera-plane floats into the store.
3. Calls `kernel_tick` once per drawn view, plus the main camera after a multi-view frame where required.
4. Performs a full instance collection after structural, scene, layer, or material changes, or when visibility differs
   from the last collection.
5. Otherwise finds sticky changed bytes, clears them, copies only those 16-float matrices into instance storage, and
   expands each batch's dirty range.
6. Uploads each dirty batch range once.

There is no per-entity Wasm call during a normal tick and no kernel allocation in tick. Host work still scans one
visibility byte per slot and copies each changed matrix. The cost of `kernel_sync_rotation` has not been isolated.

### 1.6 Kernel evidence and limits

The native and host suites cover:

- TRS, atomic failed updates, culling at plane contact, inactive slots, hierarchy composition, cycle rejection,
  depth, constraints, inherited hiding, exact changed sets, rotation synchronization, layout edges, signed zero, NaN
  payloads, all snapshot groups, and failed-tick recovery.
- An oracle in `tests/core-dirty-transforms.test.js`: incremental results match a fresh full recomputation bit for
  bit, including growth, 1% moving entities, 63-deep chains, removal, reuse, and one million entities.
- Growth preserves every value and replaces views; invalid capacities and failed growth leave state unchanged.
- `setQuaternion` creates no arrays across 1,000 calls.
- Build-time Wasm validation, compression round-trip, 30 KiB raw limit, and the combined core-stage size gate.

Recorded snapshot values: unchanged tick about 3.3 ms at 100,006 entities, 20.2 ms at 499,992, and 41.5 ms at
1,000,012, roughly 41 ns per entity per frame at the largest point. Above 1,048,576 slots was not measured. Initial
capacity is 1,024 and the enforced cap is 8,388,608.

Bit-for-bit claims are scoped. Incremental versus full recomputation is verified on the same Wasm. Cross-machine
kernel equality is expected by design but unverified. JavaScript's approximated `sin`, `cos`, `pow`, `hypot`, and
related functions are not promised to have the same final bits across JS engines.

Known kernel gaps:

- No gate proves that checked-in `wasm.ts` was rebuilt from current Rust source.
- Native Cargo tests do not execute the Wasm SIMD paths; JS tests execute the checked-in Wasm.
- No direct cross-machine kernel-bit test and no focused kernel fuzz target.
- `scripts/kernel-opt-experiment.js` expects the old compression and 70-float/5-flag layout; it must not be treated as
  runnable evidence until updated.
- The native/Wasm half-way turn-reduction rounding difference is untested.
- Growth and one rotation-sync bridge call lack isolated cost measurements.

## 2. Precise GPU mathematics

WGSL permits large builtin errors and floating-point reassociation. `packages/shared/precise-math.js` provides 19 f32
functions for code that compares CPU and GPU results or results across vendors:

`preciseDiv`, `preciseSqrt`, `preciseSin`, `preciseCos`, `preciseTan`, `preciseAtan`, `preciseAtan2`, `preciseAsin`,
`preciseAcos`, `preciseExp`, `preciseExp2`, `preciseExpm1`, `preciseSinh`, `preciseCosh`, `preciseTanh`, `preciseLog`,
`preciseLog2`, `preciseLog1p`, and `precisePow`.

The implementation uses public numerical methods: integer Payne-Hanek reduction with a 2/pi table, Cody-Waite
reduction for ln 2, Dekker products from 12-bit halves, and minimax coefficients derived by
`scripts/precise-math-coefficients.mjs` at high precision. WGSL is emitted only for requested functions, with shared
helpers emitted once.

Important primitives:

- `pmSplit` extracts a stable high part by masking mantissa bits.
- `pmProductError` returns the exact product residual for the rounded product.
- `pmFastTwoSum` implements the magnitude-ordered Dekker two-sum. A general Knuth two-sum and FMA emulation are not
  present.
- `preciseDiv` and `preciseSqrt` correct one rounded builtin result using an exact residual.
- `pmHide` reconstructs a float from integer sign, exponent, and mantissa bits through `ldexp`. It preserves the value
  but prevents a compiler from proving and cancelling the expression that produced it.

`pmHide` was required because real compilers legally rewrote error-free transforms: AMD D3D12 folded
`(1 + x) - 1`, and Mesa also regrouped and factored sums. Before the fix a Radeon 680M produced a `preciseLog1p`
result 8,383,741 ulp outside the bound; Mesa had 14 of 17 functions outside bounds. Apple's compiler (M6, Chrome and
Playwright WebKit) lost the last product of `pmProductError` while it was unhidden, so the result was the sum without
it: `precisePow` went 97 ulp out, and `preciseTan` over its bound through `preciseDiv`. Every product there is hidden now.
The same compiler spread an unhidden tail over the large part of `preciseLog2`, regrouped `(0.5 t) t` as `0.5 (t t)` in sinh
and cosh, and lost `f - sd` in pow's log pair. Hides there are named in `tests/precise-math.test.js`. The fixes are guarded by:

- A browser shader rewriter that simulates cancellation and factoring on any GPU.
- A spec-error rewriter that perturbs builtin results by WGSL's allowed error.
- Host text tests that reject self-cancelling and factorable forms.
- Dense host reference tests under fused, unfused, and worst-allowed division/sqrt behavior.
- Browser checks against a step-for-step host mirror and a broad exponent sweep.

The documented bounds are function-specific: most are within 1-2 ulp, tan about 2.5 ulp, and pow 2 ulp while
`|y log2(x)| < 16` and 5 ulp beyond. GPU checks require the bound and no more than 2 ulp from the host mirror; exact
mirror share is reported, not generally required.

At the audited fixes, dense checks and the sweep passed on NVIDIA RTX A6000/D3D12, AMD Radeon 680M/D3D12, and Intel
UHD/Mesa Vulkan. The Intel Arc 140V had not been rerun after the fix. The committed sweep reported 573,720 trig inputs
and 298,646 pow inputs with zero over bound on A6000 and Intel UHD. Bit equality across vendors is not claimed; the
per-function ulp bound is.

`pmLog2Pair` carries `s R` as a pair since 2026-11-05. In one float it left `precisePow` over its bound near the top of the
range on every GPU tried (5.66 ulp on the A6000), and the sweep never drew those inputs. The sweep now has that class,
which fails on the old maths: 318,575 pow inputs, 0 over bound on the A6000 and on an Apple M6 in Chrome 157 and
Playwright WebKit. Worst in a 262,144 input scan of that class: 1.23 ulp on the A6000, 1.03 on the M6. The AMD, Intel UHD
and Arc results above predate this change.

Node 22 and Node 26 once produced different pinned proof digests because V8 implementations of `pow` differed. The
proof inputs now use exact operations, approximated host math is replaced by deterministic stand-ins during the
proof, and the suite runs under both pow modes. NaN payloads are canonicalized only where a proof explicitly defines
that comparison; signed zero otherwise remains significant.

Measured on the RTX A6000 only (`docs/whitepaper/perf-history.md` entry 48): one precise call per element costs 1.0 to
1.8 times the builtin, `tan` 2.3, `pow` 3.0, and the path tracer's panorama and fisheye rays 1% to 7% of a traced sample.
The `pow` figure predates the pair for `s R`, which adds work, and has not been measured again.
Unmeasured: that cost on other GPUs, one kernel rotation-sync call, and cross-machine kernel bit equality.

`@margoengine/compute/subgroups` is opt-in for the same reason: its float sums follow the GPU's subgroup size, so they
do not repeat across GPUs, while integers, orders and sorts equal the default kernels. WGSL promises no subgroup size or
layout, so kernels order work by seats taken with one workgroup atomic, never by `local_invocation_index`. Checked at
sizes 32 (RTX A6000) and 4 (SwiftShader, `BROWSER_ARGS` with `--enable-unsafe-swiftshader` and
`--use-webgpu-adapter=swiftshader`).

## 3. Rendering backends and hardware tiers

**Area light integrals (2026-11-05).** `@margoengine/clustered/area` returns early from a quad with nothing to clip; the clip's own result, by the same operations. Evidence: `packages/clustered/test/ltc-edge.test.js` (bit for bit in float32) and `examples/package-benchmarks/area-lights-gpu.mjs` as the package's `test:gpu:area` (11 frames byte-equal, RTX A6000 only).

gltf-pro trims each pipeline to the vertex inputs its finished shader reads (`packages/gltf-pro/src/vertex-inputs.ts`), after
every shader patch. Evidence: `packages/materials/test/vertex-inputs-browser.mjs` (no pixel differs, RTX A6000 only).

A frame is one colour render pass when only a package draws. The main pass with nothing to draw leaves its clear to a next
pass that declares `joins`; that pass opens its render passes through `context.attach`, and the last one resolves. A clear
nobody took runs before the following pass. Core resolves in a pass of its own only when the graph's last pass did not.
Evidence: `packages/culling/test/gpu/last-pass-check.mjs` (pass counts, frames unchanged) and `tests/modern-msaa.test.js`, RTX
A6000 only; the gain on tile-based GPUs is unmeasured.

**Rendering in a worker (2026-11-05).** Core runs on a transferred `OffscreenCanvas` with no change: it reads no DOM it does not
guard. `@margoengine/worker` gives the canvas `clientWidth` and `clientHeight` and copies `devicePixelRatio` and `margoLow`, so
`resize`, `sceneSamples` and `pick` take the same paths as on the page. Evidence: `packages/worker/tests/browser-check.mjs`
(WebGPU and the WebGL2 fallback in a real worker), RTX A6000 on Chromium only.

### 3.1 Fallback ladder

| Tier | Behavior | Loading and cost |
| --- | --- | --- |
| Native WebGPU | Core `GPURenderer` and all packages | Always attempted first for `backend: 'auto'` or `'webgpu'`. |
| `@margoengine/webgl` preview | Core meshes, constant-color PBR, one directional plus ambient light; no textures, effects, or picking | App-provided fallback, normally dynamically imported. Separate chunk; 3,127 bytes gzip in the audited size record. |
| `@margoengine/webgl2-compat` | WebGPU-shaped API over WebGL2 so core and feature packages run unchanged | App installs only when native WebGPU is unavailable. Device, translator, and compute entries are lazy. |
| Unsupported message | Page explains that WebGPU is required and does not download demo code | Used below the supported fallback floor. |

Core requests an adapter without a power preference on Windows and with `high-performance` elsewhere. Requested
features are filtered against adapter support. Desktop scenes default to 4x MSAA; phones, the light tier, and exact
size use 1x. `Engine.create` records the native failure before invoking an app-supplied fallback. `exactSize` fixes the
canvas dimensions, disables resizing, and forces one sample.

**Native compatibility level (2026-11-05).** `allowCompatibilityAdapters` in `@margoengine/webgl2-compat/adapter` adds a
rung between native WebGPU and the layers: `navigator.gpu.requestAdapter` retries with `featureLevel: 'compatibility'`
when the full level finds nothing. Core changes by 0 bytes: it calls `requestAdapter` at creation and in `rebootDevice`,
so answering there covers both. Compatibility devices take the adapter's limits and rewrite `@interpolate(flat)` to
`either`, which core's pick needs. Evidence: `packages/webgl2-compat/test/adapter-browser.mjs` on a forced device on the
RTX A6000 (D3D12, Chromium): same pixels as the full level, pick hits and misses, restore keeps the level. Missing: a run
on a real OpenGL ES or Direct3D 11 class device, so forced runs prove the validation, not the older GPU's limits;
`Shadows`, occlusion culling and HDR `PostStack` fail there (known-bugs.md).

App-side detection must test both presence of `navigator.gpu` and a non-null adapter. The compatibility layer does not
silently install itself and changes no globals at import time.

### 3.2 WebGL2 compatibility architecture

`install()` returns without changes when real WebGPU has an adapter, unless forced. Otherwise it probes WebGL2,
requires highp fragment floats/ints and `EXT_color_buffer_float`, defines a `CompatGPU` at `navigator.gpu`, patches
only `getContext('webgpu')`, and installs missing WebGPU flag constants. `uninstall()` reverses those changes. Lower
half-float and LDR capability tiers are detected but not accepted because the engine depends on HDR and float-data
targets.

Each compatibility device owns a separate WebGL2 context with antialias, depth, and stencil disabled. WebGPU-style
attachments are explicit. Four-sample pipelines use multisample renderbuffers and resolve by blit; exact-pixel mode
stays unsmoothed. The canvas texture is offscreen and is y-flipped only at presentation, which occurs at the end of
each submit so same-task canvas reads see the current frame.

Translation pipeline:

1. Tokenize complete WGSL, including nested comments, Unicode identifiers, numeric forms, and template discovery.
2. Parse the full grammar and its operator restrictions.
3. Resolve and type-check declarations, pointers, abstract numbers, overloads, constants, layouts, stages, and entry
   interfaces; detect declaration cycles.
4. Produce typed IR carrying folded values, spans, and entry-point reachability.
5. Report coded syntax, type, or limit errors with Unicode-aware line/column and help links. Limits include 4 MiB
   source, 255 nesting levels, and 65,536 values in one constant.
6. Emit GLSL ES 3.00 with WebGPU layout semantics, integer operations, conversions, clamped indexes, combined
   samplers, storage reads through data textures, and helpers for missing GLSL builtins.
7. Build resources, render pipelines, a state cache, canvas presentation, and command replay.
8. Analyze compute IR and choose a GPU or CPU execution tier.

Uniformity analysis is intentionally omitted because the recorded corpus already passes the browsers' compilers.

Mapping details:

- `EXT_clip_control` supplies WebGPU depth range. Rendering flips y so textures keep a top-left origin; presentation
  flips back.
- Bind-group entries map to uniform blocks and texture units per pipeline.
- Storage-buffer render reads use RGBA32UI data textures with 16-byte texels and clamped accesses. Bindings in one
  group share a texture, reducing texture-unit pressure.
- Base vertex and base instance use uniforms because measured WebGL2 targets lacked the extension.
- Without indexed draw-buffer state, outputs with matching blend state are grouped; depth/stencil-writing cases that
  cannot be preserved are refused.
- Render shaders that write storage resources are refused.

### 3.3 Compute tiers

| Tier | Selection | Execution | Important limit |
| --- | --- | --- | --- |
| Fragment | Stores map each invocation to its own renderable texture texel and no buffer is written | Full-target draw, scissored per target/slice | Target must be renderable. |
| Scatter | Bounded stores with no same-invocation read-after-write hazard | Instanced point draw per target; buffer words use R32UI textures | At most 1,024 stores per invocation per target. |
| CPU | Atomics, workgroup memory, barriers, unbounded store loops, hazards, unsupported formats, or f16 uniform cases | Typed IR emitted as JavaScript; one invocation at a time, generators across barriers, f32 rounded with `Math.fround` | Requires CSP `unsafe-eval`; cannot read cube, multisampled, or external textures; GPU-written inputs can cause synchronous stalls. |
| Package alternate path | Planned for large atomic, sorting, or GPU-driven workloads | Feature-specific implementation | No recorded shader required it at the snapshot. |

Package routes now cover VFX, scatter (not `ScatterTiles`) and the sky's light projection as well as DOF, splats,
culling and shadows. A CPU-tier kernel that reads a GPU-written resource waits for all GPU work before it, so one small
kernel can cost a whole frame: the sky projection cost 57 ms that way. Evidence: `routes.test.js` and the frame budget of
`visual:compat:budget`; the integrated-GPU budget run is still missing.

The CPU tier's CSP requirement applies only to this opt-in compatibility path. General claims that the shipped native
engine needs no `unsafe-eval` must be scoped accordingly. Recorded A6000/Edge measurements for CPU clustered binning
over 3,456 clusters were 1.5 ms with 16 lights, 2.8 ms with 64, and 9.4 ms with 256; a 64-wide reduction with seven
barriers reached 4.4 million invocations per second.

`@margoengine/geometry/gpu` has no route through these tiers: `GeometryGenerator` writes core's vertex buffers from a
frame pass at order -1000 and refuses the WebGL2 backend with `unsupported`. Evidence: `npm run test:gpu` in
`packages/geometry` on the RTX A6000, reading vertices back and rebuilding after `rebootDevice`.

`@margoengine/bvh/gpu` has no route through these tiers either: `GPUMeshBVH` takes a `GPUDevice` and refuses anything
else with `unsupported`; WebGL2 keeps the CPU tree. Its ray test is float32 and watertight, with a four-step slack on
each node's exit distance, so rounding never loses a hit. Evidence: `npm run test:browser` in `packages/bvh` on the
RTX A6000 compares 100,000 rays with the float64 CPU tree and fires 123,200 rays at vertices and shared edges from
inside a closed mesh.

`@margoengine/bvh/gpu-build` follows a vertex buffer the GPU writes, on the same WebGPU-only terms. A build is Morton codes, a
bitonic sort and the Karras hierarchy, then bounds climb one level a dispatch: a node's stamp names the dispatch that
finished it, and a parent reads only children stamped by an earlier dispatch, because threads of one dispatch have no
order. Evidence: trees read back and walked node by node, and rays through a pose only the GPU wrote, against a float64
CPU tree, in `packages/bvh/tests/gpu-build-browser.js`.

`CulledMeshes` with `occlusion` runs before core's main pass, so it cannot read core's depth, which has no texture binding
anyway: it redraws last frame's large kept instances depth-only with this frame's camera, at the scene's sample count,
and shares the Hi-Z pyramid of `packages/culling/src/pyramid.ts` with `CulledInstances`. An instance is hidden only
strictly behind the farthest occluder depth in its footprint, so the image is core's. On the WebGL2 layer it stays
frustum and screen size. Evidence: `packages/culling/test/gpu/meshes-occlusion-check.mjs`, 0 differing pixels against
core through camera and occluder changes, 9 of 1,509 instances drawn behind a wall, RTX A6000.

`CulledModels` (`@margoengine/culling/models`) runs the same cull on `PBRInstances` rows, world = node matrix x row. gltf-pro
reads `primitive.redirect` as core reads `Batch.redirect`, so its colour and depth replays draw the kept rows; casters and
picking keep every row. Evidence: `packages/culling/test/gpu/models-cull-check.mjs`, 0 differing pixels with and without
shadows, RTX A6000. Still missing: a timed run, and any cull for non-instanced primitives.

Accepted compatibility differences include CPU transcendental last bits, exact CPU filtering versus typical GPU
fixed-point filtering, one signed-normal tie, canonical rgb9e5/snorm readback, unavailable per-sample shading and
timestamp queries, copied video frames, clamped allowed out-of-bounds reads, refused compressed attachment/readback
operations, and refused integer MSAA formats unsupported by the context.

### 3.4 Corpus, size, and compatibility evidence

The recorded corpus snapshot contains 786 modules with entry points, 3,405,543 WGSL bytes from 41 packages plus site
pages. It is stored as a Brotli corpus with a SHA-256 manifest. Tests require packages with WGSL source to contribute
a recorded module. At the snapshot all modules parsed and checked; 1,049 vertex/fragment entries compiled, 459 stage
pairs linked, 624 render pipelines drew, and 397 of 417 browser compute pipelines dispatched. Twenty path-tracer
kernels remained out of scope because ANGLE compilation could take tens of seconds to minutes.

Audited gzip sizes: root compatibility entry 92,467 bytes, device 92,286, GLSL 42,394, compute 41,489, WGSL 26,528.
The root exceeded its original 60 KiB target; that was recorded rather than hidden. Isolation tests assert no other
package reaches the layer, import changes no globals, and native core/stage bytes remain unchanged.

Evidence includes capability probing, parser/checker fuzzing and nesting bombs, complete corpus compile/link/draw,
forced native-versus-compat rendering, format/readback/query/bundle cases, compute-tier parity, package tests in
forced compatibility, no-WebGPU page behavior, exact-pixel rendering, multi-view, and device restore. Pixel parity
uses per-pixel maximum RGB difference with no more than 0.1% over 2 and mean no more than 0.25.

### 3.5 Runtime quality tiers and resolution

`@margoengine/quality` starts desktops in a light tier rather than guessing from a GPU name. Phones always use the
phone tier. URL overrides can force high or low on desktop; per-page storage records later choices.

| Tier | Main defaults |
| --- | --- |
| Phone | 1x MSAA, DPR 1, two cascades, SSAO and volumetrics off, light-tier base settings. |
| Light | 1x MSAA; shadows 1024 with PCF, SSAO 16 samples, SSR off, reduced volumetric grid/local shadows/VFX capacity. |
| High | Package defaults and desktop 4x MSAA. |

Explicit feature options override presets. Feature packages read one global preset at construction and do not import
the quality package.

Promotion and demotion rules:

- Phone or URL-forced tiers are not auto-changed.
- A light-tier page with timestamp-query support samples GPU passes after startup for 120 frames, reading the time a
  frame's passes cover, so passes that run side by side count once (2026-11-05: an Apple M6 ran 31.9 ms of passes in 8.5 ms
  of GPU time; an RTX A6000 reads the same either way, 4.33 ms, so limits set on such GPUs keep their meaning). A sufficiently low
  p90 stores high for the next page load; it never reloads immediately into a heavier tier.
- A high-tier page stores a held state and reloads once only after five consecutive one-second windows under 55 FPS;
  frame gaps above 250 ms restart a window.
- The measurement restores wrapped queue/encoder methods and destroys temporary GPU resources.
- The light tier's pace (`capFrameRate`) gives each frame the most whole refreshes that still reach 60 FPS, from a median of
  the last 16 callback gaps, so a 100 Hz display renders 100 FPS rather than 50. Evidence: unit tests from 50 to 240 Hz with
  jitter, and a real page on a simulated 100 Hz clock on an Apple M6. Missing: a run on a physical 100 Hz panel, Safari
  itself, and whether an M6 stays on the full tier at 100 Hz (it costs 13.4 ms a frame there, over the 10 ms refresh).

The source comments contain both an old 5 ms threshold and a later documented 8 ms threshold. Current code is the
authority; the discrepancy should be removed when that area changes.

`ResolutionScaler` defaults to a 12 ms budget, scale 0.5-1.0, a 30-sample window, 0.05 granularity, and eight ignored
samples after a change. Over-budget scale falls approximately with the square root of target/current cost, never by
more than 30% at once. A rise needs sustained cost below 70% of budget; an immediately reversed rise doubles holdoff
up to 32 decisions. Core sizes to the lower of device pixel ratio, quality cap, sample-count cap, and 4096 pixels per
side. Exact-size mode bypasses resizing.

### 3.6 Warm-up and device loss

`warmUp(engine)` renders offscreen delta-zero frames until two complete frames run with all asynchronously compiled
pipelines available. It retries bounded rounds and can reboot the device before falling back to synchronous pipeline
creation. `redrawAfterRestore` schedules two animation-frame renders for on-demand apps.

Core treats `device.lost` and relevant frame-time DOM exceptions as loss. Recovery is deduplicated by one shared
promise, creates a new adapter/device/renderer with the same features and samples, re-adds every geometry batch from
CPU copies, swaps renderers, rearms the watcher, and calls every plugin's restore hook in its scene. CPU-side Wasm
transforms and instance arrays survive. Frames skip rendering during recovery, and accessing geometry buffers reports
a restore-specific coded error. The WebGL2 compatibility device feeds its context loss through the same path.

Tests destroy devices and GPU processes during lifecycle checks, compare every visual demo before and after loss,
exercise scenes and multi-view water, restore compatibility devices, and include restore events in proof stories.

Known rendering gaps:

- WebGL preview size is stated inconsistently in older public files; current generated size records are authoritative.
- Intel Arc 140V precise-math evidence needs a post-fix rerun.
- Compatibility CPU compute needs `unsafe-eval`, which older broad CSP wording did not qualify.
- Visual profiles do not cover every GPU/browser/OS combination.
- Compatibility path-tracer kernels remain outside the supported compilation budget.


**Dispersed rays (2026-11-05).** In the `Transmission` pass each of the red, green and blue rays reads the blur level of its own IOR. Evidence: `node scripts/material-dispersion-gpu-check.js` (278 checks at a 0.002 tolerance), whose references use f32 IORs and, on the caller path, a fixed Fresnel, since dispersion moves refraction only.

**Native glass tint (2026-11-05).** A loaded transmissive material's multiply draw reads the full surface (`surfaceTintPBR`): base colour, transmission, metal, specular, sheen, clearcoat and thin film, maps included; the tint lanes hold the volume attenuation alone. Evidence: `packages/materials/tests/transmission-layers.test.js` and `node scripts/material-dispersion-gpu-check.js` on the native path. Missing: a measured cost of the second textured pass.

**Transmission on display-encoded targets (2026-11-05).** `materialTransmissionAdd` decodes the lit colour and the light behind, adds them in linear light and encodes the sum (encoded 0.5 + 0.5 reads 0.69, no longer 1.0); with an HDR scene target both are linear and add directly. gltf-pro's native two-draw path still adds encoded (`docs/known-bugs.md`). Evidence: `packages/materials/tests/transmission-shader.test.js`.

**Native coat and sheen lobes in shadow (2026-11-05).** `layers()` multiplies its sun light by `margoDirectVisible`, so a `direct` hook reaches the clearcoat and sheen lobes of physical shaders. The hook is asked about `margoLit(s,l,direct)`, zero where neither the base nor a lobe has light, so `shadowLit` skips the same fragments on uncoated surfaces and adds lookups only where a coat or sheen faces the light and the base does not. Evidence: `scripts/materials-clearcoat-tests.js` on the GPU (full shadow reads exactly 0, half shadow half) and `packages/gltf-pro/tests/extensions.test.js`. Missing: a measured frame cost on a coated scene.

**Clearcoat over opaque materials through `install` (2026-11-05).** `MaterialExtension.coat` scales direct, local, ambient and emitted light by `1 - clearcoat * F(n.v)` and adds the coat's own light on top, so `install(model)` follows KHR_materials_clearcoat as gltf-pro's native `layers()` does. `lightPBR` then evaluates a `direct` hook once on `vec3f(1)` (`margoDirectVisible`), so such hooks must scale the light they wrap. Evidence: `scripts/materials-clearcoat-tests.js` on the GPU (clearcoat 1 keeps 0.96 of emission at normal incidence and 0.73 at n.v 0.25; ambient 0.0782 where the unfixed shader read 0.0674; SSAO's replay equals the beauty) and `packages/materials/tests/clearcoat.test.js`.

**Dielectric Fresnel ends in lighting hooks (2026-11-05).** Ambient and local-light hooks read `s.f0` and `s.sw` (F0 and F90 of `KHR_materials_ior` and `KHR_materials_specular`); `lightPBR` writes the glTF defaults into shaders whose `Surface` has no such fields, so plain materials keep their numbers. Evidence: `tests/specular-ambient.test.js` and the `environment` browser check (specular 0 on a black dielectric reflects exactly 0 under an IBL).
## 4. Quality architecture

### 4.1 Gate map

| Gate | Command or path | Contract |
| --- | --- | --- |
| Core and stage size | build and `npm run measure:size` | Combined minified ES2022 gzip must be strictly below 25,000 bytes. |
| Kernel payload | `scripts/build-modern.js` | Raw Wasm below 30 KiB, valid module, lossless raw-deflate round trip. |
| Quality ratchets | `npm run quality` | New or worse size, duplication, test, API, or clean-room item fails. |
| Formatting and lint | `scripts/hygiene.js --verify` plus normal lint/typecheck commands | Fast source checks; quality ratchets enforce selected non-regression classes. |
| API and parity | `npm run api:check`, `npm run check:parity` | Generated API and parity contracts remain current. |
| Unit tests | root and package tests | Functional and regression evidence. |
| Documentation | `npm run docs:links`, generated-site checks | Links and generated public material remain coherent. |
| Current proofs | `npm run proofs -- --current` | Ongoing golden-output guarantees match stored outputs. |
| Fresh checkout | `npm run check:fresh-clone` | Validation and current proofs do not depend on local history or artifacts. |
| Site and visual checks | site build, `visual:check`, compatibility visual budget | Built demos render against the correct per-hardware evidence. |
| GPU/package checks | `check:views`, `check:gpu-packages`, `check:depth`, `check:wgsl`, `check:no-webgpu` | Scoped rendering, shader, package, depth, fallback, and view behavior. |
| Consumer packaging | `modern:test:packages`, bundler matrix, quickstart | Packed declarations, docs examples, browser packages, bundlers, licenses, and documented first use work. |
| Release rehearsal | `publish:rehearsal` (in `publish:dry-run` and the publish workflow) | Every tarball audited, then the one-line install, every entry imported and type-checked, and every template built, from a stand-in registry that refuses writes. |
| Public truth | `tests/public-truth.test.js` | Structured license and package-count statements match their canonical sources. |
| Timing-test hygiene | fixed-wait and wall-budget tests | Tests wait for readiness; code speed uses CPU time; justified real-time bounds are marked. |
| Async hygiene | support async call test | Async helpers in tests/scripts are awaited or returned. |
| Node compatibility | CI matrix and proof-golden tests | Minimum and supported Node APIs and proof results stay compatible. |
| Rust kernel | `npm run test:kernel` | Native kernel invariants. |

### 4.2 Size and ratchet contracts

The combined core-stage gate builds the stage entry with core bundled, every other bare package external, minifies for
ES2022, joins output chunks, gzips them, and enforces `bytes < 25_000`. The embedded kernel counts. There is no lower
bound. Core is frozen against features, not bug fixes; a core bug fix requires regression evidence and must remain
within the gate.

The detailed size record bundles public entries like consumers do and records raw/gzip size, commit, dirty state, and
lazy files. Generated records must identify their exact source revision. Current record-generation ownership is
external to this engine reference; the measuring scripts themselves remain authoritative.

Quality baselines have `{ gate, about, total, history, items }`. A new key or measured value above its limit fails.
Shrinking is free. Accepting growth requires a reason appended to history. Size headroom is the larger of 3% or 256
bytes; a static import that pulls a package entry of at least 10,000 bytes into another package is a leak item.

The five ratchets are:

- **sizes**: gzip budget for every public entry and worker, plus heavy-entry leaks.
- **duplicates**: normalized six-line windows of at least 200 characters, known algorithm families, and cross-package
  value re-exports.
- **tests**: each package has verification coverage and each public entry is imported by a test.
- **api**: public exports are documented and thrown errors follow the conventions.
- **clean-room**: engine source does not copy or depend on prohibited competing-engine implementation.

One stale comment says duplicate windows are eight lines; implementation and conventions use six.

Hygiene additionally scores format, lint, public/source `any`, strict TypeScript flags, duplicate type names, TSDoc,
bare errors, API rough edges, and dead files/exports. Not all scores are blocking by themselves; the quality ratchets
are the enforceable non-regression layer for the overlapping categories.

### 4.3 Verification and affected checks

`scripts/verify.mjs` runs fast hygiene and one package build in order, then independent chains in parallel: API,
quality, parity, sandbox build/tests, unit tests at bounded concurrency, documentation links, size measurement, and
current proofs. A chain failure terminates the other process trees. Serial mode remains available for diagnosis.

`scripts/check-merge.mjs` classifies the actual changed files and runs only checks the change can affect. It expands
package dependents transitively and chooses full validation when shared/core/build/check infrastructure changes, a
file cannot be classified, more than the supported affected-package threshold is reached, or full mode is explicitly
requested. The plan and its reason are printed and written to a result file. Plan mode runs nothing and supports
synthetic file lists for testing the classifier.

Always-run steps include verification, fresh-checkout validation, site build, and quickstart. GPU, view, depth, WGSL,
package, no-WebGPU, visual, and bundler work is scoped by documented footprints. Tests require every configured step
to be assigned a class. A step may rerun automatically only after a Windows event-log GPU reset proves an external
driver failure; a second failure remains a failure and the result records that the first attempt reset.

Full validation is an explicit mode, not a default substitute for classification. Unknown or shared changes fail
closed to full coverage. This distinction is what prevents a local package edit from needlessly exercising unrelated
packages while preserving complete coverage when impact cannot be bounded.

### 4.4 Continuous integration

The audited CI matrix included:

- Lint/typecheck on the primary Node version.
- Build, API, quality, and unit tests on the repository minimum Node.
- Node compatibility on 22.12, current 22, and 26: build, engine checks, proof goldens, API availability, consumer
  package and bundler checks, with the broader test set on the newest entry.
- Node-22-specific tests.
- Locked native Rust kernel tests.
- An on-demand Windows browser workflow for broader browser/package coverage.

GPU proof, visual, and full local hardware checks are not assumed to run on a hosted CI GPU. Whether a remote workflow
actually ran is field evidence, not inferred from the YAML.

### 4.5 Golden-output proofs

A proof scripts a package story against a recording stand-in GPU and compares every call, descriptor, and buffer byte.
It must also exercise a feature-on path that differs, proving the comparison can see the feature. Stories cover
changes such as resize, format and sample changes, hidden state, empty state, model rescans, device restoration, and
dispose.

- **Current mode** compares the working implementation with committed lossless golden outputs and runs without old
  Git history. Missing output is a failure.
- **Pinned mode** reconstructs the baseline and claim revisions for historical claims. An unavailable historical
  revision is reported as historical, not silently presented as a live pass.
- Golden metadata records proof name, source ref, resolved revision, capture revision, facts, and SHA-256 per output;
  compressed values are stored separately.
- NaN payloads can be canonicalized only by the proof's declared comparison. Every other bit, including signed zero,
  counts. The sole standard shader normalization is the documented historical AgX-body case.

When an intentional feature-off output changes, audit the exact call-level difference, update the current reference,
capture only after the comparison passes, and update the whitepaper claim with the old/new evidence and reason. Pinned
baseline and claim revisions remain immutable.

### 4.6 Visual regression

Visual checks use real GPU rendering, a fresh browser context, reduced motion, deterministic view parameters, the
demo's readiness signal, and masking for dynamic telemetry. Images are box-downsampled. For each pixel, `d` is the
largest RGB-channel difference. Gated metrics are:

- `changed`: share with `d > 0`.
- `hot`: share with `d > 24`.
- Tolerance: measured worst pairwise noise times 3 plus fixed allowances (`0.0005` changed, `0.0002` hot).

Updates capture multiple independent launches and retake until consecutive captures agree, avoiding mid-raster frames
under load. Each baseline records view, dimensions, runs, noise, tolerance, browser/GPU/power state, date, revision,
and whether rendered inputs were dirty.

Profiles are keyed by GPU slug, browser family, and browser major. A run must never compare against a different
profile. Creating a profile requires the complete view set from clean rendered inputs. Missing hardware evidence is a
failure with an instruction to select the intended GPU or deliberately capture a new profile.

At the audit snapshot, profiles existed for Intel Arc 140V/Edge 155 and RTX A6000/Edge 155 and 156. Intel on newer
Edge, Intel UHD, AMD, and Linux coverage remained absent.

### 4.7 Public truth and benchmarking

`scripts/support/public-truth.mjs` validates structured license URLs against `package.json` and `LICENSE`, and package
count phrases against `docs/catalog.json`. It does not validate every size, timing, or test-count statement. Those must
cite generated records and retain evidence status. An older WebGL preview-size inconsistency demonstrates why this
scope matters.

The benchmarking protocol uses AC power, a shared GPU-resource lock, a whole-machine idle gate, warmup, repeated
measurements, between-case load checks, fixed browser/canvas conditions, and a spread validity limit. Defaults at the
snapshot were one warmup, five measured runs, 300 frames after 60 warmup frames, at most 10% spread, and a 5%
regression threshold (1% for bytes). Report median; with five runs p95 is the slowest sample.

Timing regressions compare only matching machine identities and must exceed both the threshold and measured spread.
Bytes and counts are machine-independent. Engine comparisons use shared scene data, interleaved randomized order,
identical settings, harness timestamp queries, and an append-only ledger that keeps losses and records before/after,
cause, tradeoff, revision, and rerun command. Competing-engine code stays outside this clean-room repository.

Performance validation must include slower supported hardware before a conclusion is generalized. A pass caused by a
slower baseline is invalid; compare the run's baseline against the recorded baseline first.

### 4.8 Failure classes preserved by the gates

| Failure class | Guard |
| --- | --- |
| Current proofs depended on private local history | Committed golden outputs and fresh-checkout validation. |
| Historical proof used today's core on both sides | Claim-revision core pinning and dedicated tests. |
| Stand-in overhead erased a measured speedup | Shared recorder methods and focused regression test. |
| A timing comparison flipped under load because its two sides allocate differently | Compare work with the same allocation profile; a whole-job budget is a ratio to a control job that allocates alike (`packages/exporters/tests/exporters.test.js`: 10 of 10 with 32 processes allocating). |
| Proof digest differed by Node/V8 math | Exact proof inputs, deterministic stand-ins, and multiple pow modes. |
| Packed declarations referenced source outside the package | Every build creates declarations; consumer package check. |
| Visual profile mismatched browser or adapter | Exact profile key and explicit adapter selection. |
| Browser readiness assumed fixed time | Readiness-based waits plus fixed-wait gate. |
| Wall-time assertion failed only under CPU contention | CPU-time budget helper plus wall-budget gate. |
| GPU driver reset produced a misleading code failure | One evidence-backed retry with explicit result annotation. |
| Public generated records or prose drifted | Revision-stamped generation, public-truth checks, and whitepaper evidence. |
| A pass other than the colour pass drew a material's whole surface | `packages/materials/test/cutout-passes-browser.mjs` (picking, contact shadows, TAA velocity) and `packages/shadows/test/cutout-casters-browser.mjs` (every shadow map pass, virtual included) read pixels and velocities through a cut-out, a displaced surface and a clipping plane. |

## 5. Current evidence gaps

The following remain technical gaps, not permission to weaken a check:

1. No gate directly proves that embedded Wasm matches current Rust source.
2. Native and Wasm turn reduction differ at an exact half-way case that lacks a regression test.
3. The kernel optimization experiment uses obsolete layout and compression assumptions.
4. Cross-machine bit equality of kernel output is not measured.
5. Precise-math GPU cost versus builtins is measured on the RTX A6000 only.
6. Intel Arc 140V precise-math bounds need a post-fix run; AMD and Intel UHD need one since the `pmLog2Pair` change of
   2026-11-05, and `precisePow`'s cost needs measuring again.
7. Compatibility CPU compute requires `unsafe-eval`; broad CSP prose must remain scoped to the native engine.
8. Compatibility path-tracer kernels remain outside the practical shader-compilation budget.
9. Visual baselines do not cover every supported GPU/browser/OS combination.
10. The WebGL preview size was inconsistent across older public sources; current generated evidence should replace
    every stale statement.
11. One duplicate-window comment says eight lines while implementation and conventions use six.
12. GPU geometry generation has no speed measurement and no run on a GPU other than the RTX A6000.
12. Only the upper core-stage bound is enforced; there is intentionally no lower bound.
13. Public-truth checks cover license and package count, not every size or performance number.
14. Remote workflow configuration is not proof that a workflow actually ran.
15. The quality classifier must keep a conservative full-mode fallback for genuinely unclassifiable or shared
    changes, while ordinary package changes remain affected-only.
16. Scatter's GPU cull keeps candidate order (2026-11-05; it used to append at `atomicAdd` slots, and an Apple M6 drew
    other 4x MSAA edge pixels every frame). The exact 4x MSAA repeat check (`packages/scatter/test/repeat.browser.mjs`)
    and `packages/biomes/tests/shadows-check.mjs --msaa` have passed on the RTX A6000 and the M6 only, run by hand;
    no gate runs either one on Apple GPUs, and other GPUs are not checked. Its shadow lists still append atomically
    (depth only, so the same depth in any order).
17. Subgroup kernels have run at subgroup sizes 32 and 4 only, and no gate runs size 4.
18. GPU BVH traversal and the GPU build have no quiet speed measurement and no run on a GPU other than the RTX A6000.
