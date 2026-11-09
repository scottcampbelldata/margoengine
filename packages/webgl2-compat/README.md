# @margoengine/webgl2-compat


This is the single WebGL2 package. Use the root `install()` entry to run the real
renderer without WebGPU. The optional `/preview`, `/pick`, `/restore` and `/auto`
entries preserve the smaller preview for lower-tier WebGL2. The former webgl
workspace and its umbrella aliases were removed before release; use the entries
and examples below.

Import `margoengine/webgl2-compat` from the `margoengine` package, or `@margoengine/webgl2-compat` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

**Status: milestones M0 to M8 of the [roadmap](../../docs/webgl2-compat-roadmap.md) done.** This layer is the site's fallback: every live demo on margoengine.com loads it when the browser has no WebGPU. Of the 27 site demos, 20 draw the same pixels as native WebGPU and 7 run with one accepted difference (WebGL2 cannot read one sample of a multisampled texture); all 32 Khronos gallery models draw the same pixels ([webgl2-compat-demos.md](../../docs/webgl2-compat-demos.md) lists each one). The voxel path tracer refuses the layer (MargoError `unsupported`); XR runs on it through the [`/xr` entry](#xr-margoenginewebgl2-compatxr). Not done: the frame-budget run on an integrated GPU is not recorded yet, and a transform-feedback tier for own-index compute stores is parked (speed only, those stores already run on the scatter tier with the same pixels). The small preview is now the optional `/preview` entry of this package. This package
is the WebGL2 compatibility layer for browsers without WebGPU: a WebGPU-shaped device built on WebGL2 that translates
every WGSL shader to GLSL ES 3.00, so core and the packages run their usual WebGPU code unchanged. Today core renders
on it (meshes, instancing, 4x MSAA and exact-pixel mode, several views, picking and device loss) with the same pixels
as native WebGPU on the same GPU, and so do the render checks of materials (its compute scenarios included), glTF
PBR, lines, points, text, lod and the skinned shadow check. Render shaders read storage buffers, and compute pipelines
run (milestone M5): as fragment draws, as point draws, or on the CPU, whichever the shader allows (see Compute below).
Packages whose WebGPU route would be slow there take a route of their own (milestone M6, see Package routes below).
Render shaders that write storage buffers or textures are refused with MargoError code `unsupported`: WebGL2 render
shaders cannot write them.

Load it only where WebGPU is missing, with a dynamic import, so browsers with WebGPU never download it:

```ts
import { Engine } from 'margoengine/core';

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const webgpu = 'gpu' in navigator && (await navigator.gpu.requestAdapter()) !== null;
if (!webgpu) await (await import('margoengine/webgl2-compat')).install();
const engine = await Engine.create(canvas);
engine.render();
```

`install()` makes `navigator.gpu` a WebGPU-shaped GPU on WebGL2, makes `canvas.getContext('webgpu')` return its canvas
context, defines `GPUBufferUsage` and the other flag objects where the browser lacks them, and names its classes as
the WebGPU interfaces (`GPUBuffer`, `GPUDevice` and the rest) while installed, so `instanceof GPUBuffer` holds for its
objects, also in a browser that defines those interfaces without an adapter. Where the browser's own
WebGPU has an adapter it does nothing (it resolves `{ installed: false, reason: 'webgpu' }`) unless you pass
`{ force: true }`, which the layer's tests use to compare both paths on one machine. It rejects with MargoError code
`unsupported` on a browser whose WebGL2 is below the full tier, naming what is missing. `uninstall()` puts everything
back. The root entry holds only the probe below and `install()`: the device, the GLSL back end and the WGSL front end
load inside `install()`.

What it does:

