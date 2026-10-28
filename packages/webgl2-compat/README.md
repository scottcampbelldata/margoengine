# @margoengine/webgl2-compat

Import `margoengine/webgl2-compat` from the `margoengine` package, or `@margoengine/webgl2-compat` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

**Status: in development. Milestone M0 is done; it does not render anything yet.** This package will become the
WebGL2 compatibility layer described in the [roadmap](../../docs/webgl2-compat-roadmap.md): a WebGPU-shaped device
built on WebGL2 that translates every WGSL shader to GLSL ES 3.00, so core and the optional packages run unchanged in
browsers without WebGPU. Until it renders, apps that need a fallback use the
[`@margoengine/webgl`](../webgl/README.md) preview.

What it has today:

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

Nothing runs at import time, the package has no dependencies, and core, the stage and every other package never
import it (a test in this package checks that), so the WebGPU path is byte-identical with or without it.

Apache-2.0. Optional, tree-shakable package.

Build and unit tests: npm test --workspace @margoengine/webgl2-compat
