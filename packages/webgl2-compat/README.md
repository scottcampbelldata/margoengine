# @margoengine/webgl2-compat

Import `margoengine/webgl2-compat` from the `margoengine` package, or `@margoengine/webgl2-compat` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

**Status: in development, milestones M0 to M7 of the [roadmap](../../docs/webgl2-compat-roadmap.md) done, M8 (every site demo, docs, release) under way.** Every live demo on margoengine.com loads this layer when the browser has no WebGPU; [webgl2-compat-demos.md](../../docs/webgl2-compat-demos.md) lists how each one compares with native WebGPU. This package
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
context, and defines `GPUBufferUsage` and the other flag objects where the browser lacks them. Where the browser's own
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
  `mapAsync` with fenced readbacks, error scopes, `uncapturederror` and `device.lost`. Texture views GL has no view
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
  corner the three texels that meet there are averaged), cannot read multisampled or external textures, and needs a
  page that allows JavaScript
  compiled at run time (Content-Security-Policy `unsafe-eval`); either refusal is MargoError code `unsupported`.
  A CPU-tier dispatch may do at most `cpuWorkBudget` invocations plus loop iterations (an `install()` option and a
  device property; default 100,000,000, about one to three seconds): past it the dispatch stops, nothing it stored
  lands, and it is reported as a `GPUInternalError` with MargoError code `failed`, so an endless loop cannot hold the
  page. Only the CPU tier needs `unsafe-eval`; rendering and the fragment and point-draw tiers do not.
  `planCompute(stage)` tells which tier an entry point gets and why; `runComputeOnCPU(dispatch)` runs one on the CPU
  with buffers, without a device. `device.dispatches` counts the dispatches each tier has run, `device.programs` the
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
  against the frustum only there). Each draws the same pixels as on native WebGPU. VFX, creative particles and
  scatter run their WebGPU kernels on the CPU tier, the plan's route for them. The voxel path tracer and XR refuse the layer with MargoError code `unsupported`.
- **WGSL front end** (`margoengine/webgl2-compat/wgsl`, milestone M1): `checkWGSL(source)` and `parseWGSL(source)`.
- `webgl2Capabilities(gl)` and `probeWebGL2()`: what a browser's WebGL2 offers and the tier it reaches. The layer
  renders only on the `full` tier: renderable float colour targets (`EXT_color_buffer_float`) and `highp` in fragment
  shaders.
- In the repository, not in the package: the WGSL corpus, every shader module the packages create in their real-GPU
  checks (`npm run record:wgsl-corpus`), which the translator is tested against.

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
  recorded compute pipelines are translated for their tier and dispatched once, none refused (the voxel path tracer's 20, out of
  scope on WebGL2, are only planned).

Nothing runs at import time, the package has no dependencies, and core, the stage and every other package never
import it (a test in this package checks that), so the WebGPU path is byte-identical with or without it.

Apache-2.0. Optional, tree-shakable package.

Build and unit tests: npm test --workspace @margoengine/webgl2-compat