- **Device** (`margoengine/webgl2-compat/device`): `createCompatGPU()` gives the same GPU without installing it;
  `isCompatDevice(device)` tells a package it runs on WebGL2. Each device owns one WebGL2 context made with
  `antialias: false`, so exact-pixel rendering stays exact; it multisamples itself when a pipeline asks for 4
  samples. Buffers, textures (2D, 2D array, 3D, cube, 4x multisampled, depth and stencil formats), samplers, bind
  groups, render pipelines (async creation waits for `KHR_parallel_shader_compile`), render passes with clears,
  resolves and discards, indirect draws, copies, `writeBuffer`, `writeTexture`, `copyExternalImageToTexture`,
  `mapAsync` with fenced readbacks, error scopes, `uncapturederror` and `device.lost`. `device.destroy()` frees the
  context and, as in WebGPU, leaves the last frame on the canvas (one copy into a 2D context of the page). Texture views GL has no view
  for (an sRGB view of a unorm texture, a 2D view of an array layer, a cube view of 6 array layers, an array view of a
  cube) read a copy that is brought up to date before each use; a square 6-layer texture is a cube map. Compressed
  BC, ETC2 and ASTC textures are written with `writeTexture` where the browser's WebGL2 has their extensions (the
  adapter reports only those features); WebGL2 cannot read them back. Readbacks cover every other copyable format,
  depth, stencil, packed and snorm included; occlusion queries, render bundles and
  external textures (each video frame is copied: WebGL2 has no zero-copy video) work. The adapter reports
  `info.vendor === 'margo-webgl2'`. Clip space keeps WebGPU's z range through `EXT_clip_control`, and rendering is
  flipped in y so every texture keeps WebGPU's top-left origin; the canvas present flips it back.
- **GLSL back end** (`margoengine/webgl2-compat/glsl`): `translateWGSL({ vertex, fragment })` turns a render
  pipeline's WGSL stages into GLSL ES 3.00 and the table the device binds resources by; `translateStage` translates one
  entry point alone. Uniform buffers are read in WGSL's own memory layout (exact for every struct, `@size`, `@align`
  and matCx2), and integer division, remainder, shifts, float to integer conversion and out-of-bounds indexes follow
  WGSL rather than GLSL's undefined cases. Storage buffers read in vertex and fragment shaders (WebGL2 has none) are
  read from an RGBA32UI data texture, one 16-byte row per texel, in WGSL's layout; reads are clamped into the binding
  and `arrayLength` comes from its size. The device mirrors each buffer into its data texture on the GPU when the
  contents change, and the storage bindings of a bind group share one texture, so a pipeline spends one texture unit
  per group on them. `textureGather` and `textureGatherCompare`, which GLSL ES 3.00 lacks, fetch
  the four texels by hand with the sampler's address modes (2D and 2D-array textures; a cube gather is refused).
