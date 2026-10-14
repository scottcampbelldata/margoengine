# @margoengine/selection

Visible selection outlines for core meshes and gltf-pro models, using Jump Flood Algorithm distance fields or circular morphological dilation, and GPU picking that covers both.

```ts
import {Selection} from '@margoengine/selection';
const selection = Selection.attach(engine, {algorithm: 'jfa', width: 3, color: [1,0.5,0]});
selection.set([mesh, model, model.nodes[4]]); // core meshes, whole PBRModels, or glTF nodes (with their descendants)
```

X-ray (hidden lines): `xray` also outlines the parts of the selection hidden behind other geometry, the CAD "see the selection through the assembly" look. One `Selection` per selection set, each with its own name and style:

```ts
const picked = Selection.attach(engine, {color: [1, 0.5, 0], xray: true});           // hidden parts dashed (4 px, 85% opacity)
const hover = Selection.attach(engine, {name: 'hover', color: [0.3, 0.8, 1], width: 2}); // a second set, visible outline only
picked.options.xray = {dash: 0, opacity: 0.4};   // dimmer solid hidden lines; also color and width (default: the outline's)
picked.options.xray = false;                     // back to visible-only, exactly as before
```

With x-ray on, the selection is drawn a second time into the same mask without the depth test (core meshes through the renderer's draw hook, gltf-pro primitives through the model replay), its jump-flood (or dilation) outline is composited blended and dashed, then the visible outline is drawn over it as usual. Dashes follow the nearest silhouette pixel's coordinate along the edge's dominant axis, so straight and curved edges get dashes of the same screen length (diagonal edges up to 1.4× longer). The mask and distance-field targets are reused; x-ray adds two pipelines, one 32-byte uniform and a model draw list, and one more mask pass plus jump flood per frame. Works the same under perspective and orthographic (@margoengine/cameras) views, since both passes read the camera matrix. Hidden lines trace the silhouette of the whole selection, not edges inside it (for hidden feature edges of a part, use machinery `FeatureEdges`). With `xray` off or absent the GPU work is byte-identical to the package before x-ray (`node examples/package-benchmarks/proofs/selection-xray-off.proof.js`, 10,586 recorded calls).

`Picking.attach(engine)` enables faster `engine.pick(x, y)` in canvas CSS pixels, and makes it return gltf-pro models (including @margoengine/materials meshes):

```ts
import {Picking} from '@margoengine/selection';
const picking = Picking.attach(engine);
const mesh = await engine.pick(x, y);       // a core mesh, or the glTF node that owns the model primitive
const hit = await picking.pick(x, y);       // {mesh, model?, primitive?, primitiveIndex?, approximate?}
if (hit?.model) selection.set([hit.mesh]);  // click-to-select one part of a loaded model
```

Models are found automatically: every attached gltf-pro `PBRModel` (engine plugins with `root` and `primitives`) is pickable and selectable. Model IDs follow the core slots (`capacity + 1 + primitive slot`), so `picking.pick` names the model, primitive and node. gltf-pro draws with its own pipelines, so a scene with models skips the per-frame ID attachment and picks through the culled 3×3 micro pass: core meshes, then each model primitive whose bounding sphere meets the 3×3 frustum, share one depth buffer, so occlusion between them is exact. Primitives use the deformed (skinned) vertex buffer when one exists, the node's world matrix and the material's `doubleSided` flag with mirrored-node winding, as gltf-pro renders them. Model draws are one storage buffer of matrices drawn by `firstInstance`; the buffers and bind group are reused, so steady picking and outlining create no GPU objects and nothing is added to the frame for picking. Outlines replay selected primitives into the mask with gltf-pro's exact vertex transform and an equal depth test against the scene, so hidden parts stay unmarked.

The standard core PBR draw writes a second `r32uint` attachment in the same pass, with no extra draw calls. A pick copies a clipped 3×3 neighborhood from that frame when camera, mesh identities, geometry, transforms, visibility, materials and frame-graph revision match. Otherwise it renders a 3×3 micro frustum, rejecting each instance's bounding sphere before batching the survivors. The sphere test stays conservative under nonuniform scale, mirrored transforms and hierarchy shear. Zero means background; stored IDs are core slots plus one, so slot zero remains selectable.

The center wins. For an empty center, orthogonal neighbors win before diagonals, with a deterministic tie order. Coordinates and neighbors are bounded to the canvas. Readback remains asynchronous and one pick may be pending at a time. A reusable 768-byte staging buffer accommodates WebGPU's 256-byte row pitch. Device restoration recreates resources; removal or engine disposal frees them.

Pick proxies: objects drawn without triangles, such as @margoengine/lod imposter levels, are listed by engine plugins with `pickProxies()` (lod's `LODSystem`; selection does not import lod). When any exist, picks use the micro pass and draw each proxy's bounding sphere under its anchor's world matrix (a 256-triangle polyhedron whose faces enclose the sphere, so it is up to 4% larger at its vertices) after the model primitives, with slots `capacity + 1 + all model primitives + proxy index`. Proxies whose sphere misses the 3×3 frustum, hidden anchors and disposed anchors are skipped. `picking.pick` returns `{mesh: anchor, model?, approximate: true}`; the hit covers the whole sphere, not just the imposter's pixels, and selection outlines are not drawn for imposter levels.

`Picking.attach(engine, {capture: false})` leaves the frame untouched (no second color target, no per-frame mesh snapshot) and renders the culled 3x3 pass for every pick; use it when picks are rare and frame rate matters more. Picking covers core mesh geometry and gltf-pro models. Other custom draws (lines, points, splats, custom vertex-deformation pipelines) are not pickable. For models, alpha-mask cut-outs are picked as solid, transparent surfaces are pickable and occlude what lies behind them, section planes do not clip model picks, and skinned models are picked in the pose last drawn. Custom scene pipelines fall back to the micro pass; sections also use that pass so mutable clipping uniforms stay current. Other mutable custom shader effects should render their changed state before picking. The cached ID texture costs four bytes per viewport pixel; the package remains optional and tree-shakable.

Width is viewport pixels, 1..32. The selection mask uses an identical core vertex transform and equal depth, so occluded selected surfaces do not appear. The composite excludes the mask interior. Morphology costs more for large widths; JFA uses logarithmic ping-pong steps. Invisible/disposed meshes are omitted. gltf-pro models (and their deformed skinned buffers) replay in a second mask pass; custom vertex deformation outside gltf-pro is not included. Dispose releases all targets and passes.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/selection
Real WebGPU checks: npm run test:browser --workspace @margoengine/selection

`test/xray.browser.mjs` half hides a core box and a @margoengine/materials plane behind occluders: inside each occluder there is no outline colour with x-ray off, dashed runs with it on and one solid run with `dash: 0`, in perspective and orthographic views (`test-results/selection-xray-*.png`).

`test/models.browser.mjs` loads the damaged helmet and the robot with `loadGLTF`, a @margoengine/materials mesh and a core box on a real adapter. It checks known pixels, occlusion between the box and the helmet both ways and hidden models. A 600-pixel grid agrees with the bvh Raycaster within one pixel in perspective and orthographic (@margoengine/cameras) views; about 99% agree exactly at the pixel centre, and the rest are silhouette pixels resolved by the one-pixel neighbour fallback. Outline pixels are counted for a picked node, a whole model and a materials mesh, and must be zero for an occluded selection. Pick proxies: `test/models.test.js` checks proxy slots after model slots, culling, the enclosing sphere (faces at least the radius, vertices under 1.05×), hidden and stale proxies; `packages/lod/test/imposter-check.mjs` checks on a real adapter that every rendered imposter pixel picks its LOD anchor (approximate) and that GPU and bvh picks agree over a 16,384-pixel grid within one pixel.

