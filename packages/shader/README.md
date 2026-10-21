# @margoengine/shader

Typed shader nodes that compile to readable WGSL. One graph API drives three hosts: `NodeMaterial` (a `@margoengine/materials` Material whose colour, normal, roughness, metalness, emissive, opacity and vertex position come from nodes), `NodePass` (a full-screen effect inside `@margoengine/post`'s PostStack) and `ComputePass` (a compute shader over a storage buffer, dispatched by the frame graph). Two more entries skip the graph: `@margoengine/shader/raw` draws your own WGSL with your own vertex layout, and `@margoengine/shader/effects` has ready-made screen effects. WebGPU only.

```ts
import {createMesh, loadTexture} from '@margoengine/materials';
import {sphereGeometry} from '@margoengine/geometry';
import {NodeMaterial, uniform, texture, mix, color, uv, sin, time, positionLocal, normalLocal} from '@margoengine/shader';
const tint = uniform('#ff8800', {name: 'tint'});                      // live: tint.value = '#00ff00' never recompiles
const wave = sin(time.add(uv().y.mul(10))).mul(0.5).add(0.5);
const map = await loadTexture('/rock.jpg', {wrapS: 'repeat', wrapT: 'repeat'});
const material = new NodeMaterial({
  roughness: 0.6,                                                       // every Material option still applies
  colorNode: mix(color('#2040ff'), tint, uv().y).mul(texture(map).rgb),
  emissiveNode: tint.mul(wave.mul(0.2)),
  positionNode: positionLocal.add(normalLocal.mul(wave.mul(0.05))),     // object-space vertex position
});
createMesh(stage.engine, sphereGeometry(1, 64, 32), material);
```

```ts
import {PostStack} from '@margoengine/post';
import {Tonemap} from '@margoengine/tonemap';
import {NodePass, inputColor, inputDepth, screenUV, smoothstep, mix, vec3, uniform} from '@margoengine/shader';
const strength = uniform(0.8);
const vignette = new NodePass(inputColor().rgb.mul(smoothstep(0.8, 0.2, screenUV.sub(0.5).length()).mul(strength)));
const fog = new NodePass(mix(inputColor().rgb, vec3(0.6, 0.7, 0.8), inputDepth().mul(-40).add(1).saturate()), {kind: 'hdr'});
PostStack.attach(stage.engine, [fog, new Tonemap(), vignette]);      // hdr passes before the display effect, ldr after
```

```ts
import {ComputePass, NodeMaterial, storage, vec4, deltaTime} from '@margoengine/shader';
const field = storage(new Float32Array(4 * 1024), 'vec4f');          // or storage(1024, 'vec4f') for zeros
ComputePass.attach(stage.engine, 1024, i => field.store(i, field.element(i).add(vec4(0, deltaTime, 0, 0))));
new NodeMaterial({colorNode: field.element(3).xyz});                 // any node reads it; field.buffer(device) hands it to other passes
```

Cut-outs and slicing with `discard(condition, value)`, GPU counters and compaction with atomics:

```ts
import {NodeMaterial, ComputePass, storage, discard, texture, materialColor, positionWorld, uniform, select, uint} from '@margoengine/shader';
const slice = uniform(1.5);
new NodeMaterial({colorNode: discard(texture(leaf).a.lessThan(0.5), texture(leaf))});          // alpha cut-out
new NodeMaterial({colorNode: discard(positionWorld.y.greaterThan(slice), materialColor)});   // section the part at y = slice

const counter = storage(1, 'u32', {atomic: true}), visible = storage(n, 'u32'), radius = storage(radii, 'f32');
ComputePass.attach(stage.engine, n, i => {
  const keep = radius.element(i).greaterThan(0.1);
  const slot = counter.atomicAdd(0, select(keep, uint(1), uint(0)));   // previous value: this item's slot
  return visible.store(select(keep, slot, uint(n - 1)), i);           // compacted list; counter.element(0) is the count
});
// counter.update() before a frame resets it to its CPU data (zeros).
```

## Nodes

- Types: `f32`, `i32`, `u32`, `bool`, `vec2/3/4` of each, `mat2x2f`, `mat3x3f`, `mat4x4f`. `Node<'vec3f'>` is checked by TypeScript, and every operation checks again at run time with a message such as `vec3f + vec2f: operand types do not combine`. Numbers lift to the other operand's type; scalars splat (`mix(a, b, 0.5)`, `clamp(v, 0, 1)` on vectors).
- Constructors: `float int uint bool vec2 vec3 vec4 ivec2-4 uvec2-4 mat3 mat4`, `color('#rrggbb' | 0xrrggbb | [r, g, b])` (linear), conversions `.toFloat() .toInt() .toUint()`.
- Arithmetic and logic: `add sub mul div mod negate` (matrix times vector works), `lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual and or not`, swizzles `.x .xy .rgb .zyx` (and `.xxx` on a scalar), `.element(i)`.
- Built-ins, as functions and methods: `abs sign floor ceil round trunc fract sin cos tan asin acos atan atan2 tanh exp exp2 log log2 sqrt inverseSqrt saturate normalize radians degrees dpdx dpdy fwidth min max pow clamp step smoothstep mix reflect refract cross length distance dot oneMinus`.
- Inputs: `uv()`, `vertexColor()`, `positionLocal`, `positionWorld`, `normalLocal`, `normalWorld`, `viewDirection`, `cameraPosition`, `screenUV`, `screenCoordinate`, `varying(node)`; frame uniforms `time`, `deltaTime`, `resolution`; `uniform(value, {type, name})` with `.value` live; `texture(materialsTexture, uv?, level?)`.
- Material inputs (fragment): `materialColor`, `materialNormal`, `materialRoughness`, `materialMetalness`, `materialEmissive` (what the Material computed before nodes ran), `frontFacing`. Post inputs: `inputColor(uv?)`, `inputDepth(uv?)`. Compute input: `instanceIndex`.
- Control: `select(cond, ifTrue, ifFalse)`, `loop(count, init, (i, acc) => next)` (a bounded fold), `Fn(body, name)` (one WGSL function per argument-type signature) and `wgslFn(code)` for hand-written WGSL. `discard(cond, value)` drops the fragment where `cond` holds and is `value` elsewhere (NodeMaterial fragment nodes and NodePass nodes; a vertex or compute use throws).
- Atomics: `storage(data, 'u32' | 'i32', {atomic: true})` gives `atomicAdd(i, v)`, `atomicMax`, `atomicMin` (each returns the previous value), `atomicLoad(i)` and `atomicStore(i, v)` (a write like `store`), in ComputePass nodes only; TypeScript refuses them on other storage types. They run in the order they are made, before the body's writes, even when their result is unused (inside `loop` or `Fn` bodies only where the result is used); equal calls are never merged. `element(i)` on an atomic buffer is an `atomicLoad` in compute and a plain read in materials and post.

The compiler hash-conses the graph, so equal subexpressions built separately (three calls to `uv().y`) become one `let`; nodes not reachable from an output, unused uniforms and unused textures are never emitted. Output text depends only on the graph, so equal graphs give equal shaders and pipelines cache; uniform values live in a buffer, so changing them never recompiles. `material.fragmentCode`, `material.vertexCode`, `pass.code()` and `computePass.code` show the generated WGSL; `test/snapshots` holds examples.

## Noise (`@margoengine/shader/noise`, +2.0 kB min+gzip over the root entry)

```ts
import {createStage} from 'margoengine';
import {createMesh} from '@margoengine/materials';
import {planeGeometry} from '@margoengine/geometry';
import {NodeMaterial, positionLocal, normalLocal, uniform} from '@margoengine/shader';
import {simplex2, simplex3, perlin3, fbm, ridged, domainWarp} from '@margoengine/shader/noise';
const stage = await createStage('#app');
const p = positionLocal.xy.mul(0.4);
const height = ridged(q => simplex2(q, 42), p, {octaves: 5});                            // GPU terrain, seed 42
const clouds = domainWarp(q => fbm(r => simplex3(r, 7), q), positionLocal, {strength: 0.6});
const seed = uniform(3, {type: 'u32', name: 'seed'});                                     // perlin3 reseeds live
const material = new NodeMaterial({positionNode: positionLocal.add(normalLocal.mul(height)), emissiveNode: perlin3(positionLocal, seed).abs().xxx.mul(clouds)});
createMesh(stage.engine, planeGeometry(10, 10, 128, 128), material);
```

WGSL twins of `@margoengine/procedural/noise`: `simplex2`/`simplex3` match `new Noise(seed).simplex2`/`.simplex`, `perlin3`
matches `.perlin`, and `fbm`, `ridged`, `domainWarp` match the CPU combinators, so CPU code (physics, placement) can sample
the same field the GPU displaces. Agreement is to float rounding, not bits (f32 on the GPU, f64 on the CPU), measured on a
real adapter by `node packages/shader/test/noise-check.mjs` (under the GPU lock); on an Intel Arc 140V (Edge, 4096 points per field) the largest absolute difference was 2e-5 for single simplex and Perlin samples and 1.1e-4 for warped fBm (values span about [-1, 1]). Simplex seeds are compile-time
(each seed's 256-byte permutation is a private array, declared once per shader); `perlin3` takes a u32 node, so a uniform
reseeds without recompiling. Fractal sums unroll at graph build time (`octaves` 1..16). Not included: 4D simplex and
Worley on the GPU. Example: `examples/noise.html` (terrain with CPU-placed markers resting on the GPU surface).

## Read back one dispatch (`@margoengine/shader/readback`, +1.0 kB min+gzip over the root entry)

`ComputePass` runs every frame while attached. For a one-off result on the CPU (an editor tool, a bake, a test),
`computeReadback` runs a body once and resolves with a copy of a storage buffer:

```ts
import {storage, uint} from '@margoengine/shader';
import {computeReadback} from '@margoengine/shader/readback';
const source = storage(Uint32Array.from(cells), 'u32'), output = storage(cells.length, 'u32');
const controller = new AbortController();
const {data} = await computeReadback(stage.engine, cells.length, i => output.store(i, source.element(i).add(uint(1))), output, {
  signal: controller.signal, // cancel button: rejects with signal.reason
  timeout: 30_000,           // default; Infinity waits
});
source.dispose(); output.dispose(); // storage stays yours; `data` is a Uint32Array you own
```

`target` is a GPUDevice or an engine (its current device; no frame needs to render). The job records one dispatch and a
copy into its own command buffer, submits it, maps a private readback buffer and copies the bytes out, so `data` is
neither `output.data` nor GPU memory. It settles exactly once:

| Outcome | Settles with |
| --- | --- |
| GPU finished | `{data, type, count}`: Float32Array, Int32Array or Uint32Array by element type |
| `signal` aborted (before the call: the GPU is never touched) | rejects with `signal.reason` |
| engine disposed during the job, or already disposed | MargoError `'disposed'` |
| device lost during the job, or already lost | MargoError `'failed'` naming the loss reason |
| WGSL or a GPU call failed validation or memory (inside the job's error scopes; the device stays usable) | MargoError `'failed'` with the GPU message |
| `timeout` elapsed | MargoError `'failed'` |
| engine without WebGPU | MargoError `'unsupported'` |

Whatever the outcome, the job's readback and uniform buffers are destroyed and its abort listener, device-loss
observer and timer removed as it settles (a pending map is cancelled by the destroy); storage the body uses is never
disposed for you. Frame values read a 1 x 1 resolution and deltaTime 0. `test/readback.test.js` checks every row on a
scripted device; `node packages/shader/test/readback-check.mjs` (under the GPU lock) on a real adapter: 4,194,304 u32
read back exactly (65 ms on an NVIDIA Ampere GPU in Edge), a job on an engine that never rendered, abort right after
submit and while mapping, engine disposal and `device.destroy()` at both points, and a pipeline over the storage-binding
limit; every job destroyed its buffers and no GPU error escaped.

## Raw shaders (`@margoengine/shader/raw`, 9.6 kB min+gzip)

Your own WGSL vertex and fragment
entry points, any named attributes per vertex or per instance, live uniforms and textures, drawn into the scene's colour
and depth.

```ts
import {RawShaders, RawShaderMaterial, RawMesh} from '@margoengine/shader/raw';
const raw = RawShaders.attach(stage.engine);
const material = new RawShaderMaterial({
  vertexShader: `
struct Out { @builtin(position) clip:vec4f, @location(0) color:vec3f, @location(1) uv:vec2f }
@vertex fn vertex(a:Attributes)->Out {
  let lift = sin(camera.time + a.offset.x) * uniforms.wave;
  return Out(camera.viewProjection * mesh.world * vec4f(a.position + a.offset + vec3f(0.0, lift, 0.0), 1.0), a.color, a.uv);
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  return margoDisplay(vec4f(i.color * uniforms.tint * textureSample(map, mapSampler, i.uv).rgb, 1.0));   // lit like the scene
}`,
  uniforms: {wave: {value: 0.2}, tint: {value: '#ff8800'}},   // f32 to vec4f, i32/u32 variants, mat3x3f, mat4x4f
  textures: {map: texture},                                   // a materials Texture, GPUTexture or GPUTextureView
});
const mesh = raw.add(new RawMesh({
  material,
  attributes: {
    position: {data: positions, type: 'vec3f'},
    color: {data: colors, type: 'vec3f'},
    uv: {data: uvs, type: 'vec2f'},
    offset: {data: offsets, type: 'vec3f', step: 'instance'},   // one per instance; the instance count follows it
  },
  index: indices,
}));
material.uniforms.wave.value = 0.5;              // live, never recompiles
mesh.setAttribute('offset', offsets, [10, 5]);    // uploads instances 10..14 only
material.transparent = true;                      // render state is live too (a new pipeline compiles once)
```

- **The prelude.** Each stage's module is a short prelude, then your code (`material.code('vertex', mesh)` shows it). It
  declares `camera` (`view`, `projection`, `viewProjection`, `position`, `time`, `resolution`, `deltaTime`), `mesh`
  (`world`, and `normal`, the inverse transpose of its 3x3), `struct Attributes` with one `@location` per attribute in
  the order given, `uniforms.<name>` (the WGSL layout is computed for you), each texture as `<name>` plus
  `<name>Sampler`, and two colour helpers. Fragment output is written exactly as returned (raw); `margoDisplay(c)`
  applies the scene's display transform (PBR Neutral and sRGB on a display target, nothing inside an HDR PostStack
  capture, which tonemaps later) and `margoEncode(c)` only the sRGB encoding, for unlit colour as lines and points write
  it. With a separate `fragmentShader` each stage is its own module, so both may use `main`.
- **Geometry.** Attribute types are `f32`, `vec2f` to `vec4f` and the `i32`/`u32` variants, up to 16 attributes;
  per-vertex and per-instance attributes are each interleaved into one buffer. `setAttribute(name, data, [first,
  count])` uploads only that element range; new lengths grow the buffer; `{data, type, step}` adds or retypes an
  attribute (new layout, new pipeline). Optional index (`Uint16Array`, `Uint32Array` or numbers), `instanceCount`,
  `vertexCount` (no attributes: vertex pulling), `topology`, `drawRange`. `matrix` is the model matrix; `mesh: coreMesh`
  follows a core mesh (world = its world matrix x `matrix`) and hides with it.
- **Render state.** `transparent` (drawn after the opaque scene, sorted back to front by distance), `blending`
  (`'normal'` blends only when transparent; `'additive'`, `'multiply'`, `'premultiplied'`, `'none'` or a
  `GPUBlendState`), `depthTest` (reversed-Z `greater-equal`), `depthWrite`, `cull` (`'back'`, `'front'`, `'none'`),
  `colorWrite`; per mesh `renderOrder` and `visible`.
- **The pass.** Opaque raw meshes draw at frame-graph order 0.5 (after core meshes, before gltf-pro and materials meshes
  at 1), transparent ones at 7 (after water, sky and particles, before OIT at 8 and lines at 20);
  `new RawShaders({opaqueOrder, transparentOrder})` moves them. Each draws into the pass's own colour and depth targets
  with their format and MSAA sample count, so 1x/4x and a PostStack's HDR capture just work.
- **Compiling and errors.** Pipelines compile asynchronously and draw from the next frame on (`await raw.ready()` before a
  one-off `engine.render()`). A WGSL error is a MargoError `'failed'` naming the stage and line in your code, set on
  `material.error` and passed to `material.onError` (default `console.error`); only that draw is skipped. Assigning
  `vertexShader` or `fragmentShader` recompiles.
- **Lifecycle.** `mesh.dispose()` frees its buffers and leaves the plugin; `material.dispose()` frees its uniforms and
  pipelines (rebuilt if drawn again); `engine.removePlugin('shader:raw')` frees everything and keeps the meshes. Device
  restoration rebuilds everything from the CPU copies; a materials Texture rebinds itself, a GPUTexture from the lost
  device draws white with a warning until you assign a new one.

Measured on an NVIDIA Ampere GPU (Edge, 4x and 1x MSAA) by `node scripts/shader-raw-gpu-check.js` (under the GPU lock):
a quad with a per-vertex colour attribute and a per-instance offset and `u32` id matches its analytic colours within 0.55
of 255 over 5,225 pixels, is hidden pixel for pixel behind a core box and drawn in front of it, live uniforms and a ranged
`setAttribute` update it, device restoration redraws identical pixels, and an attached plugin with nothing visible or a
removed one leaves every pixel unchanged.

## Screen effects (`@margoengine/shader/effects`, +1.1 kB min+gzip over the root entry)

Ready-made `NodePass` effects for a PostStack, each with live `uniforms` (`effect.uniforms.darkness.value = 0.5`). LDR by
default (after tonemapping, on display colour); `{kind: 'hdr'}` runs one on linear light before the display effect.

```ts
import {PostStack} from '@margoengine/post';
import {Tonemap} from '@margoengine/tonemap';
import {vignette, rgbShift} from '@margoengine/shader/effects';
const look = vignette({darkness: 0.6}), shift = rgbShift({amount: 0.004});
PostStack.attach(stage.engine, [new Tonemap(), shift, look]);
look.uniforms.darkness.value = 0.9;                   // live
```

| Preset | Parameters (default) |
| --- | --- |
| `vignette` | `darkness` 0.8, `radius` 0.4 (0 centre, 1 corner), `softness` 0.6 |
| `rgbShift` | `amount` 0.005 (UV units), `angle` 0 (radians; red moves right, blue left) |
| `chromaticAberration` | `strength` 0.01 (red and blue scaled about the centre by 1 -/+ strength) |
| `pixelate` | `size` 8 pixels; each block is the input pixel at its centre |
| `halftone` | `size` 8 pixels, `angle` 0.26; `greyscale` (construction only) |
| `dotScreen` | `size` 6 pixels, `angle` 0.785; black dots on white |
| `sobel` | `strength` 1, `overlay` 0 (1 draws black edges over the image) |
| `sepia` | `amount` 1 (W3C Filter Effects matrix) |
| `posterize` | `levels` 4 |

The same GPU check feeds known images through them: Sobel gives exactly 4 x the luma step beside a step and 0 elsewhere,
pixelate copies each block's centre pixel exactly, and posterize, sepia, vignette, RGB shift and chromatic aberration
match their formulas within 0.6 of 255; halftone and dot screen compile and draw.

## Limits

- Nodes are fixed when a NodeMaterial, NodePass or ComputePass is constructed; build a new one to change the graph. Only uniform values, textures' pixels and storage contents change live.
- NodeMaterial patches gltf-pro's beauty shader (standard and KHR physical variants): shadows, SSAO's G-buffer and depth-equal passes see neither `positionNode` nor `normalNode`; normals are not re-derived after a vertex offset; at most 8 varyings. Its bindings start at group 2, binding 48, and node textures count against WebGPU's 16 sampled textures per stage: a `NodeMaterial` on a materials mesh fits 6 texture nodes alone, 5 with directional shadows and 3 with shadows, IBL and LocalShadows; past that, gltf-pro throws a `RangeError` naming the combination.
- `uv()` is the raw first UV set (no texture transform). `select` evaluates both branches; there is no statement-level `If`, `Break`, assignment to variables or `switch`. `discard` in a NodeMaterial affects the beauty pass only: shadows still see the whole surface, and a NodePass's discarded pixels stay the cleared transparent black. Fn bodies cannot read stage inputs such as `uv()`; pass them as arguments. No automatic derivative-safe sampling: `textureSample` inside a loop with a non-uniform bound is a WGSL uniformity error.
- Raw meshes are not picked by `engine.pick`, are not culled, and draw only into the main colour and depth: shadows, SSAO and SSR G-buffers and depth prepasses do not see them. Raw uniforms are scalars, vectors, mat3x3f and mat4x4f (no arrays or structs); no storage buffers or extra bind groups; one colour target; 32-bit attribute formats only.
- NodePass runs only inside a PostStack (a stack of one is fine). An `hdr` pass that ends the chain tonemaps with ACES.
- ComputePass is one-dimensional (up to 65535 workgroups), runs every frame while attached (`computeReadback` runs once) (an atomic counter keeps counting unless `update()` resets it), and has no workgroup memory, barriers or atomics on workgroup variables, and no `atomicSub`/`And`/`Or`/`Xor`/`Exchange`/`CompareExchange` yet. Storage elements are 4- or 8- or 16-byte types (no vec3). A device loss re-uploads the CPU `data`, not what the GPU computed.
- No GLSL/WebGL2 output, no node editor, no built-in noise library (write it with `Fn` or `wgslFn`), no light, shadow or environment nodes, no skinning or morph nodes, no MRT outputs.

Size (min + gzip, Rolldown, peers external): whole package 11.8 kB (11.2 kB before `discard` and atomics); `NodeMaterial` with colour nodes only, 5.8 kB, unchanged (post, compute and texture code tree-shake away; the test enforces this).

MIT. Optional, tree-shakable package; peers `@margoengine/core`, `@margoengine/materials` and `@margoengine/gltf-pro` (^0.1.0 || ^1.0.0).

Build and unit tests: `npm test --workspace @margoengine/shader`. Browser check on a real WebGPU adapter: `node packages/shader/test/browser-check.mjs`.
