# @margoengine/shader

Typed shader nodes that compile to readable WGSL: node materials, node post effects and node compute passes, with a visual node editor.

`ComputePass`, `ScenePass` and `RawShaders` also detach from their actual scene
on disposal, leaving same-name plugins in other scenes alone. Restoration keeps
the registration. For example:

```ts
import {Engine} from 'margoengine/core';
import {ComputePass, storage} from 'margoengine/shader';
import {ScenePass} from 'margoengine/shader/pass';
import {RawShaders} from 'margoengine/shader/raw';
const engine = await Engine.create(document.querySelector('canvas')!, {backend:'webgpu'});
const product = engine.createScene('product');
const values = storage(1, 'u32');
const compute = new ComputePass(1, i => values.store(i, 1));
const outputs = new ScenePass({outputs:{color:'rgba16float'}});
const raw = new RawShaders();
product.use(compute);
product.use(outputs);
product.use(raw);
compute.dispose();
outputs.dispose();
raw.dispose();
values.dispose();
engine.dispose();
```

`NodePass.dispose()` detaches the pass from its owning scene. A same-name pass in
another scene is preserved; device restoration keeps the registration. For a
secondary scene, attach the PostStack with `scene.use()`:

```ts
import {Engine} from 'margoengine/core';
import {PostStack} from 'margoengine/post/stack';
import {NodePass, inputColor} from 'margoengine/shader';
const engine = await Engine.create(document.querySelector('canvas')!, {backend:'webgpu'});
const product = engine.createScene('product');
const pass = new NodePass(inputColor());
const stack = new PostStack([pass]);
product.use(stack);
pass.dispose();
stack.dispose();
engine.dispose();
```