- **Compute** (`margoengine/webgl2-compat/compute`, milestone M5): compute pipelines and passes, with
  `dispatchWorkgroups` and `dispatchWorkgroupsIndirect`. The device loads this entry by itself the first time a page
  creates a compute pipeline, so a render-only page never downloads it; command buffers with compute passes wait in
  the queue until it has loaded (later writes wait behind them, in order). Each entry point runs on the fastest of
  three tiers its shader allows:
  - **fragment**: every texel store writes the invocation's own texel (the global invocation id as coordinates) and
    no buffer is written: one full-target draw per written texture and z slice.
  - **scatter**: a bounded number of stores anywhere (buffer words, texels at any coordinates), never read back by the
    invocation that made them: one instanced point draw per buffer or texture written, instance k of an invocation
    drawing its k-th store. Buffers are drawn as an R32UI texture of their words and copied back on the GPU.
  - **cpu**: atomics, workgroup memory, barriers or stores in loops of unknown length: the shader as JavaScript, one
    invocation at a time (each runs to the next barrier before any goes on), f32 arithmetic rounded as an f32 GPU
    rounds it, on copies of the bound buffers and textures (GPU-written ones are read back, a stall the device counts
    in `stalls`).

  Reads see memory as it was before the dispatch, as WGSL allows for invocations that never read back their own
  stores. The CPU tier samples cube textures at a level as WebGPU does (seamless filtering across face edges; at a
  corner the three texels that meet there are averaged) and cannot read multisampled or external textures, a refusal
  with MargoError code `unsupported`. On a page that allows JavaScript compiled at run time (Content-Security-Policy
  `unsafe-eval`) the CPU tier compiles each kernel with `new Function`; under a strict policy it runs the same kernel
  on an interpreter, a lazy chunk only such a page downloads, with the same results, about 13 to 41 times slower.
  A NaN the CPU tier stores, bitcasts or packs is written as the quiet NaN 0x7fc00000 (f16 0x7e00), so the bytes are
  the same on both paths and every browser; WGSL lets a runtime NaN be any value, so its sign and payload are not kept.
  A CPU-tier dispatch may do at most `cpuWorkBudget` invocations plus loop iterations (an `install()` option and a
  device property; default 100,000,000, about one to three seconds): past it the dispatch stops, nothing it stored
  lands, and it is reported as a `GPUInternalError` with MargoError code `failed`, so an endless loop cannot hold the
  page. Rendering and the fragment and point-draw tiers never compile JavaScript, and the CPU tier only runs faster
  with `unsafe-eval`. The one refused `new Function` that finds this out is the only violation such a page sees.
  Reading a texture back is a lazy chunk as well: the first `copyTextureToBuffer` loads it, and the queue stays in order
  while it does, so a page that never reads back never downloads it.
  `planCompute(stage)` tells which tier an entry point gets and why; `runComputeOnCPU(dispatch)` runs one on the CPU
  with buffers, without a device (`workBudget` stops it past that many invocations plus loop iterations; default no
  limit; on a page without `unsafe-eval`, `await loadInterpreter()` once first). `device.dispatches` counts the dispatches each tier has run, `device.programs` the
  render programs made with their translation and link time, and `device.state.counts` the state changes asked for
  and those the cache answered without a GL call (milestone M7 measures them on each ANGLE back end with
  `test/perf-browser.mjs`).
- **Package routes** (milestone M6): a package asks whether its device is the layer's (the adapter vendor
  `margo-webgl2`, never browser sniffing) and then loads a route of its own with `import()`, so pages with WebGPU never
  download it; until it has loaded the package keeps its WebGPU route, which the layer also runs, so no frame is drawn
  differently. DOF computes its 8x8 tile maxima without workgroup memory (all four of its kernels become fragment
  draws: 10 ms instead of 0.9 s a frame at 720p); splats sort their depth keys in one CPU dispatch (18 ms instead of
  44 ms for 10,000 splats; one readback of the keys a frame); `CulledInstances` and `CulledMeshes` cull against the
  frustum on the CPU and upload what they keep (1.1 ms instead of 11.7 ms for 10,000 parts; `'occlusion'` culls
  against the frustum only there). Each draws the same pixels as on native WebGPU. VFX, with its creative particles preset, and
  `Scatter` run their kernels as point draws on the GPU (`compat.ts` in each package). `ScatterTiles` runs its WebGPU
  kernels on the CPU tier. The voxel path tracer runs its `trace` kernel as a fragment shader with four float targets and the rest on the tiers above; ANGLE's Direct3D backend does not finish compiling it, so that page keeps the raster image (its [README](../voxel-pathtracer/README.md#on-the-webgl2-compatibility-layer)).
- **WGSL front end** (`margoengine/webgl2-compat/wgsl`, milestone M1): `checkWGSL(source)` and `parseWGSL(source)`.
- `webgl2Capabilities(gl)` and `probeWebGL2()`: what a browser's WebGL2 offers and the tier it reaches. The layer
  renders only on the `full` tier: renderable float colour targets (`EXT_color_buffer_float`) and `highp` in fragment
  shaders.
