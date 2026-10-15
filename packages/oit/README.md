# @margoengine/oit

Order-independent transparency for glTF Pro BLEND primitives and `@margoengine/materials` transparent meshes:
weighted blended OIT (McGuire and Bavoil, JCGT 2013). Overlapping transparent parts (a translucent CAD housing over
translucent and opaque gears) no longer pop as the camera orbits, because nothing depends on draw order any more. Core
meshes are opaque only and are not affected. WebGPU only.

```ts
import {OIT} from '@margoengine/oit';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Material, createMesh} from '@margoengine/materials';

const oit = OIT.attach(engine);                           // or OIT.attach(engine, {depthScale: 2})
oit.add(await loadGLTF(engine, '/gearbox.glb'));          // its BLEND primitives
oit.add(createMesh(engine, housingGeometry, new Material({color: '#9cc3e6', opacity: 0.5, transparent: true, doubleSided: true})));
// oit.add(model) returns a remover; oit.dispose() puts every model back on sorted blending.
```

Models that are not added keep glTF Pro's per-primitive back-to-front sorting, unchanged: the package hooks in through
glTF Pro's declared transparency hook (`PBRModel.setTransparency`, glTF Pro README "Transparency hook"), not text
patches, and without it every GPU call is identical (`examples/package-benchmarks/proofs/oit-detached.proof.js`).
Size: 2,210 B min+gzip (`examples/package-benchmarks/results/entry-sizes.json`); the hook adds 323 B to glTF Pro's
root entry. Core and the stage are unchanged.

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

GPU time (Stats timestamp profiler, median, MSAA 4x, the same scene; diagnostic, measured while other agents kept the
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
