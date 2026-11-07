# @margoengine/oit

Import `margoengine/oit` from the `margoengine` package, or `@margoengine/oit` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Order-independent transparency for glTF Pro BLEND primitives and `@margoengine/materials` transparent meshes:
weighted blended OIT (McGuire and Bavoil, JCGT 2013) by default, [moments](#moments-momentoit) from
`margoengine/oit/moments` for a closer result, or exact per-pixel layers from
[`margoengine/oit/exact`](#exact-layers-exactoit). Overlapping transparent parts (a translucent CAD housing over
translucent and opaque gears) no longer pop as the camera orbits, because nothing depends on draw order any more. Core
meshes are opaque; `addMesh` from `margoengine/oit/meshes` draws one see-through, and
[`addEffect`](#particles-splats-and-points-addeffect) from `margoengine/oit/vfx` brings particles, splats and points into
the same pass. WebGPU only.

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

## Tints, glows and glass (`blending`)

`OIT.attach(engine, {blending: true})` brings the surfaces that otherwise stay sorted into the pass: `additive` and
`multiply` materials, and native transmission (`KHR_materials_transmission` tints, with no
`@margoengine/materials/transmission` attached, which keeps its own draws).

```ts
import {Engine} from 'margoengine/core';
import {OIT} from 'margoengine/oit';
import {Material, createMesh} from 'margoengine/materials';
import {boxGeometry} from 'margoengine/geometry';
const engine = await Engine.create(document.querySelector('canvas')!);

const oit = OIT.attach(engine, {blending: true});
oit.add(createMesh(engine, boxGeometry(1, 1, 1), new Material({color: '#ff8040', opacity: 0.5, transparent: true, blending: 'additive'})));
oit.add(createMesh(engine, boxGeometry(2, 2, 2), new Material({color: '#c0e0d0', transmission: 0.9, roughness: 0.2})));
```

The result is `background x dimming + average colour x coverage + light`, whatever the order: a third `rgba16float`
target sums light (additive materials, the lit draw of glass), the revealage target turns `rgba16float` and multiplies
per channel (normal layers by `1 - alpha`, `multiply` materials by their colour, glass by its tint), and its alpha keeps
the coverage of normal layers alone. The composite is two draws, one multiplying and one adding, because a per-channel
factor and a sum need two blends.

Measured on an RTX A6000 (`npm run test:gpu --workspace packages/oit`), at 1x and 4x MSAA: each kind alone, glass with
maps and volume attenuation included, draws the same 8-bit pixel as the sorted path, and additive over multiply equals
multiply over additive equals the formula. Time is not measured yet.

Limits:

- Sorted blending treats these in depth order: glass in front of a glow dims it. Here dimming applies to the background
  only, so light and coloured layers are not dimmed by tints in front of them. That is the price of taking order out.
- Only this pass takes them. `ExactOIT` and `MomentOIT` leave these surfaces on the sorted path.
- `blending: 'none'`, other blends and any further render state (`depthWrite`, `depthTest`, stencil, polygon offset)
  stay on the sorted path.
- Cost: 16 more bytes per pixel, 64 more under 4x MSAA, and one more full-screen draw.

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
- Transmission, custom blending and depth overrides keep the sorted path: `blending` is an `OIT` option only.

## Moments (`MomentOIT`)

`margoengine/oit/moments` sits between the two others: fixed memory like `OIT`, and much closer to the right answer once
layers pile up, because a near layer really does dim what lies behind it.

```ts
import {Engine} from 'margoengine/core';
import {MomentOIT} from 'margoengine/oit/moments';
import {Material, createMesh} from 'margoengine/materials';
import {boxGeometry} from 'margoengine/geometry';
const engine = await Engine.create(document.querySelector('canvas')!);

const oit = MomentOIT.attach(engine);
const glass = createMesh(engine, boxGeometry(1, 1, 1), new Material({color: '#9cc3e6', opacity: 0.4, transparent: true, doubleSided: true}));
oit.add(glass);
glass.root.setPosition([0, 0, 3]);
oit.fit();                                                 // after moving models far: measures them again
```

How it works (Muenstermann, Krumpen, Klein and Peters, I3D 2018): the first draw of each model adds up, per pixel, the
optical depth `-ln(1 - alpha)` of its layers and four power moments of their log-warped depth. The second draw shades
each fragment and scales it by the transmittance in front of it, recovered from the moments by the Hamburger bound
(Peters and Klein 2015). A composite then normalises the sum and lays it over the scene at the coverage
`1 - exp(-optical depth)`. Every target is `rgba16float` or `r16float`, which blend on every WebGPU device, so no feature
is needed; the bias is 5e-5 and a CPU model of random layers puts half sums within 0.5 of 255 of float sums at that bias.

| Option | Default | Meaning |
| --- | --- | --- |
| `depthRange` | the box round the added models | `[near, far]` view depth the moments resolve, 0 < near < far. Layers outside blend as if at the end they passed. |
| `order` | 8 | Frame graph order, as for `OIT`. |

Measured on an RTX A6000 (`npm run test:gpu --workspace packages/oit`), worst channel, 0-255, against sorted blending
worked out by hand, at 1x and 4x MSAA:

| Scene | Moments | Weighted |
| --- | --- | --- |
| Four layers at alphas 0.5, 0.4, 0.6, 0.5 | 6.24 | 13.26 |
| Two dense layers at alpha 0.9 | 2.81 | 71.81 |
| One layer | under 1.5 | under 1.5 |

Adding models in another order moved no pixel in these runs. Time is not measured yet.

Limits:

- It is an approximation: a layer dims itself a little (a quarter of its own optical depth, the paper's overestimation)
  and close layers blur together, so results sit between `OIT` and `ExactOIT`. Total coverage is exact.
- Precision follows the range. The default box is measured once, reading every vertex, on the first frame after `add` or
  `fit`: a model moved far from there falls outside and loses depth order until `fit()` runs (in the check, the error
  more than doubles). Wide boxes with close layers cost accuracy too: on the CPU model a range 7 times the layers' depth
  gave 16 where a close one gave 6.5 with a bias of 5e-4. `depthRange` sets it by hand.
- Every model draws twice, and the second draw reads two more textures, which lowers the 16-texture budget of a material
  to 14. Memory: 18 bytes per pixel, plus 72 under 4x MSAA.
- Transmission, custom blending and depth overrides keep the sorted path: `blending` is an `OIT` option only.

## Depth and motion for glass (`TransparentDepth`)

Transparent surfaces write no depth, so TAA, depth of field and SSAO look straight through them. `margoengine/oit/depth`
adds them to the scene depth after their colour has drawn, whichever pass drew it.

```ts
import {Engine} from 'margoengine/core';
import {OIT} from 'margoengine/oit';
import {TransparentDepth} from 'margoengine/oit/depth';
import {Material, createMesh} from 'margoengine/materials';
import {boxGeometry} from 'margoengine/geometry';
import {PostStack, FXAA} from 'margoengine/post';
import {TAA} from 'margoengine/taa';
const engine = await Engine.create(document.querySelector('canvas')!);

const stack = PostStack.attach(engine, [new FXAA()]);
const taa = TAA.attach(engine, {velocityOnly: true, depth: () => stack.depthTexture});
const pane = createMesh(engine, boxGeometry(2, 1, 0.1), new Material({color: '#9cc3e6', opacity: 0.4, transparent: true}));
OIT.attach(engine).add(pane);
const glass = TransparentDepth.attach(engine, {threshold: 0.2});
glass.add(pane);                    // into the depth
taa.add(glass.velocity(pane));      // its own motion vectors, for glass that moves
```

| Option | Default | Meaning |
| --- | --- | --- |
| `threshold` | 0.1 | Least alpha that enters the depth, above 0, at most 1. Native transmission always enters. Additive and multiply materials never do. |
| `order` | 8.5 | Frame graph order: after the transparent colour at 8, before TAA at 9 and SSAO at 10. |

- TAA: camera motion reprojects from the glass, and `glass.velocity(model)` gives moving glass its vectors. Where layers
  overlap the nearest wins.
- Depth of field and SSAO read the glass through the same depth. Focus lands on it, and what is behind it blurs with it.
- Picking needs nothing from this entry: `Picking` takes BLEND primitives as they are, `picking.add(model)`.

Measured on an RTX A6000 (`npm run test:gpu --workspace packages/oit`), at 1x and 4x MSAA: glass writes the same depth
value as an opaque plane in its place, under OIT too, and parts under the threshold stay out. Moving glass shows its
vector where it read zero before, and a glass edge in front of a focused wall blurs only with this entry. All on
generated planes; time is not measured yet.

Limits:

- Everything depth-tested after `order` sees the glass as solid: lines (order 20) behind it disappear. A later `order`
  keeps them, and then TAA, SSAO and the rest no longer see the glass.
- What is behind the glass gets the glass's depth, so it blurs and reprojects as the glass does. One depth per pixel.
- The surfaces draw once more, shader included, for depth alone.
- Without `model` in an order-independent pass its BLEND primitives still draw sorted; this entry works the same.

## Particles, splats and points (`addEffect`)

Particles, splats and points blend over the scene in their own passes, so glass and smoke land in draw order: a particle
behind a pane still paints over it. `addEffect` from `margoengine/oit/vfx` draws them in the same pass as the models,
so each pixel's layers meet in one place.

```ts
import {Engine} from 'margoengine/core';
import {ExactOIT} from 'margoengine/oit/exact';
import {addEffect} from 'margoengine/oit/vfx';
import {Material, createMesh} from 'margoengine/materials';
import {boxGeometry} from 'margoengine/geometry';
import {VFX} from 'margoengine/vfx';
import {Splats} from 'margoengine/splats';
import {PointsPlugin, PointCloud} from 'margoengine/points';
const engine = await Engine.create(document.querySelector('canvas')!);

const oit = ExactOIT.attach(engine);                // or OIT, or MomentOIT
oit.add(createMesh(engine, boxGeometry(2, 1, 0.1), new Material({color: '#9cc3e6', opacity: 0.4, transparent: true})));

const remove = addEffect(oit, VFX.attach(engine, {capacity: 10_000, color: [1, 0.5, 0.1, 0.6]}));
addEffect(oit, Splats.attach(engine, {
  positions: new Float32Array([0, 0, -1]),
  covariances: new Float32Array([0.1, 0, 0, 0.1, 0, 0.1]),
  colors: new Float32Array([0.2, 0.6, 1, 0.8]),
}));
const points = PointsPlugin.attach(engine);
points.add(new PointCloud({positions: new Float32Array([0, 0, 1]), material: {size: 8, transparent: true, opacity: 0.5}}));
addEffect(oit, points);                             // its transparent clouds and sprites
remove();                                           // the particles go back to their own draw
```

Fog, soft particles, particle textures and sphere-shaded points keep working in the pass. Disposing the effect takes it
out; disposing the pass puts every effect back on its own draw, bit for bit.

Measured on an RTX A6000 (`npm run test:gpu --workspace packages/oit`), at 1x and 4x MSAA, for particles, splats, points
and sprites alike: in `ExactOIT` with a 50% pane, each lands within 2 of 255 of the formula on either side of the pane.
On their own draws a red particle behind the pane reads (221, 17, 42), as if in front; in the pass it reads
(119, 17, 144). Alone in any pass each stays within 2 of 255 of its own draw. The view depth each hands the pass reads
3.5 for a layer 3.5 from the eye, under perspective and orthographic cameras. All on generated layers; time is not
measured yet.

Limits:

- `PointsPlugin`'s clouds and sprites join if they are `transparent`, test depth and write none. Additive ones need
  `OIT` with `blending`, and keep their own draw otherwise; there they add to the canvas alpha as additive materials do.
- A pass draws what the plugin culled for that view, so the point budget still applies. Surfels stay out.
- Sphere-shaded points test depth at their flat quad, without the sphere's depth, and take no eye-dome lighting.
- `Splats` stop sorting while in a pass: `gpuState.sorted` holds the keys in data order. Splats far past `layers` deep
  lose the rest under `ExactOIT`, and weighted blending of dense clouds is far from the sorted picture: a trained capture
  wants its own sorted draw unless glass must cut through it.
- `MomentOIT` has no box for an effect, so with one added its default range is the camera's near and far. On a pane and
  one effect that cost nothing, at near 0.05 and far 100: the far layer read 112 of 255, against 106 with
  `depthRange: [3, 6]` and 119 exact. Many layers close together are untested; set `depthRange` if they blur.
- With 4x MSAA a textured particle covers the samples of its triangle, not only of its quad: under a pixel at the edge.
- `TransparentDepth` takes models only; effects stay out of the depth.

## Real files

`packages/oit/test/gpu/real-check.mjs` runs six Khronos sample models through every pass at 4x MSAA from eight sides, in
a real environment, with no GPU error. Share of pixels more than 2 of 255 apart, the worst of the eight sides, RTX
A6000:

| Model | Parts in `ExactOIT` | Exact against sorted | `blending` against sorted | Weighted against exact | Moments against exact |
| --- | --- | --- | --- | --- | --- |
| GlassVaseFlowers | 1 BLEND | 2.56%, worst 95 | 3.29%, worst 117 | 2.30%, worst 45 | 0.63%, worst 43 |
| DiffuseTransmissionPlant | 4 BLEND | under 0.01%, worst 13 | under 0.01%, worst 18 | under 0.01%, worst 18 | 0.01%, worst 28 |
| AlphaBlendModeTest | 2 BLEND | 0.02%, worst 16 | 0.06%, worst 26 | 0.07%, worst 17 | 0.06%, worst 19 |
| LightsPunctualLamp | 1 BLEND | 0, nothing overlaps | 0.17%, worst 64 | 0 | 0 |
| TransmissionTest | none | 0, nothing taken | 0.99%, worst 247 | 0 | 0 |
| CommercialRefrigerator | none | 0, nothing taken | 0.02%, worst 27 | 0 | 0 |

What that shows:

- Most real glass is `KHR_materials_transmission`, which only `OIT` with `blending` takes. `ExactOIT` and `MomentOIT`
  leave those models as they were: on the last two rows they draw nothing.
- Where layers stack, moments stay closest to exact, as on generated planes.
- A BLEND part that sits inside native transmission draws over it unless `blending` is on, because the transmission
  stays in the scene pass: the vase's 2.56%.
- `blending` gives up what sorted glass does between glass parts. Seen along a row of spheres in TransmissionTest, each
  sphere's light adds up and none dims the next, so 1% of the picture moves by as much as 247 of 255. No reference
  picture says which is right there; for glass behind glass, stay on the sorted path.
- Two identical sorted runs of GlassVaseFlowers can differ on a few pixels by up to 9 of 255 (docs/known-bugs.md), so
  gaps that small mean nothing.

`TransparentDepth` brought pixels nearer on all six and none farther (9.72% of the vase's picture, 13.58% of the
refrigerator's). Particles through the middle of each model draw with its BLEND parts in `ExactOIT` with no GPU error.

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
- By default transmission (KHR_materials_transmission tints) and materials with custom blending (`additive`,
  `multiply`, `none`) keep the sorted path; [`blending`](#tints-glows-and-glass-blending) brings all but `none` in.
  Depth overrides (`depthWrite`, `depthTest: false`) always keep it. Transparent instances (`PBRInstances`) go through
  OIT like other primitives.
- Transparent surfaces write no depth, as before: SSAO and DOF see the opaque scene only, and TAA has no motion vectors
  for them, until [`TransparentDepth`](#depth-and-motion-for-glass-transparentdepth) adds them.
- Cost: two 1x targets (10 bytes per pixel) plus 4x copies (40 bytes per pixel) under MSAA, and one full-screen
  composite whenever something transparent is visible: about twice the GPU time of sorted blending in the table above.
