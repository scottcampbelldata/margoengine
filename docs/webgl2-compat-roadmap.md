# WebGL2 compatibility layer: roadmap for the next version

Date: 2026-10-21. Status: ACTIVE since 2026-10-27 (Scott), on three conditions: (1) zero core bytes, so core + stage
stay under the 25,000-byte gzip gate and neither is touched; (2) browsers with WebGPU download nothing and see no
slowdown: the layer is a separate optional package, loaded by dynamic import only when `navigator.gpu` is missing or
`requestAdapter()` answers null, and the WebGPU path of core and every package is byte-identical with and without it;
(3) the exact-pixel mode (no context antialiasing) is honoured. Milestones M0 (`@margoengine/webgl2-compat`
reports WebGL2 capabilities and tiers; the WGSL corpus is recorded) and M1 (the WGSL front end: the whole corpus
parses and type-checks, [below](#wgsl-front-end-m1-2026-10-27)) and M2 (the GLSL back end and the device: core renders on
WebGL2 with the same pixels as native WebGPU, [below](#glsl-back-end-and-device-m2-2026-10-28)) are done; M3 (textures, views, copies
and readbacks for the packages) is next. It was paused
on 2026-10-24 (the apps built on Margo so far run on Electron, which has WebGPU) and planned for after v1.0.0 before
that.

## What visitors without WebGPU see today (2026-10-24)

- **Site demos.** Every live demo on margoengine.com (Night Citadel, the gameplay sandbox, the voxel sandbox, flight
  helmet, character animation, robot, windy meadow, Tokyo corner, earth, DOF, tonemap, animator and light-keeper) loads
  [examples/needs-webgpu.js](../examples/needs-webgpu.js) first. Without WebGPU (no `navigator.gpu`, or
  `requestAdapter()` answers null) it shows "This demo needs a browser with WebGPU: Chrome, Edge or Safari." in the
  canvas area, with a link to [webgpu.html](../site/webgpu.html) on which browser to update, and the demo's own code
  is never downloaded. None of the demos runs on the WebGL2 preview: each needs effects, particles, skinning or compute.
  The landing page draws no scene. `npm run check:no-webgpu` (part of `check:merge`) loads every page both ways and
  fails on a missing message or any uncaught error.
- **Apps on the engine.** `Engine.create` (and `createStage`) reject with `WebGPU unavailable` unless the app passes
  `fallback: webglRenderer` from `@margoengine/webgl`. With it, core meshes draw on WebGL2 (per-pixel PBR from each
  mesh's constant colour, one directional light plus ambient, no textures, effects or picking). Packages that need
  WebGPU throw `MargoError` code `unsupported` naming themselves; core's `engine.pick` throws `WebGPU required`.
  Covered by [webgl-preview.test.js](../tests/webgl-preview.test.js) in `npm run verify` and by the pixel readback in
  `check:no-webgpu`.

## Summary

Visitors whose browser has no WebGPU get only the `@margoengine/webgl` preview today: plain core meshes, untextured,
one light, no effects. This roadmap replaces that with a full fallback, without adding a byte to core or the stage
facade.

The plan is one new optional package, working name `@margoengine/webgl2-compat`. When a browser has no WebGPU, the app
loads it before creating the engine. It answers core's request for WebGPU with a WebGPU-shaped device built on WebGL2,
and translates every WGSL shader to GLSL ES 3.00 as it is created. Core's normal WebGPU renderer and every package then
run their usual code, unchanged. Browsers with WebGPU never download the package.

```ts
import { Engine } from '@margoengine/core';

if (!('gpu' in navigator)) await (await import('@margoengine/webgl2-compat')).install();
const engine = await Engine.create(canvas); // core's WebGPU renderer, running on WebGL2
```

Most scenes will look the same on WebGL2. WebGL2 has no compute shaders, storage buffers, atomics or indirect draws,
so features built on those run on a slower path (draw passes, the CPU or a worker) or are switched off with a stated
reason. The package-by-package plan is [below](#package-plan).

Why this works without touching core: core finds its GPU with `navigator.gpu?.requestAdapter()` and the canvas with
`canvas.getContext('webgpu')` (`packages/core/src/renderer.ts`). Both can be supplied from outside. Core itself uses no
compute shaders and no storage buffers; it has two indirect draw calls (`renderer.ts`) and one readback (`engine.pick`).

## Decision record

- "WebGL beyond core" was closed as won't-do for v1.0 on 2026-10-14 (gap 8), because the alternative was a second
  renderer for every package. v1.0 keeps that decision and ships `@margoengine/webgl` as the preview.
- On 2026-10-21 a complete roadmap was requested to implement the full fallback in the next version. This document is
  that roadmap. The core freeze and the 25,000-byte core + stage gzip gate stay in force: the plan needs zero core bytes.
- The translation-layer design replaces "a WebGL2 version of every package" (37 packages with WGSL shaders today). One
  translator and one API layer serve all of them, including packages written later.

## What the packages use today

Counted by string match in each package's `src/` at `685c4de9` (2026-10-21). Shaders assembled from templates count
once, so these are lower bounds. The survey script is reproducible: it reads `git ls-tree` and counts the patterns.

| Package | Vertex | Fragment | Compute | Storage (read) | Storage (read-write) | Atomics | Storage textures | Indirect | Readback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| core | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 4 | 1 |
| gltf-pro | 5 | 26 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| materials | 3 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| shadows | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| clustered | 2 | 2 | 1 | 8 | 2 | 0 | 0 | 0 | 0 |
| animation | 1 | 2 | 1 | 7 | 1 | 0 | 0 | 0 | 0 |
| environment | 7 | 6 | 10 | 3 | 2 | 0 | 4 | 0 | 2 |
| post | 5 | 17 | 11 | 5 | 1 | 0 | 8 | 0 | 1 |
| sky | 0 | 2 | 9 | 0 | 1 | 0 | 9 | 0 | 0 |
| taa | 2 | 4 | 2 | 2 | 1 | 0 | 2 | 0 | 0 |
| dof | 1 | 1 | 3 | 0 | 0 | 0 | 4 | 0 | 0 |
| selection | 2 | 11 | 2 | 3 | 0 | 0 | 2 | 0 | 1 |
| water | 3 | 5 | 6 | 3 | 3 | 1 | 4 | 0 | 0 |
| vfx | 1 | 3 | 5 | 4 | 6 | 2 | 0 | 1 | 0 |
| splats | 1 | 1 | 5 | 13 | 8 | 2 | 0 | 0 | 0 |
| culling | 1 | 1 | 9 | 6 | 13 | 1 | 0 | 2 | 2 |
| scatter | 4 | 3 | 1 | 3 | 4 | 1 | 0 | 2 | 0 |
| creative | 7 | 6 | 2 | 2 | 2 | 1 | 1 | 2 | 0 |
| machinery | 2 | 4 | 1 | 4 | 2 | 1 | 0 | 1 | 0 |
| shader | 0 | 1 | 1 | 0 | 0 | 2 | 0 | 0 | 1 |
| voxel | 2 | 3 | 0 | 4 | 0 | 0 | 0 | 3 | 0 |
| voxel-pathtracer | 1 | 1 | 8 | 11 | 8 | 0 | 1 | 0 | 1 |
| html | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 |
| points | 3 | 6 | 0 | 5 | 0 | 0 | 0 | 0 | 0 |
| lines, text, lod, terrain, staging, toon, tonemap, oit, transitions, video, react, controls, xr | 0-3 each | 1-3 each | 0 | 0-2 | 0 | 0 | 0 | 0 | 0-1 |

Totals: 70 vertex, 140 fragment and 78 compute entry points; 89 read-only and 55 read-write storage bindings; 11 atomic
declarations; 35 storage-texture bindings; 42 indirect calls; 16 readbacks; 13 workgroup-memory declarations.
Texture formats in use, by mentions: rgba16float 91, rgba8unorm 37, depth32float 35, r32float 21, depth32float-stencil8
20, r8unorm 17, rgba8unorm-srgb 16, rgba32float 12, r32uint 9, depth24plus 8, and a long tail.

## Architecture

```text
app ── install() ──► navigator.gpu (CompatGPU) ──► CompatAdapter ──► CompatDevice ──► WebGL2RenderingContext
                     canvas.getContext('webgpu') ──► CompatCanvasContext (owns the WebGL2 context)

core GPURenderer + packages (unchanged)
   │ createShaderModule(WGSL) ──► WGSL front end ──► IR ──► GLSL ES 3.00 back end ──► gl.compileShader
   │ createRenderPipeline ─────► program + state block + vertex layout (VAO cache)
   │ createComputePipeline ────► compute plan: fragment pass | transform feedback | CPU (WGSL→JS) | refuse
   │ command encoder ──────────► recorded command list ──► replayed on queue.submit()
   └ getCurrentTexture() ──────► offscreen texture ──► flipped blit to the default framebuffer at present
```

Parts, each its own module so apps that never need compute fallback do not load it:

1. **Install and detection.** `install({force?})` defines `navigator.gpu`, patches `HTMLCanvasElement.prototype.getContext`
   (and `OffscreenCanvas`) for `'webgpu'`, and defines the `GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage`,
   `GPUMapMode` and `GPUColorWrite` constants for apps that use them (the packages use numeric literals). `force: true`
   installs it even where WebGPU exists, for testing. `uninstall()` restores everything.
2. **Adapter and device.** Real WebGL2 limits mapped onto WebGPU limits (texture size, bind counts, uniform buffer size,
   color attachments, samples). Features reported only when an extension backs them (`texture-compression-bc` from
   `WEBGL_compressed_texture_s3tc` + `EXT_texture_compression_bptc`, `-etc2`, `-astc`, `float32-filterable` from
   `OES_texture_float_linear`, `rg11b10ufloat-renderable`). `timestamp-query` is not reported. The adapter's `info`
   says `vendor: 'margo-webgl2'` so apps and `@margoengine/stats` can show "compatibility mode".
3. **Resources.** Buffers (GL buffer plus a CPU shadow copy where the usage needs it), textures (format table, mips,
   arrays, cubes, 3D, MSAA renderbuffers), views, samplers (WebGL2 sampler objects, including compare mode), bind group
   layouts and bind groups, query sets (occlusion only).
4. **Pipelines.** Program link, vertex layout to attribute pointers, primitive, cull and front face, depth/stencil and
   bias, blend per target, write masks. Programs compile in parallel through `KHR_parallel_shader_compile`;
   `createRenderPipelineAsync` resolves when the link finishes.
5. **Commands.** Encoders record into a flat command list; `queue.submit` replays it against a state cache (current
   program, VAO, framebuffer, bound units, blend/depth state) to skip redundant GL calls.
6. **Present.** The canvas texture is an offscreen texture; at the end of the task that submitted to it, one blit
   flips it into the default framebuffer.
7. **Device loss.** `webglcontextlost` resolves `device.lost`; core's existing `rebootDevice` then rebuilds every plugin,
   exactly as on WebGPU.

## WebGPU to WebGL2 mapping

| WebGPU | WebGL2 | Gap and how it is handled |
| --- | --- | --- |
| Clip space z in [0, w] (core's reversed-Z) | z in [-w, w] | Where the browser exposes `EXT_clip_control`: `clipControlEXT(UPPER_LEFT, ZERO_TO_ONE)`, which also fixes the y direction. Without it: the translator appends `gl_Position.y = -gl_Position.y; gl_Position.z = 2.0 * gl_Position.z - gl_Position.w;` and front faces flip. Reversed-Z keeps working; precision is lower without the extension. |
| Framebuffer and texture origin top-left | bottom-left | Render everything flipped (above), so row 0 is the top in every texture, `@builtin(position)` equals `gl_FragCoord`, viewports and scissors need no conversion, and only the final present blit flips. |
| Separate textures and samplers | combined sampler uniforms | The translator creates one combined sampler per (texture, sampler) pair a shader uses and the layer binds texture and sampler object to the same unit. |
| Bind groups | uniform block bindings + texture units | A per-pipeline table from (group, binding) to block index or units, applied at draw time. Dynamic offsets use `bindBufferRange`. |
| Uniform buffers (WGSL uniform layout) | std140 uniform blocks | WGSL's uniform layout rules match std140 closely; the translator emits explicit padding members wherever `@size`, `@align` or a nested struct would differ. |
| Read-only storage buffers in vertex/fragment shaders | none | Mirrored into an `RGBA32F`/`RGBA32UI` data texture on write; the translator turns `buffer[i].field` into `texelFetch` reads with the struct flattened to texels. `arrayLength` becomes a uniform. Small fixed-size buffers that fit a uniform block use one instead. |
| Read-write storage buffers, atomics | none | Compute plan, below. |
| Storage textures written by compute | none | Compute plan, below (usually a fragment pass into the texture). |
| Compute shaders | none | Compute plan, below. |
| `drawIndirect`, `drawIndexedIndirect` | none | Arguments known on the CPU (written by `writeBuffer`, or by a CPU-run compute) are read from the shadow copy. Arguments produced on the GPU are read back with a synchronous `getBufferSubData`, which stalls; packages that would stall every frame get a direct-draw path instead. |
| `mapAsync`, `copyTextureToBuffer` | `readPixels` into a pixel-pack buffer + `fenceSync` | Asynchronous: the map resolves when the fence signals. |
| MSAA render + `resolveTarget` | multisample renderbuffer + `blitFramebuffer` | Depth resolve picks one sample. |
| Sampling a multisampled texture (`texture_multisampled_2d`, 10 uses) | none in GLSL ES 3.00 | The layer resolves first; `textureLoad(t, p, sample)` becomes `texelFetch(t, p, 0)`. Per-sample effects become per-pixel. |
| `sample_mask`, `sample_index` builtins (6 uses) | none | Dropped with a compile-time note; alpha-to-coverage uses `SAMPLE_ALPHA_TO_COVERAGE`. |
| Texture views (mip range, single layer, cube of a 6-layer array) | no views | Render-target views use `framebufferTextureLayer` / level. Sampled mip ranges set base/max level before the draw. A 6-layer 2D-array texture created with a cube view is allocated as a cube map from the start (decided at `createTexture` from the descriptor's `textureBindingViewDimension` hint or from the first view). |
| `copyExternalImageToTexture`, video | `texImage2D` from the source | Video re-uploads per frame (WebGPU's external textures are zero-copy; WebGL2 is not). |
| `instance_index` with `firstInstance`, `vertex_index` with `baseVertex` | `gl_InstanceID`, `gl_VertexID` exclude the base | `WEBGL_draw_instanced_base_vertex_base_instance` where present; otherwise the base is added through a uniform and attribute offsets. |
| Per-target blend state and write masks | global unless `OES_draw_buffers_indexed` | Without the extension, pipelines whose targets differ split into one pass per target; weighted blended OIT is the known case. |
| `depthBiasClamp` | none | Ignored; noted in the limits. |
| Index buffers shared with other usages | WebGL forbids an element buffer in any other binding | Buffers with `INDEX` plus another usage keep a separate GL element buffer, updated from the shadow copy. |
| Timestamp queries | `EXT_disjoint_timer_query_webgl2` (rarely exposed) | Not reported; stats and `GPUProfiler` show CPU time only. |
| `depth32float-stencil8`, `depth24plus` | `DEPTH32F_STENCIL8`, `DEPTH24_STENCIL8` | Direct. |
| Float render targets and blending | `EXT_color_buffer_float`, `EXT_float_blend` | Required for the full tier; without them HDR targets fall back to `rgba16float` via `EXT_color_buffer_half_float` or the scene renders LDR (low tier). |

## WGSL translator

Written clean room from the WGSL specification and the GLSL ES 3.00 specification. No other translator's source
(Tint, Naga, ANGLE, SPIRV-Cross) is read.

- **Front end:** lexer, parser and resolver for the WGSL the packages use: structs, arrays (fixed and runtime-sized),
  functions, `let`/`var`/`const`, pointers in function parameters, `override` constants, `switch`, `loop` with
  `continuing`, `for`, `while`, `break if`, `discard`, `select`, swizzles, matrix and vector constructors, abstract int
  and float literals. Errors cite the WGSL line and the package that created the module.
- **IR:** typed, after constant folding and `override` substitution (pipeline constants arrive at pipeline creation, so
  each (module, constants) pair compiles once and is cached).
- **Back end (vertex and fragment):** `#version 300 es`, `precision highp` for float, int and samplers; entry-point
  inputs and outputs to `in`/`out` with locations; `@interpolate(flat)` to `flat`; `@builtin`s to `gl_*`; fragment
  outputs to `layout(location = n) out`; `frag_depth` to `gl_FragDepth`.
- **Builtins GLSL ES 3.00 lacks:** `countOneBits`, `firstLeadingBit`, `firstTrailingBit`, `extractBits`, `insertBits`,
  `reverseBits`, `pack4x8unorm`/`snorm` and their unpacks, `dot4U8Packed`, `textureNumLevels`, `textureNumSamples` are
  emitted as helper functions or uniforms. `bitcast` maps to `floatBitsToUint` and friends; `pack2x16float` to
  `packHalf2x16`.
- **Robustness:** WGSL clamps out-of-bounds array and texture accesses; GLSL does not. Dynamic indexes are clamped in
  generated code (constant indexes are checked at compile time), so a shader cannot read past its data on WebGL2 either.
- **Texture arrays of samplers** may only be indexed by constants in GLSL ES 3.00; non-constant indexes become a
  `switch`.
- **Corpus:** every WGSL module the repository creates, recorded at runtime from the package GPU checks and demos (a
  `createShaderModule` hook writes each source once). The translator's acceptance test compiles and links the whole
  corpus through the browser's WebGL2 compiler with zero errors.

## Compute plan

Each compute pipeline is classified when it is created, from the IR:

| Tier | When it applies | How it runs |
| --- | --- | --- |
| A1: fragment pass | Every invocation writes only its own texel of storage textures (`textureStore(t, id.xy, v)`), with no atomics and no workgroup memory | A full-target draw into those textures; the global id comes from `gl_FragCoord`. Up to the device's color-attachment count per pass, else several passes. |
| A2: transform feedback | Every invocation writes only its own records of storage buffers (`out[id.x] = f(...)`), no atomics, no workgroup memory | A vertex shader run with `gl.RASTERIZER_DISCARD` and transform feedback into the output buffers. Skinning and per-particle updates fit here. |
| B: CPU | Small dispatches, or atomics, workgroup memory and barriers with inputs available on the CPU | The IR is also emitted as JavaScript and run per workgroup in phases between barriers (atomics are plain operations there). Inputs come from shadow copies; outputs upload once per dispatch. Optional worker. A per-frame budget, measured in milestone M5, decides when B is allowed. |
| C: package path | Large dispatches with atomics, sorting or GPU-driven culling | The package itself takes another route on compatibility devices (below). The device refuses the pipeline with `MargoError('unsupported')` naming the package and the compat path, so nothing fails silently. |

Packages read the tier through one helper in `packages/shared` (`compatTier(device)`: `'native'` or `'webgl2'`), never
through browser sniffing.

## Package plan

Expected result per package on WebGL2. "Same" means the same pixels within the parity tolerance (milestone M2).

| Package | Plan | Expected result |
| --- | --- | --- |
| core | Render shaders, indirect from shadow copies, `pick` readback | Same |
| gltf-pro, materials | Render shaders; check texture-unit counts (16 per stage is the WebGL2 minimum) | Same; a material whose maps exceed the units drops its least important lobes on compat, listed per material |
| shadows | Depth arrays with comparison (`sampler2DArrayShadow`) | Same |
| clustered | Light binning on the CPU (tier B, at most 1,024 lights); light lists as data textures | Same, more CPU time with many lights |
| animation | Skinning and morphs by transform feedback (A2); CPU skinning (`Skin.pose`) as fallback | Same |
| environment | Prefilter, irradiance and LUT passes as fragment passes (A1); SH reduction on the CPU (B); probes and volumetric fog per-texel (A1) | Same; volumetric fog at a lower froxel count if timing requires |
| post | SSAO, GTAO, SSR, SSGI, Bloom, FXAA, SMAA, motion blur, lens flare: per-pixel passes (A1); Hi-Z mips by fragment downsample | Same, slower; effects that read MSAA depth read the resolved depth |
| sky | LUT generation (A1) | Same |
| taa, dof | Per-pixel passes (A1); DOF's workgroup-shared blur gets a separable fragment-blur path (C) | Same, slightly different DOF filter |
| selection | Jump flood per pixel (A1) | Same |
| tonemap, toon, oit, staging, transitions, lines, text, points, lod, terrain, voxel, react, controls, labels, html | Render shaders and data textures | Same; OIT needs `OES_draw_buffers_indexed` or two passes |
| water | Height and flow simulation per texel (A1); spray particles as vfx below | Same surface; fewer spray particles |
| vfx, creative particles | Simulation on the CPU in a worker (C) with a lower particle budget; instanced draw | Same look, budget measured in M6 (not 1,000,000) |
| splats | Depth sort in a worker (C), the established WebGL approach; projection in the vertex shader | Same image, sort lags by a frame |
| culling, scatter, machinery packs | GPU-driven culling off; core's CPU frustum culling remains; scatter places instances on the CPU | Same image, more draw calls |
| stats, inspector | No GPU timestamps | CPU timings only |
| voxel-pathtracer | Out of scope for the first release; revisit after M8 | Not available on WebGL2 |
| xr | WebXR on WebGL2 needs `XRWebGLLayer`, a separate path | Not available on WebGL2 in this version |
| webgl (preview) | Kept as the small preview for apps that only show plain meshes | Unchanged |

## Milestones

Relative sizes are planning guesses, not measurements: S (days), M (one to two weeks), L (several weeks).

| # | Milestone | Size | Done when |
| --- | --- | --- | --- |
| M0 | Decisions and corpus | S | Package name, support matrix and tiers agreed; the WGSL corpus recorder lands and the corpus covers every package with shaders. |
| M1 | WGSL front end and IR | L | The whole corpus parses and type-checks; errors point at the right line; unit tests per language feature. |
| M2 | GLSL back end for render shaders + core | L | Core's basic scene, instancing, MSAA, picking and device loss run unmodified on the layer; forced-compat pixels match native WebGPU within tolerance (max channel error and mean error set in M0) on the basic-scene and PBR checks. |
| M3 | Textures, samplers, render targets, copies, readback | M | gltf-pro, materials, shadows, tonemap and environment backgrounds pass their GPU checks in forced-compat mode. |
| M4 | Storage-as-data-texture | M | clustered (with CPU binning), points, lines, text, voxel and lod pass in forced-compat mode. |
| M5 | Compute tiers A1, A2, B | L | environment IBL, post effects, sky, taa, selection, water surface and animation skinning pass; tier-B budget measured and written into `docs/limits.md`. |
| M6 | Package compat paths (tier C) | L | vfx, creative particles, splats, culling, scatter, machinery and DOF have their compat routes; each refusal message is tested. |
| M7 | Performance | M | State-cache hit rate, program compile time and frame time measured on the browser matrix; regressions against the M2 baseline fixed or recorded. |
| M8 | Demos, docs and release | M | Every site demo runs in forced-compat mode; `docs/limits.md` gains a WebGL2 column; the parity matrix's WebGL2 rows are rewritten; the package is size-recorded in `entry-sizes.json`. |

## Testing

- **Forced compatibility on one machine.** `install({force: true})` runs the layer on a WebGPU-capable browser, so
  every existing GPU check can render twice, natively and through WebGL2, on the same GPU and compare pixels. Each
  package check gains a `--compat` flag.
- **Corpus compile test** in Node's browser harness: every recorded WGSL module translates, compiles and links.
- **Browser matrix** (real devices): Safari before WebGPU support on macOS and iOS, Firefox on Linux and Android,
  Chrome on Linux where WebGPU is off, an older Android phone, and Chrome with WebGPU disabled. Which visitors actually
  lack WebGPU is not measured; M0 decides whether to measure it.
- **CI:** the corpus test and the forced-compat basic-scene check join `npm run verify`; the full forced-compat sweep
  joins `check:merge`.
- **Core gate:** `npm run measure:size` must report the same core + stage bytes before and after every milestone.

## Size and speed targets

Targets, not measurements: the compat package's root entry (install, adapter, device, resources, commands, GLSL back
end) stays under 60 KB gzip, the CPU compute runner loads separately, and a forced-compat basic scene runs within 1.5x
of native frame time on the desktop GPU. M7 replaces these with measured numbers.

## Risks

| Risk | Mitigation |
| --- | --- |
| Translator semantics drift (integer division by zero, shifts, NaN handling, uniformity) | Corpus parity tests; generated guards where WGSL defines a result GLSL leaves undefined. |
| Texture-unit limit (16 per stage minimum) on rich materials | Per-material unit budget at pipeline creation; documented lobe drop order. |
| Program compile stalls on first use | `KHR_parallel_shader_compile`, async pipeline creation, warm-up of the demo's pipelines behind the loading screen. |
| Synchronous readbacks for GPU-produced indirect arguments | Packages that hit it every frame take their compat path; the layer counts stalls and `@margoengine/stats` shows them. |
| CPU compute too slow on phones | Tier-B budget per frame; packages lower their counts on compat devices. |
| Mobile precision (`highp` support in fragment shaders) | Required; devices without it are refused with a clear message. |
| Context loss | Mapped onto core's existing device-restore path; tested in M2. |
| Maintenance: new WGSL features in later packages | The corpus test fails CI when a new shader does not translate. |

## Out of scope for this version

WebXR on WebGL2, the voxel path tracer, GPU timestamps, zero-copy video, per-sample MSAA effects, 1,000,000-particle
budgets and GPU-driven culling on WebGL2.

## Decisions (M0, 2026-10-27)

1. **Name.** The package is `@margoengine/webgl2-compat` (`margoengine/webgl2-compat` in the umbrella, like every
   package). It names what it does, WebGL2 compatibility for the WebGPU API, and stays apart from `@margoengine/webgl`,
   which is a different thing: a second, small renderer. **`@margoengine/webgl` stays** as the preview until the layer
   replaces it: it is 3,021 B gzip and draws plain meshes on any WebGL2, including devices below the layer's minimum
   tier. M8 decides its retirement, once every page that uses the preview draws the same through the layer.
2. **Minimum tier: `EXT_color_buffer_float` and `highp` fragment shaders are required** (the `full` tier of
   `webgl2Capabilities`). Below it, `install()` (M2) will reject with `MargoError` code `unsupported` naming what is
   missing, and the app keeps the `@margoengine/webgl` preview. Reasons: Margo's HDR path renders to `rgba16float`
   (91 mentions in the packages) and float data targets (`r32float`, `rgba32float`), so a half-float or LDR tier would
   need a second render path in many packages and double the test matrix; and every WebGL2 configuration this PC can
   run reaches `full`. Measured with `npm run capabilities --workspace @margoengine/webgl2-compat` (2026-10-27):

   | Browser and back end | GPU | Tier | Missing optional extensions |
   | --- | --- | --- | --- |
   | Chrome 156, ANGLE D3D11 (default) | AMD Radeon (integrated) | full | `WEBGL_draw_instanced_base_vertex_base_instance`, ETC2, ASTC |
   | Edge 156, ANGLE D3D11 (default) | AMD Radeon (integrated) | full | the same |
   | Chrome 156, ANGLE OpenGL | AMD Radeon (integrated) | full | base vertex/instance, `OES_draw_buffers_indexed`, ETC2 |
   | Chrome 156, ANGLE Vulkan | NVIDIA RTX A6000 | full | base vertex/instance, `KHR_parallel_shader_compile`, ETC2, ASTC |
   | Chrome 156, SwiftShader (CPU) | none | full | base vertex/instance, `KHR_parallel_shader_compile`, `EXT_texture_norm16` |

   After a reboot the same five ran on the NVIDIA RTX A6000 (D3D11 and OpenGL rows too) and again all reached `full`;
   ANGLE OpenGL on NVIDIA has `OES_draw_buffers_indexed` but lacks ASTC as well as ETC2.
   `npm run test:browser --workspace @margoengine/webgl2-compat` (in `check:merge`) asserts the `full` tier in the
   default test browser. All five have `EXT_clip_control`, `EXT_float_blend`, `OES_texture_float_linear`, 8 draw buffers, a 65,536-byte
   uniform block and 16 (D3D11) or 32 fragment texture units; MSAA is 8 samples (SwiftShader 4). What this changes in
   the plan: no configuration has `WEBGL_draw_instanced_base_vertex_base_instance`, so the base-instance uniform path
   is the main path from M2, not a fallback; pipeline creation must not depend on `KHR_parallel_shader_compile`; OIT's
   split pass is needed on ANGLE OpenGL. Not measured: Safari without WebGPU, Firefox and phones (no such device here);
   the browser matrix of M7 covers them, and a half-float tier can be reconsidered with that data.
3. **No visitor counter** (Scott, 2026-10-27). The layer is built without measuring how many visitors lack WebGPU.
4. **Pixel parity for M2 (proposed; M2 confirms it).** Native WebGPU and forced-compat render the same scene on the
   same GPU and browser in exact-pixel mode (`antialias: false`), read back as 8-bit RGBA. Per pixel, d is the largest
   RGB channel difference (0 to 255), the visual check's metric. "Same" means: at most 0.1% of pixels with d > 2,
   and a mean d of at most 0.25. Reasons: the two paths go through different shader compilers (Dawn's WGSL to HLSL and
   ANGLE's GLSL to HLSL), which may order float operations differently, so a one- or two-level difference after the
   sRGB encode is expected and is not a bug; the 0.1% allows depth ties along silhouettes; the mean catches a small
   shift over the whole image (a wrong light colour or exposure), which a share-of-pixels gate alone would miss. M2
   measures the run-to-run noise of both paths first; the tolerance may tighten, and it never loosens without Scott.
5. **Corpus storage.** The corpus is in the repository: 786 distinct modules with entry points (3,405,543 bytes of
   WGSL) from 41 packages plus bundled site pages, recorded from `check:wgsl`, every package GPU test, `check:views`,
   `check:depth` and the visual check (the path tracer's suite in Chrome, see `docs/known-bugs.md`). It is kept small enough by storing the sources, pipeline layouts and pipelines
   Brotli-compressed (`corpus.json.br`, about 166 KB) beside a plain-text manifest (about 226 KB, one line per
   module); the manifest pins the SHA-256 of the data, and `npm run record:wgsl-corpus` rebuilds both. The corpus test
   fails when a package with WGSL in its source has no module in the corpus. Shaders created inside workers are not
   recorded (the hook runs in pages only); none of the packages compiles WGSL in a worker today.

## WGSL front end (M1, 2026-10-27)

`@margoengine/webgl2-compat/wgsl` (its own entry; the root entry never imports it): `parseWGSL` and `checkWGSL`.

- **What it covers.** The lexer follows the specification's textual structure: nested block comments, every line
  break, Unicode identifiers, reserved words, all numeric literal forms and the template-list discovery algorithm.
  The parser covers the whole grammar, including the operator rules (no mixed bitwise chains, no chained
  comparisons). The checker resolves module-scope declarations in any order with cycle detection, applies the Load
  Rule and pointer rules, materializes abstract numbers, resolves operator, constructor, conversion and built-in
  overloads (texture, atomic, packing and bit built-ins included), folds constant expressions with the errors the
  specification requires (overflow, division by zero, shifts past the width, non-finite floats), checks statement
  rules (`continuing`, `break if`, `switch` with one `default`, returns on every path by statement behaviors, no
  recursion), lays out structs with `@align` and `@size`, and checks entry-point interfaces, resource bindings and the
  stage of every built-in (fragment-only derivatives and sampling, compute-only barriers and workgroup memory).
- **The IR** is typed: every expression has its WGSL type (memory references kept apart from values), the folded value
  when it is constant, and its source span; `locate(offset)` gives the line and column. Each entry point lists the
  globals it reaches, which the back end turns into the per-pipeline binding table.
- **Errors.** `WGSLError` with code `syntax`, `type` or `limit`, line and column in code points, and a help link
  (`margoengine.com/errors#wgsl-<code>`). Fuzz tests (random token soup, random expressions in a typed function,
  mutated corpus modules, nesting bombs, 4 MiB of input) check that nothing else escapes and that every case ends
  quickly; property tests compare i32, u32 and f32 folding with a reference evaluator.
- **Corpus result.** All 786 corpus modules parse and check (about 0.5 s for the 3.4 MB on this PC). For every
  pipeline the browser accepted with an explicit layout, each resource the checked entry point reaches sits at a layout
  entry of the same kind, visible to its stage.
- **Left out on purpose, with reasons.** Uniformity analysis (every corpus shader passes it in the browsers' WebGPU
  compilers; it returns as a check if the layer ever compiles shaders no WebGPU browser saw). Array sizes given by an
  override expression other than a single override name (no package uses one). Diagnostic filters are parsed and
  ignored (the front end emits no warnings). Built-ins that do not fold yet (`refract`, the bit and pack functions)
  give runtime values, so a `const` that uses one fails with a clear message; none is used that way in the packages. Abstract integers are evaluated exactly up to 2^53, not the specification's
  64 bits; a larger one fails with code `limit` and asks for a concrete type.

## GLSL back end and device (M2, 2026-10-28)

Measured on this PC (NVIDIA RTX A6000, Edge 156 with ANGLE Direct3D 11 for WebGL2, Dawn for WebGPU).

- **What landed.** `@margoengine/webgl2-compat/glsl` (the GLSL ES 3.00 back end), `/device` (GPU, adapter, device,
  queue, resources, render pipelines, command encoding and replay, canvas context) and `install()` / `uninstall()` in
  the root entry, which loads the device by `import()` only when called. Core is unchanged: `npm run measure:size`
  reports the same core + stage bytes.
- **Parity (decision 4 confirmed, not loosened).** Core drawn natively and on the layer, read back as 8-bit RGBA: the
  basic scene (instanced cubes and spheres, a mirrored mesh, a one-sided mesh, a floor) with 4x MSAA and in exact-pixel
  mode, and two views with a partial clear: 0.000% of pixels with d > 2, mean d 0.000, max d 0 in all three. Run-to-run
  noise of both paths: 0. Picking returns the same mesh at all 100 grid points; a destroyed compat device is restored
  by core and draws the same picture (max d 0). WebGL2 reports no GL error. The tolerance stays as proposed.
- **Semantics.** 32 probe cases computed from runtime inputs are bit-identical to native WebGPU. One difference was
  found and kept: `pack4x8snorm(-0.5)` packs -63 on the layer (the WGSL specification's floor(0.5 + v)) and -64 natively
  (Chrome rounds the tie); the probe stays off exact ties.
- **Corpus.** 881 vertex and fragment entry points without storage resources translate and compile; the 257 distinct
  stage pairs of the recorded pipelines link; all 347 recorded pipelines without storage draw once through the device.
  Waiting for M4 and M5: 231 recorded pipelines that read storage buffers, 45 that call `arrayLength`, and every compute
  pipeline. The counts are printed by `npm run test:browser`.
- **Sizes (gzip).** Root static part (probe and install): about 1.9 KB. `install()` loads 60,837 B in all (the sizes
  gate counts the lazy chunk with the root): `/device` 60,634 B, of which `/glsl` 40,815 B, of which the `/wgsl` front
  end. Against the 60 KB target the root with install is 60,837 B, 837 B over 60,000 (under 60 KiB, 61,440 B); nothing
  was cut to fit.
- **What the checks found and fixed.** (1) ANGLE's Direct3D back end compiles a pixel shader at its first draw, so a
  shader that links can still fail: uniform reads addressed by word made it emulate a dynamic vector index per read,
  and a large shader failed to compile; reads now index 16-byte rows with static components. (2) The same compiler
  could not build a call of a function that may discard inside a larger expression (selection's pick shader); such
  calls are evaluated into a temporary when that keeps WGSL's order exact. (3) The front end accepted `insertBits` and
  `extractBits` with constant offset + count past 32 bits, a shader-creation error in WGSL. (4) Pointer `let`s failed
  to translate. Each has a regression test; the corpus draw check (`corpus-draw-browser.mjs`) now catches the class of
  draw-time compile failures.
- **Choices M3 onward build on.** Uniform buffers are blocks of `uvec4` rows read back in WGSL's layout; one GL texture
  unit per (texture, sampler) pair; multisampled textures are renderbuffers with a resolved copy for sampling; every
  device owns its own WebGL2 context on an `OffscreenCanvas` and presents through an `ImageBitmap` (a detached canvas
  and `drawImage` where OffscreenCanvas is missing); vertex strides above 255 bytes, texture views of another format or
  of one layer of an array, render bundles, queries, gather and cube arrays are refused with code `unsupported`, each
  naming its milestone.

## Textures, readbacks, queries, bundles and gather (M3, first landing, 2026-10-28)

Measured on this PC (NVIDIA RTX A6000, Edge 156 with ANGLE Direct3D 11 for WebGL2, Dawn for WebGPU).

- **Texture views.** WebGL2 has no texture views, so a view GL cannot sample directly reads a copy of its own: an sRGB
  view of a unorm texture (or the reverse), a 2D view of one layer of an array or cube, a cube view of six layers of an
  array, and a 2D-array view of a cube or a 2D texture. A copy is made when first used and brought up to date before
  each use, one subresource (level and layer) at a time: each storage keeps the version it holds of every subresource,
  writes (uploads, copies, render attachments) bump the version, and reads copy only what changed. A texture without
  copies pays nothing. Same-format copies are blits; sRGB twins copy raw bytes through a pixel buffer, on the GPU (a
  blit would decode and encode). A square 6-layer 2D texture is now allocated as a cube map (WebGPU compatibility
  mode's default), since every package samples its 6-layer textures as cubes; a 2D-array view of it reads a copy.
  Rendering into an sRGB view writes the sRGB copy, which the unorm view then reads back exactly.
- **Readbacks.** `copyTextureToBuffer` covers every format WebGPU lets a buffer receive: depth16unorm and depth32float
  (also the depth aspect of depth32float-stencil8), stencil (stencil8 and the stencil aspect of the depth-stencil
  formats), the packed rgb10a2unorm, rgb10a2uint, rg11b10ufloat and rgb9e5ufloat, and the snorm formats. Formats
  `readPixels` cannot read are drawn first into a 32-bit target with `texelFetch` and packed back into WebGPU's bytes;
  stencil is read by eight bit-plane draws (each passes the stencil test where its bit is set and adds its weight).
  Two values cannot round-trip, because WebGL2 reads decoded values, not stored bits: rgb9e5ufloat comes back in its
  canonical encoding (a non-canonical one written by `writeTexture` reads back canonical), and an snorm byte of -128
  reads back as -127 (both decode to -1.0). Writing stencil-only data stays refused: WebGL2 uploads depth and stencil
  together.
- **Occlusion queries** use `ANY_SAMPLES_PASSED`: a result is 1 when any sample passed, else 0 (WebGPU asks only for
  zero or not). WebGL2 makes results available only in a later task, so a resolve lands in its buffer once they are,
  and every later write and copy into that buffer waits behind it in order; `mapAsync` resolves after that.
  Timestamp queries stay unavailable.
- **Render bundles** record the same steps as a render pass and replay inside `executeBundles`, with the pass's
  pipeline, bind groups and buffers cleared before and after, as WebGPU specifies.
- **External textures** copy the video frame (an `HTMLVideoElement` or `VideoFrame`) into an rgba8unorm texture per
  source at each `importExternalTexture`, reused while the size stays; sampled values are sRGB-encoded, as for
  `colorSpace: 'srgb'` (other colour spaces are refused). WebGL2 has no zero-copy video.
- **Gather.** `textureGather` and `textureGatherCompare` fetch the four texels of the bilinear footprint at level 0
  with `texelFetch`, applying the sampler's address modes and compare function from a uniform the device sets at each
  draw. 2D and 2D-array textures; a gather on a cube is refused (GLSL ES 3.00 cannot fetch cube texels).
- **Results against native WebGPU** (`features-browser.mjs` in `npm run test:gpu`, both in one page): sRGB views both
  ways and rendering through one, 2D views of array layers before and after rendering into them, cube views of a
  6-layer and of layers 6 to 11 of a 12-layer texture, an array view of a cube, readbacks of 16 format and aspect
  cases, occlusion queries over two frames, two bundles with their own pipelines between pass draws, gather in all
  three address modes with offsets and an array layer, gather compare, and an external texture: all bit-identical.
- **Forced-compatibility runs of package checks.** `--compat` (or `MARGO_COMPAT=1`) on any check that opens its pages
  with `scripts/browser.js` runs them on the layer with no page edit: an init script
  (`scripts/support/compat-shim.js`) makes the first `requestAdapter()` install the layer with `force: true`. The
  materials check passes 44 scenarios on the layer; its 14 others need compute (clustered lights, image-based
  lighting, GPU culling of instances) and must be refused with code `unsupported` naming milestone M5. The glTF PBR
  shader review passes whole. Both run in `npm run test:gpu`. Still to come in M3: the shadows check (its scene is a
  skinned robot, and skinning is compute), the tonemap half of the post-effects suite, and the environment
  background checks, which need splitting from their compute parts or the animation compat path first.
- **Bugs found and fixed, each with a regression test in `features-browser.mjs`.** (1) An upload while another texture
  unit was active went to that unit's texture: `GLState.scratch` selected unit 0 only when its binding changed (the
  materials check's canvas texture update showed the old image). (2) A draw that sampled a multisampled texture's
  resolve wrote depth with depth writes off: the resolve blit reset the write masks after the pipeline had set them;
  bindings are now applied before the pipeline state.
- **Sizes (gzip, the sizes gate's method).** The root with `install()` loads 66,864 B (60,837 B after
  M2): `/device` 66,664 B, `/glsl` 41,566 B, `/wgsl` 26,528 B. Over the 60,000 B target by 6,864 B; nothing was cut. Every byte the layer adds loads only through `install()`, so browsers with WebGPU download none of it, and
  `npm run measure:size` reports the same core + stage bytes.

## Storage buffers in render shaders (M4, 2026-10-28)

Measured on this PC (NVIDIA RTX A6000, Edge 156 with ANGLE Direct3D 11 for WebGL2, Dawn for WebGPU).

- **Data textures.** A storage buffer read in a vertex or fragment shader is read from an RGBA32UI texture, one
  16-byte row per texel, row-major, `1 << shift` texels wide (at most 2,048, so a binding holds up to 2,048 x 16 x
  `MAX_TEXTURE_SIZE` bytes; `maxStorageBufferBindingSize` is capped to that). The shader reads WGSL's own layout from
  those rows exactly as it reads uniform blocks (static components, dynamic rows), so every struct, `@size`, `@align`
  and runtime-sized array reads the same bytes as on WebGPU. Each read is clamped into the binding (WGSL's robust
  access allows any value inside it), and `arrayLength` is (binding size - array offset) / stride from a per-draw
  uniform, which also clamps indexes into runtime-sized arrays.
- **Mirroring.** Every change of a buffer's contents (`writeBuffer`, mapped writes, copies, readbacks landing) bumps
  its version; before a draw reads it, its data texture is refreshed from the GL buffer on the GPU through
  `PIXEL_UNPACK_BUFFER`, never through the CPU. The storage bindings of a bind group without a dynamic offset share one
  data texture, filled binding after binding, so a pipeline spends one texture unit per bind group on storage: the
  glTF PBR fragment shaders with clustered lights read 14 textures and 3 or 4 storage buffers, which would not fit
  WebGL2's 16 units one texture per buffer. A binding with a dynamic offset keeps its buffer's own texture.
- **Corpus.** All 1,049 vertex and fragment entry points compile, all 459 distinct stage pairs of the recorded render
  pipelines link, and all 624 recorded render pipelines draw through the device (347 before M4). Nothing waits on
  M4 any more; writes to storage, storage textures, atomics and compute wait for M5.
- **Package checks in forced compatibility** (in `npm run test:gpu`): lod, lines and text pass whole; points passes
  its single-sample run. Its 4x run shades eye-dome lighting per sample (`@builtin(sample_index)`, comparing matching
  coverage samples), which WebGL2 cannot do (per-sample shading is out of scope); the layer reads the resolved,
  averaged texel there, which darkens point edges the per-sample version leaves alone. The voxel checks draw under
  Bloom (compute, M5), and clustered bins its lights in a compute pass, so both wait for M5 (or, for clustered, the
  CPU binning path the package plan gives it).
- **Bugs found and fixed, each with a regression test.** (1) Word reads with a dynamic component (`array<u32>` in a
  storage buffer: every index) indexed a vector dynamically, which ANGLE's Direct3D back end emulates with a helper
  per use; a shader with many of them failed at its first draw and lost the context. The component is now selected
  with static swizzles (corpus draw check). (2) A copy made for one texture binding during a draw (a stale sRGB view's
  copy) bound texture unit 0 after another binding had been put there; units are now bound only after every copy,
  resolve and upload of the draw (`features-browser.mjs`, regressions). (3) 4x multisampled integer textures made an
  incomplete framebuffer (ANGLE has no multisample integer renderbuffers): the device now refuses them with code
  `unsupported` when the context reports no 4-sample support for the format.
- **Tonemap in forced compatibility (completes that part of M3).** `node scripts/modern-postfx-tests.js --compat`
  (in `npm run test:gpu`) runs the tonemap half of the post-effects suite on the layer: the three tone curves, the
  Khronos PBR Neutral reference within 2e-5, exposure in stops, contrast, the 3D LUT, the ACEScg white point, the
  effects variant (white balance, vignette, grain, aberration), the adapted exposure read from a storage buffer,
  Tonemap in an engine (resize, curve change, re-attach, device restore) and the tonemap demo. DOF, TAA and the
  auto-exposure meter are compute passes and wait for M5; the native run is unchanged. The environment background
  checks build their environments with compute (IBL), and the shadows check's scene is a skinned robot (skinning is
  compute), so both wait for M5 too.
- **Sizes (gzip, the sizes gate's method).** The root with `install()` loads 68,518 B: `/device` 68,303 B, `/glsl`
  42,017 B, `/wgsl` 26,528 B. Over the 60,000 B target by 8,518 B; nothing was cut. Browsers with WebGPU download none
  of it, and core + stage are unchanged.
