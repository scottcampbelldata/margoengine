# @margoengine/oit

Import `margoengine/oit` from the `margoengine` package, or `@margoengine/oit` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Order-independent transparency for glTF Pro BLEND primitives and `@margoengine/materials` transparent meshes:
weighted blended OIT (McGuire and Bavoil, JCGT 2013) by default, or exact per-pixel layers from
[`margoengine/oit/exact`](#exact-layers-exactoit). Overlapping transparent parts (a translucent CAD housing over
translucent and opaque gears) no longer pop as the camera orbits, because nothing depends on draw order any more. Core
meshes are opaque; `addMesh` from `margoengine/oit/meshes` draws one see-through. WebGPU only.

```ts
import {OIT} from 'margoengine/oit';
import {loadGLTF} from 'margoengine/gltf-pro';
import {Material, createMesh} from 'margoengine/materials';
import {boxGeometry} from 'margoengine/geometry';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const housingGeometry = boxGeometry(1, 1, 1);
const oit = OIT.attach(engine);                           // or OIT.attach(engine, {depthScale: 2})
oit.add(await loadGLTF(engine, '/gearbox.glb'));          // its BLEND primitives
oit.add(createMesh(engine, housingGeometry, new Material({color: '#9cc3e6', opacity: 0.5, transparent: true, doubleSided: true})));
// oit.add(model) returns a remover; oit.dispose() puts every model back on sorted blending.
```

Models that are not added keep glTF Pro's per-primitive back-to-front sorting, unchanged: the package hooks in through
glTF Pro's declared transparency hook (`PBRModel.setTransparency`, documented on `PBRTransparency`), not text
patches, and without it every GPU call is identical (`examples/package-benchmarks/proofs/oit-detached.proof.js`).
Size: 2,210 B min+gzip (`examples/package-benchmarks/results/entry-sizes.json`); the hook adds 323 B to glTF Pro's
root entry. Core and the stage are unchanged.

## Core meshes

```ts
import {Engine, box, PbrMaterial} from 'margoengine/core';
import {OIT} from 'margoengine/oit';
import {addMesh} from 'margoengine/oit/meshes';
const engine = await Engine.create(document.querySelector('canvas')!);
const oit = OIT.attach(engine);
const mesh = engine.createMesh().setGeometry(box(1, 1, 1)).setMaterial(new PbrMaterial({color: '#9cc3e6'}));
const restore = addMesh(oit, engine, mesh, {opacity: 0.4});
mesh.setPosition([1, 0, 0]);   // the see-through copy follows
restore();                     // back to the opaque mesh, the same frame as before
```

The geometry and material are copied once, so a later `setMaterial` or `setGeometry` needs a new `addMesh`. While
see-through `mesh.geometry` is null: the mesh casts no shadow and `engine.pick` does not see it, as for every transparent surface.

## Exact layers (`ExactOIT`)

`margoengine/oit/exact` stores every transparent fragment in a per-pixel list, keeps the nearest `layers` of each pixel
and blends them in true depth order. The result is what sorted blending would give if every pixel were sorted on its
own, so surfaces that cut through each other come out right, where the weighted pass above only approximates.

```ts
import {Engine} from 'margoengine/core';
import {ExactOIT} from 'margoengine/oit/exact';
import {Material, createMesh} from 'margoengine/materials';
import {boxGeometry} from 'margoengine/geometry';
const engine = await Engine.create(document.querySelector('canvas')!);

const oit = ExactOIT.attach(engine, {layers: 8});          // the default; 1 to 32
oit.add(createMesh(engine, boxGeometry(1, 1, 1), new Material({color: '#9cc3e6', opacity: 0.4, transparent: true, doubleSided: true})));
engine.render();
console.log(oit.stats);                                    // {fragments, dropped, capacity, limit}, a few frames behind
```

`add`, `addMesh`, the frame graph place and `dispose` work as for `OIT`. Options, all fixed at construction:

| Option | Default | Meaning |
| --- | --- | --- |
| `layers` | 8 | Nearest layers kept per pixel, 1 to 32. Farther ones are left out, so a pixel with more loses the far end. Fragments behind opaque surfaces sort last and do not take a place from visible ones. |
| `pool` | 2 | Starting list size in fragments per screen pixel. The list grows by itself, see below. |
| `order` | 8 | Frame graph order, as for `OIT`. |

How it runs: the transparent draws append to the list in a pass with no colour targets (four halves of colour and
alpha, depth, the coverage mask and the link: 16 bytes a fragment). A compute pass sorts each pixel's list and cuts it
to `layers`. The resolve then draws one full-screen triangle per layer, far to near, with normal blending. A fragment
shader that writes storage runs ahead of the depth test, and core's scene depth cannot be sampled, so hidden fragments
reach the list too; each resolve layer writes `frag_depth` and leaves the depth test to the hardware, so hidden layers
drop out per sample, and the stored coverage mask keeps MSAA edges. Coplanar layers order by their colour bits, the same
on every frame.

Measured on an RTX A6000 (`npm run test:gpu --workspace packages/oit`), the same four unlit planes as the table below:
0.66 of 255 from blending worked out by hand, at 1x and 4x MSAA; the weighted pass gives more than 3 times that. Adding
the models in another order changes no pixel, and two sheets that cross swap at the line. Time is not measured yet.

Limits:

- The list holds what one storage binding allows: 8,388,608 fragments on a default device (128 MiB). That is every
  transparent fragment of the frame, hidden ones included: 4 screen layers at 1920x1080, 1 at 3840x2160. A short list
  drops fragments for the few frames until its read-back makes it grow, and it never shrinks; past `limit` it keeps
  dropping, which `stats.dropped` shows and which looks like missing layers, not wrong blending.
