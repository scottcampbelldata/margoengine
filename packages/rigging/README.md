# @margoengine/rigging

Install `npm i margoengine` and import `margoengine/rigging` (or this package alone: `npm i @margoengine/rigging`, imported as `@margoengine/rigging`; the two are the same module).

Rigging and animation authoring for characters made in Margo or anywhere else: smooth automatic skin weights, weight painting with undo, and the skin checks game engines need before export. Everything here is plain data in, plain data out: no engine, renderer or GPU is needed, core is never imported, and an app that does not import this package ships none of it.

## Automatic weights (bone heat)

`boneHeatWeights(mesh, joints)` gives every vertex smooth weights from a rest skeleton, by bone heat diffusion (I. Baran and J. Popović, "Automatic rigging and animation of 3D characters", SIGGRAPH 2007). Each joint moves the vertices around its bone, the segment from the joint to each child (a point at a leaf joint), and weights blend smoothly across joints. Weights are 0 or more and sum to 1 per vertex. Heat only reaches a vertex from bones it can see, so an arm's weight does not leak into the hip it hangs beside.

```ts
import { boneHeatWeights, checkSkin, type RigJoint } from 'margoengine/rigging';

// Any triangle mesh (positions xyz, optional indices) and a rest skeleton in the same space.
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 2, 0]);
const indices = new Uint32Array([0, 1, 2, 2, 1, 3]);
const joints: RigJoint[] = [
  { name: 'hips', parent: -1, position: [0.5, 0, 0] },
  { name: 'spine', parent: 0, position: [0.5, 1, 0] },
  { name: 'head', parent: 1, position: [0.5, 2, 0] },
];
const weights = await boneHeatWeights({ positions, indices }, joints, { visibility: false });
const { joints: JOINTS_0, weights: WEIGHTS_0 } = weights.toInfluences(4); // glTF's four strongest per vertex
console.log(JOINTS_0.length, WEIGHTS_0.length); // 16 16
console.log(checkSkin({ weights: weights.toInfluences(4), joints }).ok); // true
```

Options, each with its default:

| Option | Default | Meaning |
| --- | --- | --- |
| `skip` | `[]` | Joints (indices or names) that move no vertices, such as a root at the feet. |
| `visibility` | `true` | Heat only from visible bones; uses `@margoengine/bvh`, loaded on first use. `false` takes the nearest bone (faster; fine for convex parts). Or pass `(from, to) => boolean`. |
| `heat` | `1` | Heat constant c in H = c / d². Larger keeps vertices closer to their nearest bone. |
| `weld` | `1e-6` | Vertices closer than this fraction of the mesh size are one point, so weights cross UV seams and split faces. |
| `tolerance` | `1e-6` | Largest weight error per vertex when a bone's solve stops. |
| `maxIterations` | `2000` | Conjugate-gradient iterations per bone; a `MargoError` with code `failed` when not enough. |
| `threshold` | `1e-4` | Weights below this share are dropped before renormalising. |
| `signal` | none | `AbortSignal`; the promise rejects with its reason. The solve yields to the event loop every 30 ms. |

Vertices at one position always get the same weights. Pass `joints` from `@margoengine/exporters/skin`'s `humanoidJoints()`, or turn any glTF skeleton into joints with `rigJoints(retargetRig(model))`.

## Weight painting

`WeightPainter` paints a `WeightMap` with brush dabs: `add`, `subtract`, `replace` (toward `value`) and `smooth` (toward the neighbours' average). Each dab keeps every vertex it touches summing to 1: when one bone gains or loses weight, the other unlocked bones on that vertex make up the difference. Locked bones never change. Every stroke returns its undo.

```ts
import { WeightMap, WeightPainter } from 'margoengine/rigging';

const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
const map = new WeightMap(3, 2, [1, 0, 1, 0, 1, 0]);
const painter = new WeightPainter(map, mesh, { parents: [-1, 0], locked: [] });
const stroke = painter.stroke({ mode: 'add', bone: 1, center: [0, 1, 0], radius: 0.8, strength: 0.5, falloff: 'smooth' });
painter.smoothAll({ iterations: 2, strength: 0.5 });
stroke.undo(); // undo strokes newest first
painter.normalize();
```

| Stroke field | Default | Meaning |
| --- | --- | --- |
| `mode` | required | `add`, `subtract`, `replace` or `smooth`. |
| `bone` | required except for `smooth` | The bone painted. |
| `center`, `radius` | required | Brush sphere in mesh space. |
| `strength` | `0.5` | Amount at the centre (0-1). |
| `value` | `1` | `replace`'s target weight. |
| `falloff` | `smooth` | `smooth` (smoothstep), `linear` or `constant`. |

Subtracting from a vertex whose other bones hold nothing passes the weight to the bone's parent (pass `parents`); with no unlocked parent the vertex keeps it, so a vertex never ends up unweighted. `WeightMap` is dense (`values[vertex * boneCount + bone]`); `toInfluences(4)` returns the strongest four per vertex, renormalised, and `WeightMap.fromInfluences({joints, weights})` reads them back.

## Skin checks before export

`checkSkin` reports what Unity, Unreal, Godot, Roblox and glTF validators reject or render wrongly: unweighted vertices, more than four influences, weights that don't sum to 1, negative or non-finite weights, joint indices outside the skin, and degenerate bones (a joint on its parent, or a non-invertible inverse bind matrix). `assertSkin` throws a `RangeError` naming each fault and its fix.

```ts
import { WeightMap, assertSkin, checkSkin } from 'margoengine/rigging';

const weights = new WeightMap(2, 2, [0.6, 0.6, 0, 0]);
const report = checkSkin({ weights, maxInfluences: 4, tolerance: 1e-3 });
for (const issue of report.issues) console.log(issue.code, issue.count, issue.vertices, issue.message);
// not-normalized 1 [0] "1 vertex(es) have weights that don't sum to 1; call normalize()"
// unweighted 1 [1] "1 vertex(es) have no weight; paint them or run boneHeatWeights"
weights.normalize();
try {
  assertSkin({ weights });
} catch (error) {
  console.log((error as RangeError).message); // still names vertex 1 as unweighted
}
```

Input is a `WeightMap` or per-vertex influences (`{joints, weights, influences?}`, glTF's JOINTS_0 / WEIGHTS_0 at the default width 4); add `joints` (the rest skeleton) or `inverseBindMatrices` to check bones too. Defaults: `maxInfluences` 4, `tolerance` 1e-3.

## Sources

Written clean room from the published papers listed in [docs/clean-room.md](../../docs/clean-room.md#rigging-margoenginerigging).