Import `margoengine/shader` from the `margoengine` package, or `@margoengine/shader` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Typed shader nodes that compile to readable WGSL. One graph API drives three hosts: `NodeMaterial` (a `@margoengine/materials` Material whose colour, normal, roughness, metalness, emissive, opacity and vertex position come from nodes), `NodePass` (a full-screen effect inside `@margoengine/post`'s PostStack) and `ComputePass` (a compute shader over a storage buffer, dispatched by the frame graph). Two more entries skip the graph: `@margoengine/shader/raw` draws your own WGSL with your own vertex layout, and `@margoengine/shader/effects` has ready-made screen effects. Graphs run on native WebGPU and on the full WebGL2 compatibility layer (`@margoengine/webgl2-compat`), which translates their WGSL to GLSL ES 3.00; `@margoengine/shader/glsl` takes GLSL functions in and shows the GLSL a graph becomes.

```ts
import {createMesh, loadTexture} from 'margoengine/materials';
import {sphereGeometry} from 'margoengine/geometry';
import {NodeMaterial, uniform, texture, mix, color, uv, sin, time, positionLocal, normalLocal} from 'margoengine/shader';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
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
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const strength = uniform(0.8);
const vignette = new NodePass(inputColor().rgb.mul(smoothstep(0.8, 0.2, screenUV.sub(0.5).length()).mul(strength)));
const fog = new NodePass(mix(inputColor().rgb, vec3(0.6, 0.7, 0.8), inputDepth().mul(-40).add(1).saturate()), {kind: 'hdr'});
PostStack.attach(stage.engine, [fog, new Tonemap(), vignette]);      // hdr passes before the display effect, ldr after
```

One pass needs no stack of yours: `await NodePass.attach(engine, node, options?)` loads `@margoengine/post` and adds
the pass to the scene's PostStack after the last effect of its kind, or runs it in a new PostStack when the scene has
none (`PostStack.join`), and returns it. `pass.dispose()` takes it out of that stack, and a stack made for it goes
with it. The options are the constructor's (`kind`, `name`) plus `signal`, which cancels the attach while the stack
loads.

```ts
import {NodePass, inputColor, vec4} from 'margoengine/shader';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const invert = await NodePass.attach(stage.engine, vec4(inputColor().rgb.oneMinus(), 1));
invert.dispose();                                                    // removes the pass and its PostStack
```

```ts
import {PostStack} from 'margoengine/post/stack';
import {Tonemap} from 'margoengine/tonemap';
import {NodePass, inputColor, vec4} from 'margoengine/shader';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const stack = PostStack.attach(stage.engine, [new Tonemap()]);
const invert = await NodePass.attach(stage.engine, vec4(inputColor().rgb.oneMinus(), 1));
console.log(stack.effects.length);                                   // 2: the pass joined the scene's stack after Tonemap
invert.dispose();                                                    // Tonemap keeps drawing
stack.dispose();
```

```ts
import {ComputePass, NodeMaterial, storage, vec4, deltaTime} from 'margoengine/shader';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const field = storage(new Float32Array(4 * 1024), 'vec4f');          // or storage(1024, 'vec4f') for zeros
ComputePass.attach(stage.engine, 1024, i => field.store(i, field.element(i).add(vec4(0, deltaTime, 0, 0))));
new NodeMaterial({colorNode: field.element(3).xyz});                 // any node reads it; field.buffer(device) hands it to other passes
```

Cut-outs and slicing with `discard(condition, value)`, GPU counters and compaction with atomics:

```ts
import {NodeMaterial, ComputePass, storage, discard, texture, materialColor, positionWorld, uniform, select, uint} from 'margoengine/shader';
import {loadTexture} from 'margoengine/materials';
import {createStage} from 'margoengine';
const n = 1024;
const stage = await createStage('#viewport', {backend: 'webgpu'});
const slice = uniform(1.5), leaf = await loadTexture('/leaf.png'), radii = new Float32Array(n).fill(0.2);
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
import {loadTexture} from 'margoengine/materials';
import {createStage} from 'margoengine';
const n = 1024;
const stage = await createStage('#viewport', {backend: 'webgpu'});
const fog = await loadTexture('/fog.png');
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
- Inputs: `uv()`, `vertexColor()`, `positionLocal`, `positionWorld`, `normalLocal`, `normalWorld`, `viewDirection`, `cameraPosition`, `screenUV`, `screenCoordinate`, `varying(node)`; in a NodeMaterial also `positionView`, `normalView`, `tangentLocal`, `tangentWorld`, `bitangentWorld`, `linearDepth`, `cameraNear`, `cameraFar`, `modelMatrix`, `viewMatrix`, `projectionMatrix`, `vertexIndex`, `instanceIndex`, `instanceMatrix`, `instanceColor`, `instanceUV` (see [Input nodes](#input-nodes)); frame uniforms `time`, `deltaTime`, `resolution`; `uniform(value, {type, name})` with `.value` live; `texture(materialsTexture, uv?, level?)`, `textureCube(cube, direction, level?)`, `texture3D(volume, uvw, level?)`.
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

`node packages/shader/test/editor-check.mjs` builds a graph with a real mouse and keyboard in a
browser (palette, typed constants, dragged wires), draws the material it makes and reads the pixels back: the colour, a
rebuild after a retyped number, no rebuild after a node move, undo and redo, and that an incomplete or ill-typed graph keeps
the last valid material on screen.

## Noise (`@margoengine/shader/noise`, 5.3 kB min+gzip on its own)

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
real adapter by `node packages/shader/test/noise-check.mjs`; on an Intel Arc 140V (Edge, 4096 points per field) the largest absolute difference was 2e-5 for single simplex and Perlin samples and 1.1e-4 for warped fBm (values span about [-1, 1]). Simplex seeds are compile-time
(each seed's 256-byte permutation is a private array, declared once per shader); `perlin3` takes a u32 node, so a uniform
reseeds without recompiling. Fractal sums unroll at graph build time (`octaves` 1..16). Example: `examples/noise.html` (terrain with CPU-placed markers resting on the GPU surface).

Cellular noise and 4D simplex, for cracks, cells, caustics and animation that loops:

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {NodeMaterial, cos, mix, sin, smoothstep, time, uv, vec3, vec4} from 'margoengine/shader';
import {simplex4, voronoi2, worley3} from 'margoengine/shader/noise';
const stage = await createStage('#app');
const cell = voronoi2(uv().mul(8), 5);                                                   // x nearest, y second, z cell id
const crack = smoothstep(0, 0.05, cell.y.sub(cell.x));                                   // 0 on every border
const turn = time.mul((Math.PI * 2) / 4);                                                // one circle in 4 seconds
const loop = simplex4(vec4(uv().mul(3), cos(turn), sin(turn)), 7);                       // repeats exactly every 4 seconds
createMesh(stage.engine, planeGeometry(4, 4), new NodeMaterial({
  colorNode: mix(vec3(0.1), vec3(cell.z, 0.5, loop.mul(0.5).add(0.5)), crack),
  emissiveNode: worley3(vec3(uv().mul(6), time)).oneMinus().pow(8).xxx,                  // caustic-like light
}));
```

| Node | Returns | CPU twin |
| --- | --- | --- |
| `simplex4(p, seed)` | `f32`, about -1 to 1 | `new Noise(seed).simplex4(x, y, z, w)` |
| `worley3(p, seed)` | `f32`, distance from 0 | `new Noise(seed).worley(x, y, z)` |
| `worley2(p, seed)` | `f32`, distance from 0 | none |
| `voronoi2(p, seed)`, `voronoi3(p, seed)` | `vec3f`: nearest distance, second nearest, cell id 0 to 1 | `.x` of `voronoi3` is `worley` |

`seed` of the cellular nodes may be a u32 node, as for `perlin3`; `simplex4` seeds are compile-time, like the other simplex nodes. `fbm`, `ridged` and `domainWarp` take `vec4f` fields too. The cellular search visits two cells each side, which is exact for both distances: 25 cells in 2D, 125 in 3D with three hashes each, so `voronoi3` and `worley3` are costly per pixel and suit a bake, a compute pass or a low-resolution texture better than a full-screen fragment.

## Utility nodes (`@margoengine/shader/utils`)

Ready nodes for what graphs keep rewriting. Each is plain nodes, so what you leave out costs nothing.

```ts
import {createStage} from 'margoengine';
import {createMesh, loadTexture} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {NodeMaterial, positionWorld, texture, vec3} from 'margoengine/shader';
import {blendOverlay, bumpNormal, hue, normalMap, oscSine, parallaxUV, remap, triplanar} from 'margoengine/shader/utils';
const stage = await createStage('#app');
const [albedo, normals, height] = await Promise.all([
  loadTexture('/brick.jpg'),
  loadTexture('/brick-normal.png', {colorSpace: 'linear'}),
  loadTexture('/brick-height.png', {colorSpace: 'linear'}),
]);
const carved = parallaxUV(height, {scale: 0.04});                                  // read every map with this UV
createMesh(stage.engine, planeGeometry(4, 4), new NodeMaterial({
  colorNode: blendOverlay(texture(albedo, carved).rgb, vec3(0.6, 0.5, 0.4), 0.5),
  normalNode: normalMap(texture(normals, carved).rgb),
}));
const rock = new NodeMaterial({
  colorNode: hue(triplanar(albedo, {scale: 0.5}).rgb, remap(oscSine(), 0, 1, -0.2, 0.2)),   // no UVs needed
  normalNode: bumpNormal(positionWorld.y.mul(8).sin().mul(0.02)),
});
createMesh(stage.engine, planeGeometry(2, 2), rock);
```

| Node | Gives | Notes |
| --- | --- | --- |
| `normalMap(rgb, {strength, frame, coord, flipY})` | a `normalNode` | `rgb` is the map's colour, so load it with `{colorSpace: 'linear'}`. `frame: 'derivatives'` (default) works on any mesh; `'tangents'` reads the mesh's. `flipY: false` is for glTF UVs, with their origin at the top left. |
| `bumpNormal(height, {strength, normal})` | a `normalNode` | `height` in world units, as a node. Tilts `normal`, by default the surface's. |
| `triplanar(map, {position, normal, scale, sharpness})` | `vec4f` | `map` is a `Texture` or a function of a UV. Three reads. World space by default; `positionLocal` and `normalLocal` stick it to the object. |
| `parallaxUV(height, {coord, scale, steps, frame})` | `vec2f` | `height` is a `Texture` (red, 1 at the surface) or a function of a UV. `scale` is the depth in UV units, default 0.05. `steps: 1` is a plain offset; the default 16 searches. |
| `rotateUV(coord, angle, center?)`, `rotateAxis(v, axis, angle)` | `vec2f`, `vec3f` | Radians. `center` defaults to 0.5; `axis` must be unit length. |
| `matcapUV(normal?, position?)` | `vec2f` | View space, and the same lookup as `MatcapMaterial`. |
| `equirectUV(direction, {flipY})` | `vec2f` | The panorama layout of `@margoengine/environment`: the image's middle faces -z. `flipY: false` is for images not stored flipped. |
| `luminance(rgb)`, `saturation(rgb, amount)`, `hue(rgb, angle)` | `f32`, `vec3f` | Linear colour, Rec. 709 weights. `saturation` 0 is grey. `hue` turns about the grey axis, in radians, so it keeps the sum of the channels and not the luminance. |
| `blendAdd`, `blendSubtract`, `blendMultiply`, `blendScreen`, `blendOverlay`, `blendHardLight`, `blendSoftLight`, `blendDodge`, `blendBurn`, `blendDarken`, `blendLighten`, `blendDifference`, `blendExclusion` | `vec3f` | `(base, top, opacity = 1)`, the W3C formulas, for colours from 0 to 1. Brighter light clips. |
| `remap(x, inLow, inHigh, outLow = 0, outHigh = 1)`, `remapClamp(...)` | as `x` | Scalars or vectors. `remap` runs past the ends, `remapClamp` stops at them. `inLow` and `inHigh` must differ. |
| `oscSine(t = time)`, `oscSquare`, `oscTriangle`, `oscSawtooth` | `f32` | 0 to 1, one period per unit of `t`, so one a second by default. `oscSine(time.mul(4))` runs four times as fast. |

`normalMap`, `bumpNormal` and `parallaxUV` read screen derivatives, or a texture in a search, so they belong in fragment nodes. Outside a uniform branch the derivative rule of [Limits](#limits) applies, and `parallaxUV`'s `height` function must sample with an explicit level (`texture(map, q, 0).r`). A `Texture` passed to it is read at level 0, so a distant surface can shimmer. The search sees no silhouette: the mesh's outline stays flat. Grazing views are held at about 84 degrees, so the shift stays bounded.

`node packages/shader/test/utils-check.mjs` runs the maths nodes and all 13 blend modes over 256 random inputs against JavaScript formulas, and reads the rest back from a wall: each normal map direction in both frames, a known slope through `bumpNormal`, both projections of `triplanar`, `parallaxUV` against the depth worked out by hand for a flat and a sloped field at 45 degrees, `matcapUV` against `MatcapMaterial` on a sphere, and a panorama's top and bottom rows.

## Read back one dispatch (`@margoengine/shader/readback`, 8.8 kB min+gzip on its own)

`ComputePass` runs every frame while attached. For a one-off result on the CPU (an editor tool, a bake, a test),
`computeReadback` runs a body once and resolves with a copy of a storage buffer:

```ts
import {storage, uint} from 'margoengine/shader';
import {computeReadback} from 'margoengine/shader/readback';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const cells = new Uint32Array(1024);
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
scripted device; `node packages/shader/test/readback-check.mjs` on a real adapter: 4,194,304 u32
read back exactly (65 ms on an NVIDIA Ampere GPU in Edge), a job on an engine that never rendered, abort right after
submit and while mapping, engine disposal and `device.destroy()` at both points, and a pipeline over the storage-binding
limit; every job destroyed its buffers and no GPU error escaped.

## Input nodes

What a vertex or fragment knows, as nodes in the shader root. Each one tree-shakes, and the shader only reads what the graph uses.

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {boxGeometry} from 'margoengine/geometry';
import {NodeMaterial, cameraFar, cameraNear, linearDepth, normalView, saturate, vec3} from 'margoengine/shader';
const stage = await createStage('#app');
const rim = saturate(normalView.z.negate().add(1)),                                  // bright where the surface turns away
  fog = linearDepth.sub(cameraNear).div(cameraFar.sub(cameraNear));                  // 0 at the near plane, 1 at the far one
createMesh(stage.engine, boxGeometry(1, 1, 1), new NodeMaterial({emissiveNode: vec3(rim, fog, 0)}));
```

| Node | Value | Notes |
| --- | --- | --- |
| `positionView`, `normalView` | view space: x right, y up, the camera looks along -z | |
| `linearDepth` | distance from the camera plane in world units, positive in front | |
| `tangentLocal`, `tangentWorld`, `bitangentWorld` | the mesh's tangent frame, unit length, with its handedness | a mesh without tangents gets a fixed frame around its normal, not lined up with its UVs: `computeTangents` from `@margoengine/geometry` gives real ones |
| `cameraNear`, `cameraFar` | the camera's planes, read back from its projection | perspective and orthographic |
| `modelMatrix`, `viewMatrix`, `projectionMatrix` | `mat4x4f` | `modelMatrix` is the mesh's, without an instance's |
| `vertexIndex`, `instanceIndex` | `u32` | in a fragment, the first vertex of the triangle |
| `instanceMatrix`, `instanceColor`, `instanceUV` | this instance's matrix, tint and UV scale (xy) and offset (zw) | identity, white and (1, 1, 0, 0) without instances |
| `textureCube(cube, direction, level?)` | a `CubeTexture` sampled along a direction | refuses a texture of another dimension |
| `texture3D(volume, uvw, level?)` | a `Texture` made with `{dimension: '3d'}` | refuses a texture of another dimension |

`NodePass` and `ComputePass` have no mesh, so these are NodeMaterial nodes. A depth pass reads `vertexIndex`, `instanceIndex` and the main camera, and nothing tied to tangents: a `positionNode` that reads those casts the mesh unmoved, as [Node output in every pass](#node-output-in-every-pass) describes.

`node packages/shader/test/inputs-check.mjs` reads each input back as a pixel on a wall the camera faces, with and without tangents, and compiles the instance inputs plain, instanced and in uniform rows.

## Custom vertex attributes

`attribute(name, type)` is a per-vertex value of the mesh being drawn, from its `geometry.attributes`. Types are one to
four of `f32`, `i32` or `u32` (`'f32'`, `'vec3f'`, `'vec2u'`, ...), and `data` holds one value of that type per vertex,
component after component. One material serves any number of meshes, each with its own data, and every pass that draws
the material reads it, shadows included. In `positionNode` it is the vertex's value; in the colour slots it is
interpolated across the triangle, and integer types take the triangle's first vertex.

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {NodeMaterial, attribute, color, mix, positionLocal, vec3} from 'margoengine/shader';
const stage = await createStage('#app');
const geometry = planeGeometry(2, 2, 32, 32), vertices = geometry.positions.length / 3;
const heat = Float32Array.from({length: vertices}, (_, i) => (geometry.positions[i * 3]! + 1) / 2);
const material = new NodeMaterial({
  colorNode: mix(color('#2040ff'), color('#ff4020'), attribute('heat', 'f32')),
  positionNode: positionLocal.add(vec3(0, 0, attribute('heat', 'f32').mul(0.5))),
});
const mesh = createMesh(stage.engine, {...geometry, attributes: {heat: {data: heat, type: 'f32'}}}, material);
heat.fill(1, 0, 33); // the first row of vertices
mesh.setGeometry({...geometry, attributes: {heat: {data: heat, type: 'f32'}}}, {start: 0, count: 33}); // uploads 33
```

`createMesh`, `createInstancedMesh`, `setGeometry` and a material swap throw when the geometry lacks an attribute the
material reads, gives it another type or the wrong number of values, or holds a value that does not fit (`NaN`, a
fraction for an integer type). The values are copied when the call is made: edit your array, then call `setGeometry`,
with a range to upload those vertices alone. Meshes that come from elsewhere (a loaded glTF, `BatchedMesh`) have no
`geometry.attributes`, so a material that reads one cannot draw them. The values of a mesh's attributes are interleaved
into one read-only storage buffer read by vertex index (one of the vertex stage's storage buffers), so the 80-byte
vertex and its pipelines are unchanged. `node packages/shader/test/attribute-check.mjs` (and `--compat`) compares meshes
drawn from attributes with the same meshes built on the CPU, pixel for pixel. Sources: D. Rákos, "Programmable Vertex
Pulling", in P. Cozzi and C. Riccio (eds.), "OpenGL Insights", CRC Press, 2012
(<https://www.taylorfrancis.com/books/9781439893777/chapters/10.1201/b12288-29>); W3C, "WebGPU Shading Language",
built-in values (<https://www.w3.org/TR/WGSL/#built-in-values>).

## Skinning and morph targets (`@margoengine/shader/deform`)

Deformation as nodes, so a graph can add its own effect on top and every pass draws the result. `skinning()` is linear blend skinning and `morphing()` is morph targets, both as glTF 2.0 defines them; they run in the vertex stage from `storage()` buffers you fill.

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {NodeMaterial, sin, storage, time, vec3} from 'margoengine/shader';
import {morphing, skinning, worldNormal} from 'margoengine/shader/deform';
const stage = await createStage('#app');
const geometry = planeGeometry(2, 2, 16, 16), vertices = geometry.positions.length / 3;
const skin = skinning({
  bones: storage(new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]), 'vec4f'),   // one matrix, four columns
  joints: storage(new Uint32Array(vertices * 4), 'vec4u'),                            // four bone numbers per vertex
  weights: storage(new Float32Array(vertices * 4).map((_, i) => (i % 4 ? 0 : 1)), 'vec4f'),
});
const morph = morphing({
  count: 1,
  vertices,
  positions: storage(new Float32Array(vertices * 4), 'vec4f'),                        // offsets, target after target
  weights: storage(new Float32Array([0.5]), 'f32'),
});
createMesh(stage.engine, geometry, new NodeMaterial({
  positionNormals: 'keep',                                                            // normalNode below replaces them
  positionNode: skin.position(morph.position()).add(vec3(0, sin(time).mul(0.1), 0)),  // morph, then bones, then an effect
  normalNode: worldNormal(skin.normal(morph.normal())),
}));
```

Update the pose by writing the buffer's `data` and calling `update()`, or write the buffer from a `ComputePass`.

| Function | Returns | Notes |
| --- | --- | --- |
| `skinningFromModel(model, primitive)` | `skinning()`'s result and `{geometry, bones, joints, weights, update()}` | `primitive` is an entry of `model.primitives` whose node has a skin. |
| `skinning({bones, joints, weights})` | `{position(p?), normal(n?)}` | `bones` holds the joint matrix times the inverse bind matrix, four `vec4f` columns per bone, in mesh space. `p` and `n` default to the mesh's own, so pass a morph's output to chain them. |
| `morphing({count, vertices, positions, normals?, weights})` | `{position(p?), normal(n?)}` | The buffers hold `count * vertices` offsets, target after target. Without `normals`, `normal()` is the base normal. |
| `worldNormal(n)` | a `normalNode` | A mesh-space normal in world space, per vertex and interpolated. Right on scaled and mirrored meshes. |

**Normals.** `normalNode: worldNormal(skin.normal())` costs one blend per vertex and is what glTF asks for. Left out, a `positionNode` makes normals by the rules of [Node output in every pass](#node-output-in-every-pass): three evaluations of the skin per vertex, and the true normal of the deformed surface.

**A loaded glTF character.** `skinningFromModel(model, primitive)` reads the skin for you: joints, weights, inverse bind matrices, the bind pose as `geometry`, and a joint palette that `update()` fills from the model's nodes, so `Animation`, a pose you set by hand or anything else that moves those nodes drives it.

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {Animation} from 'margoengine/animation';
import {NodeMaterial, positionWorld, sin, time, vec3} from 'margoengine/shader';
import {skinningFromModel, worldNormal} from 'margoengine/shader/deform';
const stage = await createStage('#app', {autoStart: false});
const {engine} = stage;
const model = await loadGLTF(engine, '/fox.glb');
const animation = Animation.attach(model);
const fox = skinningFromModel(model, model.primitives[0]);
createMesh(engine, fox.geometry, new NodeMaterial({
  positionNode: fox.position().add(vec3(0, sin(time).mul(5), 0)),
  normalNode: worldNormal(fox.normal()),
  colorNode: positionWorld.normalize(),
}));
model.root.visible = false;   // show the node version alone
engine.onFrame(() => fox.update());
engine.start();
```

Draw `fox.geometry` at the world origin: the palette holds world matrices, so the skin lands where the model stands. `update()` reads the matrices of the last transform update, so called from `onFrame` the skin runs a frame behind the joints. `JOINTS_1` (more than four influences) is refused, and a mesh drawn this way keeps its bind pose bounds, so a character that walks far from them needs `engine.render({culling: false})` or its own bounds.

**A character played by `@margoengine/animation`, on its own mesh.** Its compute deformer already replaced the vertices every pass fetches, so in a NodeMaterial on such a character `positionLocal` and `normalLocal` are the posed vertex: add an effect with `positionLocal.add(...)` and leave these nodes out.

`node packages/shader/test/deform-check.mjs` compares each of these with the same mesh deformed on the CPU: position, morph into skin, an effect on top, lit normals (also on a stretched, mirrored mesh, and from neighbours), a new pose, the shadow, and an effect on vertices a compute deformer moved.

## Extra outputs and scene passes (`@margoengine/shader/pass`)

A `ScenePass` draws its models into textures of its own before the frame's colour pass, and a `PassMaterial` writes extra outputs into them. Anything drawn later in the frame samples those textures with `texture()`: selective bloom, refraction, custom post chains.

```ts
import {createStage} from 'margoengine';
import {Material, createMesh} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {PostStack} from 'margoengine/post';
import {NodePass, inputColor, texture, uv, vec4} from 'margoengine/shader';
import {PassMaterial, ScenePass} from 'margoengine/shader/pass';
const stage = await createStage('#app');
const pass = ScenePass.attach(stage.engine, {outputs: {glow: 'rgba16float'}});
const lamp = createMesh(stage.engine, planeGeometry(1, 1), new PassMaterial({outputs: {glow: vec4(4, 2, 1, 1)}}));
const wall = createMesh(stage.engine, planeGeometry(4, 4), new Material({color: [0.5, 0.5, 0.5]}));
pass.add(lamp);
pass.add(wall);                                                           // a plain mesh hides the glow it covers
PostStack.attach(stage.engine, [new NodePass(inputColor().rgb.add(texture(pass.texture('glow'), uv()).rgb))]);
```

| Name | What it does |
| --- | --- |
| `ScenePass.attach(engine, {outputs, order?})` | `outputs` maps names to filterable colour formats such as `rgba16float` or `rgba8unorm`. `order` defaults to 0.5, before the colour pass. |
| `pass.add(model)` | Draws a gltf/pbr model or a mesh in the pass, opaque and masked surfaces only. Returns a remover. |
| `pass.texture(name)` | The output for `texture()`, the size of the drawing buffer. Transparent black where nothing was drawn. |
| `pass.velocity(previous?)` | A `vec2f` node for an output: how far the surface moved on screen since the last frame, in UV units. It covers camera motion; a moving mesh passes where it was as a world position. |
| `new PassMaterial({outputs, ...})` | A `NodeMaterial` with a `vec4f` node per output name, worked out after the surface, so `materialEmissive` and `materialNormal` hold the final values: `{emissive: vec4(materialEmissive, 1)}` is the glow of a surface alone. It draws as usual in the frame. |

**The lit colour.** The output name `color` holds the shaded colour of each surface, in linear light before tone mapping, whatever the canvas encodes, so a surface left out of the pass can show what is behind it and the frame encodes that light once:

```ts
import {createStage} from 'margoengine';
import {Material, createMesh} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {NodeMaterial, screenUV, sin, texture, time, vec2} from 'margoengine/shader';
import {ScenePass} from 'margoengine/shader/pass';
const stage = await createStage('#app');
const pass = ScenePass.attach(stage.engine, {outputs: {color: 'rgba16float'}});
pass.add(createMesh(stage.engine, planeGeometry(4, 4), new Material({color: [0.8, 0.3, 0.2]})));
const wobble = vec2(sin(screenUV.y.mul(40).add(time)).mul(0.01), 0);
const pane = createMesh(stage.engine, planeGeometry(1, 1), new NodeMaterial({emissiveNode: texture(pass.texture('color'), screenUV.add(wobble)).rgb}));
pane.root.setPosition([0, 0, 0.5]);
```

The pass draws each model a second time, and shading runs again only for `color`, single-sampled. The sky, core meshes, blended surfaces and other plugins are not in it. A model can be in a `ScenePass`, `SSR` and `SSGI` at once: each draws it with its own capture.

**The frame itself.** `sceneColor(engine)` reads what the frame has drawn so far, so core meshes, the sky, water, fog and other plugins are all there, resolved from MSAA, with no second draw. It is the snapshot `@margoengine/materials` transmission takes after the opaque phase, so the surface reading it is `transparent: true`, which draws after the snapshot, and other blended surfaces are not in it:

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {NodeMaterial, screenUV, sin, time, vec2} from 'margoengine/shader';
import {sceneColor} from 'margoengine/shader/pass';
const stage = await createStage('#app');
const behind = sceneColor(stage.engine);
stage.box({color: '#c04030'});
const wobble = vec2(sin(screenUV.y.mul(40).add(time)).mul(0.01), 0);
const pane = createMesh(stage.engine, planeGeometry(2, 2), new NodeMaterial({shading: 'basic', transparent: true, toneMapped: false, emissiveNode: behind.read(screenUV.add(wobble))}));
pane.root.setPosition([0, 0, 1]);
```

`behind.read(uv)` gives linear light, whatever the target encodes: on a display-encoded canvas it undoes the sRGB curve, and `toneMapped: false` encodes it back to the same value. A lit or tone-mapped surface adds its own light on top. `behind.texture` is the raw snapshot, in the frame's format. The frame pays for the snapshot from the first `sceneColor` until the last `dispose()`, and `hdrTarget` is the node telling which kind of target is bound.

`node packages/shader/test/pass-check.mjs` reads these back as pixels: two outputs with a plain mesh hiding one part, an output from a graph, a live uniform and the final emissive, the lit colour against the picture (sunlit and tone mapped too), a mesh moved in the same frame, a pane showing the wall behind it, a NodePass adding an output, a camera step as velocity, and a canvas resize.

## Node output in every pass

A graph is one description of a surface, so every pass draws it. Each pass gets its own variant, compiled from the same nodes when the material is made:

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {Shadows} from 'margoengine/shadows';
import {NodeMaterial, discard, normalLocal, positionLocal, sin, time, uv, vec3} from 'margoengine/shader';
const stage = await createStage('#app');
const flag = new NodeMaterial({
  doubleSided: true,
  positionNode: positionLocal.add(normalLocal.mul(sin(positionLocal.x.mul(6).add(time)).mul(0.1))),   // shading follows the wave
  colorNode: discard(uv().y.lessThan(0.1), vec3(0.8, 0.1, 0.1)),                                      // the shadow has the same hole
});
const mesh = createMesh(stage.engine, planeGeometry(2, 1, 64, 32), flag), shadows = Shadows.attach(stage.engine);
shadows.add(mesh);
```

| Pass | `positionNode` | `normalNode` | `discard()` |
| --- | --- | --- | --- |
| Colour, SSAO's G-buffer and ambient passes | yes | yes | yes |
| `Shadows`, `VirtualShadows`, `LocalShadows`, `Clustered` integrated shadows | yes | not read | yes |
| Picking primitives and contact shadows | yes | not read | yes |
| TAA velocity | yes: the surface moves as the mesh and camera do, and as the graph's uniforms changed since last frame | not read | yes |

**Normals.** After a `positionNode`, normals follow the new shape. `positionNormals: 'neighbours'` evaluates the graph again 0.001 mesh units to two sides of each vertex: smooth, for shapes worked out from `positionLocal`, at three evaluations of the graph per vertex. `'faces'` takes each triangle's normal in the fragment, for graphs that read `uv()`, whose neighbours a vertex cannot know: it shows facets on a coarse mesh and keeps a normal map's detail on top. `'keep'` leaves the mesh's normals. The default is `'faces'` when the graph reads `uv()`, else `'neighbours'`; a `normalNode` wins over `'faces'`.

**What a depth pass reads.** `cameraPosition`, `viewDirection`, `viewMatrix`, `projectionMatrix`, `positionView`, `normalView`, `linearDepth`, `cameraNear` and `cameraFar` are the main camera's in every depth pass, not the light's, so a mesh that faces the camera casts the shape the camera sees; in a multi-view frame that is `engine.camera`. A shadow has no surface, so fragment nodes that read `materialColor`, `materialNormal`, `materialRoughness`, `materialMetalness` or `materialEmissive` cast without their `discard()`, and a `positionNode` reading `tangentLocal`, `tangentWorld` or `bitangentWorld` casts the mesh unmoved; the colour pass is not affected. A `positionNode` also replaces a `displacementMap` in depth passes. Such a caster counts as moving, so shadow caches redraw it each frame. In TAA velocity a `positionNode` that reads the graph's uniforms (a `uniform()` you change, `time`, the camera) runs a second time on last frame's values, which TAA keeps per view, so a shape that moves over time leaves no ghost trail; nothing to register. A move driven by a storage buffer or a texture that changes (skinning bones, morph weights, a height map) is not tracked that way: its surface moves as the mesh and camera do.

`node packages/shader/test/passes-check.mjs` checks these on pixels: a caster moved by a graph against a plain mesh placed there in all four shadow passes, a cut caster against a half-sized one, both normal modes against the analytic normal of a wave, and SSAO's G-buffer pass drawing such a surface.

## Lighting written in the graph (`@margoengine/shader/lighting`)

`LightingMaterial` is a `NodeMaterial` that writes its own lighting: toon steps, hatching, a custom BRDF. Shadows, clustered lights and the environment keep working, because the graph reads what those effects worked out. Attach them as for any material.

```ts
import {createStage} from 'margoengine';
import {createMesh} from 'margoengine/materials';
import {sphereGeometry} from 'margoengine/geometry';
import {Shadows} from 'margoengine/shadows';
import {Clustered} from 'margoengine/clustered';
import {floor, max, normalWorld, reflect, viewDirection} from 'margoengine/shader';
import {LightingMaterial, ambientLight, environment, localLight, sunColor, sunDirection, sunVisibility} from 'margoengine/shader/lighting';
const stage = await createStage('#app');
// A BRDF of your own, for the sun and every clustered light: three flat bands.
const toon = new LightingMaterial({
  color: '#3366ff',
  lightModel: ({normal, direction, color}) => color.mul(floor(max(normal.dot(direction), 0).mul(3).add(0.5)).div(3)),
});
// Or the whole pixel: the sun as a band through its shadow, the rest of the light as it is, a mirror's rim on top.
const inked = new LightingMaterial({
  color: '#ff8000',
  lightingNode: sunColor.mul(sunVisibility).mul(normalWorld.dot(sunDirection).step(0.3).mul(0.25))
    .add(localLight).add(ambientLight)
    .add(environment(reflect(viewDirection.negate(), normalWorld), 0.2).mul(0.1)),
});
const shadows = Shadows.attach(stage.engine), lights = Clustered.attach(stage.engine);
lights.setLights([{position: [0, 2, 1], range: 12, color: [1, 0.3, 0.1], intensity: 20}]);
for (const material of [toon, inked]) {
  const mesh = createMesh(stage.engine, sphereGeometry(0.8, 32, 16), material);
  shadows.add(mesh);
  lights.add(mesh);
}
```

- **`lightModel`** is a function of `{direction, view, normal, color, roughness, metalness}` that returns the light leaving towards the camera, the cosine term included. It replaces the physically based response to the sun and to each clustered point, spot and extra directional light; their colour, falloff and shadows apply around it. Rectangle and disc area lights, ambient and emissive light stay as they are. It compiles to one WGSL function, so stage inputs (`uv()`, `positionLocal`, material nodes) work in it. It runs inside the clustered light loop, where WGSL forbids implicit-derivative reads: sample a texture with an explicit level, or in `lightingNode`.
- **`lightingNode`** is the final linear colour of the pixel, before fog and tone mapping. It reads:

| Node | What it reads | Without the effect |
| --- | --- | --- |
| `sunDirection` | unit vector towards the sun | |
| `sunColor` | the sun's colour times intensity, before shadows | |
| `sunVisibility` | the shadow effect's result per channel, 0 to 1 | 1 |
| `localLight` | the sum of the clustered lights, with their shadows | zero |
| `ambientLight` | ambient light with the material's response: image-based light, probes, the sky | the built-in sky |
| `litColor` | the colour the material shows with its usual lighting | |
| `environment(direction, roughness = 0)` | the scene's ambient light on a mirror facing `direction`, also in `lightModel` | the built-in sky |

In `lightingNode`, `normalWorld` is the shading normal, after normal maps and `normalNode`. The nodes above other than `environment` are refused in other slots and in `lightModel`, where there is no one sun. Set either option or both; `lightModel` then shapes `litColor`, `localLight` and the sun's share of them. `shading` must stay `'standard'`. An SSAO replay and the G-buffer see `normalNode` and the ambient light as they do on any material.

`node packages/shader/test/lighting-check.mjs` checks these against what they read: `sunVisibility` under a real shadow map, Lambert written as a `lightModel` against `shading: 'lambert'` on the sun and a point light, and `litColor`, `localLight` and `ambientLight` against a plain `Material` with the same effects.

## The compute model

`ComputePass` runs 1D, 2D or 3D grids, shares memory inside a workgroup, and can take its size from an earlier pass. None of it costs anything in a pass that does not use it. Here each 256-wide workgroup sums its items with a prefix scan:

```ts
import {ComputePass, Loop, If, Var, globalId, localIndex, storage, uint, workgroup, workgroupBarrier} from 'margoengine/shader';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const values = new Uint32Array(1024).fill(1);
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

`node packages/shader/test/compute-model-check.mjs` checks each of these against a CPU result: a 1,024-item scan, 13 x 7 and 5 x 3 x 6 grids with the cells past the count left alone, an indirect dispatch sized by the pass before it, 256 invocations through every atomic including a compare-and-swap maximum, and a workgroup histogram.

## Subgroups and half floats (`@margoengine/shader/subgroups`)

WebGPU's two optional compute features as nodes. Each comes from a function of the engine, which writes the fast WGSL when
the device has the feature and portable WGSL when it does not, so one graph runs everywhere. Ask for the features when you
create the engine; an adapter that lacks one simply leaves it out.

```ts
import {createStage} from 'margoengine';
import {ComputePass, If, Let, storage} from 'margoengine/shader';
import {halfFloats, subgroups} from 'margoengine/shader/subgroups';
const stage = await createStage('#app', {features: ['subgroups', 'shader-f16']});
const sg = subgroups(stage.engine), h = halfFloats(stage.engine);

const values = storage(new Uint32Array(1024).fill(3), 'u32'), total = storage(1, 'u32', {atomic: true});
ComputePass.attach(stage.engine, 1024, i => {
  const sum = Let(sg.add(values.element(i)));            // all lanes at once, kept before any branch
  If(sg.elect(), () => { total.atomicAdd(0, sum); });    // one atomic per subgroup, not one per invocation
});

const input = storage(new Float32Array(1024).fill(0.5), 'f32'), output = storage(1024, 'f32');
ComputePass.attach(stage.engine, 1024, i => output.store(i, h.full(h.half(input.element(i)).mul(0.25).add(1))));
console.log(sg.supported, h.supported);
```

| Node | What each lane gets | With no `subgroups` feature |
| --- | --- | --- |
| `sg.size`, `sg.id` | lanes in this subgroup, this lane's number | `1`, `0` |
| `sg.add`, `mul`, `min`, `max`, `and`, `or`, `xor` | the reduction over the lanes | `x` |
| `sg.inclusiveAdd`, `inclusiveMul` | the reduction up to and including this lane | `x` |
| `sg.exclusiveAdd`, `exclusiveMul` | the reduction over the lanes before this one | `0`, `1` |
| `sg.all(b)`, `sg.any(b)` | whether `b` holds on every lane, on any lane | `b` |
| `sg.ballot(b)` | a bit per lane where `b` holds | `b` as bit 0 |
| `sg.elect()` | true on one lane | `true` |
| `sg.broadcast(x, lane)`, `sg.broadcastFirst(x)` | `x` of that lane, a constant, or the first active lane | `x` |
| `sg.shuffle(x, lane)`, `shuffleUp`, `shuffleDown`, `shuffleXor` | `x` of another lane | `x` |

- **The fallback is a subgroup of one lane.** WebGPU never promises a subgroup size, so code written properly works for any
  `size`, and one is a size: nothing to branch on, no shared memory, and the same answer at the end. Lanes of a `shuffle`
  must stay below `size`.
- **Uniform control flow.** A subgroup call has to run on every lane together, so a ComputePass that uses one runs whole
  workgroups as a barrier does: its count is a multiple of `workgroupSize`, and WGSL refuses a call under a branch. Keep a
  result with `Let` before an `If`.
- **Half floats.** `h.half(x)` gives an f16 node (`'f16'`, `'vec2h'` to `'vec4h'`) and `h.full(x)` turns it back. Numbers join in
  as `0.25h`, and an f32 node has to go through `half` first, which TypeScript checks. Without `shader-f16` the same graph
  stays f32, so a value keeps more precision and goes past 65,504 without turning infinite.
- **Packed storage.** `packHalf2(vec2)` and `unpackHalf2(u32)` hold two floats rounded to f16 in one u32 on every device.
  Storage buffers have no f16 element type.

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

`node packages/shader/test/compute-texture-check.mjs` (real GPU): eight generations of Conway's life on a 32 x 32 pair equal a CPU run, a material follows the pair as it swaps, all 16 formats write and read back through a second pass, a blur sampling in compute gives exact thirds, and in-place r32float counts to 3.

## GLSL functions (`@margoengine/shader/glsl`, 18.2 kB min+gzip on its own)

Bring GLSL you already have. `glslFn` turns a GLSL ES 3.00 or 1.00 function (with the helpers, structs and constants
it uses) into a node function, as `wgslFn` does for WGSL. It is translated to WGSL once, so the same source runs on
WebGPU and on the WebGL2 layer: there is no second copy to keep in step. `toGLSL` goes the other way: the GLSL ES 3.00
program the WebGL2 layer makes from a `NodePass`, a `NodeMaterial` that has drawn, or WGSL stages.

```ts
import {createStage} from 'margoengine';
import {createMesh, Texture} from 'margoengine/materials';
import {planeGeometry} from 'margoengine/geometry';
import {NodeMaterial, NodePass, time, uv} from 'margoengine/shader';
import {glslFn, toGLSL} from 'margoengine/shader/glsl';
const stage = await createStage('#app');
const tint = glslFn<'vec3f'>(`vec3 tint(vec3 c, float t) { return mix(c, c.bgr, t); }`);
const checker = new Texture({data: new Uint8Array([255, 255, 255, 255, 40, 40, 40, 255, 40, 40, 40, 255, 255, 255, 255, 255]), width: 2, height: 2});
const tiles = glslFn<'vec4f'>(`#version 300 es
vec4 tiles(sampler2D map, vec2 uv, float count) {
  vec2 cell = fract(uv * count);
  return texture(map, uv * count) * (0.75 + 0.25 * step(0.5, cell.x));
}`);
const material = new NodeMaterial({colorNode: tint(tiles(checker, uv(), 4).rgb, time.sin().mul(0.5).add(0.5))});
createMesh(stage.engine, planeGeometry(2, 2), material);
const program = toGLSL(new NodePass(tiles(checker, uv(), 4)), await import('margoengine/webgl2-compat/glsl'));
console.log(program.fragment.source);   // GLSL ES 3.00, with program.fragment.textures and .uniforms
```

- Arguments: a node or a number per scalar or vector parameter (a boolean for `bool`), a node for a matrix, and a
  `Texture` from `@margoengine/materials` of the matching dimension for a sampler. A texture that `texture()` also
  reads binds once.
- Options: `name` picks the function to call (default: the last one defined), `defines` adds `#define` lines,
  `flipY: true` flips y at every 2D lookup and `texelFetch` for code written for a bottom-left image origin, and
  `strict: true` keeps WGSL's derivative uniformity rule. By default translated functions turn that rule off, so an
  implicit `texture()` inside a branch on a per-pixel value compiles, as GLSL allows.
- Lookups in vertex or compute nodes read level 0, as `texture()` nodes do. A source without `#version` reads as
  GLSL ES 3.00; `#version 100` and `#version 300 es` are accepted.
- Errors are MargoError `failed` with `line` and `column` (1-based, in your source) and a help link. A uniform or a
  `gl_` built-in inside the function is refused with "pass it as an argument". Translation is cached per source,
  options and stage (256 entries).
- `glslToWGSL(code, options)` returns the WGSL, the entry name, the parameters and the result type, for tools.
- `toGLSL(target, translator, options)` takes the layer's translator as its second argument, so this entry never loads
  the 44 kB layer itself; `options` are the layer's (`clipControl`, `points`, `uniformBlockSize`,
  `accurateInverseTrig`). A `NodeMaterial` that has not drawn yet throws MargoError `state`.

`node packages/shader/test/glsl-check.mjs` and `node packages/shader/test/glsl-check.mjs --compat` (real GPU) run every fixture of `test/glsl-fixtures.js` as written in the browser's own WebGL2 compiler and as `glslFn`
in a NodePass: within 1 level per channel on every pixel, natively and on the layer. NodeMaterials built from GLSL
match the same graphs written in WGSL and `texture()`, and every `toGLSL` program compiles and links in raw WebGL2.

## Raw shaders (`@margoengine/shader/raw`, 15.2 kB min+gzip)

Your own WGSL vertex and fragment
entry points, any named attributes per vertex or per instance, live uniforms, textures and storage buffers, drawn into the
scene's colour and depth. Raw meshes also cast shadows, write SSAO's G-buffer, are culled and are picked like other meshes.

```ts
import {RawShaders, RawShaderMaterial, RawMesh} from 'margoengine/shader/raw';
import {loadTexture} from 'margoengine/materials';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const raw = RawShaders.attach(stage.engine);
const texture = await loadTexture('/map.png');
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), colors = new Float32Array(9).fill(1), uvs = new Float32Array(6);
const indices = new Uint16Array([0, 1, 2]), offsets = new Float32Array(15 * 3);
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
  textures: {map: texture},                                   // a materials Texture, GPUTexture or GPUTextureView, or (device) => texture;
                                                              // {texture, sampler, dimension, sampleType} as a plain object adds options
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
  declares `camera` (`view`, `projection`, `viewProjection`, `position`, `time`, `resolution`, the target size,
  `deltaTime`, and `viewport`, the drawn view as x, y, width and height in target pixels), `mesh`
  (`world`, and `normal`, the inverse transpose of its 3x3), `struct Attributes` with one `@location` per attribute in
  the order given, `uniforms.<name>` (the WGSL layout is computed for you), each texture as `<name>` plus
  `<name>Sampler`, each storage buffer as `<name>`, and two colour helpers. Fragment output is written exactly as returned (raw); `margoDisplay(c)`
  applies the scene's display transform (PBR Neutral and sRGB on a display target, nothing inside an HDR PostStack
  capture, which tonemaps later) and `margoEncode(c)` only the sRGB encoding, for unlit colour as lines and points write
  it. With a separate `fragmentShader` each stage is its own module, so both may use `main`.
- **Arrays and structs.** `count` makes a uniform array, `struct` a uniform struct, and both together an array of structs.
  An array's value is a list of elements or all their numbers in a row. Elements of a uniform array sit 16 bytes apart, so
  the element is a vec3, a vec4, a matrix or a struct; a list of `f32` or `vec2f` belongs in a storage buffer, and the
  material says so when it refuses one. A struct field is a plain uniform type, a nested struct (`{struct: {...}}`, read as
  `uniforms.light.falloff.near`) or an array (`{type, count}` or `{count, struct}`), nested as deep as you like; each
  sits at its WGSL uniform layout offset, every generated struct aligned to 16 bytes:
  `{struct: {gain: 'f32', inner: {struct: {tint: 'vec3f'}}, rows: {type: 'vec4f', count: 2}}, value: {gain: 1, inner: {tint: [1, 0, 0]}, rows: [[0, 0, 0, 1], [0, 0, 0, 1]]}}`.
- **Storage buffers and bind groups.** `storage: {name: buffer}` declares `<name>:array<type>`. Pass a `storage()` node as
  it is, so a compute pass fills what the mesh draws, or `{buffer, type, access}` with your own GPUBuffer (or a function of
  the device, which also serves device restoration; a plain buffer is lost with its device, so the material binds a zeroed
  stand-in and `engine.onError` hears of it once, see Device restore below). `type` may be a struct your code declares, in every stage that reads
  the buffer. `'read_write'` binds to the fragment stage only, as WebGPU requires. `groups` adds up to two bind groups at
  `@group(2)` and `@group(3)` for bindings your WGSL declares; each is a function of the device.
- **Device restore.** A texture or storage buffer you made belongs to the device that made it. Give `textures` a
  `(device) => GPUTexture | GPUTextureView` and it is made once per device, so it is back after `engine.rebootDevice()`;
  `ShaderMaterial` sampler uniforms take the same function. A plain GPUTexture, view or buffer is lost with its device: the
  binding reads opaque white (a storage buffer reads a zeroed stand-in), `engine.onError` hears of it once (`'state'`,
  [#borrowed-lost](https://margoengine.com/errors#borrowed-lost)), the frame keeps drawing, and assigning a new one to
  `material.textures.<name>.texture` or `material.storage.<name>.buffer` brings it back.
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
- **The pass.** Opaque raw meshes draw at frame-graph order 0.5 (after core meshes, before gltf/pbr and materials meshes
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

### Shadows, SSAO, culling and picking

```ts
import {createStage} from 'margoengine';
import {SSAO} from 'margoengine/post/ssao';
import {Picking} from 'margoengine/selection';
import {Shadows} from 'margoengine/shadows';
import {RawMesh, RawPicking, RawShaderMaterial, RawShaders} from 'margoengine/shader/raw';
const stage = await createStage('#app');
const engine = stage.engine, raw = RawShaders.attach(engine);
const material = new RawShaderMaterial({
  vertexShader: `
    struct Out {@builtin(position) clip:vec4f, @location(0) world:vec3f, @location(1) normal:vec3f}
    @vertex fn vertex(a:Attributes)->Out {
      let w = mesh.world * vec4f(a.position, 1);
      return Out(camera.viewProjection * w, w.xyz, normalize(mesh.normal * a.normal));
    }
    @fragment fn gbuffer(i:Out)->MargoGBuffer {return margoGBuffer(i.normal, i.world, vec3f(0.3));}
    @fragment fn fragment(i:Out)->@location(0) vec4f {return margoDisplay(vec4f(vec3f(0.3) + i.normal.y * 0.5, 1));}`,
  gbufferEntry: 'gbuffer',
});
const mesh = raw.add(new RawMesh({
  material,
  attributes: {
    position: {data: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], type: 'vec3f'},
    normal: {data: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], type: 'vec3f'},
  },
  index: [0, 1, 2, 0, 2, 3],
}));
Shadows.attach(engine).add(mesh);                                 // casts through your vertex shader
SSAO.attach(engine).add(raw);                                     // meshes with gbufferEntry write their own normals
const picking = RawPicking.attach(Picking.attach(engine), raw);   // engine.pick now answers raw meshes
await raw.ready();
const hit = await engine.pick(200, 150);
console.log(picking.rawOf(hit) === mesh);
```

- **Shadows.** `shadows.add(mesh)` draws the mesh into every cascade of `Shadows` with your vertex stage, where
  `camera.viewProjection` and `camera.projection * camera.view` are the cascade's light matrix. Both sides cast, whatever
  the material's `cull`, as in the depth pass of every other caster. Your fragment stage runs
  too when its code holds `discard`, so a cut-out shape casts a cut-out shadow. Transparent materials cast none.
  `virtualShadows.add(mesh)` (`@margoengine/shadows/virtual`) and `localShadows.add(mesh)`
  (`@margoengine/clustered/shadows`, point, spot, extra directional and area lights) cast the same way, and so does
  Clustered's `addShadowCaster(mesh)` for its integrated `shadows` maps, which call the hook with forward depth
  (`depthCompare: 'less-equal'`) and redraw every frame. `LocalShadows`
  and `{static: true}` keep a raw caster's maps until `mesh.shadowVersion` changes: new attributes or indices, a newly
  compiled pipeline, another material, new uniform values, or a moved mesh (its `matrix` or the core mesh it follows).
  A vertex stage that moves points by `camera.time`, a texture or a storage buffer needs `mesh.invalidateShadow()` when
  they change, or `localShadows.add(mesh, {dynamic: true})`. A raw shader receives no shadow unless it samples one
  itself. `packages/shadows/test/cutout-casters-browser.mjs` checks a whole and a `discard`-cut raw quad in all four
  passes and the cached maps following a move and a uniform, on WebGPU and the WebGL2 layer.
- **TAA.** A raw shader's motion is its own code, so TAA sees only a raw mesh's depth and the camera's motion, and a
  shape the shader moves ghosts. Give the material `velocityEntry`: a `@vertex fn` beside your vertex entry, with the same
  inputs, that returns `margoVelocity(position, positionBefore)`, where the vertex is now and where it was last frame, both
  before `mesh.world`. It may read `margoBefore.time` (last frame's `camera.time`) and `margoBefore.world`; keep last
  frame's value of any uniform your move reads beside it. The velocity pass draws with `depthCompare: 'equal'` against
  your vertex entry's depth, so compute the position there with the same expression `margoVelocity` uses
  (`camera.viewProjection * mesh.world * vec4f(p, 1)`) and declare it `@invariant`, as `MargoVelocity` does: WGSL lets
  two programs round the same expression differently otherwise (WGSL 12.10), and a pixel then gets no motion. Then `taa.add(raw)`: opaque meshes with the entry draw their
  motion into TAA's velocity pass, with last frame kept per TAA view. Without the entry nothing changes.

```ts
import {EngineKernel} from 'margoengine/core';
import {TAA} from 'margoengine/taa';
import {RawMesh, RawShaderMaterial, RawShaders} from 'margoengine/shader/raw';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
const raw = RawShaders.attach(engine), taa = TAA.attach(engine);
const material = new RawShaderMaterial({
  vertexShader: `
    fn wave(p:vec3f, t:f32)->vec3f {return p + vec3f(0, sin(p.x * 3 + t) * 0.2, 0);}
    @vertex fn vertex(a:Attributes)->@builtin(position) @invariant vec4f {
      return camera.viewProjection * mesh.world * vec4f(wave(a.position, camera.time), 1);
    }
    @vertex fn velocity(a:Attributes)->MargoVelocity {
      return margoVelocity(wave(a.position, camera.time), wave(a.position, margoBefore.time));
    }
    @fragment fn fragment()->@location(0) vec4f {return margoDisplay(vec4f(0.2, 0.5, 0.9, 1));}`,
  velocityEntry: 'velocity',
  cull: 'none',
});
raw.add(new RawMesh({
  material,
  attributes: {position: {data: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], type: 'vec3f'}},
  index: [0, 1, 2, 0, 2, 3],
}));
taa.add(raw); // the waving quad writes its own motion
```

- **SSAO.** Opaque raw meshes occlude from their depth with nothing to set, like every mesh, and their pixels are not
  darkened. `ssao.add(raw)` with `gbufferEntry` on a material goes further: that `@fragment fn` returns
  `margoGBuffer(worldNormal, worldPosition, ambient)`, SSAO uses your normals, and `ambient` is the light it may take away.
  `GTAO` takes the same source (`gtao.add(raw)`), as it shares SSAO's G-buffer.
- **SSR and SSGI.** Opaque raw meshes hide what is behind them in SSR's and SSGI's depth with nothing to set, and neither
  reflect nor take bounced light. `ssr.add(raw)`, `ssgi.add(raw)`, `targets.add(raw)` (`@margoengine/post/mrt`), `bounce.add(raw)` (`@margoengine/clustered`) and `pass.add(raw)` (a node `ScenePass`) with `captureEntry` on a material go further: that
  `@fragment fn` returns `margoCapture(MargoMaterial(worldPosition, worldNormal, toEye, baseColor, metallic, roughness,
  ambient))`, SSR reflects the screen in the surface by its normal, metallic and roughness, and SSGI adds the light bounced
  onto it by its normal and diffuse albedo (`ambient` is the ambient light your colour fragment added, which SSGI's bounce
  stands in for; `vec3f(0)` when it added none). In the capture pass meshes without the entry still write their depth, with
  their own `discard`s. `packages/shader/test/raw-check.mjs` (`ssrOwn`, `ssgiOwn`, `gtaoOwn`) checks each against the same
  mesh without the entry, on WebGPU and the WebGL2 layer.
- **Node ScenePass.** In a `ScenePass` the capture entry's `color` output is the material's base colour. To write
  another output, declare `var<private> margoOut<name>:vec4f;` in your fragment code and assign it in the entry before it
  returns (`margoOutglow = vec4f(1, 0, 0, 1);` for an output `glow`); declare `var<private> margoBeauty:vec4f;` and
  assign it to give `color` your own lit colour. Outputs the entry leaves alone read as transparent black.
  `raw-check.mjs` (`passOwn`, `passDepth`) checks it on both backends.

```ts
import {createStage} from 'margoengine';
import {SSR} from 'margoengine/post/ssr';
import {RawMesh, RawShaderMaterial, RawShaders} from 'margoengine/shader/raw';
const stage = await createStage('#app');
const raw = RawShaders.attach(stage.engine);
const floor = new RawShaderMaterial({
  vertexShader: `
    struct Out {@builtin(position) clip:vec4f, @location(0) world:vec3f, @location(1) normal:vec3f}
    @vertex fn vertex(a:Attributes)->Out {
      let w = mesh.world * vec4f(a.position, 1);
      return Out(camera.viewProjection * w, w.xyz, normalize(mesh.normal * a.normal));
    }
    @fragment fn capture(i:Out)->MargoCapture {
      return margoCapture(MargoMaterial(i.world, i.normal, camera.position - i.world, vec3f(0.9), 1.0, 0.05, vec3f(0)));
    }
    @fragment fn fragment(i:Out)->@location(0) vec4f {return vec4f(0.05, 0.05, 0.05, 1);}`,
  fragmentEntry: 'fragment',
  captureEntry: 'capture',
});
raw.add(new RawMesh({
  material: floor,
  attributes: {
    position: {data: [-3, 0, 3, 3, 0, 3, 3, 0, -3, -3, 0, -3], type: 'vec3f'},
    normal: {data: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], type: 'vec3f'},
  },
  index: [0, 1, 2, 0, 2, 3],
}));
SSR.attach(stage.engine).add(raw); // the raw floor is a mirror of what the screen holds
```

- **Culling.** A mesh out of view is skipped in the colour, shadow, SSAO and pick passes, and counted in `raw.stats.culled`.
  The sphere comes from a per-vertex vec3f `position`. A mesh with no such attribute, or an instanced one, is never culled
  unless you give `bounds: {center, radius}`. A vertex shader that moves points outside that sphere needs `bounds` or
  `frustumCulled: false`.
- **Picking.** `RawPicking.attach(picking, raw)` draws the meshes into the pick tile after the scene's meshes, in the same
  depth test, with your vertex stage, so a mesh is picked where it shows. `hit.mesh` is the core mesh it follows or an empty
  stand-in, and `picking.rawOf(hit)` gives the RawMesh back. One ID covers a mesh, so a hit names no instance, and a
  fragment's `discard` does not cut the pick.

Measured on an NVIDIA Ampere GPU (Edge, 4x and 1x MSAA) by `node scripts/shader-raw-gpu-check.js`:
a quad with a per-vertex colour attribute and a per-instance offset and `u32` id matches its analytic colours within 0.55
of 255 over 5,225 pixels, is hidden pixel for pixel behind a core box and drawn in front of it, live uniforms and a ranged
`setAttribute` update it, device restoration redraws identical pixels, and an attached plugin with nothing visible or a
removed one leaves every pixel unchanged.

## GLSL programs as materials (`@margoengine/shader/glsl-material`, 35.6 kB min+gzip on its own, `RawMesh` included)

Paste a whole GLSL program, as a web engine's `RawShaderMaterial` takes one: a GLSL ES 3.00 or 1.00 vertex and fragment
stage with `void main()`, your own `uniform`s, attributes and varyings. `ShaderMaterial` translates it to WGSL once per
source and defines, with the same GLSL front end as `glslFn`, so one GLSL source draws on WebGPU and on the WebGL2
layer. It is a `RawShaderMaterial`, so it draws with a `RawMesh` in the `RawShaders` plugin and keeps that render state.

```ts
import {createStage} from 'margoengine';
import {RawShaders, RawMesh} from 'margoengine/shader/raw';
import {ShaderMaterial, glslProgramToWGSL} from 'margoengine/shader/glsl-material';
const stage = await createStage('#viewport', {controls: false});
const raw = RawShaders.attach(stage.engine);
const vertexShader = `#version 300 es
in vec2 position;
out vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;
const fragmentShader = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float time;
uniform vec3 tint;
uniform bool stripes;
out vec4 color;
void main() {
  float wave = 0.5 + 0.5 * sin(time + vUv.x * 12.0);
  color = vec4(tint * (stripes ? wave : 1.0), 1.0);
}`;
const material = new ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms: {time: {value: 0}, tint: {value: '#ff8800'}, stripes: {value: true}},
});
raw.add(new RawMesh({material, attributes: {position: {data: new Float32Array([-1, -1, 3, -1, -1, 3]), type: 'vec2f'}}}));
stage.engine.onFrame((_, delta) => (material.uniforms.time.value = (material.uniforms.time.value as number) + delta));
console.log(glslProgramToWGSL({vertexShader, fragmentShader}).uniforms);   // the GLSL names, types and WGSL members
```

- **Uniforms.** `material.uniforms.<name>.value` is live and never translates again. Values: a number
  or boolean, an array, typed array or `{x, y, z, w}` for a vector or a column-major matrix, `'#rrggbb'` for a `vec3`,
  and for a `sampler2D`, `samplerCube`, `sampler3D` or `sampler2DArray` a `Texture` of `@margoengine/materials`, a
  GPUTexture or a GPUTextureView. Types come from the GLSL: `float`, `int`, `uint`, `bool` and their vectors, `mat2`,
  `mat3`, `mat4`. A uniform the program declares and `uniforms` omits starts at zero (a sampler with no texture reads
  opaque white, as raw materials do; GL would read black). Both stages may declare the same uniform; its type must
  match.
- **Attributes and varyings.** Attributes match a `RawMesh` attribute by name. One the mesh lacks reads GL's default
  (0, 0, 0, 1), and a narrower one is widened the same way, so `in vec4 position` takes a `vec2f` attribute. Varyings
  link by name and type; integer varyings must be `flat`. A flat varying takes its value from the first vertex of a
  triangle on WebGPU and from the last in GL, so keep flat values equal across a primitive.
- **GL conventions.** By default the program sees GL's: `gl_Position` in GL clip space (z from -1 to 1, mapped onto
  Margo's reversed depth), `gl_FragCoord` with rows counted from the bottom and GL depth, `dFdy` along GL window y,
  `gl_FragDepth` in GL depth, and 2D lookups and `texelFetch` reading a Margo texture as GL reads one uploaded with
  `UNPACK_FLIP_Y_WEBGL` (`flipY: true`). `flipY: false` reads rows top down, and `clipSpace: 'webgpu'` takes clip z
  from 0 to 1 unchanged. Built-ins: `gl_Position`, `gl_PointSize`, `gl_VertexID`, `gl_InstanceID`, `gl_FragCoord`,
  `gl_FrontFacing`, `gl_PointCoord`, `gl_FragColor`, `gl_FragData[0]`, `gl_FragDepth`, `gl_DepthRange` and the
  `gl_Max*` constants at WebGL's minimums.
- **Defines.** `defines: {NAME: value}` go before both stages (`true` as 1). Assigning `material.defines`, or editing
  it and setting `material.needsUpdate = true`, translates again; so does assigning `vertexShader` or `fragmentShader`.
  Translations are cached per source and defines (64 programs), so switching back costs nothing.
- **Render state.** Everything a `RawShaderMaterial` takes (`transparent`, `blending`, `depthTest`, `depthWrite`,
  `cull`, `colorWrite`, `depthCompare`, `depthBias`, `alphaToCoverage`), plus the GL names a pasted program's
  material sets: `side` ('front', 'back' or 'double'; not together with `cull`), `depthFunc` in GL's sense (nearer is
  less, default 'less-equal'), `polygonOffset` with `polygonOffsetFactor` and `polygonOffsetUnits`, and
  `blending: 'custom'` with `blendSrc`, `blendDst`, `blendEquation` and their `Alpha` forms. All of them are live.
- **Built-in names.** `builtins` picks the names under which the engine supplies its matrices and attributes; see
  [Engine values under familiar names](#engine-values-under-familiar-names).
- **Errors.** Syntax and link errors throw MargoError `failed` from the constructor with `stage`, `line` and `column`
  in your GLSL as written and a help link: a varying whose type or interpolation differs between the stages, one read
  but never written, mixed versions, a uniform declared with two types, an unsupported uniform type, more than one
  colour output or `gl_FragData` above 0. `glslProgramToWGSL(source)` returns both stages' WGSL and the uniform,
  texture, attribute and varying tables for tools.

`node packages/shader/test/glsl-material-check.mjs` and the same command with `--compat`
draw each program of `test/glsl-material-fixtures.js` with the browser's own WebGL compiler (WebGL 1 for GLSL ES 1.00,
WebGL 2 for 3.00) and as a `ShaderMaterial`, then again after changing uniforms or defines: within 1 level per channel
on every pixel, natively and on the layer.

### Engine values under familiar names

A program pasted from another web engine reads that engine's names for the model, view and projection matrices and
the vertex streams. `builtins` supplies Margo's values under one convention's names, each named after its signature
uniform; [docs/porting-glsl.md](../../docs/porting-glsl.md) says which convention each engine uses.

| `builtins` | Uniforms the engine fills | Attributes `shaderMesh` fills |
| --- | --- | --- |
| `'modelViewMatrix'` | `modelMatrix`, `viewMatrix`, `modelViewMatrix`, `projectionMatrix`, `normalMatrix`, `cameraPosition`, `isOrthographic`; all may be used undeclared | `position`, `normal`, `uv`, `uv1`, `color`, `tangent`, `instanceMatrix`, `instanceColor`; all may be used undeclared |
| `'worldViewProjection'` | `world`, `view`, `projection`, `worldView`, `worldViewProjection` | `position`, `normal`, `uv`, `uv2`, `color` (vec4) |
| `'matrix_model'` | `matrix_model`, `matrix_normal`, `matrix_view`, `matrix_viewInverse`, `matrix_view3`, `matrix_projection`, `matrix_viewProjection`, `view_position`, `camera_params`, `screen_size`, `viewport_size`, `view_index` | `vertex_position`, `vertex_normal` |
| `'auto'` (default) | the one convention the program's names show, or none; names of two conventions throw MargoError `failed` | as chosen |
| `false` | none: the program declares every matrix it reads | none |

A name you list in `uniforms` is yours and the engine leaves it alone. Matrices follow GL: the projection takes view
z onto clip z from -1 to 1, which the material maps onto Margo's reversed depth, so a program that writes
`projectionMatrix * modelViewMatrix * vec4(position, 1.0)` draws in depth order with core meshes. `attributes:
{myPos: 'position'}` maps your own attribute names onto streams; `defaultAttributeValues` sets what a stream the mesh
lacks reads (the defaults: `uv` and `uv1` (0, 0), `color` and `instanceColor` white).

`shaderMesh(geometry, material, options)` builds the `RawMesh`: `geometry` is `{positions, normals, uvs, uvs1, colors,
tangents, indices}` or a core `Geometry`; `options.attributes` and `options.instances` add data by GLSL name, and
`instances: {instanceMatrix, instanceColor}` draws one copy per matrix. The mesh's `material` keeps its type, so its
uniforms stay typed:

```ts
import {createStage} from 'margoengine';
import {RawShaders} from 'margoengine/shader/raw';
import {ShaderMaterial, shaderMesh, type ShaderUniformValue} from 'margoengine/shader/glsl-material';
const stage = await createStage('#viewport');
const raw = RawShaders.attach(stage.engine);
const material = new ShaderMaterial({
  builtins: 'modelViewMatrix',
  vertexShader: `#version 300 es
out vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`,
  fragmentShader: `#version 300 es
precision highp float;
uniform float time;
in vec3 vNormal;
out vec4 color;
void main() {
  color = vec4(vNormal * 0.5 + 0.5 + 0.1 * sin(time), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  uniforms: {time: {value: 0}},
});
const s = 0.5;
const positions = [-s, -s, 0, s, -s, 0, s, s, 0, -s, s, 0];
const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
const instanceMatrix = [-1, 0, 1].flatMap((x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x * 1.5, 0, 0, 1]);
const mesh = raw.add(shaderMesh({positions, normals, indices: [0, 1, 2, 0, 2, 3]}, material, {instances: {instanceMatrix}}));
stage.engine.onFrame((_, delta) => {
  const time: ShaderUniformValue = mesh.material.uniforms.time.value;   // typed through the mesh
  mesh.material.uniforms.time.value = (time as number) + delta;
});
```

- **Includes.** `#include <name>` and `#include "name"` expand from `includes: {name: 'glsl'}` (8 deep), in both
  stages. Two chunks are built in for the fragment stage: `tonemapping_fragment` applies the display tone map to the
  colour the program wrote (PBR Neutral, only when Margo displays the frame) and `colorspace_fragment` encodes it to
  sRGB when the target expects that. An unknown include throws with its stage, line and column.
- **Output colour.** A program's colour is taken as sRGB, as GL would show it on screen (`outputColorSpace: 'srgb'`,
  the default); `'linear'` takes it as linear light and lets Margo tone map and encode it like its own materials. A
  program that includes `colorspace_fragment` writes its colour as it is.
- **Float textures the device cannot filter.** WebGPU filters `rgba32float` only with the optional `float32-filterable`
  feature. Name such a `sampler2D` in `unfilterable: {name: {filter: 'linear', wrap: 'clamp'}}` (`filter` `'nearest'`,
  `'linear'` or `'mipmap'`, `wrap` `'clamp'` or `'repeat'`): it binds as an unfilterable-float texture and its
  `texture()`, `textureLod`, `textureGrad` and `textureOffset` lookups read texels with `textureLoad` and filter them as
  GL does (OpenGL ES 3.0.6 section 3.8.10), so the result is the same with or without the feature. Shadertoy's buffer
  channels use it.

### Raw depth state

`RawShaderMaterial` also takes `depthCompare` (default 'greater-equal', Margo's reversed depth), `depthBias` and
`depthBiasSlopeScale` (triangles only), `alphaToCoverage` (multisampled targets) and `blending: 'subtractive'`, all
live. A texture with `sampleType: 'depth'` is a `texture_depth_2d` (or cube, or 2d array) with a comparison sampler
(default `compare: 'less-equal'`) for `textureSampleCompare`; with no texture it reads a far depth of 1.

### Blocks, structs, arrays and samplers

Uniforms of any shape a GLSL ES program declares are live values under the names GL gives them:

- **Structs and arrays.** `uniform Light lights[2];`, `uniform vec2 offsets[4];`, nested structs and the non-square
  matrices (`mat2x3` and the rest) take a value shaped like the type: an object per struct, a list per array, and a flat
  run of numbers also works for an array of vectors. Each leaf is its own raw member, so changing one field reuploads
  without translating. `glslProgramToWGSL` lists each leaf (`lights[1].color`) with its `root` and `path`.
- **Uniform blocks.** `uniform Rig { ... };` makes its fields plain uniforms; `uniform Rig { ... } rig;` makes one
  struct uniform `rig`. A block holds no samplers (GLSL ES 3.00 4.3.7).
- **Sampler arrays.** `uniform sampler2D maps[2];` takes a list of textures. Indexing with a constant reads one
  binding; any other index (a loop counter, an ES 1.00 loop index) reads every element and keeps the one picked.
- **Integer and shadow samplers.** `isampler2D`, `usampler2D` (and 3D, cube, 2D array) read textures of integers;
  `sampler2DShadow`, `samplerCubeShadow` and `sampler2DArrayShadow` compare against a depth texture. Pass a
  `GPUTexture` or `{texture, sampler}`, with the sampler's `compare` (default 'less-equal'), as the value.

### Points, flat varyings, wireframes and saving

- **Sized points.** A vertex stage that writes `gl_PointSize`, drawn with `topology: 'point-list'`, gives squares of that
  many pixels of the view it is drawn in, centred on each point, with `gl_PointCoord` from the upper left (OpenGL ES
  3.0.6 3.4): `shaderMesh`
  draws each point as an instance of six corners. A point whose centre leaves the view is dropped whole, as in GL.
- **Flat varyings.** GL takes a flat value from a primitive's last vertex and WebGPU from its first, so for a program with
  a `flat` varying `shaderMesh` lists each triangle or line from its last vertex, winding kept; a strip becomes a list.
- **Wireframe.** `wireframe: true` (live, on any `RawShaderMaterial`) draws each edge of the triangles once as a line.
- **Saving.** `glslMaterialCodec(ShaderMaterial)` from `@margoengine/shader/serialization` keeps the GLSL, the uniform
  values and the state, and restoring translates the GLSL again. It takes the class, so the entry loads no GLSL front
  end; without it a ShaderMaterial has no codec and capturing one throws rather than saving its WGSL translation.

```ts
import {createStage} from 'margoengine';
import {captureMaterialLibrary, restoreMaterialLibrary} from 'margoengine/materials/serialization';
import {RawShaders} from 'margoengine/shader/raw';
import {ShaderMaterial, shaderMesh} from 'margoengine/shader/glsl-material';
import {glslMaterialCodec, shaderMaterialCodecs} from 'margoengine/shader/serialization';
const stage = await createStage('#viewport');
const raw = RawShaders.attach(stage.engine);
const material = new ShaderMaterial({
  vertexShader: `#version 300 es
in vec3 position;
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `#version 300 es
precision highp float;
struct Band { vec3 color; float width; };
uniform Shade { Band bands[2]; float mixAmount; } shade;
out vec4 color;
void main() {
  float t = fract(gl_FragCoord.x / (shade.bands[0].width + shade.bands[1].width));
  color = vec4(mix(shade.bands[0].color, shade.bands[1].color, step(0.5, t) * shade.mixAmount), 1.0);
}`,
  uniforms: {shade: {value: {bands: [{color: [1, 0.5, 0], width: 8}, {color: [0, 0.4, 1], width: 8}], mixAmount: 1}}},
});
raw.add(shaderMesh({positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], indices: [0, 1, 2, 0, 2, 3]}, material));
material.wireframe = true;
const codecs = [...shaderMaterialCodecs, glslMaterialCodec(ShaderMaterial)];
const saved = await captureMaterialLibrary({material}, {codecs});
const copy = (await restoreMaterialLibrary(saved, {codecs})).material as ShaderMaterial;
console.log(copy.wireframe, copy.uniforms.shade.value);
```

- **Lights.** `lights: true` hands the program the scene's lights under Margo's names, as uniforms it declares (only
  those it declares are filled, each pass, with no new translation when they change): `vec3 sunDirection` (world space,
  unit, towards the sun), `vec3 sunColor` (`engine.lighting` radiance times intensity, linear), `vec3 ambientLight`
  (the ambient light core meshes get: `ambient` times radiance w), and the point and spot lights of
  `shaderScene(raw).setLights(clustered)` (a `Clustered` of `@margoengine/clustered`, or any `{list}` of its lights) as
  `pointLights[N]` and `spotLights[N]` with `int pointLightCount` and `spotLightCount`. Declare each list as an array
  of your own struct with any of the fields `vec3 position`, `vec3 color` (colour times intensity times
  `intensityScale`, linear), `float range` (0 is unlimited), `float decay` (default 2) and, for spots, `vec3 direction`,
  `float outerCos` and `float innerCos` (cosines of the cone's outer and inner half-angles). The lists fill in list
  order, as many as `N` holds. Clustered's own falloff is `clamp(1 - (d / range)^4, 0, 1)^2 / max(d^decay, 2^-12)`, and
  its cone `smoothstep(outerCos, innerCos, dot(-l, direction))`.
- **Fog.** `fog: true` hands over `shaderScene(raw).setFog(fog)` (an `@margoengine/environment` `Fog`, or any object with its
  fields) as `vec3 fogColor`, `float fogNear`, `fogFar`, `fogDensity`, `fogHeight` and `fogHeightFalloff`. Margo's fog
  is linear from near to far at distance `d` from the camera, or `1 - exp(-(density d)^2)` when density is above 0,
  times `exp(-heightFalloff max(y - height, 0))`. `fogColor` comes as your program writes colour: display-ready
  (sRGB, as given) by default, linear with `outputColorSpace: 'linear'` or `#include <colorspace_fragment>`. Without a
  fog the values read as no fog (density 0, near and far at the float maximum). A name you give in `uniforms` is yours.