- In the repository, not in the package: the WGSL corpus, every shader module the packages create in their real-GPU
  checks (`npm run record:wgsl-corpus`), which the translator is tested against.
  Additive recordings of an identical source retain all creating packages, labels,
  pages and distinct pipelines; a later package label resolves an initially bundled
  page's owner. Source bytes are still stored once. The corpus regression test checks
  this across a write/read/add cycle.

### Native WebGPU on older GPUs (`margoengine/webgl2-compat/adapter`)

Before falling to WebGL2, a browser can offer WebGPU at compatibility level on OpenGL ES and Direct3D 11 class devices.
Core asks for the full level only, so `allowCompatibilityAdapters()` adds that request. Call it before `Engine.create`:

```ts
import { Engine } from 'margoengine/core';
import { allowCompatibilityAdapters } from 'margoengine/webgl2-compat/adapter';

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
allowCompatibilityAdapters();
const engine = await Engine.create(canvas);
engine.render();
```

`navigator.gpu.requestAdapter` keeps asking for the full level first, so a device that has it never changes; only when
that finds nothing does it ask again with `featureLevel: 'compatibility'`. Device restore goes through the same call and
comes back at the same level. To use the WebGL2 layer below it, call this first and test `requestAdapter` for `null`
before `install()`. A compatibility device takes every limit its adapter has, because core and the packages ask for
none, and its shaders' `@interpolate(flat)` becomes `@interpolate(flat, either)`, which is all the level allows. A depth
texture a shader only loads becomes its float type there, for the same reason.
`{ force: true }` asks for compatibility level first, to try a scene against that validation on any GPU. `dispose()`
(or `using`) puts the browser's method back; a second call before that throws MargoError `state`, and a page with no
`navigator.gpu` gets `unsupported`.

Core, picking, device restore, `@margoengine/materials`, `Shadows`, `CulledInstances` and an HDR `PostStack` run on the
level. `Shadows` draw the same pixels as at the full level; a 4x `PostStack` captures in `rg11b10ufloat`, with less
precision and no alpha, within 2 of 255 on the Bloom and Tonemap test frame. The table is in
[limits.md](../../docs/limits.md), and what does not run yet is in [known-bugs.md](../../docs/known-bugs.md). The check is
`test/adapter-browser.mjs`, in `test:gpu`.

### XR (`margoengine/webgl2-compat/xr`)

`XR` from `margoengine/xr` draws through the browser's `XRGPUBinding`, which needs WebGPU. Headsets and phones without it
still have WebXR on WebGL: `installXR()` gives `XR` a binding of the same shape on an `XRWebGLLayer`, so sessions, input,
hit testing and the stereo drawing run as they do on WebGPU. Call it after `install()` installed the layer, and create
`XR` as usual:

```ts
import { Engine } from 'margoengine/core';
import { XR } from 'margoengine/xr';

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const button = document.querySelector('button') as HTMLButtonElement;
const { installed } = await (await import('margoengine/webgl2-compat')).install();
if (installed) (await import('margoengine/webgl2-compat/xr')).installXR({ framebufferScale: 0.75 });
const engine = await Engine.create(canvas);
const xr = await XR.create(engine);
button.onclick = () => xr.requestSession('immersive-vr');
```

Where `install()` leaves the browser's WebGPU in place, the `installed` test skips this entry and `XR` uses the native
binding. `framebufferScale` is the layer's `framebufferScaleFactor` (default: the browser's own), the first setting to
lower on a weak GPU.

`addXRButton` of `@margoengine/stage/xr` needs none of this: it calls `navigator.gpu.xrRoute()`, which runs `installXR` with
the same options, so a stage on the layer gets its route without importing this package by name.

