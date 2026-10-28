# @margoengine/webgl2-compat

Import `margoengine/webgl2-compat` from the `margoengine` package, or `@margoengine/webgl2-compat` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

**Status: in development, milestones M0 and M1 only; it does not render anything yet.** This package will become the
WebGL2 compatibility layer described in the [roadmap](../../docs/webgl2-compat-roadmap.md): a WebGPU-shaped device
built on WebGL2 that translates every WGSL shader to GLSL ES 3.00, so core and the optional packages run unchanged in
browsers without WebGPU. Until it renders, apps that need a fallback use the
[`@margoengine/webgl`](../webgl/README.md) preview.

What it has today:

- `checkWGSL(source)` and `parseWGSL(source)` in `margoengine/webgl2-compat/wgsl` (milestone M1): the WGSL front end of
  the translator, below.
- `webgl2Capabilities(gl)` and `probeWebGL2()`: what a browser's WebGL2 offers (the extensions and limits the layer
  maps onto WebGPU) and the tier it reaches. The layer will render only on the `full` tier: renderable float colour
  targets (`EXT_color_buffer_float`) and `highp` in fragment shaders.
- In the repository, not in the package: the WGSL corpus, every shader module the packages create in their real-GPU
  checks (`npm run record:wgsl-corpus`), which the translator is tested against.

```ts
import { probeWebGL2 } from 'margoengine/webgl2-compat';

const caps = probeWebGL2(); // null when the browser has no WebGL2
if (caps?.supported) console.log(`WebGL2 compatibility tier: ${caps.tier}`);
else console.log(`Below the minimum: missing ${caps ? caps.missing.join(', ') : 'WebGL2'}`);
```

Load it only where WebGPU is missing, with a dynamic import, so browsers with WebGPU never download it:

```ts
const gpu = 'gpu' in navigator ? await navigator.gpu.requestAdapter() : null;
if (!gpu) {
  const { probeWebGL2 } = await import('margoengine/webgl2-compat');
  console.log(probeWebGL2()?.tier ?? 'no WebGL2');
}
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
alone. It has its own entry, so the root entry stays small and apps that never translate shaders never load it.

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

Nothing runs at import time, the package has no dependencies, and core, the stage and every other package never
import it (a test in this package checks that), so the WebGPU path is byte-identical with or without it.

Apache-2.0. Optional, tree-shakable package.

Build and unit tests: npm test --workspace @margoengine/webgl2-compat