- **Motion vectors.** `velocity: true` gives TAA (`taa.add(raw)`) the motion of every vertex the program moves: its
  vertex stage runs a second time with last frame's model matrix, view-projection and time, and TAA reads where each
  vertex was, as a WGSL `velocityEntry` writes it. A move driven by your own uniforms names, for each, the uniform that
  holds its value of last frame (`velocity: {wave: 'waveBefore'}`), which you set before you change the first; it needs
  no declaration. Without `velocity` TAA sees the camera's motion over the depth only, so a shape the shader moves
  leaves a trail.
- **What each entry carries.** The scene options and `shaderScene` live in `shader/glsl-material` alone. `ShaderPass`
  and `Shadertoy` draw with the same program core without them, so their entries hold no light, fog or motion code;
  `toy.material()` refuses `lights`, `fog` and `velocity`. Their materials still pass `instanceof ShaderMaterial`.

```ts
import {createStage} from 'margoengine';
import {sphereGeometry} from 'margoengine/geometry';
import {TAA} from 'margoengine/taa';
import {RawShaders} from 'margoengine/shader/raw';
import {ShaderMaterial, shaderMesh, shaderScene} from 'margoengine/shader/glsl-material';
const stage = await createStage('#viewport');
const raw = RawShaders.attach(stage.engine);
shaderScene(raw)
  .setFog({color: '#8899aa', near: 4, far: 30})
  .setLights({list: [{position: [2, 2, 3], range: 12, color: [1, 0.6, 0.3], intensity: 4}]});
const material = new ShaderMaterial({
  lights: true,
  fog: true,
  velocity: {wave: 'waveBefore'},
  uniforms: {wave: {value: 0}, waveBefore: {value: 0}},
  vertexShader: `uniform float wave;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vec3 p = position + normal * 0.1 * sin(wave + position.y * 4.0);
  vNormal = mat3(modelMatrix) * normal;
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`,
  fragmentShader: `precision highp float;
