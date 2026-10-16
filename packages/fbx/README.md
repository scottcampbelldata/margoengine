# @margoengine/fbx

Native binary and ASCII FBX import through Margo's first-party glTF exporter and optional PBR/animation pipeline. The package has no Three.js runtime dependency. Core, stage, and the animation runtime are unchanged.

```ts
import {loadFBX} from '@margoengine/fbx';
import {Animation} from '@margoengine/animation';
const model = await loadFBX(engine, '/assets/character.fbx');
const animation = Animation.attach(model);
animation.play('Walking');
```

`convertFBX(bytes, options)` returns a GLB `ArrayBuffer`. `parseFBX(engine, bytes, options)` returns a `PBRModel`. `loadFBX(engine, stringOrURL, options)` fetches an HTTP(S) asset and resolves texture paths against the final response URL. Options remain `{resourcePath?: string; signal?: AbortSignal}`. Explicit resource paths must use HTTP(S).

## Supported first implementation

- Binary FBX versions 7400–7700 with 32/64-bit node records, raw arrays, and zlib-compressed arrays. Array headers remain 32-bit in every supported version. ASCII uses the same scene conversion.
- Bounded concave triangulation; normal, UV, tangent/binormal, color, and material layers with Direct/IndexToDirect and ByControlPoint/ByVertice/ByPolygonVertex/ByPolygon/AllSame mappings. The first attribute layer and UV set are imported; UV V and tangent handedness convert to glTF conventions.
- Area-weighted normals, UV/hard-edge vertex splitting, shared geometry instances, and material partitions. Multiple material partitions become separate child mesh nodes under the original model transform.
- Six fixed-axis Euler orders, pivots/offsets, pre-rotation and inverse post-rotation, mesh-only geometric transforms, units, and signed axis conversion. Missing GlobalSettings preserves raw coordinates. Canonical FBX Y-up uses FrontAxisSign +1; Blender Z-up converts `(x,y,z)` to `(x,z,-y)`.
- Linear Normalize skin clusters, exact joint IDs and bind matrices, four strongest influences with deterministic tie order and normalization, and remapping onto split vertices.
- Single-shape blend channels with sparse position/normal deltas, names, initial weights, and animated percent weights. Blender's all-100 per-control-point FullWeights convention is accepted.
- Lambert/Phong dielectric materials, diffuse/emissive colors, opacity/transparency, shininess-derived roughness, and embedded or external PNG/JPEG diffuse and normal textures.
- Multiple animation stacks, one layer per stack, STEP and LINEAR curves, missing-axis rest values, and interpolation at common key times. LINEAR transform tracks are adaptively baked for Euler motion and moving pivots, with sampled translation/scale tolerance `1e-5 * max(1, magnitude)` and angular tolerance `1e-4` radians. These are sampling criteria, not a proof of continuous error bounds. Rotation segments are subdivided to preserve full turns.

## Explicit limits

Input is capped at 64 MiB, converted GLB at 128 MiB, expanded position vertices at 1,000,000 across mesh instances, and decoded texture pixels at 16,000,000. Parsing also bounds cumulative decoded arrays to 64 MiB, allocation accounting to 128 MiB, node/property counts, hierarchy depth, and work. Geometry, deformation, and animation have additional work/output limits. These are import budgets, not a zero-allocation or peak-heap guarantee. The downstream glTF runtime separately limits GLB/buffer bytes to 64 MiB, so a larger `convertFBX` result may be exportable but cannot be attached by `parseFBX`.

Unsupported data rejects explicitly: InheritType other than 0, nonuniform ancestor scales (including animated parent scales), unrepresentable shear, spherical rotation order, Additive/TotalOne or nonlinear skinning, progressive morphs, layered textures, cubic/mixed/constant-next animation interpolation, and animation-layer blending. Cameras/lights and non-mesh geometry do not produce renderable output. Extra UV/layer sets and unsupported material maps are omitted. Arbitrary shader graphs are outside the supported material subset.

Array decompression requires platform `DecompressionStream('deflate')`. Image decoding in `parseFBX` requires `createImageBitmap`; `convertFBX` can run headlessly without image decoding. Cancellation is checked during fetch, decompression, parsing, baking, and image decoding; synchronous CPU sections cannot process a newly dispatched abort until the JavaScript event loop resumes.

## Verification and progress

Run `npm test --workspace @margoengine/fbx`. Tests use first-party synthetic binary/ASCII fixtures, malformed streams, numeric geometry and bind references, Khronos GLB validation, and real `PBRModel`/`Animation` attachment and seek checks in a headless engine. They do not require Three.js or a test-only decompressor.

Real DCC compatibility and rendered skinning remain separate gates. Set `MARGOENGINE_FBX_FIXTURE` to a Vite-served skinned asset before `npm run test:modules:browser` to check skin/clip retention and changing rendered pixels. The checked-in synthetic rig does not certify every Blender/Maya/Max export convention.

See [the implementation plan and progress](../../docs/native-fbx-plan.md) for completed checks and remaining compatibility work.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/fbx

