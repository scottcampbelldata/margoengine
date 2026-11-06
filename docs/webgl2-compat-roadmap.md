# WebGL2 compatibility layer: roadmap for the next version

Date: 2026-10-21. Status: ACTIVE since 2026-10-27 (Scott), on three conditions: (1) zero core bytes, so core + stage
stay under the 25,000-byte gzip gate and neither is touched; (2) browsers with WebGPU download nothing and see no
slowdown: the layer is a separate optional package, loaded by dynamic import only when `navigator.gpu` is missing or
`requestAdapter()` answers null, and the WebGPU path of core and every package is byte-identical with and without it;
(3) the exact-pixel mode (no context antialiasing) is honoured. Milestones M0 (`@margoengine/webgl2-compat`
reports WebGL2 capabilities and tiers; the WGSL corpus is recorded) and M1 (the WGSL front end: the whole corpus
parses and type-checks, [below](#wgsl-front-end-m1-2026-10-27)) and M2 (the GLSL back end and the device: core renders on
WebGL2 with the same pixels as native WebGPU, [below](#glsl-back-end-and-device-m2-2026-10-28)) are done, and so are M3 (first
part), M4 (storage buffers read in render shaders), M5 (compute, [below](#compute-m5-2026-10-28)) and M6 (package
routes, [below](#package-routes-m6-2026-10-29)) and M7 (performance and hardening) and M8 (every site demo, docs and the release,
[below](#demos-docs-and-release-m8-2026-10-29)), which landed on 2026-10-31. It was paused
on 2026-10-24 (the apps built on Margo so far run on Electron, which has WebGPU) and planned for after v1.0.0 before
that.

## What visitors without WebGPU see today (2026-10-29)

- **Site demos.** Every live demo on margoengine.com loads [examples/needs-webgpu.js](../examples/needs-webgpu.js)
  first. Without WebGPU (no `navigator.gpu`, or `requestAdapter()` answers null) it downloads this layer with a
  dynamic import, installs it and runs the demo on it, with a "WebGL2 compatibility mode" note linking to
  [webgpu.html](../site/webgpu.html); a demo part that refuses the layer (MargoError code `unsupported`) shows the
  refusal over the scene. Only a browser without WebGL2 at the layer's full tier as well gets "This demo needs a
  browser with WebGPU: Chrome, Edge or Safari." and never downloads the demo's code. The landing page draws no scene.
  `npm run check:no-webgpu` (part of `check:merge`) loads every page with WebGPU (none of the layer may download), in
  both no-WebGPU modes (the layer must install, no uncaught error) and with WebGL2 removed too (the message must show).
  How each demo looks on the layer is [webgl2-compat-demos.md](webgl2-compat-demos.md).
- **Apps on the engine.** `Engine.create` (and `createStage`) reject with `WebGPU unavailable` unless the app passes
  `fallback: webglRenderer` from `@margoengine/webgl`. With it, core meshes draw on WebGL2 (per-pixel PBR from each
  mesh's constant colour, one directional light plus ambient, no textures or effects). Packages that need
  WebGPU throw `MargoError` code `unsupported` naming themselves; core's `engine.pick` throws `WebGPU required` unless
  the app adds `webglPicking` from `@margoengine/webgl/pick`.
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
- The translation-layer design replaces "a WebGL2 version of every package" (36 packages with WGSL shaders today). One
  translator and one API layer serve all of them, including packages written later.

## What the packages use today

Counted by string match in each package's `src/` at `685c4de9` (2026-10-21); the rows and totals cover the packages
still in the engine, and the texture-format mentions are as counted then. Shaders assembled from templates count
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
| shader | 0 | 1 | 1 | 0 | 0 | 2 | 0 | 0 | 1 |
| voxel | 2 | 3 | 0 | 4 | 0 | 0 | 0 | 3 | 0 |
| voxel-pathtracer | 1 | 1 | 8 | 11 | 8 | 0 | 1 | 0 | 1 |
| html | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 |
| points | 3 | 6 | 0 | 5 | 0 | 0 | 0 | 0 | 0 |
| lines, text, lod, terrain, staging, toon, tonemap, oit, transitions, video, react, controls, xr | 0-3 each | 1-3 each | 0 | 0-2 | 0 | 0 | 0 | 0 | 0-1 |

Totals: 68 vertex, 136 fragment and 77 compute entry points; 85 read-only and 53 read-write storage bindings; 10 atomic
declarations; 35 storage-texture bindings; 41 indirect calls; 16 readbacks; 13 workgroup-memory declarations.
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
| culling and scatter packs | GPU-driven culling off; core's CPU frustum culling remains; scatter places instances on the CPU | Same image, more draw calls |
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
| M6 | Package compat paths (tier C) | L | vfx, creative particles, splats, culling, scatter and DOF have their compat routes; each refusal message is tested. |
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
end) stays under 60 KB gzip (superseded 2026-10-30: the limit is 73,000 B, an accepted difference, see "Left in M8" below), the CPU compute runner loads separately, and a forced-compat basic scene runs within 1.5x
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
   tier. Decided with the end of M8 (2026-10-31): it stays for v1.0 (3,154 B gzip, `entry-sizes.json`), and the layer is
   documented as the site's fallback; its retirement is for after v1.0. Today its code users are the React `loadFallback`
   and one benchmark page.
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

## Compute (M5, 2026-10-28)

Measured on this PC (NVIDIA RTX A6000, Edge 156 with ANGLE Direct3D 11 for WebGL2, Dawn for WebGPU).

- **Tiers.** Each compute entry point is planned from the typed IR when its pipeline is built (`planCompute` in
  `margoengine/webgl2-compat/compute`):
  - *fragment (A1)*: every `textureStore` writes the invocation's own texel (its coordinates are the global invocation
    id, tracked through lets, conversions, constructors and function parameters: xy for 2D, xy and z as the layer for
    arrays, xyz for 3D) and no storage buffer is written. One full-target draw per written texture and z slice,
    scissored to the dispatch; the global id comes from `gl_FragCoord`, and a fragment that stores nothing is
    discarded.
  - *scatter (A2, in place of transform feedback)*: a bounded number of stores anywhere, never read back by the
    invocation that made them. One instanced point draw per target: instance k of an invocation draws its k-th store
    (a texel, or a 4-byte word of a buffer) at the store's address. Buffers are drawn as their "word texture" (R32UI,
    one word per texel, filled from the GL buffer and copied back through an RGBA32UI draw and `readPixels` into the
    buffer, all on the GPU). Every draw of a dispatch reads memory as it was before the dispatch, which is the WGSL
    result for invocations that do not read back their own stores (storage textures both read and written are read
    from a copy). Transform feedback would cover only stores at the invocation's own index; skinning batches and light
    lists store at indexes read from buffers, so the point draw covers both.
  - *CPU (B)*: atomics, workgroup memory, barriers, stores in loops of unknown length, an own store read back, and
    anything GLSL ES 3.00 cannot express (f16 values in uniform buffers): the IR as JavaScript, compiled once per
    pipeline with `new Function`. One invocation at a time; with barriers each invocation is a generator and every
    invocation of a workgroup runs to its next barrier before any goes on. f32 operations round through `Math.fround`
    (the same bits as an f32 GPU for +, -, *, / and sqrt), and integers follow WGSL (division by zero, shifts,
    saturating conversions). Bound buffers are copied in (a GPU-written one is read back: a stall, counted in
    `device.stalls`) and the ones it writes are copied back; textures are read back per level on first use; stored
    texels are drawn back through a mask, so unwritten texels keep their values.
  - *C (package paths)*: no recorded shader needs one; packages whose kernels would be slow on the CPU tier take a
    route of their own (M6, [below](#package-routes-m6-2026-10-29)).
- **Lazy loading.** The device keeps only what `getBindGroupLayout` needs (default layouts from the IR); planning,
  translation and the CPU tier load with the compute entry, the first time a page creates a compute pipeline.
  `createComputePipeline` before that returns at once and is planned at its first dispatch; command buffers with
  compute passes wait in the queue until the entry has loaded, and later queue operations wait behind them in order.
  `createComputePipelineAsync` loads it first and rejects on a refusal.
- **Tier-B budget** (in [limits.md](limits.md)): a clustered-binning kernel over 3,456 clusters takes 1.5 ms with 16
  lights, 2.8 ms with 64 and 9.4 ms with 256 per dispatch, copies included; a 64-wide reduction with 7 barriers per
  invocation runs 4.4 million invocations a second. Nothing is refused by size: a larger dispatch runs, slower.
- **Corpus.** All 443 compute entry points plan in Node: 37 fragment, 308 scatter, 98 CPU. In the browser
  (`npm run test:browser`) 397 of the 417 recorded compute pipelines are translated and dispatched once with zero
  failures: 34 fragment, 278 scatter, 82 CPU, 3 refused (below). The other 20 belong to the voxel path tracer, out of
  scope on WebGL2: ANGLE's Direct3D shader compiler takes 20 s to several minutes for each of its kernels.
- **Checks on the layer** (`--compat`, in `npm run test:gpu`): the compute check (11 cases, each against native WebGPU
  in the same page: own-texel stores into 2D, array, 3D and mip-level views, a read-write storage texture, struct and
  word stores at data-dependent indexes, two targets at once, atomics with workgroup memory and barriers, texture reads
  and stores on the CPU, CPU sampling, stores in loops of unknown length, indirect dispatch, overrides, and queue order
  around the lazy load); the materials check whole (its 14 compute scenarios, refused until now, pass: clustered light
  binning, image-based lighting, GPU culling of instances); the shadows lit-faces check (skinned robot: skinning on the
  scatter tier, the nearest-depth reduction on the CPU); the voxel render check at 4x and 1x; the environment check
  (IBL: equirect to cube and the mip chain as fragment draws, the SH projection on the CPU, the BRDF LUT as word
  stores); and the whole post-effects suite (DOF, TAA and the auto-exposure meter included).
- **Bugs found and fixed, each with a regression test.** (51) FXC, ANGLE's Direct3D 11 shader compiler, discards every
  fragment of a shader that ends `if (!flag) discard;` when the global flag is set after a texelFetch behind a
  uniform-dependent early return (reproduced in raw WebGL2); the fragment tier ends `if (flag) return; discard;`
  (compute check, `fragmentStore`). (52) ANGLE's Direct3D 11 back end applies `TEXTURE_BASE_LEVEL` twice in GLSL's
  `textureSize`: a view starting at mip 2 of a 32-texel texture reads 2 texels instead of 8 (reproduced in raw
  WebGL2). `textureDimensions`, `textureNumLayers`, the robust `textureLoad` clamp, gather and
  `textureSampleBaseClampToEdge` now read the view's size from a per-texture uniform the device sets, never from
  `textureSize`; a texture read only for its size keeps a binding slot for that uniform but takes no texture unit
  (features check, `mipViews`; it broke the environment's mip chain). (53) The layer showed canvas frames
  a microtask after the submit, so a page reading the canvas in the same task (drawImage, toDataURL) saw the previous
  frame, where WebGPU shows the current texture; the layer now presents at the end of each submit (features check,
  `canvasRead`; the voxel check's edit-to-pixels count was one frame late).
- **Accepted differences.** Render shaders that write storage buffers or textures are refused (WebGL2 render stages
  cannot write them; no recorded shader does). CPU-tier kernels cannot read cube (sampled since 2026-10-29,
  [below](#cube-sampling-on-the-cpu-tier-2026-10-29)), multisampled or external textures (refused, coded: the light
  probes' bake kernels sample a cube map in kernels with workgroup memory, the corpus's 3 refusals then) and need a page that allows `unsafe-eval`. CPU-tier transcendental functions (sin, exp, pow) differ from
  the GPU in the last bits, and CPU texture filtering uses exact weights where GPUs use 8-bit fixed-point ones (within
  4/255 in the check). The scatter tier runs the shader once per store (an invocation that stores a 20-word vertex
  runs 20 times), so it costs more GPU time than one compute dispatch; M7 measures it. Out-of-bounds reads clamp into
  the resource, as WGSL allows.
- **Sizes (gzip, the sizes gate's method, which counts the lazy chunks).** The root with `install()` loads 91,068 B
  (68,530 B before): `/device` 90,901 B, `/glsl` 42,394 B (the size uniforms of bug 52), `/compute` 41,489 B, `/wgsl`
  26,528 B. A render-only page downloads what it did before plus the bug fixes: the compute chunks (about 22 KB) load
  only with the first compute pipeline. Over the 60,000 B target by 31,068 B; nothing was cut. Browsers with WebGPU
  download none of it, and core + stage are unchanged at 21,974 B.

## Compressed textures (M3, second part, 2026-10-28)

- **Formats and features.** The BC, ETC2/EAC and ASTC formats of WebGPU map onto `WEBGL_compressed_texture_s3tc` and
  `_s3tc_srgb`, `EXT_texture_compression_rgtc`, `EXT_texture_compression_bptc`, `WEBGL_compressed_texture_etc` and
  `WEBGL_compressed_texture_astc`. The adapter reports `texture-compression-bc` only when all four BC extensions are
  there, and `-etc2` and `-astc` when theirs is; a compressed texture needs its feature on the device (TypeError
  otherwise, as in WebGPU) and a 2D size in whole blocks. On this PC ANGLE Direct3D 11 reports BC only (no ETC2, no
  ASTC); ANGLE OpenGL reports ETC2 as well.
- **Writes.** `writeTexture` and `copyBufferToTexture` upload whole blocks with `compressedTexSubImage2D/3D` (a mip
  level smaller than a block takes the level's own size). Sampling and `textureLoad` decode as on WebGPU: the features
  check compares BC1 (two mip levels) and BC4 blocks with native WebGPU, bit for bit.
- **Accepted differences.** WebGL2 cannot read compressed texels back or attach them: `copyTextureToBuffer`,
  `copyTextureToTexture` and sRGB views of a compressed texture (which the layer would copy) are refused with
  MargoError code `unsupported`.

## Per-target blend states without OES_draw_buffers_indexed (M3, second part, 2026-10-28)

- WebGL2 alone has one blend state and one colour write mask for all draw buffers; `OES_draw_buffers_indexed` sets
  them per target, and ANGLE's OpenGL back end lacks it on some GPUs (the AMD one here). A pipeline whose colour
  targets differ in blend state or write mask now draws once per group of targets with the same state, with only that
  group's draw buffers on (before, target 0's state applied to all of them). The features check runs such a pipeline
  (one target blended additively, one written in red only) on a device whose context hides the extension and compares
  it with native WebGPU.
- **Accepted difference.** Such a pipeline with depth writes or stencil writes is refused with MargoError code
  `unsupported`: the draws after the first would test against the depth and stencil the first one wrote. Weighted
  blended OIT, the known case, writes no depth in its accumulation pass.

## Package routes (M6, 2026-10-29)

Measured on this PC (NVIDIA RTX A6000, Edge 156 with ANGLE Direct3D 11 for WebGL2, Dawn for WebGPU); frame times are
wall time per frame, native then the layer.

- **How a package finds the layer.** `compatTier(device)` and `loadCompatRoute(device, load)` in `packages/shared`
  (`compat.js`): the layer's devices report the adapter vendor `margo-webgl2`. A package with a route starts its
  `import('./compat.js')` in `setup` only there, so pages with WebGPU never download the route, and keeps its WebGPU
  route until the chunk has loaded: the layer runs that route too (on its generic tiers, slowly), so no frame is drawn
  differently and no package needs an asynchronous setup. Core never imports the helper (core + stage unchanged at
  21,974 B gzip); the WGSL of every WebGPU route is byte-identical (checked against the previous commit).
- **DOF.** Its CoC and bokeh kernels share 8x8 tile maxima through workgroup memory, which put them on the CPU tier:
  913 ms a frame at 1280 x 720 (0.72 ms natively). The route computes the CoC per pixel, the tile maxima in a pass of
  its own (one invocation per tile, the same 64 values) and the near-field reach per pixel from its neighbouring tiles;
  all four kernels store only their own texel and run as fragment draws: 10.1 ms. Max is exact and order-free, so the
  output equals the WebGPU route's.
- **Splats.** The 8-pass radix sort (32 dispatches with workgroup histograms and scans) took 44 ms for 10,000 splats and
  308 ms for 100,000. The route sorts the projected keys in one CPU dispatch (an LSD radix sort with 8-bit digits, 4
  passes, stable on the whole 32-bit key, so the same order); the projection stays on the GPU: 17.9 and 39 ms (1.2 and
  2.1 natively), with one readback of the keys a frame (a counted stall). The plan's worker sort with a frame of lag
  is not needed for the same image.
- **Culling.** `CulledInstances` (cull, scan and compaction kernels with workgroup scans, and the Hi-Z pyramid) took
  11.7 ms for 10,000 parts (0.98 natively). The route runs the kernels' frustum test in double precision on the CPU
  from the transforms the plugin keeps and uploads the kept records and the indirect arguments: 1.14 ms, no compute,
  no stall. `CulledMeshes` does the same from core's batch records. A padded bounding sphere is conservative, so the
  image is the same.
- **Generic tiers as the route (until 2026-11-05, see VFX, scatter and sky below).** VFX and creative particles (a VFX preset) and scatter use atomics; the plan's
  route for them was simulation and placement on the CPU, which is what the CPU tier does with their own kernels. Their checks pass on the layer (`--compat`). Budgets: VFX 6.5 ms for 5,000 particles and
  48 ms for 50,000 (0.61 and 0.67 natively); scatter 5.4 ms for 10,000 instances and 40 ms for 100,000 (0.56 and 0.85).
- **VFX, scatter and sky (2026-11-05).** The gameplay sandbox spent 3,748 ms of main-thread work a frame on the layer
  against 0.6 natively. VFX and scatter handed out slots with atomics and workgroup scans; their routes
  (`vfx/src/compat.ts`, `scatter/src/compat.ts`, with `shared/prefix.js`, an exact prefix count from own-index stores)
  run the same tests as point draws and draw every slot, the vertex stage dropping those past the count, since an indirect draw would
  read its arguments back. That left 56.6 ms, nearly all one `readPixels`: the sky's spherical-harmonics kernel, on the
  CPU tier for its workgroup memory, read the light map every frame and so waited for the frame's GPU work. Its route
  (`sky/src/compat.ts`) is nine point-draw invocations adding the same terms in the same order: 2.9 ms. The VFX and sky
  routes equal the WebGPU kernels word for word on the CPU runner (`routes.test.js`); the sandbox's pixels against native
  did not change (d > 2 on 1.15% of pixels, 1.16% before). `ScatterTiles` keeps the generic tiers.
- **Refusals.** The voxel path tracer (out of scope: ANGLE's Direct3D compiler takes 20 s to minutes per kernel) and XR
  (WebXR on WebGL2 needs `XRWebGLLayer`) refuse the layer with MargoError code `unsupported` naming what they need;
  each message has a unit test.
- **Checks.** `routes-browser.mjs` (in `npm run test:gpu`) draws DOF, splats, `CulledInstances` and `CulledMeshes`
  natively and on the layer in exact-pixel mode once a frame's dispatches are the route's own: no pixel differs.
  `routes.test.js` checks each route's tiers and computes the sort and the culling against the kernels' results. The
  VFX and scatter LOD checks run with `--compat` in `npm run test:gpu`.
- **Bugs found and fixed, each with a regression test.** (62) `destroy()` lost the context while the page canvas showed an
  ImageBitmap of it, and Chrome 157 on macOS crashed the tab at its next commit; the canvas now takes its own copy first
  (`destroy-frame-browser.mjs`).
  (61) A buffer or texture destroyed right after the submit that used
  it lost its GL object before that work ran when the queue was waiting for the compute part to load (an incomplete
  framebuffer at DOF's first frames); WebGPU frees a resource only after the work submitted before. `destroy()` now
  waits behind the queue's backlog (compute check, `destroyAfterSubmit`).
  (58) On an AMD Radeon 680M (ANGLE Direct3D 11) the post-effects suite on the layer timed out filling the DOF example's
  focus slider: DOF's kernels ran on the CPU tier, 2.4 s a frame at 1100 x 660 even on this PC (the fill took 14 s
  here, over 30 s on the slower CPU), so the page never answered. The DOF route takes it to 11 ms a frame (the fill
  15 ms); the suite now asserts on the layer that the example's frames dispatch nothing on the CPU tier.
- **Accepted differences.** `'occlusion'` culling culls against the frustum only on the layer (the Hi-Z pyramid would
  be a GPU readback every frame): the same image with more parts drawn. `CulledMeshes`' `minRadius` threshold is
  tested in double precision, so a part exactly at the threshold may be kept on one path and dropped on the other.

## Cube sampling on the CPU tier (2026-10-29)

- CPU-tier kernels now sample cube textures with `textureSampleLevel` and query `textureDimensions` and
  `textureNumLevels` on them. The face and face coordinates come from the major axis by WGSL's face table; linear
  filtering is seamless as on WebGPU: a texel of the bilinear footprint past a face edge is read from the neighbouring
  face its centre's direction falls on, and at a corner the three texels that meet there are averaged. Cube arrays
  stay refused (WebGL2 has none), as does a cube in any other built-in on the CPU.
- This clears the corpus's last refusals: the light probes' bake kernels (a cube map sampled in kernels with
  workgroup memory). All 397 recorded compute pipelines that are in scope now dispatch (34 fragment, 278 scatter, 85
  CPU), none refused.
- The compute check's `cpuCube` case samples an 8 x 8 cube with two levels along 134 directions (face centres, random
  ones, both sides of every edge, near every corner) at levels 0, 0.4 and 1, natively and on the CPU tier: within the
  4/255 the check allows CPU texture filtering (exact weights against the GPU's 8-bit fixed-point ones).

## Performance (M7, 2026-10-29)

Measured on this PC (NVIDIA RTX A6000) with the GPU held exclusively, `perf-browser.mjs` (960 x 540 canvas, 4x MSAA,
frames rendered with a task between them, median of 5 rounds of 30): wall time per frame, native WebGPU (Dawn) where
the browser offers it, the layer, and for the basic scene the milestone M2 layer built from bd1fcd0a. With
`--use-angle=gl`, `vulkan` or `swiftshader` Chrome's WebGPU has no adapter, so only the layer runs there.

| Browser and back end | Basic: native, layer, M2 layer | DOF | Splats (20,000) | CulledInstances (10,000) |
| --- | --- | --- | --- | --- |
| Edge, ANGLE Direct3D 11 | 0.29, 0.20, 0.18 ms | 0.35, 2.95 ms | 0.48, 3.26 ms | 0.41, 1.20 ms |
| Chrome, ANGLE Direct3D 11 | 0.22, 0.18, 0.21 ms | 0.34, 2.41 ms | 0.52, 3.71 ms | 0.35, 1.13 ms |
| Chrome, ANGLE OpenGL | -, 0.96, 0.90 ms | 6.76 ms | 37.97 ms | 4.12 ms |
| Chrome, ANGLE Vulkan | -, 0.23, 0.18 ms | 0.39 ms | 3.29 ms | 1.06 ms |
| Chrome, SwiftShader (CPU) | -, 8.81, 9.07 ms | 85.4 ms | 189 ms | 79.7 ms |

- **Against the M2 baseline.** The basic scene draws within noise of the M2 layer on every back end (the GLSL of its
  programs is byte-identical). Frames rendered back to back in one task first showed the current layer slower (0.24
  against 0.17 ms on Edge, 8.8 against 3.7 ms on SwiftShader): the M2 layer showed a frame in a microtask after the
  submit (bug 53), so such a run presented one frame in thirty; the page now yields a task between frames, as
  animation frames do. Against native WebGPU the layer stays within the 1.5x target on the Direct3D 11 and Vulkan
  back ends for the basic scene.
- **State cache.** 70% to 76% of the state changes the layer asks for are already in place and cost no GL call (43
  requests a frame for the basic scene, 275 with DOF); `device.state.counts` holds the numbers.
- **Programs.** Translating WGSL to GLSL takes 2 to 6 ms for a scene's programs; handing them to WebGL2 until the link
  status is known takes 31 to 34 ms for the basic scene on Direct3D 11 (ANGLE compiles there), 11 ms on OpenGL and
  under 1 ms on Vulkan and SwiftShader (their compile happens at the first draw or in the background).
  `device.programs` holds the counts and times.
- **Stalls.** None in steady frames except the splats route's one key readback a frame. DOF alone now shows the
  captured scene sharp (no CoC or blur pass) until its route has loaded, instead of a first frame on the CPU tier: its
  start-up (Engine.create to the first finished frame) went from 1,148 to 71 ms on Edge, and its 7 start-up stalls to
  none. Effects that read its `outputTexture` (Tonemap's `source`) get that sharp scene meanwhile (the unit test
  and the post-effects suite on the layer check it).
- **Scatter tier.** 65,536 invocations storing 1, 2, 4, 8 and 16 words take 0.51, 0.52, 0.76, 1.10 and 1.94 ms a
  dispatch on the layer (0.19 to 0.26 natively): about 0.09 ms more per stored word, since every word is a point
  draw of its own. Transform feedback would write all of an invocation's words at its own index in one vertex
  pass (up to 64 interleaved components); it is not built, and parked on 2026-10-31 as a speed-only item (those stores already run on the scatter tier with the
  same pixels; no package's kernel spends more than a few milliseconds a frame there, splat projection, 14 words, is
  the largest), together with the sandbox's CPU-tier speed.
- **Integrated GPUs.** The bug 58 frame (8.4 s a frame on an AMD Radeon 680M) came from the CPU tier, not the GPU. A
  per-frame time budget check for every compat demo on an integrated GPU belongs to M8, which runs every demo on the
  layer.

## Hardening (M7, 2026-10-29)

- **CPU-tier work budget (bug 65).** Generated kernels ran with no limit, so an endless loop or a huge dispatch held
  the tab. Each CPU-tier dispatch now has a budget of invocations plus loop iterations (`cpuWorkBudget`, an
  `install()` option and a device property, default 100,000,000, about one to three seconds of JavaScript here):
  every invocation and every loop iteration takes one, and a dispatch that runs out stops, stores nothing (its
  copies are not written back) and is reported as a `GPUInternalError` with MargoError code `failed` naming the fix,
  as a GPU resets a dispatch that runs too long. The compute check runs an endless loop and a 64,000-invocation
  dispatch against a budget of 20,000, and the same dispatch after raising it.
- **`unsafe-eval`.** Only the CPU tier compiles code at run time (`new Function`); rendering and the fragment and
  point-draw tiers do not. Under a Content-Security-Policy without `unsafe-eval` the CPU-tier kernels are refused
  with MargoError code `unsupported`. On the layer that means the splats route's sort and the generic routes of VFX,
  scatter, clustered binning and other atomics or workgroup kernels. An interpreter of the IR
  would remove the need at a large speed cost; it is listed for after M8.
- **Adapter-independent checks (bug 66).** The features check compared compat with native exactly but also held
  three sanity bytes an Intel Arc 140V rounds one level differently (both natively and on the layer); those now
  allow two levels, and the exact comparison with native on the same adapter stays.

## Demos, docs and release (M8, 2026-10-29)

Measured on this PC (NVIDIA RTX A6000, Edge 156 with ANGLE Direct3D 11 for WebGL2, Dawn for WebGPU).

- **Site demos load the layer.** The demo pages' gate ([examples/needs-webgpu.js](../examples/needs-webgpu.js))
  imports `@margoengine/webgl2-compat` only when WebGPU is missing, installs it and runs the demo on it; a part that
  refuses the layer shows the refusal with its code. `check:no-webgpu` asserts that a browser with WebGPU downloads
  none of the layer on every page (the dual viewport page excepted, it draws both ways), that without WebGPU each demo
  installs it with no uncaught error, and that without WebGL2 as well the old message shows.
- **Every demo compared** (`npm run visual:compat`, in `check:merge`; table in
  [webgl2-compat-demos.md](webgl2-compat-demos.md)): 59 demos, 27 site demos and 32 Khronos gallery models. All 32
  models and 20 site demos draw the same pixels as native WebGPU by the parity rule (decision 4); 7 site demos run
  with differences the table states (0.20% to 1.24% of pixels with d > 2, one cause, in the last item of this list).
  Main-thread work per still frame on the layer: 0.4 to 9.2 ms for every demo with a recorded frame except khronos-NodePerformanceTest
  (55.6 ms, native 36.9 ms; native 0.3 to 1.1 ms for the others).
- **Exact still frames.** 56 of the 59 demos capture the same pixels twice natively, and the check fails when one of
  them stops doing so, so native noise cannot flip a status. ui-game, weather and animator still moved with real time
  under reduced motion (their status flipped between runs); they now hold still and draw the same pixels on the layer.
  Sciviz points differed only in its status line, which states how long the plot took; the check paints it over,
  and sciviz points now draws the same pixels on the layer. Three still show
  native noise in the table, none with a pixel at d > 2: gameplay sandbox (its VFX particles' draw order, fixed
  since by `33c403984`; the table's cell changes at its next recording) and two Khronos models (ToyCar,
  IridescenceLamp).
- **Compute lab and sciviz surface (two bugs found by the run, both fixed).** Sciviz surface did not start on the layer
  ("Uniform p.time is missing"): a browser without a WebGPU adapter may still define the native `GPUBuffer` interface,
  the layer's buffers failed `instanceof GPUBuffer`, and the compute package encoded its own uniform buffer as the
  uniform's value. `install()` now names the layer's classes as the WebGPU interfaces while installed (restored by
  `uninstall()`). The compute lab drew a scrambled CDF: the radix sort's local pass needs workgroup memory, so the
  layer ran it on its CPU tier at about 40 loop steps per key, and at 4,194,304 samples it passed the 100 million step
  work budget; the layer dropped the pass and its internal error reached no scope. The compute package now takes a
  sort route on the layer (`packages/compute/src/compat.ts`, loaded only there: one invocation, an LSD radix sort with
  8-bit digits, the same stable order by the same low bits, about 9 steps per key), its waits reject on internal
  errors, and the layer shows an uncaptured error nobody prevented in the console, as browsers do. The work budget is
  unchanged. Both demos now draw the same pixels as native (regression tests: `packages/compute/tests/layer-route.test.js`,
  `packages/webgl2-compat/test/device.test.js`).
- **Shadows route (bug found by the run).** Soft shadows reduce each map layer to its nearest depth with workgroup
  memory and atomics, so the layer ran it on the CPU tier, reading the whole 2048 x 2048 map back every frame with a
  dynamic caster: 480 ms a frame for batched mesh and clipping planes, 168 ms for character animation. The route
  (`packages/shadows/src/compat.ts`, loaded only on the layer) computes the same minimum with two fragment-tier block
  passes and one point-draw word per layer: those demos now take 0.4 to 1.3 ms, and `routes-browser.mjs` finds no
  pixel different from native (regression tests: `routes.test.js` tiers, the route case in `routes-browser.mjs`, and
  the frame budget of `visual:compat:budget`).
- **Frame budget.** `visual:compat:budget` (a check:merge step of its own that holds the GPU exclusively, in chunks
  of 8 demos) fails a demo whose median frame on the layer costs more than 50 ms of main-thread work and more than
  twice its native frame (`--budget=<ms>`). It was part of `visual:compat`, in a shared GPU slot, until a landing
  failed on khronos-NodePerformanceTest at 86 ms beside other GPU suites (2026-10-30). The run on an integrated GPU
  (AMD Radeon 680M) is still to be recorded. On the RTX A6000 gameplay-sandbox passes at 2.9 ms of main-thread work a
  frame on the layer (3,748 ms before its routes); the frame interval there is 66.6 ms, GPU time, which this budget does not cover.
- **Dual viewport** ([examples/dual-viewport.html](../examples/dual-viewport.html), the launch showcase item): one
  scene with PBR materials and soft shadows, native WebGPU on the left and the layer on the right, with the live pixel
  difference and both frame times. In exact-pixel mode and with 4x MSAA on this PC no pixel of the 274,176 differs by more than one level.
- **Docs.** [webgpu.html](../site/webgpu.html) explains the compatibility mode to visitors (what loads and when, the
  download, what it refuses, the `unsafe-eval` note for the CPU tier); [limits.md](limits.md) and the error page's
  `compatibility-layer` entry name the site behaviour and the refusals.
- **Two mip ranges of one texture in one draw (bug, fixed 2026-10-30).** GL keeps one base and max level per texture
  object, and the layer set them per binding, so a draw that sampled two views of one texture with different levels
  read both at the level of the one bound last. Bloom's last up step reads two levels of its down chain, so every
  Bloom glow on the layer was wrong at its widest level (the voxel night view's sky glow: d > 2 on 1.45% of pixels,
  now 0.22%). Such a binding now reads a copy of its own, brought up to date only when its levels changed; the compute
  check's `fragmentMipViews` case fails without the fix.
- **Causes of the demos that run with differences, all found.** The seven (DOF, gameplay sandbox, Night Citadel and the
  four voxel views) read the scene's resolved depth, which keeps each pixel's nearest of 4 samples natively and one
  sample on WebGL2: the accepted per-sample MSAA difference ([webgl2-compat-demos.md](webgl2-compat-demos.md#accepted-difference-per-sample-reads-of-multisampled-textures)).
  Sciviz points (its status line, which states the plot time, now masked) differs by 16 pixels, within the parity
  rule: of the 2,000,000 positions sampled on the GPU, 5% of the x coordinates differ by one unit in the last place
  (0.1% of the normal samples already do; the two paths round their float arithmetic differently), and one point
  lands on the next pixel.
- **Size in M8.** The size (measured in two numbers since 2026-10-30, `splits` in `entry-sizes.json`: the base
  that `install()` loads is 72,500 B gzip, the lazy compute runtime another 22,094 B; the joined root record, 94,046 B,
  counted both, and the sizes gate now holds each). **Accepted difference (Scott, 2026-10-30):** the base limit is
  73,000 B, not the 60,000 B target, which no gate ever enforced. The base carries the full WGSL to GLSL translator and
  the WGSL checker, both needed on the first frame; native WebGPU always validates shaders, so a build without the
  checker would behave differently from it. The lazy compute runtime is measured and gated on its own.
- **Left from M8.** The integrated-GPU budget run. The transform-feedback tier for own-index stores is parked (speed
  only, see the scatter tier above); nothing is built for it.