struct Point { vec3 position; vec3 color; float range; float decay; };
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 ambientLight;
uniform Point pointLights[4];
uniform int pointLightCount;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(vNormal);
  vec3 c = ambientLight + sunColor * max(dot(n, sunDirection), 0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= pointLightCount) break;
    vec3 l = pointLights[i].position - vWorld;
    float d = length(l);
    float x = d / pointLights[i].range;
    float w = clamp(1.0 - x * x * x * x, 0.0, 1.0);
    c += pointLights[i].color * max(dot(n, l / d), 0.0) * w * w / max(pow(d, pointLights[i].decay), 1.0 / 4096.0);
  }
  float f = clamp((distance(vWorld, cameraPosition) - fogNear) / (fogFar - fogNear), 0.0, 1.0);
  gl_FragColor = vec4(mix(c * 0.4, fogColor, f), 1.0);
}`,
});
raw.add(shaderMesh(sphereGeometry(1, 48, 24), material));
TAA.attach(stage.engine).add(raw);
stage.engine.onFrame((_, delta) => {
  material.uniforms.waveBefore.value = material.uniforms.wave.value;
  material.uniforms.wave.value = (material.uniforms.wave.value as number) + delta * 3;
});
```

## GLSL post passes (`@margoengine/shader/glsl-pass`, 40.4 kB min+gzip on its own)