Each eye renders with 4x multisampling into a texture of its own, as big as its part of the XR framebuffer, and one draw
per eye puts it into the framebuffer at the end of the frame: one extra full-eye copy a frame against the native binding.
The session's `XRWebGLLayer` has no depth buffer, so the compositor gets no depth and cannot reproject by it. The session
asks for no `webgpu` feature, and its `XRView` projections, which have z in [-1, 1] on WebGL, are remapped to the layer's
[0, 1]. `dispose()` (or `using`) puts `XRGPUBinding` back; a second call before that throws MargoError `state`, as does a
call before `install()`, and a browser without WebXR or `XRWebGLLayer` gets `unsupported`. The WebGL context of an XR
device is a page canvas's (`xrCompatible`), not an `OffscreenCanvas`'s.

The check is `test/xr-browser.mjs`, in `test:gpu`: one scene through `XR`, natively and on the layer, with no pixel
different in either eye on an NVIDIA RTX A6000. `navigator.xr` and the browser's XR layers are stand-ins there, over real
devices and framebuffers; no headset has run this route ([limits.md](../../docs/limits.md)).

### GLSL back end (`margoengine/webgl2-compat/glsl`)

```ts
import { translateWGSL } from 'margoengine/webgl2-compat/glsl';

const source = `
@group(0) @binding(0) var<uniform> tint: vec4f;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return tint; }`;

const program = translateWGSL({ vertex: { source }, fragment: { source } });
console.log(program.fragment.source); // #version 300 es ...
for (const u of program.fragment.uniforms) console.log(u.block, u.group, u.binding, u.size); // _Bf0_0 0 0 16
```

Each stage lists the uniform blocks it declares (`uniforms`), its combined samplers (`textures`: one per texture and
sampler pair, plus one per texture read by `textureLoad` or its size queries), vertex `inputs`, `varyings` (matched by
location) and fragment `outputs`. A shader the layer cannot run yet throws MargoError code `unsupported`; WGSL that
does not check throws `WGSLError`.

### Probing WebGL2

```ts
import { probeWebGL2 } from 'margoengine/webgl2-compat';

const caps = probeWebGL2(); // null when the browser has no WebGL2
if (caps?.supported) console.log(`WebGL2 compatibility tier: ${caps.tier}`);
else console.log(`Below the minimum: missing ${caps ? caps.missing.join(', ') : 'WebGL2'}`);
```

`webgl2Capabilities(gl)` reads a context you already have (pass the one you will render with; `antialias: false`
keeps exact-pixel rendering) and enables the extensions it finds, as `getExtension` does. `probeWebGL2({canvas})`
makes a throwaway `antialias: false` context on a new 1 x 1 `OffscreenCanvas` (or the canvas you pass), reads it and
releases it. Both report `tier` (`full`, `half-float` or `ldr`), `supported`, `missing`, `highpFragment`,
`extensions`, `limits` and the renderer string.

`npm run capabilities --workspace @margoengine/webgl2-compat` prints the report for every installed Chromium browser
and ANGLE back end on the machine; the roadmap's tier decision quotes it.

### Compute (`margoengine/webgl2-compat/compute`)

```ts
import { planCompute, runComputeOnCPU } from 'margoengine/webgl2-compat/compute';

const source = `
@group(0) @binding(0) var<storage, read_write> sums: array<atomic<u32>, 4>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  atomicAdd(&sums[id.x % 4u], id.x);
}`;

const plan = planCompute({ source });
console.log(plan.tier, plan.reason); // cpu it uses atomicAdd()

const sums = new Uint32Array(4);
runComputeOnCPU({ source, workgroups: [2], buffers: new Map([['0:0', sums]]) });
console.log([...sums]); // [1984, 2016, 2048, 2080]
```

`planCompute` returns the tier, the workgroup size (overrides applied), what the entry point writes (`targets`, with
how many words or texels one invocation stores) and the reason it is not on a faster tier. `runComputeOnCPU` binds
buffers by `"group:binding"` and changes them in place. Neither is needed to use compute through the device; both are
there for tools and tests.

### WGSL front end (`margoengine/webgl2-compat/wgsl`)

