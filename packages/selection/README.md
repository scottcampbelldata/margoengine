# @margoengine/selection

Visible core-mesh selection outlines using Jump Flood Algorithm distance fields or circular morphological dilation.

```ts
import {Selection} from '@margoengine/selection';
const selection = Selection.attach(engine, {algorithm: 'jfa', width: 3, color: [1,0.5,0]});
selection.set([mesh]);
```

`Picking.attach(engine)` enables faster `engine.pick(x, y)` in canvas CSS pixels:

```ts
import {Picking} from '@margoengine/selection';
const picking = Picking.attach(engine);
const mesh = await engine.pick(x, y);
```

The standard core PBR draw writes a second `r32uint` attachment in the same pass, with no extra draw calls. A pick copies a clipped 3×3 neighborhood from that frame when camera, mesh identities, geometry, transforms, visibility, materials and frame-graph revision match. Otherwise it renders a 3×3 micro frustum, rejecting each instance's bounding sphere before batching the survivors. The sphere test stays conservative under nonuniform scale, mirrored transforms and hierarchy shear. Zero means background; stored IDs are core slots plus one, so slot zero remains selectable.

The center wins. For an empty center, orthogonal neighbors win before diagonals, with a deterministic tie order. Coordinates and neighbors are bounded to the canvas. Readback remains asynchronous and one pick may be pending at a time. A reusable 768-byte staging buffer accommodates WebGPU's 256-byte row pitch. Device restoration recreates resources; removal or engine disposal frees them.

`Picking.attach(engine, {capture: false})` leaves the frame untouched (no second color target, no per-frame mesh snapshot) and renders the culled 3x3 pass for every pick; use it when picks are rare and frame rate matters more. Picking covers core mesh geometry. Custom glTF-pro/skinned draws and vertex-deformation pipelines keep their existing exclusion. Custom scene pipelines fall back to the micro pass; sections also use that pass so mutable clipping uniforms stay current. Other mutable custom shader effects should render their changed state before picking. The cached ID texture costs four bytes per viewport pixel; the package remains optional and tree-shakable.

Width is viewport pixels, 1..32. The selection mask uses an identical core vertex transform and equal depth, so occluded selected surfaces do not appear. The composite excludes the mask interior. Morphology costs more for large widths; JFA uses logarithmic ping-pong steps. Invisible/disposed meshes are omitted. Separate glTF-pro/skinned buffers, custom vertex deformation and TAA-jittered geometry are not included in the core replay. Dispose releases all targets and passes.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/selection
Real WebGPU checks: npm run test:browser --workspace @margoengine/selection