`ShaderPass` runs a full-screen GLSL ES 1.00 or 3.00 program as a stage of `@margoengine/post`'s PostStack, in the
`{uniforms, vertexShader, fragmentShader}` form web engines use for post passes. The stack's colour reaches the program
through the first of `tDiffuse`, `textureSampler` and `uColorBuffer` it declares (or the sampler named by `input`).
Without a vertex stage the pass supplies one triangle over the target that writes `vUv`, `vUV` or `vUv0`, whichever the
fragment reads, with uv (0, 0) at the lower left; a vertex stage of your own gets `position` (xyz) and `uv`, and
`projectionMatrix` and `modelViewMatrix` are the identity, as for a full-screen quad.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post';
import {ShaderPass} from 'margoengine/shader/glsl-pass';

const stage = await createStage(document.querySelector('canvas')!);
const pass = new ShaderPass({
  uniforms: {amount: {value: 0.5}},
  fragmentShader: `precision highp float;
uniform sampler2D tDiffuse;
uniform float amount;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  gl_FragColor = vec4(mix(c.rgb, vec3(dot(c.rgb, vec3(0.299, 0.587, 0.114))), amount), 1.0);
}`,
});
PostStack.attach(stage.engine, [pass]);
pass.uniforms.amount.value = 1; // live, no translation
```

`await ShaderPass.attach(engine, shader, options?)` does the same in one call: it loads `@margoengine/post`, adds the
pass to the scene's PostStack after the last effect of its kind (or a new PostStack when there is none) and returns
it, and `pass.dispose()` takes it out again, with the stack when attach made it. The options are the constructor's
plus `signal`.

```ts
import {createStage} from 'margoengine';
import {ShaderPass} from 'margoengine/shader/glsl-pass';