The first part of the translator: a lexer, parser and type checker for WGSL, written from the W3C WGSL specification.
`checkWGSL(source)` resolves every name, checks every type and folds constant expressions, and returns a typed IR with
source positions: structs with their memory layout, globals with address space, access mode, `@group` and
`@binding`, functions, and each entry point with the resources it reaches. `parseWGSL(source)` returns the syntax tree
alone.

```ts
import { checkWGSL, WGSLError } from 'margoengine/webgl2-compat/wgsl';

const source = `
@group(0) @binding(0) var<uniform> tint: vec4f;
@fragment fn main() -> @location(0) vec4f { return tint; }`;

try {
  const module = checkWGSL(source);
  for (const entry of module.entryPoints)
    console.log(entry.stage, entry.name, entry.globals.map((g) => g.name)); // fragment main ['tint']
} catch (error) {
  if (!(error instanceof WGSLError)) throw error;
  console.log(`${error.code} at line ${error.line}, column ${error.column}: ${error.detail}`);
}
```

A fault in the text throws `WGSLError` with `code` (`syntax`, `type` or `limit`), the 1-based `line` and `column` (in
code points) of the token at fault, its `offset`, and a message that ends with a help link. Anything else thrown is a
bug. `WGSL_LIMITS` bounds what hostile input can cost: 4 MiB of source, 255 levels of nesting, 65,536 values in one
constant. The front end checks every module the packages create (the corpus below) and the browser's own pipeline
layouts for them. It does not run WGSL's uniformity analysis yet; every shader in the corpus passes that analysis in the
browsers' own WebGPU compilers, where it was recorded.

### How it is tested

- Core on the layer against native WebGPU, same GPU and browser (`npm run test:gpu`): a lit scene of instanced
  meshes with 4x MSAA and in exact-pixel mode, two views with a partial clear, picking and a destroyed device that core
  restores. The roadmap's measure (at most 0.1% of pixels more than 2 levels apart, mean difference at most 0.25)
  passes with no pixel different on an NVIDIA RTX A6000 under ANGLE Direct3D 11.
- 32 cases of WGSL semantics computed from runtime inputs (integer division by zero, shifts past 31, saturating
  conversions, the bit and pack built-ins, uniform layouts, loops, switch, pointers), bit-identical to native WebGPU.
- The milestone M3 features against native WebGPU in one page (`npm run test:gpu`): sRGB, layer, cube and array
  views; readbacks of depth, stencil, packed and snorm formats; occlusion queries; render bundles; textureGather in
  every address mode and textureGatherCompare; an external texture from a VideoFrame; multisampled targets read with
  textureLoad; storage buffers read in both stages, with arrayLength, a dynamic offset, writeBuffer between submits
  and a GPU copy. Results are bit-identical.
- Package checks in forced-compatibility mode: `--compat` on a check that opens its pages with the repository's
  browser harness runs every page on the layer. The materials check (its compute scenarios included: clustered
  lights, image-based lighting, GPU culling of instances), the glTF PBR shader review, lod, lines, text, the shadows
  lit-faces check (a skinned robot), the voxel render check, the environment check, the post-effects suite, the VFX
  check and scatter's LOD check pass whole, and points on its single-sample path (its 4x eye-dome lighting shades per sample, which WebGL2 cannot).
- XR against native WebGPU (`npm run test:gpu`): both eyes of one scene through `XR`, with stand-ins for the browser's XR objects; no pixel differs.
- The package routes against native WebGPU (`npm run test:gpu`): DOF, splats, `CulledInstances` and `CulledMeshes`
  each draw the same scene natively and on the layer once a frame's dispatches are their route's; no pixel differs.
- The compute check against native WebGPU in one page (`npm run test:gpu`): 13 cases over the three tiers (own-texel
  stores into 2D, array, 3D and mip-level views, a read-write storage texture, struct and word stores at
  data-dependent indexes, atomics with workgroup memory and barriers, texture reads, stores and sampling on the CPU,
  indirect dispatch, overrides, cube sampling on the CPU across seams and corners, queue order around the lazy load,
  and resources destroyed right after the submit
  that uses them while it waits for that load).
