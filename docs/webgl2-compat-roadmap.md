# WebGL2 compatibility layer: roadmap for the next version

Date: 2026-10-21. Status: planned for the version after v1.0.0. Nothing here is implemented yet.

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

- HANDOFF closed "WebGL beyond core" as won't-do for v1.0 on 2026-10-14 (gap 8), because the alternative was a second
  renderer for every package. v1.0 keeps that decision and ships `@margoengine/webgl` as the preview.
- On 2026-10-21 Scott asked for a complete roadmap to implement the full fallback in the next version. This document is
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
| A1 — fragment pass | Every invocation writes only its own texel of storage textures (`textureStore(t, id.xy, v)`), with no atomics and no workgroup memory | A full-target draw into those textures; the global id comes from `gl_FragCoord`. Up to the device's color-attachment count per pass, else several passes. |
| A2 — transform feedback | Every invocation writes only its own records of storage buffers (`out[id.x] = f(...)`), no atomics, no workgroup memory | A vertex shader run with `gl.RASTERIZER_DISCARD` and transform feedback into the output buffers. Skinning and per-particle updates fit here. |
| B — CPU | Small dispatches, or atomics, workgroup memory and barriers with inputs available on the CPU | The IR is also emitted as JavaScript and run per workgroup in phases between barriers (atomics are plain operations there). Inputs come from shadow copies; outputs upload once per dispatch. Optional worker. A per-frame budget, measured in milestone M5, decides when B is allowed. |
| C — package path | Large dispatches with atomics, sorting or GPU-driven culling | The package itself takes another route on compatibility devices (below). The device refuses the pipeline with `MargoError('unsupported')` naming the package and the compat path, so nothing fails silently. |

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
| M0 | Decisions and corpus | S | Package name, support matrix and tiers agreed with Scott; the WGSL corpus recorder lands and the corpus covers every package with shaders. |
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

## Open decisions for Scott

1. Package name (`@margoengine/webgl2-compat` proposed) and whether `@margoengine/webgl` stays as the small preview.
2. Minimum browser tier: require `EXT_color_buffer_float` (full HDR), or also support half-float-only and LDR devices.
3. Whether to measure how many visitors lack WebGPU before M1 (it needs a counter on the site).
4. The pixel-parity tolerance that counts as "same" in M2.