const stage = await createStage(document.querySelector('canvas')!);
const invert = await ShaderPass.attach(stage.engine, {
  fragmentShader: `uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() { gl_FragColor = vec4(1.0 - texture2D(tDiffuse, vUv).rgb, 1.0); }`,
});
invert.dispose(); // removes the pass and its PostStack
```

- **Options.** `kind`: `'ldr'` (default) runs on display colour after tonemapping and writes display colour;
  `'hdr'` runs on linear light before it and, when last, goes through the display transform (its `outputColorSpace`
  defaults to `'linear'`). `input` (default the first convention name declared; `null` for a pass that reads nothing),
  `name`, and the program options of `ShaderMaterial`: `glslVersion`, `flipY`, `strict`, `builtins`, `attributes`
  (`{aPosition: 'position'}`), `includes`, `outputColorSpace`, `blending` (default `'none'`: the pass replaces its
  output). `pass.material` is the ShaderMaterial (`pass.material.code('fragment')` shows the WGSL).
- **What a pass reads.** `gl_FragCoord` counts pixels of the target from the lower left, as GL's; the input sampler
  reads the stack's colour with v up, as a GL render target reads. In a view of a multi-view frame the pass draws
  inside the view, and `vUv` names the input pixels under it (it runs over the view's part of the target). The pipeline compiles at once, so the first frame
  draws. `await pass.ready()` resolves when it has.
- **Not here.** Scene depth as a sampler (NodePass has `inputDepth()`). Shadertoy programs run through
  `@margoengine/shader/shadertoy`, below.

## Shadertoy programs (`@margoengine/shader/shadertoy`, 49.9 kB min+gzip on its own)

`Shadertoy` runs the Image tab of a Shadertoy program, `void mainImage(out vec4 fragColor, in vec2 fragCoord)` as
written in Shadertoy's editor, with its documented inputs: `iResolution`, `iTime`, `iTimeDelta`, `iFrameRate`,
`iFrame`, `iChannelTime[4]`, `iChannelResolution[4]`, `iMouse`, `iDate`, `iSampleRate`, `iChannel0` to `iChannel3`
and the older `iGlobalTime`, with the Common tab, Buffer A to D, keyboard, video and audio channels. One toy draws
three ways: as a PostStack pass, into a texture once a frame, or on a mesh.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post';
import {RawShaders} from 'margoengine/shader/raw';
import {shaderMesh} from 'margoengine/shader/glsl-material';
import {Shadertoy} from 'margoengine/shader/shadertoy';

const stage = await createStage(document.querySelector('canvas')!);
const toy = new Shadertoy(`void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0)), 1.0);
}`);
PostStack.attach(stage.engine, [toy.pass()]); // over the whole screen

// Or on a mesh, with fragCoord = uv * resolution; the attached toy runs the clock and draws toy.texture.
stage.engine.use(toy); // Shadertoy.attach(stage.engine, source) makes and attaches a toy in one call
RawShaders.attach(stage.engine).add(shaderMesh({positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], uvs: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3]}, toy.material()));
```

- **Channels.** `new Shadertoy({image: {source, iChannel0, ...}, resolution})`: a channel is a
  `@margoengine/materials` Texture, a GPUTexture or view, `(device) => GPUTexture | GPUTextureView` (made once per
  device; see Device restore below), `'input'` (in a pass, the colour of the stage before), a
  buffer `'A'` to `'D'`, `'keyboard'`, a video or image, an AnalyserNode, or null (opaque black, as GL reads an
  unbound unit), or `{texture, type, filter, wrap, resolution}` with `type` `'2d'` (default; `'3d'` for a 3D
  GPUTexture), `'cube'` or `'3d'`, `filter` `'linear'` (default), `'nearest'` or `'mipmap'` (a texture brings its own
  levels), `wrap` `'clamp'` (default) or `'repeat'`. A function's texture is a sampler2D unless `type` says `'3d'` or
  `'cube'`. 2D channels read Margo's images upright (v up, as Shadertoy's flipped uploads read); `iChannelResolution`
  is the GPUTexture's size (a function's: the texture it made), a Texture's `width` and `height`, the target for
  `'input'`, or `resolution`.