- Memory: 16 bytes per list fragment (the default `pool` starts at 32 bytes per pixel, about 63 MiB at 1920x1080) plus 4
  bytes per pixel.
- Colour is held in half floats: at most 65,504, 11 bits of precision.
- It needs storage buffers in fragment shaders, so WebGPU only, and not compatibility mode: `setup` throws
  `'unsupported'` there; use `OIT`.
- Transmission, custom blending and depth overrides keep the sorted path, as for `OIT`.

## Hashed alpha

Noise-based transparency that writes depth, for hair and foliage under TAA, shadows and SSAO, is a material feature,
not a pass: `alphaHash()` from `margoengine/materials/alpha-hash` (materials README, "Hashed alpha").

## How it works

- BLEND primitives leave the beauty pass. In OIT's pass (frame graph order 8 by default: after the scene, edges and
  section caps, before TAA, SSAO and the post composites) they draw with their normal lit shader into two targets,
  depth tested against the opaque scene and not writing depth: accumulation (`rgba16float`, additive:
  premultiplied colour × w, alpha × w) and revealage (`r16float`, multiplied by 1 − alpha).
- Weight: `w = clamp(10 / (depth / depthScale)^6, 0.01, 1000)`, `depth` the view-space depth (perspective and
  orthographic alike), `depthScale` by default the camera's distance to its target each frame. A layer 10 % nearer
  than another weighs 1.9× as much.
- A composite pass draws one full-screen triangle over the scene: average colour `accum.rgb / accum.a` at coverage
  `1 − revealage`, blended premultiplied-over, so `TransparentCanvas` keeps valid alpha. It is the only pass that reads
  textures (the two targets, with `textureLoad`); the transparent draws add no texture bindings, so the 16-texture
  budget in the glTF Pro README is unchanged.
- MSAA: with a 4x scene the two targets are 4x and resolve at the end of the pass; the composite runs per pixel on the
  4x scene target. Inside `PostStack`, Tonemap, TAA or DOF captures the pass follows their target (HDR `rgba16float`
  colours accumulate linear). No transparent primitive drawn: no OIT pass at all.

## Accuracy (real GPU, `examples/package-benchmarks/oit-gpu.mjs`)

Arc 140V, Edge 155, AC power, results in `examples/package-benchmarks/results/oit-gpu.json`.

Colour, centre pixel, 0-255 per channel: unlit planes (materials `'basic'`) at 0.6/0.3/0/-0.3 m in front of an opaque grey
plane, camera 4 m away, alphas 0.5/0.4/0.6/0.5 in red, green, blue, yellow. The same at MSAA 1x and 4x, perspective and
orthographic.

| Layers | OIT vs analytic sorted blending (approximation error) | OIT vs the WBOIT formula (implementation error) | Sorted path vs analytic |
| --- | --- | --- | --- |
| 1 | 0.5 (exact) | 0.5 | 0.5 |
| 2 | 4.6 | 0.3 | 0.4 |
| 4 | 8.7 | 0.6 | 0.8 |

Over a `TransparentCanvas` the recovered alpha is within 0.002 of 1 − Π(1 − alpha) and the premultiplied colour within
1.1 for 1, 2 and 4 layers. Inside a `PostStack` (Bloom + FXAA, HDR capture) one layer equals the sorted path exactly.

Popping: a 50 % double-sided housing over two opaque gears and a 55 % gear, orbited 360° in 1° steps at 640×360,
MSAA 4x, against a reference that sorts every translucent triangle separately. A pop is a pixel that jumps by more than
16 between steps where the reference stays within 3.

| Path | Steps with > 1 % of covered pixels popping | Steps with > 0.1 % | Worst step | Mean / p95 error vs reference |
| --- | --- | --- | --- | --- |
| Sorted per primitive (default) | 13 | 78 | 1.41 % | 7.5 / 29.8 |
| OIT | 0 | 5 | 0.36 % | 6.7 / 22.8 |

GPU time (Stats timestamp profiler, median, MSAA 4x, the same scene; diagnostic, measured while other jobs kept the
CPU at 45-100 %):

| Resolution | Opaque only | + sorted transparency | + OIT | OIT accumulate pass | OIT composite pass |
| --- | --- | --- | --- | --- | --- |
| 1280×720 | 0.07 ms | 0.39 ms (+0.33) | 0.62 ms (+0.56) | 0.33 ms | 0.23 ms |
| 1920×1080 | 0.13 ms | 0.72 ms (+0.59) | 1.41 ms (+1.28) | 0.79 ms | 0.49 ms |

## Limits (the WBOIT approximation)

- It is an approximation, exact only for one layer. With several overlapping layers the colour is a depth-weighted
  average, not the front-to-back result: a near layer does not fully hide a far one, and two layers at similar depth
  mix whatever their order. Errors grow with layer count and with colour contrast between layers (table above).
  Choose `depthScale` near the distance of the transparent parts if the default (orbit distance) is far off.
- Outside about 0.46 to 3.2 × `depthScale` the weight is clamped: nearer or farther layers lose depth ordering among
  themselves (they still blend order-independently). Very bright HDR colours (above ~60 in linear units) can overflow
  the `rgba16float` accumulation when stacked.
- Transmission (KHR_materials_transmission tints) and materials with custom blending (`additive`, `multiply`, `none`)
  or depth overrides (`depthWrite`, `depthTest: false`) keep the sorted path. Transparent instances (`PBRInstances`)
  go through OIT like other primitives.
- Transparent surfaces write no depth, as before: SSAO, DOF and picking see the opaque scene only; TAA has no motion
  vectors for them.
- Cost: two 1x targets (10 bytes per pixel) plus 4x copies (40 bytes per pixel) under MSAA, and one full-screen
  composite whenever something transparent is visible: about twice the GPU time of sorted blending in the table above.
