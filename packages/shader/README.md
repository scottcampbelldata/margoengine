# @margoengine/shader

Import `margoengine/shader` from the `margoengine` package, or `@margoengine/shader` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Typed shader nodes that compile to readable WGSL. One graph API drives three hosts: `NodeMaterial` (a `@margoengine/materials` Material whose colour, normal, roughness, metalness, emissive, opacity and vertex position come from nodes), `NodePass` (a full-screen effect inside `@margoengine/post`'s PostStack) and `ComputePass` (a compute shader over a storage buffer, dispatched by the frame graph). Two more entries skip the graph: `@margoengine/shader/raw` draws your own WGSL with your own vertex layout, and `@margoengine/shader/effects` has ready-made screen effects. WebGPU only.

```ts
import {createMesh, loadTexture} from 'margoengine/materials';
import {sphereGeometry} from 'margoengine/geometry';
import {NodeMaterial, uniform, texture, mix, color, uv, sin, time, positionLocal, normalLocal} from 'margoengine/shader';
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
import {PostStack} from 'margoengine/post';
import {Tonemap} from 'margoengine/tonemap';
import {NodePass, inputColor, inputDepth, screenUV, smoothstep, mix, vec3, uniform} from 'margoengine/shader';
const strength = uniform(0.8);
const vignette = new NodePass(inputColor().rgb.mul(smoothstep(0.8, 0.2, screenUV.sub(0.5).length()).mul(strength)));
const fog = new NodePass(mix(inputColor().rgb, vec3(0.6, 0.7, 0.8), inputDepth().mul(-40).add(1).saturate()), {kind: 'hdr'});
PostStack.attach(stage.engine, [fog, new Tonemap(), vignette]);      // hdr passes before the display effect, ldr after
```

```ts
import {ComputePass, NodeMaterial, storage, vec4, deltaTime} from 'margoengine/shader';
const field = storage(new Float32Array(4 * 1024), 'vec4f');          // or storage(1024, 'vec4f') for zeros
ComputePass.attach(stage.engine, 1024, i => field.store(i, field.element(i).add(vec4(0, deltaTime, 0, 0))));
new NodeMaterial({colorNode: field.element(3).xyz});                 // any node reads it; field.buffer(device) hands it to other passes
```

Cut-outs and slicing with `discard(condition, value)`, GPU counters and compaction with atomics:

```ts
import {NodeMaterial, ComputePass, storage, discard, texture, materialColor, positionWorld, uniform, select, uint} from 'margoengine/shader';
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

Statements: variables that change, branches that run one side only, loops that leave early:

```ts
import {block, If, Loop, Break, Var, NodeMaterial, ComputePass, storage, texture, uv, vec3, uint} from 'margoengine/shader';
const march = block(() => {
  const light = Var(vec3(0)), depth = Var(0);                          // Var(0, 'u32') for other types
  Loop(64, () => {
    const density = texture(fog, uv().add(depth), 0).r;                 // an explicit level: see Limits
    If(density.greaterThan(0.95), () => Break());                       // stops this pixel's loop here
    light.addAssign(vec3(density).mul(0.02));
    depth.addAssign(0.01);
  });
  return light;
});
new NodeMaterial({colorNode: march});

const hits = storage(1, 'u32', {atomic: true}), out = storage(n, 'u32');
ComputePass.attach(stage.engine, n, i => {                              // a ComputePass body is a statement body already
  If(i.mod(2).equal(0), () => {
    out.store(hits.atomicAdd(0, 1), i);                                 // runs here, for the even invocations only
  });
});
```

## Statements

`block(() => value)` is a node worked out by statements; NodeMaterial slots, NodePass nodes and Fn bodies all take one. A ComputePass body and every body below are statement bodies too, so they need no `block`.

- `Var(init, type?)` declares a variable; `.assign(v)`, `.addAssign`, `.subAssign`, `.mulAssign`, `.divAssign` and `.assignElement(i, v)` change it. It is a node, so `x.add(1)`, `x.xy` and `x.lessThan(0)` read it.
- `If(cond, body).ElseIf(cond, body).Else(body)` runs one body. Only that body's nodes run, which is the reason to use it over `select`; a condition after the first is worked out only when the ones before it failed. Conditions are single `bool`s.
- `Loop(count, i => ...)` or `Loop({from, to, step}, i => ...)` counts with an `i32` `i`; the bounds are read once, on entry. `While(cond, body)` tests `cond` before each pass and hangs the GPU if it never fails, so bound it. `Break()` and `Continue()` work in both; `loop()` stays the plain fold.
- `Switch(i32 or u32 node).Case(1, body).Case([2, 3], body).Default(body)` picks one body. There is no fall-through, `Default` is optional, and `Break()` inside a Case ends the Switch rather than a loop around it, as in C and WGSL.
- `Let(node)` keeps a value as it is now. A node that reads a `Var` is worked out where it is used: after `const next = x.add(1); x.assign(0);`, `next` is `1`, while `Let(x.add(1))` taken before the assignment keeps the old sum.
- Storage `store` and atomics inside these bodies happen right there, in order. At the top level of a ComputePass body atomics run where they are made and writes run after them, returned or not.

Mistakes fail when the material or pass is built, with a message that says what to do: a statement outside a body, `Break()` with nothing to leave (a `block` is a value, so a Break in it cannot reach a loop outside it), a `Var` or `Let` used outside the body it was made in, repeated cases. An atomic made in a branch and used outside it is refused too, because the only way to emit it would be to run it twice.

## Nodes

- Types: `f32`, `i32`, `u32`, `bool`, `vec2/3/4` of each, `mat2x2f`, `mat3x3f`, `mat4x4f`. `Node<'vec3f'>` is checked by TypeScript, and every operation checks again at run time with a message such as `vec3f + vec2f: operand types do not combine`. Numbers lift to the other operand's type; scalars splat (`mix(a, b, 0.5)`, `clamp(v, 0, 1)` on vectors).
- Constructors: `float int uint bool vec2 vec3 vec4 ivec2-4 uvec2-4 mat3 mat4`, `color('#rrggbb' | 0xrrggbb | [r, g, b])` (linear), conversions `.toFloat() .toInt() .toUint()`.
- Arithmetic and logic: `add sub mul div mod negate` (matrix times vector works), `lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual and or not`, swizzles `.x .xy .rgb .zyx` (and `.xxx` on a scalar), `.element(i)`.
- Built-ins, as functions and methods: `abs sign floor ceil round trunc fract sin cos tan asin acos atan atan2 tanh exp exp2 log log2 sqrt inverseSqrt saturate normalize radians degrees dpdx dpdy fwidth min max pow clamp step smoothstep mix reflect refract cross length distance dot oneMinus`.
- Inputs: `uv()`, `vertexColor()`, `positionLocal`, `positionWorld`, `normalLocal`, `normalWorld`, `viewDirection`, `cameraPosition`, `screenUV`, `screenCoordinate`, `varying(node)`; frame uniforms `time`, `deltaTime`, `resolution`; `uniform(value, {type, name})` with `.value` live; `texture(materialsTexture, uv?, level?)`.
- Material inputs (fragment): `materialColor`, `materialNormal`, `materialRoughness`, `materialMetalness`, `materialEmissive` (what the Material computed before nodes ran), `frontFacing`. Post inputs: `inputColor(uv?)`, `inputDepth(uv?)`. Compute input: `instanceIndex`.
- Control: `select(cond, ifTrue, ifFalse)`, `loop(count, init, (i, acc) => next)` (a bounded fold), `Fn(body, name)` (one WGSL function per argument-type signature) and `wgslFn(code)` for hand-written WGSL. `discard(cond, value)` drops the fragment where `cond` holds and is `value` elsewhere (NodeMaterial fragment nodes and NodePass nodes; a vertex or compute use throws). Statement-level `If`, `Loop` and the rest are under [Statements](#statements).
- Atomics: `storage(data, 'u32' | 'i32', {atomic: true})` gives `atomicAdd(i, v)`, `atomicMax`, `atomicMin` (each returns the previous value), `atomicLoad(i)` and `atomicStore(i, v)` (a write like `store`), in ComputePass nodes only; TypeScript refuses them on other storage types. They run in the order they are made, before the body's writes, even when their result is unused (inside `loop` or `Fn` bodies only where the result is used); equal calls are never merged. `element(i)` on an atomic buffer is an `atomicLoad` in compute and a plain read in materials and post.

The compiler hash-conses the graph, so equal subexpressions built separately (three calls to `uv().y`) become one `let`; nodes not reachable from an output, unused uniforms and unused textures are never emitted. Output text depends only on the graph, so equal graphs give equal shaders and pipelines cache; uniform values live in a buffer, so changing them never recompiles. `material.fragmentCode`, `material.vertexCode`, `pass.code()` and `computePass.code` show the generated WGSL; `test/snapshots` holds examples.

Float uniforms (scalars, vectors and matrices) must stay finite as float32; otherwise construction or a `.value` assignment throws `TypeError` and keeps the previous value. Portable graphs (`@margoengine/shader/graph`) need complete three-number `fallback.color` and `fallback.emissive` arrays. A material from `createGraphMaterial` keeps its validated graph in `material.surfaceGraph`, so a baking host can evaluate the same pattern with `evaluateSurfaceGraph`.

## Visual editor (`@margoengine/shader/editor`)

`NodeEditor` is a node-graph editor for the portable surface graph (`SurfaceGraph`, `@margoengine/shader/graph`): pick nodes
from a palette, wire outputs to inputs, type constants, and see at once whether the graph is valid. It is plain DOM in a shadow
root (light and dark), needs no framework and has no effect on import. `onGraph` hands you every new valid graph, so a
material can be rebuilt as the artist edits (hot reload).

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {sphereGeometry} from 'margoengine/geometry';
import {createGraphMaterial, type SurfaceGraph} from 'margoengine/shader/graph';
import {NodeEditor} from 'margoengine/shader/editor';
const stage = await createStage('#app');
const geometry = sphereGeometry(1, 64, 32);
const saved = localStorage.getItem('surface');                      // {graph, layout} saved below, if any
const editor = new NodeEditor(document.querySelector<HTMLElement>('#editor')!, saved ? JSON.parse(saved) : {});
const mesh = createMesh(stage.engine, geometry, createGraphMaterial(editor.model.toGraph()));
const stop = editor.onGraph((graph: SurfaceGraph) => {              // called for each new VALID graph, not for moves
  mesh.material = createGraphMaterial(graph);                       // swapped live from the next frame
  localStorage.setItem('surface', JSON.stringify({graph, layout: editor.layout}));
});
editor.onChange(status => console.log(status.ok ? 'ok' : status.message));   // fix-it text, e.g. which input is empty
// later: stop(); editor.dispose();   (or pass {signal} and abort it; `using editor = new NodeEditor(...)` works too)
```

- **Using it.** `Shift+A` or a double click on the canvas opens the palette (type to search; arrows and Enter; 28 operations).
  Drag from a node's output socket to an input socket, or click an output and then an input. Drag from a wired input to move
  or drop the wire; click a wired input to pick its wire up. Drag a title bar to move nodes; drag empty canvas to pan, wheel to
  zoom at the cursor. `Delete` removes the selection (or the wire of a focused input), `Ctrl+Z` / `Ctrl+Y` undo and redo,
  `Ctrl+D` duplicates, `Ctrl+A` selects all, arrows nudge (Shift: 32 px), `F` fits, `Esc` cancels. Sockets are buttons with
  labels, so the keyboard and screen readers can wire a graph; the status line is a live region. Touch works through the same
  pointer events.
- **Unconnected inputs.** Most second inputs have a default shown as a number field (`Multiply` B = 1, `Mix` Factor = 0.5,
  `Clamp` 0 to 1, `Combine` 0, 0, 0); type there instead of adding a Number node. The editor adds them as hidden `float`
  nodes when it exports. Inputs without a default (the first input of most nodes) must be wired; until then the status line
  names the node and input and `graph` throws, and nothing is reported to `onGraph`.
- **Validation as you edit.** The editor runs the real validator: loops are refused when you wire them, type mistakes (a vec3
  into a number slot), the 128 node, depth 32 and work limits show in the status line, and the node a message is about is
  outlined (click the status line to select it). Each node shows its output type. The **WGSL** button shows the shader
  `createGraphMaterial` generates for the current graph (debugging).
- **Saving.** `editor.graph` is the portable graph (`serializeSurfaceGraph` makes the JSON) and `editor.layout` the node
  positions; pass both back as `{graph, layout}`. Layout is not part of the portable graph. Constants of a portable graph are
  immutable by design, so editing a number rebuilds the material (the pipeline cache makes equal graphs free); use a
  `uniform` in code for values that change every frame.
- **Without the DOM.** `GraphModel` is the editor's state: `addNode`, `connect`, `connectOutput`, `setValue`, `setInline`,
  `removeNodes`, `duplicate`, `batch`, `undo` / `redo`, `status()`, `toGraph()`. Use it to script graph edits in tools and tests.
  `readOnly: true` shows a graph without allowing edits.

`node packages/shader/test/editor-check.mjs` (real GPU, under the GPU lock) builds a graph with a real mouse and keyboard in a
browser (palette, typed constants, dragged wires), draws the material it makes and reads the pixels back: the colour, a
rebuild after a retyped number, no rebuild after a node move, undo and redo, and that an incomplete or ill-typed graph keeps
the last valid material on screen.

## Noise (`@margoengine/shader/noise`, +2.0 kB min+gzip over the root entry)

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {NodeMaterial, positionLocal, normalLocal, uniform} from 'margoengine/shader';
import {simplex2, simplex3, perlin3, fbm, ridged, domainWarp} from 'margoengine/shader/noise';
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
import {storage, uint} from 'margoengine/shader';
import {computeReadback} from 'margoengine/shader/readback';
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

## The compute model

`ComputePass` runs 1D, 2D or 3D grids, shares memory inside a workgroup, and can take its size from an earlier pass. None of it costs anything in a pass that does not use it. Here each 256-wide workgroup sums its items with a prefix scan:

```ts
import {ComputePass, Loop, If, Var, globalId, localIndex, storage, uint, workgroup, workgroupBarrier} from 'margoengine/shader';
const input = storage(Uint32Array.from(values), 'u32'), sums = storage(values.length, 'u32');
const tile = workgroup(256, 'u32');
ComputePass.attach(stage.engine, values.length, i => {         // values.length: a multiple of 256, as it has barriers
  tile.store(localIndex, input.element(i));
  workgroupBarrier();
  const step = Var(uint(1));
  Loop(8, () => {
    const mine = Var(tile.element(localIndex));
    If(localIndex.greaterThanEqual(step), () => mine.addAssign(tile.element(localIndex.sub(step))));
    workgroupBarrier();                                        // everyone has read
    tile.store(localIndex, mine);
    workgroupBarrier();                                        // everyone has written
    step.mulAssign(uint(2));
  });
  return sums.store(i, tile.element(localIndex));
}, {workgroupSize: 256});

const image = storage(640 * 480, 'vec4f');
ComputePass.attach(stage.engine, [640, 480], i => image.store(i, globalId.toFloat().xyzz));   // 2D: i runs row by row

const args = storage(new Uint32Array([0, 1, 1]), 'u32');       // workgroups x, y, z, written by an earlier pass
ComputePass.attach(stage.engine, 1, () => args.store(0, sums.element(0).div(64).add(1)));
ComputePass.attach(stage.engine, 1 << 20, i => image.store(i, globalId.toFloat().xyzz), {indirect: args, order: -99});
```

- **Grids.** `count` is a number, `[x, y]` or `[x, y, z]`; invocations past it return at once. The body's `i` numbers them row by row. `workgroupSize` takes the same forms, at most 256 invocations and 64 along z; the default is 64, `[8, 8]` or `[4, 4, 4]`. `globalId` (vec3u) is the position in the grid.
- **Inside a workgroup.** `localId`, `localIndex`, `workgroupId` and `workgroupCount` are the WGSL built-ins. `workgroup(count, type, {atomic})` declares memory the group shares; `.element(i)`, `.store(i, v)` (here and now, unlike a storage `store` at the top of a body) and `.uniformLoad(i)` use it.
- **Barriers.** `workgroupBarrier()`, `storageBarrier()` and `textureBarrier()`. Every invocation must reach one, so a pass with a barrier has no early return and its `count` must be a multiple of `workgroupSize`, or it throws. A barrier under a branch that differs between invocations is a WGSL uniformity error when the pipeline compiles; `uniformLoad` gives a value the group agrees on. Storage writes made before a barrier at the top of a body happen before it.
- **Atomics.** On storage and workgroup memory: `atomicAdd`, `atomicSub`, `atomicMax`, `atomicMin`, `atomicAnd`, `atomicOr`, `atomicXor`, `atomicExchange` (each returns the previous value), `atomicLoad`, `atomicStore`, and `atomicCompareExchange(i, compare, value)`, which returns `{old, exchanged}`. It is WGSL's weak form: it may fail when the values are equal, so retry on `exchanged`.
- **Indirect.** `{indirect: buffer, indirectOffset}` reads three u32 workgroup counts from a storage buffer at dispatch. `count` stays the limit of the guard, and the 65,535 groups check does not apply to it.

`node packages/shader/test/compute-model-check.mjs` (real GPU, under the GPU lock) checks each of these against a CPU result: a 1,024-item scan, 13 x 7 and 5 x 3 x 6 grids with the cells past the count left alone, an indirect dispatch sized by the pass before it, 256 invocations through every atomic including a compare-and-swap maximum, and a workgroup histogram.

## Compute that writes textures (`@margoengine/shader/compute-texture`)

`storageTexture` is a texture a ComputePass writes; `pingPong` is a pair that a pass reads and writes in steps, for simulations, painting and repeated filters. Both work with `texture()`, so a material, NodePass or later pass reads them like any other texture.

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {ComputePass, NodeMaterial, texture, vec2, vec4} from 'margoengine/shader';
import {pingPong} from 'margoengine/shader/compute-texture';
const stage = await createStage('#app');
const grid = pingPong(256, 256);                                     // rgba16float, zeros
ComputePass.attach(stage.engine, grid.pixels, i => {
  const at = grid.coord(i), p = grid.uv(at), step = vec2(1 / 256, 0);
  const blur = texture(grid, p.sub(step), 0).add(texture(grid, p.add(step), 0)).mul(0.5);   // filtered reads of last step
  return grid.store(at, blur.mul(0.99).add(vec4(p.x.mul(0.01))));                           // writes the next
});
createMesh(stage.engine, planeGeometry(2, 2), new NodeMaterial({shading: 'basic', colorNode: texture(grid).rgb}));
```

- **Formats.** All 16 that every WebGPU device can write: `rgba8unorm`, `rgba8snorm`, `rgba8uint`, `rgba8sint`, `rgba16float` (default), `rgba16uint`, `rgba16sint`, and `r32`, `rg32`, `rgba32` in `float`, `uint` and `sint`. `load` and `store` use `vec4f`, `vec4u` or `vec4i` to match. `texture()` works on `rgba8unorm`, `rgba8snorm`, `rgba16float`, and on 32-bit floats where the device has `float32-filterable`; other formats throw a MargoError `'unsupported'` when bound, and `load` reads them.
- **The pair.** `load` and `texture()` read the front image; `store` writes the back one. A pass that stores swaps the pair after its dispatch, so two passes in a frame run as two steps, and a pass that only reads swaps nothing. `swap()` does it by hand. The back image holds the step before last, so write every texel you want kept.
- **One texture, one role per pass.** A pass reads or writes a `storageTexture`, because WebGPU refuses both in one dispatch; doing both throws when the pass is built. For r32 formats, `{readWrite: true}` allows it in place, each invocation on its own texels; it needs the browser's WGSL feature `readonly_and_readwrite_storage_textures` and throws a MargoError `'unsupported'` without it. Reads and writes of different invocations are not ordered: use `pingPong` for neighbours.
- **Helpers.** `t.pixels` is the count for one invocation per texel, `t.coord(i)` the texel of invocation `i`, and `t.uv(coord)` its centre as 0..1. `store` runs where it is made, also inside `If` and `Loop`. Options: `data` (first contents, and what a device loss restores), `filter`, `wrap`.
- **Baking.** `t.texture(device)` is the GPUTexture to copy from. To get texels on the CPU, read them through `computeReadback`: `computeReadback(engine, t.pixels, i => out.store(i, t.load(t.coord(i))), out)`.
- **Lifecycle.** `dispose()` (or `using`) destroys the GPU copies; the next use makes them again from `data`, as a device loss does. What compute wrote is not kept across either.

`node packages/shader/test/compute-texture-check.mjs` (real GPU, under the GPU lock): eight generations of Conway's life on a 32 x 32 pair equal a CPU run, a material follows the pair as it swaps, all 16 formats write and read back through a second pass, a blur sampling in compute gives exact thirds, and in-place r32float counts to 3.

## Raw shaders (`@margoengine/shader/raw`, 10.1 kB min+gzip)

Your own WGSL vertex and fragment
entry points, any named attributes per vertex or per instance, live uniforms and textures, drawn into the scene's colour
and depth.

```ts
import {RawShaders, RawShaderMaterial, RawMesh} from 'margoengine/shader/raw';
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
- **Shared buffers.** Meshes whose packed vertex, instance or index bytes are equal hold one GPU buffer, counted per
  device, so 10,000 boxes built from one geometry upload it once and a run of them binds it once. Nothing to set:
  `new RawMesh({material, attributes, index})` with the same data is enough. A mesh leaves on its first write
  (`setAttribute`, `setIndex`), and the others keep drawing the old bytes. Each shared buffer keeps a CPU copy of its
  bytes to compare new meshes with, until its meshes have left it.
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
import {PostStack} from 'margoengine/post';
import {Tonemap} from 'margoengine/tonemap';
import {vignette, rgbShift} from 'margoengine/shader/effects';
const look = vignette({darkness: 0.6}), shift = rgbShift({amount: 0.004});
PostStack.attach(stage.engine, [new Tonemap(), shift, look]);
look.uniforms.darkness.value = 0.9;                   // live
```

| Preset | Parameters (default) |
| --- | --- |
| `vignette` | `darkness` 0.8, `radius` 0.4 (0 centre, 1 corner), `softness` 0.6 |
| `rgbShift` | `amount` 0.002 (UV units, about 4 px at 1920 wide), `angle` 0 (radians; red moves right, blue left) |
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
- `uv()` is the raw first UV set (no texture transform). `select` evaluates both branches; `If` runs one. `discard` in a NodeMaterial affects the beauty pass only: shadows still see the whole surface, and a NodePass's discarded pixels stay the cleared transparent black. Fn bodies cannot read stage inputs such as `uv()`; pass them as arguments. No automatic derivative-safe sampling: `texture(map, uv)`, `dpdx`, `dpdy` and `fwidth` inside an `If`, `Switch` or `While` on a per-pixel value, or a loop with a non-uniform bound or a `Break` on one, are a WGSL uniformity error, reported when the pipeline compiles; pass `texture` an explicit level there or sample before the branch.
- Raw meshes are not picked by `engine.pick`, are not culled, and draw only into the main colour and depth: shadows, SSAO and SSR G-buffers and depth prepasses do not see them. Raw uniforms are scalars, vectors, mat3x3f and mat4x4f (no arrays or structs); no storage buffers or extra bind groups; one colour target; 32-bit attribute formats only.
- NodePass runs only inside a PostStack (a stack of one is fine). An `hdr` pass that ends the chain tonemaps with ACES.
- Storage textures are 2D, one mip level, one sample; `@margoengine/shader/compute-texture` has no 3D or array form.
- ComputePass dispatches at most 65,535 workgroups per axis (an indirect dispatch is checked by the GPU only) and runs every frame while attached (`computeReadback` runs once; an atomic counter keeps counting unless `update()` resets it). Workgroup memory has no struct elements, and all of a pass's must fit the device's 16,384 bytes. Storage elements are 4- or 8- or 16-byte types (no vec3). A device loss re-uploads the CPU `data`, not what the GPU computed.
- No GLSL/WebGL2 output, no node editor, no built-in noise library (write it with `Fn` or `wgslFn`), no light, shadow or environment nodes, no skinning or morph nodes, no MRT outputs.

Size (min + gzip, Rolldown, peers external): whole package 15.2 kB (11.8 kB before statements, 13.9 kB before the compute model); `NodeMaterial` with colour nodes only, 6.0 kB (post, compute, texture and statement code tree-shake away; the test enforces this).

Apache-2.0. Optional, tree-shakable package; peers `@margoengine/core`, `@margoengine/materials` and `@margoengine/gltf-pro` (^0.1.0 || ^1.0.0).

Build and unit tests: `npm test --workspace @margoengine/shader`. Browser check on a real WebGPU adapter: `node packages/shader/test/browser-check.mjs`.
