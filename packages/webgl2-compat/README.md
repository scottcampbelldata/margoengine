# @margoengine/webgl2-compat

Import `margoengine/webgl2-compat` from the `margoengine` package, or `@margoengine/webgl2-compat` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

**Status: in development, milestones M0 to M2 of the [roadmap](../../docs/webgl2-compat-roadmap.md).** This package
is the WebGL2 compatibility layer for browsers without WebGPU: a WebGPU-shaped device built on WebGL2 that translates
every WGSL shader to GLSL ES 3.00, so core and the packages run their usual WebGPU code unchanged. Today core renders
on it (meshes, instancing, 4x MSAA and exact-pixel mode, several views, picking and device loss) with the same pixels
as native WebGPU on the same GPU. Shaders that read storage buffers or storage textures, and compute pipelines, are
refused with a coded error naming the milestone that brings them (M4 and M5); until then, apps that need those
features keep them off without WebGPU, or use the [`@margoengine/webgl`](../webgl/README.md) preview.

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
  `mapAsync` with fenced readbacks, error scopes, `uncapturederror` and `device.lost`. The adapter reports
  `info.vendor === 'margo-webgl2'`. Clip space keeps WebGPU's z range through `EXT_clip_control`, and rendering is
  flipped in y so every texture keeps WebGPU's top-left origin; the canvas present flips it back.
- **GLSL back end** (`margoengine/webgl2-compat/glsl`): `translateWGSL({ vertex, fragment })` turns a render
  pipeline's WGSL stages into GLSL ES 3.00 and the table the device binds resources by; `translateStage` translates one
  entry point alone. Uniform buffers are read in WGSL's own memory layout (exact for every struct, `@size`, `@align`
  and matCx2), and integer division, remainder, shifts, float to integer conversion and out-of-bounds indexes follow
  WGSL rather than GLSL's undefined cases.
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
- The corpus (`npm run test:browser`): all 881 vertex and fragment entry points that use no storage resources compile,
  all 257 such distinct stage pairs link, and all 347 such recorded pipelines draw once through the device.

Nothing runs at import time, the package has no dependencies, and core, the stage and every other package never
import it (a test in this package checks that), so the WebGPU path is byte-identical with or without it.

Apache-2.0. Optional, tree-shakable package.

Build and unit tests: npm test --workspace @margoengine/webgl2-compat