- The corpus (`npm run test:browser`): all 1,049 vertex and fragment entry points compile, all 459 distinct stage pairs
  of the recorded render pipelines link, all 624 recorded render pipelines draw once through the device, and 397
  recorded compute pipelines are translated for their tier and dispatched once, none refused (the voxel path tracer's 20 are only planned here,
  because its compile times on ANGLE's Direct3D backend do not fit this check; its own check runs them on Vulkan).

Nothing runs at import time. The package depends on `@margoengine/math` and has `@margoengine/core` as a peer;
install matching local tarballs for all three. Core, the stage and the other packages never load the compatibility
device on the native WebGPU path (a test in this package checks that), so that path is byte-identical with or without it.

Apache-2.0. Optional, tree-shakable package.

Build and unit tests: npm test --workspace @margoengine/webgl2-compat

## Preview, picking, restore and escalation

WebGL2 fallback renderer for browsers without WebGPU. It draws core meshes with core's PBR
material, shaded per pixel (GGX metallic-roughness from each mesh's constant colour and factors, one directional
light plus ambient, no textures or effects);
optional packages that need WebGPU stay unavailable on this path. Picking is the optional `/pick` entry below.

```ts
import {Engine} from 'margoengine/core';
import {webglRenderer} from 'margoengine/webgl2-compat/preview';
const canvas = document.querySelector('canvas')!;

// WebGPU when available, otherwise WebGL2.
const engine = await Engine.create(canvas, {backend: 'auto', fallback: webglRenderer});
```

Without a `fallback`, `backend: 'auto'` requires WebGPU and `Engine.create` rejects with
"WebGPU unavailable"; `backend: 'webgl2'` always uses the fallback. The renderer lives outside
core, so apps that target WebGPU only do not load its 3,443 B min+gzip
([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)).

Without React, load it only when WebGPU is missing (needs no core change; WebGPU users download nothing of
this package, because the dynamic import is a separate chunk that never runs for them):

```ts
import {Engine} from 'margoengine/core';
const canvas = document.querySelector('canvas')!;

const fallback = navigator.gpu ? undefined : (await import('margoengine/webgl2-compat/preview')).webglRenderer;
const engine = await Engine.create(canvas, {fallback});
```

In React, use the Canvas props `loadFallback={() => import('margoengine/webgl2-compat/preview')}` and `fallbackContent`; load
`margoengine/webgl2-compat/pick` there instead when the scene has pointer handlers
(see the [React README](../react/README.md)).

`fallback: canvas => webglRenderer(canvas, {transparent: true})` gives the WebGL2 canvas `alpha: true`
(premultiplied) and a transparent clear: the WebGL side of `TransparentCanvas` from
`@margoengine/environment`, which only acts on WebGPU (core passes nothing to the fallback).

## Picking

`engine.pick` refuses on this renderer unless the app adds `webglPicking` from `margoengine/webgl2-compat/pick`. With it,
`engine.pick(x, y, view?)` answers as it does on WebGPU: CSS pixels, views, layers, nearest surface, and back faces of
single-sided materials do not count. The plugin does nothing on WebGPU or the compatibility layer, where core's pick
already runs, so load it only on the preview:

```ts
import {Engine, box} from 'margoengine/core';
import {webglRenderer} from 'margoengine/webgl2-compat/preview';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgl2', fallback: webglRenderer});
const crate = engine.createMesh().setGeometry(box());
engine.start();

if (engine.backend === 'webgl2') engine.use((await import('margoengine/webgl2-compat/pick')).webglPicking());

canvas.addEventListener('click', async (event) => {
  const mesh = await engine.pick(event.offsetX, event.offsetY);
  console.log(mesh === crate ? 'crate' : 'nothing');
});
```

Each pick refreshes the scene as a frame does (without changing the canvas), draws mesh ids into a 1x1 target and reads
that one pixel with a blocking `readPixels`. The program and target are made by the first pick. A view that draws into a
texture cannot be picked here, because the preview refuses to draw one. `engine.removePlugin('webgl-pick')` gives the
engine back core's answer. Picking covers the core meshes this renderer draws: a plugin's `onPick` hook is not called
on the preview. `Picking` from `margoengine/selection` attaches after this plugin and answers through it, so
`HoverHighlight` works with `onHover`; a hit holds the mesh only, and `pickMany` costs one such pick a point. `/pick` also
exports `webglRenderer`, so a React Canvas gets working pointer handlers from
`loadFallback={() => import('margoengine/webgl2-compat/pick')}`.

## Lost contexts

A browser can take a WebGL context away (a driver reset, too many contexts, a laptop switching GPUs). Without help the
next frame throws `failed`, and `engine.rebootDevice()` refuses. `webglRestore` from `margoengine/webgl2-compat/restore` keeps a
long session alive: frames pass without drawing and new geometry waits, then every program and buffer is made again and
each scene's plugins hear `onDeviceRestored`. Like `webglPicking`, it does nothing on WebGPU or the compatibility layer.

```ts
import {Engine, box} from 'margoengine/core';
import {webglRenderer} from 'margoengine/webgl2-compat/preview';
import {webglRestore} from 'margoengine/webgl2-compat/restore';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {backend: 'webgl2', fallback: webglRenderer});
engine.createMesh().setGeometry(box());
engine.use(webglRestore({timeout: 30_000}));
engine.onError = (error) => console.error(error);
engine.start();

// Rebuilds at once on a live context; on a lost one, resolves when the browser gives it back.
await engine.rebootDevice();
```

`timeout` (default 30000) is how many milliseconds to wait for a lost context. Past it `rebootDevice` rejects with code
`timeout`, and a loss nobody called it for reaches `engine.onError` the same way; a restore after that still recovers. Add
the plugin before the context can be lost: the browser only gives a context back to a page that asked at the moment of
the loss. An engine that draws on demand rather than with `engine.start()` should draw again from `onDeviceRestored`.
`engine.removePlugin('webgl-restore')` gives the engine back core's answers.

## Automatic escalation

The preview draws plain core meshes, and other packages refuse it with code `unsupported`. `autoEngine` from
`margoengine/webgl2-compat/auto` (for React, the `loadCompat` prop of `Canvas`, which goes straight to the layer) picks the path a page's own packages can draw on, so a visitor never gets half a scene: WebGPU
when the browser has it, else this preview, else, when a package refuses the preview, the
compatibility layer in this package. One option turns that last step on: `loadCompat`, the layer's dynamic
import. Each entry is downloaded only if it is used.

```ts
import {box} from 'margoengine/core';
import {Shadows} from 'margoengine/shadows';
import {autoEngine} from 'margoengine/webgl2-compat/auto';

const engine = await autoEngine(
  document.querySelector('canvas')!,
  (engine) => {
    engine.createMesh().setGeometry(box());
    engine.use(new Shadows());
  },
  {loadCompat: () => import('margoengine/webgl2-compat')},
);
engine.canvas.addEventListener('click', () => console.log(engine.backend));
engine.start();
```

`setup` builds the scene and runs twice when the page escalates, so it should start from nothing and use the engine it
is given. The layer cannot draw to a canvas that holds the preview's context, so escalating replaces the element in the
page with a copy: use `engine.canvas` afterwards, as above. The third argument takes every `Engine.create` option except
`fallback`, plus `loadCompat` (default none: the refusal rejects). The app passes the import so that the auto entry does not statically load the
layer and a page that leaves it out never bundles it. Only refusals during `setup` escalate, and any other error rejects with the engine disposed. A browser whose WebGL2 is
below what the layer needs rejects with the layer's `unsupported` error, which names what is missing.

Apache-2.0. Optional, tree-shakable package; core peer: ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/webgl2-compat
