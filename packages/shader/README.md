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

`node packages/shader/test/utils-check.mjs` (real GPU, under the GPU lock) runs the maths nodes and all 13 blend modes over 256 random inputs against JavaScript formulas, and reads the rest back from a wall: each normal map direction in both frames, a known slope through `bumpNormal`, both projections of `triplanar`, `parallaxUV` against the depth worked out by hand for a flat and a sloped field at 45 degrees, `matcapUV` against `MatcapMaterial` on a sphere, and a panorama's top and bottom rows.

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

`NodePass` and `ComputePass` have no mesh, so these are NodeMaterial nodes. A depth pass reads `vertexIndex` and `instanceIndex`, and nothing tied to the camera or to tangents: a `positionNode` that reads those casts the mesh unmoved, as [Node output in every pass](#node-output-in-every-pass) describes.

`node packages/shader/test/inputs-check.mjs` (real GPU, under the GPU lock) reads each input back as a pixel on a wall the camera faces, with and without tangents, and compiles the instance inputs plain, instanced and in uniform rows.

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
import {loadGLTF} from 'margoengine/gltf-pro';
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

`node packages/shader/test/deform-check.mjs` (real GPU, under the GPU lock) compares each of these with the same mesh deformed on the CPU: position, morph into skin, an effect on top, lit normals (also on a stretched, mirrored mesh, and from neighbours), a new pose, the shadow, and an effect on vertices a compute deformer moved.

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
| `pass.add(model)` | Draws a gltf-pro model or a mesh in the pass, opaque and masked surfaces only. Returns a remover. |
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

`node packages/shader/test/pass-check.mjs` (real GPU, under the GPU lock) reads these back as pixels: two outputs with a plain mesh hiding one part, an output from a graph, a live uniform and the final emissive, the lit colour against the picture (sunlit and tone mapped too), a mesh moved in the same frame, a pane showing the wall behind it, a NodePass adding an output, a camera step as velocity, and a canvas resize.

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
| TAA velocity | no: such a surface keeps camera motion | not read | no |

**Normals.** After a `positionNode`, normals follow the new shape. `positionNormals: 'neighbours'` evaluates the graph again 0.001 mesh units to two sides of each vertex: smooth, for shapes worked out from `positionLocal`, at three evaluations of the graph per vertex. `'faces'` takes each triangle's normal in the fragment, for graphs that read `uv()`, whose neighbours a vertex cannot know: it shows facets on a coarse mesh and keeps a normal map's detail on top. `'keep'` leaves the mesh's normals. The default is `'faces'` when the graph reads `uv()`, else `'neighbours'`; a `normalNode` wins over `'faces'`.

**What a depth pass cannot read.** A shadow has no view of the camera or of the material's computed values. A `positionNode` that reads `cameraPosition` or `viewDirection` casts the mesh unmoved, and fragment nodes that read those or `materialColor`, `materialNormal`, `materialRoughness`, `materialMetalness` or `materialEmissive` cast without their `discard()`; the colour pass is not affected. A `positionNode` also replaces a `displacementMap` in depth passes. Such a caster counts as moving, so shadow caches redraw it each frame.

`node packages/shader/test/passes-check.mjs` (real GPU, under the GPU lock) checks these on pixels: a caster moved by a graph against a plain mesh placed there in all four shadow passes, a cut caster against a half-sized one, both normal modes against the analytic normal of a wave, and SSAO's G-buffer pass drawing such a surface.

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

`node packages/shader/test/lighting-check.mjs` (real GPU, under the GPU lock) checks these against what they read: `sunVisibility` under a real shadow map, Lambert written as a `lightModel` against `shading: 'lambert'` on the sun and a point light, and `litColor`, `localLight` and `ambientLight` against a plain `Material` with the same effects.

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

`node packages/shader/test/compute-texture-check.mjs` (real GPU, under the GPU lock): eight generations of Conway's life on a 32 x 32 pair equal a CPU run, a material follows the pair as it swaps, all 16 formats write and read back through a second pass, a blur sampling in compute gives exact thirds, and in-place r32float counts to 3.

## Raw shaders (`@margoengine/shader/raw`, 13.2 kB min+gzip)

Your own WGSL vertex and fragment
entry points, any named attributes per vertex or per instance, live uniforms, textures and storage buffers, drawn into the
scene's colour and depth. Raw meshes also cast shadows, write SSAO's G-buffer, are culled and are picked like other meshes.

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
  `<name>Sampler`, each storage buffer as `<name>`, and two colour helpers. Fragment output is written exactly as returned (raw); `margoDisplay(c)`
  applies the scene's display transform (PBR Neutral and sRGB on a display target, nothing inside an HDR PostStack
  capture, which tonemaps later) and `margoEncode(c)` only the sRGB encoding, for unlit colour as lines and points write
  it. With a separate `fragmentShader` each stage is its own module, so both may use `main`.
- **Arrays and structs.** `count` makes a uniform array, `struct` a uniform struct, and both together an array of structs.
  An array's value is a list of elements or all their numbers in a row. Elements of a uniform array sit 16 bytes apart, so
  the element is a vec3, a vec4, a matrix or a struct; a list of `f32` or `vec2f` belongs in a storage buffer, and the
  material says so when it refuses one. A struct field is a plain uniform type, not an array or another struct.
