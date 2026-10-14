# @margoengine/shader

Typed shader nodes that compile to readable WGSL: the Margo counterpart of three.js TSL and node materials. One graph API drives three hosts: `NodeMaterial` (a `@margoengine/materials` Material whose colour, normal, roughness, metalness, emissive, opacity and vertex position come from nodes), `NodePass` (a full-screen effect inside `@margoengine/post`'s PostStack) and `ComputePass` (a compute shader over a storage buffer, dispatched by the frame graph). WebGPU only.

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

## Coming from TSL

| three.js TSL | @margoengine/shader |
| --- | --- |
| `new MeshStandardNodeMaterial()` + `.colorNode = ...` | `new NodeMaterial({colorNode, roughnessNode, metalnessNode, emissiveNode, normalNode, opacityNode, positionNode})` |
| `material.positionNode = positionLocal.add(...)` | `positionNode: positionLocal.add(...)` |
| `uniform(0.5)`, `u.value = 1` | same |
| `texture(map, uv())` | `texture(map, uv())` with a `@margoengine/materials` Texture |
| `time`, `uv()`, `positionWorld`, `normalWorld`, `cameraPosition`, `screenUV` | same names |
| `positionViewDirection` | `viewDirection` (world space, surface to camera) |
| `vec3(...)`, `.mul()`, `.add()`, `mix`, `smoothstep`, `.xyz` | same |
| `select(cond, a, b)` | same |
| `If(cond, () => ...).Else(...)` | `select(cond, a, b)` (both sides evaluate) |
| `Loop(n, ({i}) => { acc.addAssign(...) })` | `loop(n, init, (i, acc) => acc.add(...))` |
| `Fn(([a, b]) => ...)` | `Fn((a: Node<'vec3f'>, b: Node<'f32'>) => ...)` (positional, typed) |
| `wgslFn('fn f(...) -> T {...}')` | same |
| `varying(node)` / `vertexStage(node)` | `varying(node)` |
| `pass(scene, camera)` + `postProcessing.outputNode` | `new NodePass(node)` in a `PostStack` (or `NodePass.attach(engine, node)` alone); `inputColor()`, `inputDepth()` |
| `storage(attribute, 'vec4', n)`, `Fn(...)().compute(n)`, `renderer.compute(...)` | `storage(array, 'vec4f')`, `ComputePass.attach(engine, n, i => buf.store(i, value))` |
| `instanceIndex` | `instanceIndex` (compute only) |
| `Discard(cond)` inside `Fn` | `discard(cond, value)` around the value it guards |
| `atomicAdd(buf.element(i), v)`, `atomicMax`, `atomicMin`, `atomicLoad`, `atomicStore` | `buf.atomicAdd(i, v)` ... on `storage(data, 'u32', {atomic: true})` |

## Limits

- Nodes are fixed when a NodeMaterial, NodePass or ComputePass is constructed; build a new one to change the graph. Only uniform values, textures' pixels and storage contents change live.
- NodeMaterial patches gltf-pro's beauty shader (standard and KHR physical variants): shadows, SSAO's G-buffer and depth-equal passes see neither `positionNode` nor `normalNode`; normals are not re-derived after a vertex offset; at most 8 varyings. Its bindings start at group 2, binding 48, and node textures count against the 16 sampled textures per stage that gltf-pro, materials and shadows already use (about four remain).
- `uv()` is the raw first UV set (no texture transform). `select` evaluates both branches; there is no statement-level `If`, `Break`, assignment to variables or `switch`. `discard` in a NodeMaterial affects the beauty pass only: shadows still see the whole surface, and a NodePass's discarded pixels stay the cleared transparent black. Fn bodies cannot read stage inputs such as `uv()`; pass them as arguments. No automatic derivative-safe sampling: `textureSample` inside a loop with a non-uniform bound is a WGSL uniformity error.
- NodePass runs only inside a PostStack (a stack of one is fine). An `hdr` pass that ends the chain tonemaps with ACES.
- ComputePass is one-dimensional (up to 65535 workgroups), runs every frame while attached (an atomic counter keeps counting unless `update()` resets it), and has no workgroup memory, barriers or atomics on workgroup variables, and no `atomicSub`/`And`/`Or`/`Xor`/`Exchange`/`CompareExchange` yet. Storage elements are 4- or 8- or 16-byte types (no vec3). A device loss re-uploads the CPU `data`, not what the GPU computed.
- No GLSL/WebGL2 output, no node editor, no built-in noise library (write it with `Fn` or `wgslFn`), no light, shadow or environment nodes, no skinning or morph nodes, no MRT outputs.

Size (min + gzip, Rolldown, peers external): whole package 11.8 kB (11.2 kB before `discard` and atomics); `NodeMaterial` with colour nodes only, 5.8 kB, unchanged (post, compute and texture code tree-shake away; the test enforces this).

MIT. Optional, tree-shakable package; peers `@margoengine/core`, `@margoengine/materials` and `@margoengine/gltf-pro` (^0.1.0 || ^1.0.0).

Build and unit tests: `npm test --workspace @margoengine/shader`. Browser check on a real WebGPU adapter: `node packages/shader/test/browser-check.mjs`.