- **Changing a channel.** `toy.setChannel(index, texture, tab)` (tab default `'image'`, else `'bufferA'` to
  `'bufferD'`, `'cubeA'` or `'sound'`) gives a texture channel a new GPUTexture or view of its sampler type, a
  Texture, a function or null, a video or image channel another, and an audio channel another AnalyserNode. The toy's
  own channels (`'input'`, a buffer, `'cubeA'`, `'keyboard'`) are set when it is made and throw a TypeError here, as
  does a texture of another sampler type.
- **Device restore.** A GPUTexture or view you made belongs to the device that made it. A function channel is made
  again on the new device after `engine.rebootDevice()`. A plain one is lost: the channel reads opaque black (as an
  unbound one), `engine.onError` hears of it once (`'state'`,
  [#borrowed-lost](https://margoengine.com/errors#borrowed-lost)) under the channel's name, the frame keeps drawing,
  and `toy.setChannel` brings it back. The toy's buffers, Cube A and its keyboard, video and audio textures are its
  own and are made again by themselves.

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post';
import {Shadertoy} from 'margoengine/shader/shadertoy';

const stage = await createStage(document.querySelector('canvas')!);
// Made once per device, so the channel is back by itself after a device restore.
const noise = (device: GPUDevice) => {
  const texture = device.createTexture({size: [64, 64], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture}, crypto.getRandomValues(new Uint8Array(64 * 64 * 4)), {bytesPerRow: 64 * 4}, [64, 64]);
  return texture;
};
const toy = new Shadertoy({
  image: {
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(texture(iChannel0, fragCoord / iChannelResolution[0].xy).rgb, 1.0);
}`,
    iChannel0: {texture: noise, wrap: 'repeat'},
  },
});
PostStack.attach(stage.engine, [toy.pass()]);
// A plain texture works too, but is lost with its device: set a new one after a restore.
toy.setChannel(0, noise(stage.engine.gpu!));
```
- **Inputs.** `toy.time`, `toy.frame`, `toy.timeDelta`, `toy.frameRate`, `toy.mouse` (`[x, y, clickX, clickY]` in
  pixels) and `toy.date` (year, month from 0 as JavaScript's Date, day, seconds since midnight; `undefined` follows
  the clock) are settable; `iSampleRate` is `sampleRate` (default 44100). The clock starts at frame 0, time 0 and adds
  each frame's delta; `pause()`, `play()` and `reset()` control it. A pass runs it by itself; for a material or the
  texture attach the toy (`engine.use(toy)`, or `Shadertoy.attach(engine, options)`). The assigned `{value}`s are read only: set the toy. Paused, the buffers
  and the keyboard, video and audio channels hold until `toy.frame` is set, which runs them once.
- **Targets.** `toy.pass(options)` is a ShaderPass (`kind`, `name`, `flipY`, `blending` as there): `iResolution` is the
  target's size and fragCoord its pixel, from the lower left. `toy.texture` is an rgba8unorm image of `resolution`
  (default 512 x 512) drawn before the scene each frame while the toy is attached, for raw, node and GLSL materials.
  `toy.material(options)` is a ShaderMaterial (render state options as there) with fragCoord = uv * `resolution`.
  `toy.fragmentShader`, `toy.meshShaders` and `toy.buffers` show the GLSL around each source; an error names its tab
  (`error.tab`: `'common'`, `'image'`, `'bufferA'` to `'bufferD'`, `'cubeA'`, `'sound'`) and that tab's own line.

### Multipass: Common, Buffer A to D, keyboard, video and audio

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post';
import {Shadertoy} from 'margoengine/shader/shadertoy';

const stage = await createStage(document.querySelector('canvas')!);
const toy = new Shadertoy({
  common: 'vec3 palette(float t) { return 0.5 + 0.5 * cos(6.2832 * (t + vec3(0.0, 0.33, 0.67))); }',
  // Buffer A reads its own last frame: a trail that fades.
  bufferA: {
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy, dot_ = 0.5 + 0.3 * vec2(cos(iTime), sin(iTime * 1.3));
  float d = length(uv - dot_);
  fragColor = max(texture(iChannel0, uv) * 0.97, vec4(palette(iTime * 0.1) * smoothstep(0.05, 0.0, d), 1.0));
}`,
    iChannel0: 'A',
  },
  image: {
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec3 trail = texture(iChannel0, fragCoord / iResolution.xy).rgb;
  float space = texelFetch(iChannel1, ivec2(32, 0), 0).x; // the space bar is down
  fragColor = vec4(mix(trail, 1.0 - trail, space), 1.0);
}`,
    iChannel0: {texture: 'A', filter: 'mipmap'},
    iChannel1: 'keyboard',
  },
});
PostStack.attach(stage.engine, [toy.pass()]);
```

- **Common and buffers.** `common` is placed before every tab's source. `bufferA` to `bufferD` take a source and
  channels as `image` does; each frame they draw in the order A, B, C, D, then the image, into rgba32float targets of
  the image's size that start at zero. A channel given `'A'` to `'D'` reads that buffer's latest image: its own last
  frame, this frame's for a buffer drawn before it. A buffer keeps all four components as written (negative and above
  1 too); the image writes opaque colour.
- **Filtering a buffer.** A buffer channel's `filter` is `'nearest'`, `'linear'` or `'mipmap'` (trilinear; the buffer's
  mip levels are made each frame by a 2 x 2 box) and `wrap` `'clamp'` or `'repeat'`. rgba32float can be filtered by
  the device only with `float32-filterable`, which is optional in WebGPU, so a linear or mipmap buffer channel reads
  its texels with `textureLoad` and filters them as GL does (four loads a level, OpenGL ES 3.0.6 section 3.8.10). It
  reads the same on every device, with or without the feature, and needs no `features` option. A function that takes
  `sampler2D` filters as the channel passed to it says.
- **Keyboard.** `'keyboard'` is a 256 x 3 channel as Shadertoy's: `texelFetch(iChannel0, ivec2(keyCode, row), 0).x`
  is 1 when the key is down (row 0), went down this frame (row 1) or has been toggled by its presses (row 2). It
  listens on `keyboard` (default the window) and stops on `dispose()`.
- **Video and images.** A `<video>`, canvas, OffscreenCanvas, ImageBitmap or `<img>` is copied into its channel each
  frame (a video once it has a frame; an image or ImageBitmap once), upright as Shadertoy's flipped uploads.
  `iChannelTime` is the video's `currentTime` and `iChannelResolution` its size. `filter: 'mipmap'` makes its levels.
- **Audio.** An `AnalyserNode` (or any object with `getByteFrequencyData` and `getByteTimeDomainData`) is a 512 x 2
  channel: `texture(iChannel0, vec2(x, 0.25)).x` is the spectrum, `vec2(x, 0.75)` the waveform, as Shadertoy's sound
  input. `iChannelTime` is its context's `currentTime`.
- **Base level.** A channel whose `filter` is `'nearest'` or `'linear'` reads only the base level of a texture that
  has mip levels, as GL does without a mipmap min filter (OpenGL ES 3.0.6 section 3.8.10).

### Cube A, VR and sound

```ts
import {createStage} from 'margoengine';
import {PostStack} from 'margoengine/post';
import {Shadertoy} from 'margoengine/shader/shadertoy';

const stage = await createStage(document.querySelector('canvas')!);
const toy = new Shadertoy({
  // Cube A: drawn into the six faces of a cube each frame; rayDir is the unit direction of the texel.
  cubeA: {
    source: `void mainCubemap(out vec4 fragColor, in vec2 fragCoord, in vec3 rayOri, in vec3 rayDir) {
  vec3 sky = mix(vec3(0.9, 0.6, 0.4), vec3(0.2, 0.4, 0.9), 0.5 + 0.5 * rayDir.y);
  fragColor = vec4(sky + 0.3 * pow(max(dot(rayDir, normalize(vec3(cos(iTime), 0.4, sin(iTime)))), 0.0), 64.0), 1.0);
}`,
    size: 256,
  },
  image: {
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  fragColor = vec4(texture(iChannel0, normalize(vec3(p, -1.5))).rgb, 1.0);
}
// With vr: true a pass and a mesh call mainVR with each pixel's ray from the camera drawing it (each eye in XR).
void mainVR(out vec4 fragColor, in vec2 fragCoord, in vec3 fragRayOri, in vec3 fragRayDir) {
  fragColor = vec4(texture(iChannel0, fragRayDir).rgb, 1.0);
}`,
    iChannel0: 'cubeA',
  },
  // The Sound tab: one stereo sample per call, from -1 to 1.
  sound: {
    source: `vec2 mainSound(int samp, float time) {
  float note = sin(6.2831853 * fract(440.0 * time)) * exp(-3.0 * fract(time));
  return vec2(note, note * 0.8);
}`,
  },
  vr: true,
});
PostStack.attach(stage.engine, [toy.pass()]);

// The samples, rendered over the next frames while the toy is attached.
stage.engine.use(toy);
const sound = await toy.sound({seconds: 4});
const audio = new AudioContext(),
  player = audio.createBufferSource();
player.buffer = sound.audioBuffer(audio);
player.connect(audio.destination);
player.start();
```

- **Cube A.** `cubeA: {source, size, iChannel0, ...}` takes `void mainCubemap(out vec4 fragColor, in vec2 fragCoord,
  in vec3 rayOri, in vec3 rayDir)`. Each frame, after the buffers and before the image, it is drawn into the six faces
  of an rgba16float cube of `size` pixels a face (a power of two from 1 to 2048, default 1024): `rayDir` is the unit
  direction through the texel's centre, faces as OpenGL ES 3.0.6 Table 3.21 numbers them, `rayOri` is zero and
  `fragCoord` is the texel's place in its face from the face's first row, so the faces hold what GL's would. Any tab
  reads it as `'cubeA'`, a `samplerCube` channel (`'nearest'`, `'linear'` or `'mipmap'`; the cube's levels are made
  each frame when a channel asks for them); Cube A reads its own last frame. It is one draw into a 3 x 2 atlas of the
  faces and six copies into the cube a frame, one more draw per mip level and six copies per level.
- **mainVR.** With `vr: true` the Image source needs `void mainVR(out vec4 fragColor, in vec2 fragCoord, in vec3
  fragRayOri, in vec3 fragRayDir)`. `toy.pass()` calls it with the ray of each pixel from the camera that draws it:
  the camera's position and the direction to the pixel's point on the near plane (the inverse of its view-projection),
  so in an XR frame each eye's view gets its own rays. `toy.material()` calls it with the ray from the camera to the
  surface. `toy.texture` keeps calling mainImage. `toy.vrShader` shows the pass's program.
- **mainSound.** `sound: {source, iChannel0, ...}` takes `vec2 mainSound(int samp, float time)`, or the older `vec2
  mainSound(float time)`; its channels read textures only. `toy.sound({seconds = 180, signal})` renders it while the
  toy is attached, 262,144 samples (one 512 x 512 rgba32float block) a frame, mapped back on the next frame, and
  resolves to `{sampleRate, channels: [left, right], audioBuffer(context)}`: one Float32Array a channel with values
  clamped to -1 to 1, `time` is `samp / sampleRate`, and `audioBuffer` makes a Web Audio buffer for any audio context.
  The signal rejects the promise with its reason; a new device starts the render again. `toy.soundShader` shows
  the program.

## Screen effects (`@margoengine/shader/effects`, 8.6 kB min+gzip on its own)

Ready-made `NodePass` effects for a PostStack, each with live `uniforms` (`effect.uniforms.darkness.value = 0.5`). LDR by
default (after tonemapping, on display colour); `{kind: 'hdr'}` runs one on linear light before the display effect.

```ts
import {PostStack} from 'margoengine/post';
import {Tonemap} from 'margoengine/tonemap';
import {vignette, rgbShift} from 'margoengine/shader/effects';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
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
Each effect is one `NodePass`: one render pass that reads the previous image and writes its own at the output's precision, reusing one pass descriptor every frame. pixelate copies each block's centre pixel exactly, and posterize, sepia, vignette, RGB shift and chromatic aberration
match their formulas within 0.6 of 255; halftone (8 px cells) and dot screen (12 px cells) keep flat 0.2 and 0.6 tones
within 5 of 255 on average, since each dot covers its value's share of the cell. Their 1 px edge ramp adds about
pi / 12 px^2 per dot and loses its outer half where a dot meets its cell's side, so small cells drift by a few levels
(about 5 of 255 for dot screen's default 6 px at 80% ink).

## Black hole (`@margoengine/shader/black-hole`)

A spinning (Kerr) black hole drawn by one full-screen raw shader: a thin accretion disk with the Page-Thorne flux,
gravitational and Doppler redshift and beaming, a relativistic jet, and a lensed star field and Milky Way. Every ray is
traced back from the camera through Kerr spacetime (fourth-order Runge-Kutta in Boyer-Lindquist coordinates), so the
shadow, the photon ring and the disk's secondary images come out of the maths, not from a texture. The scene unit is the
Schwarzschild radius r_s = 2M; the hole sits at the origin with its spin along +y.

```ts
import {BlackHole, traceGeodesic} from 'margoengine/shader/black-hole';
import {ShaderClock} from 'margoengine/shader';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {
  backend: 'webgpu',
  camera: {position: [-0.55, 0.95, 11.8], target: [0, -0.05, 0], fov: 38, near: 0.05, far: 1000},
});
const hole = BlackHole.attach(stage.engine, {spin: 0.9, accretion: 1, jet: 0.5});
hole.view = 'redshift';                          // 'beauty' (default), 'redshift', 'beaming', 'temperature', 'orders'
hole.flare(ShaderClock.attach(stage.engine).time); // a hot spot that spirals in over 8 s on the engine clock
const fan = [-3, -2, -1, 1, 2, 3].map((y) => traceGeodesic([0, y, 40], [0, 0, -1], {spin: hole.spin}));
hole.showGeodesics(fan);                         // the rays drawn as lines; each knows its fate and disk crossings
```

| Option | Default | What it does |
| --- | --- | --- |
| `spin` | 0.9 | a = J / M^2, 0 to 0.998 (Thorne's limit). The horizon and ISCO follow it (`hole.horizon`, `hole.isco`). |
| `accretion` | 1 | Disk brightness, a multiple of the default accretion rate; 0 hides the disk. |
| `peakTemperature` | 4500 | Disk temperature at its flux peak in kelvin, before redshift; the colour is the Planckian locus at g T. |
| `diskOuter` | 6 | Outer disk radius in r_s. |
| `turbulence` | 0.6 | Disk turbulence, 0 (a smooth Page-Thorne disk) to 1. |
| `jet`, `jetLorentz` | 0.5, 5 | Jet brightness (0 to 1) and its bulk Lorentz factor (1 to 20). |
| `stars`, `galaxy` | 1, 1 | Star field and Milky Way brightness; 0 hides them. |
| `timeScale` | 6 | Units of M of orbital time per second of the shader clock (`camera.time`). |
| `diskTime` | null | External texture clock in seconds for replay. Null follows the engine shader clock. |
| `diskInflow` | 0.002 | Prescribed inward drift in M per unit of orbital time, with zero giving circular advection. |
| `exposure` | 1 | Linear exposure of the output. |
| `view` | `'beauty'` | The picture, or a map that explains it: redshift g, beaming g^4, observed temperature, image order. |
| `prefilter` | true | Band-limit the disk and draw stars as points through the lens (off shows a plain point-sampled march). |
| `steps` | 260 | Integration steps per ray. |

The material backtraces each disk emitter through Kerr circular angular velocity and a steady radial drift
before sampling its texture. The beaming map keeps the approaching side's Doppler factor and weights it by
the moving emission. `hole.diskTime` can receive elapsed seconds from `PhysicsWorld`, and `kerrDiskAdvection`
gives the corresponding radius and angular phase on the CPU.

The output is linear HDR: the disk's flux peak is about 0.8 before `exposure`, its Doppler-boosted side several times
that. For a glowing picture, raise `exposure` and end with threshold-free bloom and a filmic curve, as
`examples/event-horizon` does: `exposure: 4.9` on the hole, `new Bloom({strength: 0.05, threshold: 0, radius: 0.6})`
and `new Tonemap({curve: 'acescg', contrast: 1.15})`.

How it works (sources, read as papers only):

- Kerr null geodesics in Boyer-Lindquist coordinates and the camera's ray in the zero-angular-momentum frame: O. James,
  E. von Tunzelmann, P. Franklin and K. S. Thorne, "Gravitational lensing by spinning black holes in astrophysics, and
  in the movie Interstellar", Classical and Quantum Gravity 32, 065001 (2015), eqs. A.9 to A.15,
  https://arxiv.org/abs/1502.03808. Stars are points carried through the inverse pixel-footprint jacobian with their
  magnification, as that paper's ray bundles do, so lensing never stretches them into dashes.
- Horizon, ISCO, photon orbit and circular-orbit angular velocity: J. M. Bardeen, W. H. Press and S. A. Teukolsky,
  "Rotating black holes: locally nonrotating frames, energy extraction, and scalar synchrotron radiation", ApJ 178, 347
  (1972), https://ui.adsabs.harvard.edu/abs/1972ApJ...178..347B. Redshift g = 1 / (u^t (1 - Omega b)).
- Disk flux: D. N. Page and K. S. Thorne, "Disk-accretion onto a black hole. Time-averaged structure of accretion
  disk", ApJ 191, 499 (1974), eq. 15n, https://ui.adsabs.harvard.edu/abs/1974ApJ...191..499P. Observed intensity g^4 F:
  J.-P. Luminet, "Image of a spherical black hole with thin accretion disk", A&A 75, 228 (1979),
  https://ui.adsabs.harvard.edu/abs/1979A&A....75..228L.
- Jet: a parabolic funnel near the hole (K. Asada and M. Nakamura, "The structure of the M87 jet: a transition from
  parabolic to conical streamlines", ApJL 745, L28 (2012), https://ui.adsabs.harvard.edu/abs/2012ApJ...745L..28A),
  brightness D^(2 + alpha) (M. L. Lind and R. D. Blandford, "Semidynamical models of radio jets: relativistic beaming
  and source counts", ApJ 295, 358 (1985), https://ui.adsabs.harvard.edu/abs/1985ApJ...295..358L): side on it beams
  away and is nearly invisible; down the axis it is bright. Its light also climbs out of the hole's potential: the
  frequency ratio is the zero-angular-momentum frame's lapse times D (`kerrLapse`, Bardeen, Press and Teukolsky 1972),
  and the emitters switch on from 1.2 to 3 r_s, since the funnel next to the hole is starved of mass (R. D. Blandford
  and R. L. Znajek, "Electromagnetic extraction of energy from Kerr black holes", MNRAS 179, 433 (1977),
  https://doi.org/10.1093/mnras/179.3.433; J. C. McKinney, "General relativistic magnetohydrodynamic simulations of the
  jet formation and large-scale propagation from black hole accretion systems", MNRAS 368, 1561 (2006),
  https://arxiv.org/abs/astro-ph/0603045). Without both, the jet's base shone as a dot over the shadow seen from
  near the pole.
- Disk detail without banding: the pixel footprint from ray differentials (H. Igehy, "Tracing ray differentials",
  SIGGRAPH 1999, https://graphics.stanford.edu/papers/trd/), octaves faded above the footprint's Nyquist limit (A.
  Norton, A. P. Rockwood and P. T. Skolmoski, "Clamping: a method of antialiasing textured surfaces by bandwidth
  limiting in object space", SIGGRAPH 1982, https://doi.org/10.1145/965145.801274), and two advected noise phases
  crossfaded every 24 s so Keplerian shear never winds the pattern without bound (F. Neyret, "Advected textures",
  SCA 2003, https://hal.inria.fr/inria-00537472). The turbulent brightness is log-normal, exp(5 turbulence n), as the
  surface density of magnetised disk turbulence is (S. A. Balbus and J. F. Hawley, "A powerful local shear instability
  in weakly magnetized disks. I. Linear analysis", ApJ 376, 214 (1991),
  https://ui.adsabs.harvard.edu/abs/1991ApJ...376..214B), so bright knots and dark lanes read at video resolution.
- Sky: stars on a latitude-band grid in two layers (140 and 300 bands), a steep luminosity function and colours
  on the Planckian locus from 3,000 to 15,000 K. They crowd towards the galactic plane (5% of cells at the poles, about
  20% in the plane), and the Milky Way is a thin and a thick disk and a bulge cut by dust lanes, so the lens visibly
  bends the band and its crowded star field into the Einstein ring.
- The spin axis: Boyer-Lindquist coordinates are singular there. A ray of axial angular momentum b turns at
  sin(theta_min) = |b| / sqrt(q + a^2); near the axis each step covers at most a quarter of the way left to that turn
  (`kerrAxisStep`), and a ray that would turn within a third of `POLE_BAND` (0.001) is taken over the axis instead
  (`kerrAxial`): inside the band it goes straight, and the reflection at theta = 0 turns its phi by the swing a
  straight line makes there, 2 acos(theta_min / POLE_BAND) (`kerrAxisTurn`). Before, rays a hundredth of a pixel apart
  near the axis left in unrelated directions, a dashed seam through the sky and over the far disk. The disk-plane
  crossing test is half open (`crossesEquator`): a product test lost the crossing when a step ended exactly on theta =
  pi / 2 in f32, a dark speck on the disk.
- Colour: the Planckian locus as cubic fits (B. Kang, O. Moon, C. Hong, H. Lee, B. Cho and Y. Kim, "Design of advanced color temperature control system for HDTV applications", Journal of the
  Korean Physical Society 41, 865 (2002)).

The CPU twin (`traceGeodesic`, `kerrRhs`, `kerrAxisStep`, `kerrAxial`, `kerrAxisTurn`, `crossesEquator`, `kerrLapse`,
`novikovThorneFlux`, `diskRedshift`, `jetDoppler`, `blackbodyColor` and the radius functions) runs the same integrator
step for step, for overlays and tests. Limits: a ray gets at most `steps` steps, so rays that graze the photon orbit
end dark; the null condition holds under 1e-5 on escaping rays and drifts more on retrograde captured rays inside 4 M.
The camera frame is built without atan2: one GPU compiler drops the sign of a negated component of a constant-scaled
vector in a division (docs/known-bugs.md). GPU checks: `node packages/shader/test/black-hole-check.mjs` (camera frame,
round stars, the jet side on, disk detail over time) and `node packages/shader/test/negated-division-check.mjs`
(Margo's formulations, and whether the fault is present).

## Limits

- Nodes are fixed when a NodeMaterial, NodePass or ComputePass is constructed; build a new one to change the graph. Only uniform values, textures' pixels and storage contents change live.
- NodeMaterial patches gltf/pbr's shader (standard and KHR physical variants); [Node output in every pass](#node-output-in-every-pass) lists what the other passes see. At most 8 varyings. Its bindings start at group 2, binding 48, and node textures count against WebGPU's 16 sampled textures per stage: a `NodeMaterial` on a materials mesh fits 6 texture nodes alone, 5 with directional shadows and 3 with shadows, IBL and LocalShadows; past that, gltf/pbr throws a `RangeError` naming the combination.
- `uv()` is the raw first UV set (no texture transform). `select` evaluates both branches; `If` runs one. A NodePass's discarded pixels stay the cleared transparent black. Fn bodies cannot read stage inputs such as `uv()`; pass them as arguments. No automatic derivative-safe sampling: `texture(map, uv)`, `dpdx`, `dpdy` and `fwidth` inside an `If`, `Switch` or `While` on a per-pixel value, or a loop with a non-uniform bound or a `Break` on one, are a WGSL uniformity error, reported when the pipeline compiles; pass `texture` an explicit level there or sample before the branch.
- SSR, SSGI, scene targets (`@margoengine/post/mrt`), the clustered `LightBounce` and the node `ScenePass` see a raw mesh's own surface only through `captureEntry`, SSAO and GTAO through `gbufferEntry`; without them they see only the depth it writes. In scene targets a raw mesh's `t.light` is zero and `t.shadow` 1. A raw mesh with `captureEntry` added to an effect whose capture takes no `MargoMaterial` throws an `unsupported` MargoError. TAA velocity sees a mesh's own motion only through `velocityEntry`. A raw pick names the mesh, not the instance, and ignores `discard`. Uniform arrays hold 16-byte elements, struct fields are not arrays or structs, and a material has one colour target, 32-bit attribute formats only and at most two extra bind groups.
- NodePass and ShaderPass run only inside a PostStack: a stack of one is fine, and `NodePass.attach` and `ShaderPass.attach` make one. Neither attach joins a PostStack the scene already has (a PostStack's effects are fixed when it is made); add the pass to that stack's array instead. An `hdr` pass that ends the chain tonemaps with ACES.
- Subgroup operations and half floats run in ComputePass nodes only: `enable` has to open a module, and a material's shader is assembled from others. There are no `quad*` operations, and no f16 uniforms, storage or textures.
- Storage textures are 2D, one mip level, one sample; `@margoengine/shader/compute-texture` has no 3D or array form.
- ComputePass dispatches at most 65,535 workgroups per axis (an indirect dispatch is checked by the GPU only) and runs every frame while attached (`computeReadback` runs once; an atomic counter keeps counting unless `update()` resets it). Workgroup memory has no struct elements, and all of a pass's must fit the device's 16,384 bytes. Storage elements are 4- or 8- or 16-byte types (no vec3). A device loss re-uploads the CPU `data`, not what the GPU computed.
- `glslFn` takes functions, not whole GLSL programs: no `main`, uniforms, `in`/`out` variables or `gl_` built-ins inside (pass them as arguments). Its parameters are scalars, vectors, square matrices and `sampler2D`, `samplerCube`, `sampler3D` or `sampler2DArray`; the called function takes inputs only (helpers may have `out` and `inout`). Sources are at most 65,536 code units and 32,768 tokens, with at most 128 levels of nesting. Line and column are exact for syntax errors and refusals; a backslash line continuation joins lines, so later lines count one less. `toGLSL` gives the layer's translation with its default options unless you pass them.

Size (min + gzip, as `examples/package-benchmarks/entry-sizes.mjs` measures it and `examples/package-benchmarks/results/entry-sizes.json` records it: each entry bundled on its own, peers external, so the figures overlap): root entry 18.7 kB; `NodeMaterial` with colour nodes only, 8.6 kB (post, compute, texture and statement code tree-shake away).

Apache-2.0. Optional, tree-shakable package; peers `@margoengine/core`, `@margoengine/materials` and `@margoengine/gltf/pbr` (^0.1.0 || ^1.0.0).

Build and unit tests: `npm test --workspace @margoengine/shader`. Browser check on a real WebGPU adapter: `node packages/shader/test/browser-check.mjs`.

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

## Film time

A `Shadertoy` (and a Shadertoy pass) moves iTime and iFrame with `advanceTime(delta)` in the frame update, so `seek` from `@margoengine/cutscene/seek` starts a film scene on the frame a continuous run shows. iDate follows the wall clock unless you set `date`.

Shader `time` and `deltaTime` (node materials, `NodePass`, `ComputePass` and the raw camera block, `margoBefore.time` included) read the engine's frame clock, `ShaderClock`: seconds of frame deltas since it started, never the wall clock, so the same frame draws the same picture and a seek replays it with every other clock. `RawShaders`, `ComputePass` and `NodePass` attach it with themselves (the plugin `shader:clock`) and remove it with the last of them. A node material on an engine without one attaches it after the first frame that draws it, so attach it yourself before a seek when only node materials read `time`:

```ts
import {createMesh} from 'margoengine/materials';
import {sphereGeometry} from 'margoengine/geometry';
import {NodeMaterial, ShaderClock, color, sin, time} from 'margoengine/shader';
import {seek} from 'margoengine/cutscene/seek';
import {createStage} from 'margoengine';
const stage = await createStage('#viewport', {backend: 'webgpu'});
const clock = ShaderClock.attach(stage.engine);                       // one per engine; 0 until the first frame update
const glow = sin(time).mul(0.5).add(0.5);
createMesh(stage.engine, sphereGeometry(1, 64, 32), new NodeMaterial({colorNode: color('#ff4020').mul(glow)}));
// This scene starts 12 s into the film: the pulse is where a run from 0 had it.
await seek(stage.engine, 12, {fps: 30});
stage.engine.render({delta: 1 / 30});
console.log(clock.time);                                              // 360 steps of 1 / 30 s, then the frame's own
```

Before this, shader `time` was `performance.now()` in seconds, the time since the page opened; it now starts at 0 with the clock.