- **Storage buffers and bind groups.** `storage: {name: buffer}` declares `<name>:array<type>`. Pass a `storage()` node as
  it is, so a compute pass fills what the mesh draws, or `{buffer, type, access}` with your own GPUBuffer (or a function of
  the device, which also serves device restoration). `type` may be a struct your code declares, in every stage that reads
  the buffer. `'read_write'` binds to the fragment stage only, as WebGPU requires. `groups` adds up to two bind groups at
  `@group(2)` and `@group(3)` for bindings your WGSL declares; each is a function of the device.
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
  too when its code holds `discard`, so a cut-out shape casts a cut-out shadow. Transparent materials cast none. For
  `{static: true}`, call `mesh.invalidateShadow()` after moving the mesh; attribute changes and a newly compiled pipeline
  redraw the map by themselves. A raw shader receives no shadow unless it samples one itself.
- **SSAO.** Opaque raw meshes occlude from their depth with nothing to set, like every mesh, and their pixels are not
  darkened. `ssao.add(raw)` with `gbufferEntry` on a material goes further: that `@fragment fn` returns
  `margoGBuffer(worldNormal, worldPosition, ambient)`, SSAO uses your normals, and `ambient` is the light it may take away.
- **Culling.** A mesh out of view is skipped in the colour, shadow, SSAO and pick passes, and counted in `raw.stats.culled`.
  The sphere comes from a per-vertex vec3f `position`. A mesh with no such attribute, or an instanced one, is never culled
  unless you give `bounds: {center, radius}`. A vertex shader that moves points outside that sphere needs `bounds` or
  `frustumCulled: false`.
- **Picking.** `RawPicking.attach(picking, raw)` draws the meshes into the pick tile after the scene's meshes, in the same
  depth test, with your vertex stage, so a mesh is picked where it shows. `hit.mesh` is the core mesh it follows or an empty
  stand-in, and `picking.rawOf(hit)` gives the RawMesh back. One ID covers a mesh, so a hit names no instance, and a
  fragment's `discard` does not cut the pick.

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
- NodeMaterial patches gltf-pro's shader (standard and KHR physical variants); [Node output in every pass](#node-output-in-every-pass) lists what the other passes see. At most 8 varyings. Its bindings start at group 2, binding 48, and node textures count against WebGPU's 16 sampled textures per stage: a `NodeMaterial` on a materials mesh fits 6 texture nodes alone, 5 with directional shadows and 3 with shadows, IBL and LocalShadows; past that, gltf-pro throws a `RangeError` naming the combination.
- `uv()` is the raw first UV set (no texture transform). `select` evaluates both branches; `If` runs one. A NodePass's discarded pixels stay the cleared transparent black. Fn bodies cannot read stage inputs such as `uv()`; pass them as arguments. No automatic derivative-safe sampling: `texture(map, uv)`, `dpdx`, `dpdy` and `fwidth` inside an `If`, `Switch` or `While` on a per-pixel value, or a loop with a non-uniform bound or a `Break` on one, are a WGSL uniformity error, reported when the pipeline compiles; pass `texture` an explicit level there or sample before the branch.
- Raw meshes cast into `Shadows` only: `VirtualShadows` and `LocalShadows` take no custom caster. SSR, GTAO, SSGI, TAA velocity and scene passes do not see them, beyond the depth they write. A raw pick names the mesh, not the instance, and ignores `discard`. Uniform arrays hold 16-byte elements, struct fields are not arrays or structs, and a material has one colour target, 32-bit attribute formats only and at most two extra bind groups.
- NodePass runs only inside a PostStack (a stack of one is fine). An `hdr` pass that ends the chain tonemaps with ACES.
- Subgroup operations and half floats run in ComputePass nodes only: `enable` has to open a module, and a material's shader is assembled from others. There are no `quad*` operations, and no f16 uniforms, storage or textures.
- Storage textures are 2D, one mip level, one sample; `@margoengine/shader/compute-texture` has no 3D or array form.
- ComputePass dispatches at most 65,535 workgroups per axis (an indirect dispatch is checked by the GPU only) and runs every frame while attached (`computeReadback` runs once; an atomic counter keeps counting unless `update()` resets it). Workgroup memory has no struct elements, and all of a pass's must fit the device's 16,384 bytes. Storage elements are 4- or 8- or 16-byte types (no vec3). A device loss re-uploads the CPU `data`, not what the GPU computed.
- No GLSL/WebGL2 output.

Size (min + gzip, Rolldown, peers external): whole package 18.0 kB (11.8 kB before statements, 13.9 kB before the compute model, 15.2 kB before node output in every pass, 16.8 kB before the input nodes); `NodeMaterial` with colour nodes only, 8.4 kB (post, compute, texture and statement code tree-shake away; the test enforces this).

Apache-2.0. Optional, tree-shakable package; peers `@margoengine/core`, `@margoengine/materials` and `@margoengine/gltf-pro` (^0.1.0 || ^1.0.0).

Build and unit tests: `npm test --workspace @margoengine/shader`. Browser check on a real WebGPU adapter: `node packages/shader/test/browser-check.mjs`.
