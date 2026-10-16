# Native FBX loader and glTF skin export

Date: 2026-10-16. This is the project note for replacing the Three.js bridge in `@margoengine/fbx`. It is not a launch plan. Core and the stage facade stay frozen. No new package name is required.

The static glTF writer already exists. `@margoengine/exporters` writes glTF 2.0 and GLB for meshes, hierarchy, PBR materials, and PNG or JPEG images. The Khronos validator is part of its tests. That writer stops where the FBX bridge needs it: no skins, no clips, no morph targets. `@margoengine/fbx` parses with Three's `FBXLoader`, converts legacy materials to `MeshStandardMaterial`, and writes the GLB with Three's `GLTFExporter`. `parseFBX` then hands that GLB to `parseGLTF` from `@margoengine/gltf-pro`.

The work is two pieces in this order:

1. Teach the existing exporter to write the skin, clip, and morph data that `@margoengine/animation` already reads.
2. Replace `FBXLoader` and `GLTFExporter` with a parser in `@margoengine/fbx` that builds that data and calls `exportGLB`.

A second glTF writer would duplicate `packages/exporters/src/gltf.ts`. `three` leaves only `@margoengine/fbx`. It never enters core, the stage, or the other packs.

## Public API that stays

These three functions stay. Callers, including `loadFBX(engine, url)` plus `Animation.attach(model)`, do not change.

| Function | Input | Output |
| --- | --- | --- |
| `convertFBX(input, options)` | `ArrayBuffer` or a view, at least 32 bytes and at most 64 MiB | GLB `ArrayBuffer`, at most 128 MiB |
| `parseFBX(engine, input, options)` | Same bytes, plus an `EngineKernel` | `PBRModel` from `parseGLTF` |
| `loadFBX(engine, url, options)` | HTTP or HTTPS URL | `PBRModel` |

`FBXOptions` stays `{ resourcePath?: string; signal?: AbortSignal }`. `resourcePath` must be `http:` or `https:` when it is set. `loadFBX` rejects any other protocol and fills `resourcePath` from the response URL's directory when the caller omits it. Fetching uses `readResponse` from `packages/shared/loading.js` with the same 64 MiB cap.

`parseFBX` keeps the image pass it has now. It reads each `images[]` entry from the GLB BIN chunk, decodes it with `createImageBitmap` at `colorSpaceConversion: 'none'` and `premultiplyAlpha: 'none'`, sums `width * height`, and rejects a total above 16,000,000 pixels. Each bitmap is closed if a later image fails. The decoded list is passed as the third argument to `parseGLTF`.

Geometry inside one FBX stays at or below 1,000,000 position vertices, counted the way the bridge counts them today: the sum of position counts across meshes. A file with no mesh geometry still throws `FBX has no mesh geometry`.

## What the GLB must satisfy

`@margoengine/animation` is the consumer that defines the skin and clip subset. The writer emits only documents that pass these checks.

- `asset.version` is `"2.0"`. Animated nodes use `translation`, `rotation`, and `scale`. They do not use `matrix`. `gltf-pro` accepts a static matrix and decomposes it, and the animation package rejects a channel whose node has `matrix`.
- One animation channel per node and path. Paths are `translation`, `rotation`, `scale`, and `weights`.
- Sampler inputs and outputs are component type `5126` (Float32). Input is `SCALAR`. Output is `VEC3` for translation and scale, `VEC4` for rotation, and `SCALAR` for weights.
- Times are finite, non-negative, and strictly increasing. The default interpolation is `LINEAR`. `STEP` and `CUBICSPLINE` are legal. Cubic output length is `times.length * width * 3`.
- A skin's `joints` are unique node indices. `inverseBindMatrices` is Float32 `MAT4`, one matrix per joint, column major. Omitting the accessor means identity binds, which this writer will not do. It always writes the matrices.
- A skinned primitive has `JOINTS_0` and `WEIGHTS_0` only. `JOINTS_1` and `WEIGHTS_1` are rejected by the animation package. Joint ids are unsigned byte or unsigned short, not normalized. Weights are Float32, or normalized unsigned byte or short. This writer uses unsigned short joints and Float32 weights. Each vertex has four influences. Each id is in range of that primitive's skin joint list. The four weights sum to a positive number. The animation package divides by that sum.
- Morph targets are per-primitive `POSITION`, `NORMAL`, and `TANGENT` deltas, each `VEC3`. The count matches the base vertex count. Initial weights live on the node, then the mesh. Names go in `meshes[].extras.targetNames` because `gltf-pro` reads them there.
- Four influences is a hard renderer limit. More FBX influences are reduced before export, not written as a second set.

`gltf-pro` still requires a normal of non-zero length on every vertex, a renderable mesh, and a hierarchy no deeper than 62. Textures need `TEXCOORD_0` or `TEXCOORD_1`. The FBX path writes `TEXCOORD_0` only.

## Exporter changes

The new fields live on the plain data scene in `packages/exporters/src/scene.ts`. An engine scene (`EngineKernel`) does not grow skin data. Core meshes have no joints. Engine export stays static, and the existing exporter tests keep passing without setting the new fields.

```ts
interface MorphData {
  name?: string;
  positions: ArrayLike<number>; // xyz delta per vertex
  normals?: ArrayLike<number>;
  tangents?: ArrayLike<number>; // xyz, handedness stays on the base TANGENT
}

interface GeometryData {
  // existing positions, normals, uvs, tangents, colors, indices
  joints?: ArrayLike<number>;  // 4 unsigned ints per vertex
  weights?: ArrayLike<number>; // 4 floats per vertex
  morphs?: readonly MorphData[];
}

interface ExportNode {
  // existing transform, geometry, material, children
  skin?: SkinData;          // object identity, not a preassigned index
  morphWeights?: readonly number[];
}

interface SkinData {
  name?: string;
  joints: readonly ExportNode[];
  inverseBindMatrices: ArrayLike<number>; // 16 column-major floats per joint
}

interface AnimationChannelData {
  node: ExportNode;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  interpolation?: 'STEP' | 'LINEAR' | 'CUBICSPLINE';
  times: ArrayLike<number>;   // seconds
  values: ArrayLike<number>;
}

interface ExportScene {
  nodes: readonly ExportNode[];
  animations?: readonly { name?: string; channels: readonly AnimationChannelData[] }[];
}
```

`exportGLB` and `exportGLTF` walk the scene as they do now. While they assign glTF node indices, they remember the `ExportNode` object that produced each index. Skin joints and animation channels resolve through that map. A joint or channel node that was not visited throws. Hidden nodes skipped by `onlyVisible` are not valid targets.

Writer rules, on top of the rules already in `packages/exporters/src/gltf.ts`:

- `JOINTS_0` is a `UNSIGNED_SHORT` `VEC4` accessor. `WEIGHTS_0` is a Float32 `VEC4` accessor. Both are required together. A vertex with a non-integer joint, a negative weight, or a weight sum of 0 throws before any bytes are committed.
- `inverseBindMatrices` is one Float32 `MAT4` accessor. The accessor count equals `joints.length`.
- Morph deltas are Float32 `VEC3` accessors on `meshes[].primitives[].targets`. `TANGENT` morphs are `VEC3` deltas. The base `TANGENT` stays `VEC4`. This matches `animation`, which reads morph tangents as `VEC3`.
- Node `weights` is the initial morph weight array. Length equals the target count. Values must be finite.
- Animation samplers do not share accessors across channels in the first version. Sharing is an optimization, not a requirement.
- `CUBICSPLINE` values are in glTF order: in-tangent, value, out-tangent, repeated per key. The FBX parser does not emit cubic splines in the first slice.
- The JSON key order gains `skins` and `animations` after `nodes`. Buffers stay last. Padding stays as it is: JSON chunk spaces, BIN chunk zeros, buffer views on 4-byte boundaries.
- `generator` stays caller-controlled. The FBX package passes `Margo Engine fbx`.

Static export of an engine scene never writes `skins` or `animations`. A data scene that sets them does.

## FBX document model

The parser accepts FBX 7.4 and 7.5 binary, and the ASCII form used by the existing unit fixture (`FBX 7.4.0`). Binary versions in the header from 7400 through 7700 use the same node record. Array counts and the null-node sentinel change at 7500.

### Binary header and nodes

The magic is the 21 bytes `Kaydara FBX Binary  \0`, then the byte `0x1A`, then a little-endian `uint32` version. The existing fixture writes version 7400 at offset 23 and `0x1A` at offset 21.

A node is:

| Field | 7400–7499 | 7500+ |
| --- | --- | --- |
| End offset | `uint32` | `uint64` |
| Property count | `uint32` | `uint64` |
| Property list byte length | `uint32` | `uint64` |
| Name length | `uint8` | `uint8` |
| Name | bytes | bytes |
| Properties | typed | typed |
| Children | nodes | nodes |
| Sentinel, if the node has children | 13 zero bytes | 25 zero bytes |

The top-level node list ends with the same sentinel. A truncated record, an end offset before the cursor, or a name that runs past the buffer throws `Invalid FBX`.

Property type codes:

| Code | Value |
| --- | --- |
| `Y` | `int16` |
| `C` | `uint8` boolean |
| `I` | `int32` |
| `F` | `float32` |
| `D` | `float64` |
| `L` | `int64` |
| `S` | `uint32` length, then bytes. Not null-terminated. |
| `R` | Same as `S`. Raw bytes. |
| `f` `d` `i` `l` `b` | Array. Header below. |

An array header is encoding `uint32` and compressed byte length, then the payload. Below version 7500 the element count is `uint32`. At 7500 and above the element count and the compressed length are `uint64`. Encoding `0` is raw little-endian elements. Encoding `1` is zlib deflate. Any other encoding throws. Element widths are 4, 8, 4, 8, and 1 for `f`, `d`, `i`, `l`, and `b`. The existing fixture writes `d` and `i` arrays with a 12-byte header (`uint32` count, `uint32` encoding, `uint32` byte length) and encoding 0. That fixture must keep parsing.

Decompression uses `DecompressionStream` when it exists, and a small inflate implementation in the package tests so Node can parse encoding `1` without a browser. A decoded array longer than the declared count throws. The decoded byte length is capped by the 64 MiB input budget. The parser does not expand an array into a JavaScript number per element when a typed array will do. `Vertices` stays `Float64Array`. `PolygonVertexIndex` stays `Int32Array`.

### ASCII

The existing fixture is the ASCII subset that must keep working:

- A leading `; FBX 7.4.0` comment line.
- Objects with `Name: property, property { children }`.
- Quoted strings, bare identifiers, commas, and nested braces.
- Arrays written as `*count { a: v, v, v }`.

Comments run from `;` to the end of the line, including the first line. Strings use double quotes. Numbers are decimal or scientific. `*count` must equal the number of values. Unknown objects are kept in the generic node tree and ignored by the scene builder, so a file with extra takes does not fail the triangle test.

ASCII and binary both lower into one in-memory node: a name, an array of properties, and child nodes. Scene building reads that tree and does not care which encoding produced it.

### Objects and connections

The scene builder reads these top-level nodes:

- `FBXHeaderExtension`, for `FBXVersion` on ASCII. Binary uses the header version.
- `GlobalSettings`, for axis and unit.
- `Objects`, whose children are the scene records.
- `Connections`, whose children are `C` records.
- `Documents` and `Takes` are ignored.

An object id is the first property when it is an integer. The second property is a name string of the form `Type::Name` or `Type::Name`. The third, when present, is the subtype (`Mesh`, `LimbNode`, `Skin`, `Cluster`, `BlendShape`, `BlendShapeChannel`, `Phong`, `Lambert`, `Texture`, `Clip`).

Connections:

- `C: "OO", childId, parentId` attaches an object to an object.
- `C: "OP", childId, parentId, "PropertyName"` attaches an object to a named property. Animation curves use this. Texture-to-material links use this.

A missing parent id `0` means the scene root. The triangle fixture connects the model to `0`. A connection whose child or parent id was never defined throws. Cycles in the model parent graph throw.

Properties on a model or material usually live under `Properties70`, each as `P: "Name", "Type", "Label", "Flags", ...values`. The builder reads those tuples. A direct child property with the same name is the fallback for files that do not use `Properties70`. The triangle fixture has neither, so the model transform is identity.

## Scene conversion

Output is one Y-up, right-handed scene in meters, which is the glTF and Margo node space. Conversion happens before any matrix is written.

### Units and axes

`GlobalSettings` properties:

| Property | Meaning | Default if absent |
| --- | --- | --- |
| `UnitScaleFactor` | Centimeters per file unit | `1` |
| `UpAxis` | `0` X, `1` Y, `2` Z | `1` |
| `UpAxisSign` | `1` or `-1` | `1` |
| `FrontAxis` | `0` X, `1` Y, `2` Z | `2` |
| `FrontAxisSign` | `1` or `-1` | `1` |
| `CoordAxis` | The remaining axis | `0` |
| `CoordAxisSign` | `1` or `-1` | `1` |

Positions, translations, and geometric translations are multiplied by `UnitScaleFactor * 0.01` so a Maya file in centimeters becomes meters. A file that already used meters has `UnitScaleFactor` of `100`. The triangle fixture has no `GlobalSettings`, so a vertex at `(1, 0, 0)` stays `(1, 0, 0)` only if the default is changed to "no conversion when GlobalSettings is absent". That is the rule: a missing `GlobalSettings` does not scale and does not swap axes. The existing triangle is in whatever numbers the file stored. A present `GlobalSettings` always converts.

The axis convert is a single 3×3 applied to positions, normals, translations, and the rotation basis. Scale is applied in the converted space. `UpAxis` 1, `UpAxisSign` 1, `FrontAxis` 2, `FrontAxisSign` 1, `CoordAxis` 0, `CoordAxisSign` 1 is identity. Other combinations are a permutation with signs. A file whose three axes are not a permutation of X, Y, and Z throws.

### Nodes

Every `Model` becomes an `ExportNode`. Subtypes:

| Subtype | Becomes |
| --- | --- |
| `Mesh` | A node. Geometry is attached if a `Geometry` object connects to it. |
| `LimbNode`, `Limb`, `Root`, `Null` | A transform node with no mesh. Joints are these nodes. |
| `Camera`, `Light` | Ignored, along with their children that are not models. |

Parenting follows `OO` connections from model to model. A model connected only to `0` is a scene root. The glTF node name is the part after `::`, with the type prefix removed.

### Local transform

FBX evaluates, in order:

1. Translation.
2. Rotation offset, then rotation pivot, then pre-rotation, then local rotation, then post-rotation, then the inverse rotation pivot.
3. Scaling offset, then scaling pivot, then local scale, then the inverse scaling pivot.
4. Geometric translation, rotation, and scale. These apply to the mesh vertices and not to children.

The properties are `Lcl Translation`, `Lcl Rotation`, `Lcl Scaling`, `RotationOffset`, `RotationPivot`, `PreRotation`, `PostRotation`, `ScalingOffset`, `ScalingPivot`, `GeometricTranslation`, `GeometricRotation`, `GeometricScaling`. Missing vectors are zero, except scale, which is `(1, 1, 1)`. Euler angles are degrees. `RotationOrder` `0` is XYZ and is the only order the first slice accepts. Any other order throws a typed error that names the node, so the failure is obvious. A later slice can add the other five orders.

`InheritType` `0` (local) is accepted. `InheritType` `1` (parent scale ignored on rotation) and `2` (segment scale compensate) throw in the first slice. Those modes are real on Maya rigs and are called out here so they are not silently dropped.

The local rotation, pre-rotation, and post-rotation bake into one quaternion. glTF has no pre-rotation slot. The bake is the product `pre * local * post` with the pivots folded into the translation. A test with a 90 degree pre-rotation and a zero local rotation must produce the same quaternion as a 90 degree local rotation and a zero pre-rotation.

Geometric transform is applied to the mesh's positions and normals, not to the node. Children do not inherit it. That matches FBX and keeps the joint chain free of the mesh's geometric offset.

### Geometry

`Geometry` subtype `Mesh` supplies:

- `Vertices`, a double array, three per control point.
- `PolygonVertexIndex`, an int array. A negative value ends a polygon. The control-point index is `value` when `value >= 0`, and `(-value) - 1` when `value < 0`. The fixture `0, 1, -3` is the triangle `(0, 1, 2)`.

Polygons with more than three vertices are fanned from the first vertex. A polygon with fewer than three vertices throws. The resulting triangle list is the glTF index buffer. Export still uses 16-bit indices at or below 65535 vertices and 32-bit above, because 65535 is the primitive restart value. That rule already lives in the writer.

Normals and UVs use layer elements. The builder reads the first `LayerElementNormal` and the first `LayerElementUV`. Later UV sets are ignored, and a comment in the reader says so. `MappingInformationType` and `ReferenceInformationType`:

| Mapping | Direct | IndexToDirect |
| --- | --- | --- |
| `ByVertice` | One value per control point | Index array into the direct array, one per control point |
| `ByPolygonVertex` | One value per polygon vertex, in `PolygonVertexIndex` order | Index array, one per polygon vertex |
| `ByPolygon` | One value per polygon, copied to each of its triangles | Same, through the index |
| `AllSame` | One value, copied to every vertex | The index array's first entry |

Any other mapping throws. After triangulation, values are stored per exported vertex, not per control point. A control point with two different normals becomes two glTF vertices. The same split applies to UVs and vertex colors. Joint weights are copied onto each split vertex from the control point.

Missing normals are generated from the triangle faces, area-weighted, then normalized. A zero-length generated normal throws, which matches `gltf-pro`.

`LayerElementMaterial` with `AllSame` uses one material index. `ByPolygon` uses one material index per polygon, and the builder splits the mesh into one glTF primitive per material. The first slice writes one primitive per material on one glTF mesh. `gltf-pro` already loads multiple primitives.

Vertex colors from the first `LayerElementColor` are written as linear `COLOR_0`. FBX colors are treated as linear. A file that stored sRGB colors will look wrong, and the README will say that, because guessing the space is worse.

### Materials

The builder accepts `Lambert` and `Phong`. Anything else on a mesh falls back to a white dielectric: color `(1, 1, 1, 1)`, roughness `1`, metalness `0`.

| FBX | glTF |
| --- | --- |
| `DiffuseColor` | `baseColorFactor` rgb. Alpha comes from `Opacity`, default `1`. |
| `Opacity` | `baseColorFactor` alpha. Below `1` sets `alphaMode` to `BLEND`. |
| `EmissiveColor` | `emissiveFactor` |
| `Shininess` | Roughness `clamp(sqrt(2 / (shininess + 2)), 0.045, 1)`. This is the formula the Three bridge uses today. |
| `SpecularColor` | Ignored for metalness. Metalness stays `0`. |

`DiffuseColor` connected through a `Texture` and `Video` becomes `baseColorTexture`. `NormalMap` becomes `normalTexture`. Other maps are ignored in the first slice. The texture file must be PNG or JPEG. Embedded `Content` bytes are used when present. Otherwise the name is resolved against `resourcePath` and fetched with the abort signal. A `file:` URL still throws `FBX resources need HTTP(S)`.

The Three bridge also rewrites non-standard materials with that shininess formula. The native path applies the same formula to Phong and Lambert and does not construct a `MeshStandardMaterial`.

### Skin

A `Deformer` of subtype `Skin` connected to a mesh, containing `Cluster` deformers, becomes one `SkinData`.

Each cluster has:

- `Indexes`, control-point indices.
- `Weights`, one float per index.
- `Transform`, the 16-float mesh bind matrix, column major as stored by FBX.
- `TransformLink`, the 16-float bone bind matrix.
- An `OO` connection to the `LimbNode` that is the joint.

The inverse bind matrix written to glTF is `inverse(TransformLink) * Transform`, after the axis and unit conversion has been applied to both matrices. A cluster with no joint link is dropped. A cluster whose index count and weight count differ throws. A negative weight throws.

More than four weights on one control point: keep the four largest, drop the rest, and renormalize so the stored weights sum to 1. If the original sum is 0, throw. A test with five weights on one vertex checks that the smallest was dropped and that the glTF weights sum to 1.

`Transform` and `TransformLink` are required. The writer does not invent an identity bind from the current pose. A cluster missing either matrix throws. That is stricter than some importers, and it avoids a silent bad bind.

The skin is attached to the mesh node. Joint nodes are the limb nodes, included in the hierarchy even when they have no mesh.

### Morphs

A `Deformer` of subtype `BlendShape` on a mesh contains `BlendShapeChannel` children, each connected to one `Shape`.

- `Shape.Indexes` lists control points.
- `Shape.Vertices` lists xyz deltas, three floats per index.
- `Shape.Normals` is optional and follows the same index list.
- `BlendShapeChannel.DeformPercent` is the default weight in the range 0 to 100. The glTF node weight is that value divided by 100.
- The channel name after `::` becomes `extras.targetNames`.

Deltas are expanded to a dense `VEC3` array the length of the exported vertex count. Split vertices copy the control point's delta. A shape index past the control-point count throws. A shape with no indexes is an empty target and is skipped.

Tangents are not reconstructed for morphs in the first slice. The base mesh still has tangents when the geometry supplied them. Morph `TANGENT` is omitted, which the animation shader treats as a zero delta.

### Animation

The builder reads one `AnimationStack` as one glTF animation. The stack's name after `::` is the clip name. The fixture's stack is `AnimStack::Move` and the glTF clip name is `Move`.

Inside the stack, each `AnimationLayer` connected by `OO` is merged into that one clip. The first slice does not blend layers. A second layer that animates the same node and property throws `Duplicate animation target`, which is the same error the animation package throws for two channels of one path.

An `AnimationCurveNode` connects to a model property through `OP`. The property names that map to glTF are:

| Curve node property | glTF path | Value width |
| --- | --- | --- |
| `Lcl Translation` | `translation` | 3 |
| `Lcl Rotation` | `rotation` | 4, quaternion |
| `Lcl Scaling` | `scale` | 3 |
| `DeformPercent` | `weights` | one scalar per morph on that mesh, in target order |

`AnimationCurve` objects connect to the curve node by `OP` with `"d|X"`, `"d|Y"`, or `"d|Z"`. A missing axis stays at the rest value for every key. The fixture writes only `d|X` on translation, from 0 to 2, and the other two components stay 0. The times in that fixture are `0` and `46186158000`, and the glTF input accessor is `[0, 1]`.

`KeyTime` is in FBX ticks. One second is `46186158000` ticks. Seconds are `keyTime / 46186158000`. The result is stored as Float32, which is what the animation package requires.

`KeyValueFloat` is one float per key. Translation and scale values are converted with the same unit scale as the node. Rotation values are degrees on that Euler axis and are combined with the other axes at each distinct time, using `RotationOrder` 0. The sampled Euler is converted to a quaternion. Keys on X, Y, and Z that do not share times are unioned, and a missing axis holds its previous value.

`KeyAttrFlags` selects interpolation. The flag constants from the FBX SDK curve definition:

| Flag | Meaning | glTF |
| --- | --- | --- |
| `0x00000002` | Constant | `STEP` |
| `0x00000004` | Linear | `LINEAR` |
| `0x00000008` | Cubic | `LINEAR` at the key values, tangents dropped |

A curve with no flags is linear. A curve that mixes constant and linear per key span uses `LINEAR` for the whole channel in the first slice, which is a known loss, and the channel is still accepted. Cubic tangents in `KeyAttrDataFloat` are not read yet. A comment on that branch names the deferred `CUBICSPLINE` work.

Weight curves write one glTF `weights` channel for the mesh node. The output is a scalar stream of all target weights, target-major within each key, which is the glTF layout. Targets with no curve hold `DeformPercent / 100`.

Channels that would target a node using a baked `matrix` are not emitted that way. The node is always written as TRS.

## Module split inside `@margoengine/fbx`

| File | Job |
| --- | --- |
| `src/index.ts` | `convertFBX`, `parseFBX`, `loadFBX`. Budgets, abort, image decode. No Three imports. |
| `src/binary.ts` | Header, nodes, properties, inflate. |
| `src/ascii.ts` | The ASCII subset above, into the same node type. |
| `src/document.ts` | Objects, connections, `Properties70`. |
| `src/scene.ts` | Axis, units, nodes, local transforms. |
| `src/geometry.ts` | Polygons, layers, vertex split, generated normals. |
| `src/material.ts` | Lambert and Phong, textures. |
| `src/skin.ts` | Clusters and the inverse-bind product. |
| `src/morph.ts` | Shapes and percent weights. |
| `src/animation.ts` | Stacks, curves, ticks, Euler to quaternion. |
| `src/convert.ts` | Builds the `ExportScene` and calls `exportGLB`. |

`package.json` drops `three`. It gains a dependency on `@margoengine/exporters`. `@margoengine/gltf-pro` and the core peer stay. The package remains `sideEffects: false`.

## Tests

The current file `packages/fbx/test/fbx.test.js` is the regression contract. These assertions stay, and they must pass with no `three` import in the package or the test:

- The ASCII triangle and the hand-built binary triangle both produce a GLB whose first bytes are the glTF magic `0x46546c67`, one mesh, and a position accessor of count 3.
- The Khronos validator reports zero errors on both.
- The animated ASCII fixture produces one animation named `Move`, a translation channel, input times `[0, 1]`, and output values `[0, 0, 0, 2, 0, 0]`. Validator errors stay zero.
- Inputs shorter than 32 bytes or claiming a `file:` resource path throw. An already-aborted signal throws `AbortError`.

The texture test that patches `FBXLoader.prototype.parse` and `GLTFExporter.prototype.parseAsync` is rewritten. It builds a binary FBX with one embedded 1×1 PNG, or it calls the image accounting path with a GLB the native converter produced. The assertions stay: 12 images are decoded once, width and height are read once each, and every bitmap is closed when the caller aborts.

New tests, each with a binary and an ASCII case where the builder is shared:

| Test | Asserts |
| --- | --- |
| Missing `GlobalSettings` | The fixture vertex `(1, 0, 0)` is unchanged. |
| `UnitScaleFactor` 1 and a vertex at x = 100 | glTF position x is 1. |
| Y-up identity axis | No axis swap. |
| Z-up, sign +1 | Y and Z swapped to Y-up. |
| Polygon `0, 1, 2, -4` | Two triangles, four vertices or an indexed quad fan. |
| Five weights on one control point | Four influences, smallest dropped, weight sum 1, validator clean. |
| Cluster missing `TransformLink` | Throws, and names the cluster. |
| 90° `PreRotation` on X, zero local rotation | Same quaternion as a 90° local X rotation. |
| `InheritType` 2 | Throws. |
| `RotationOrder` 1 | Throws. |
| Phong shininess 10 | Roughness equals `clamp(sqrt(2 / 12), 0.045, 1)`. |
| Shape delta on control point 1 | Morph `POSITION` is zero everywhere except that vertex, and `DeformPercent` 50 becomes node weight 0.5. |
| Cubic flag `0x8` | Channel is `LINEAR` and the key values are present. |
| Deflate-encoded vertex array | Same triangle as the raw array. |
| 7500 header with `uint64` node fields | The same triangle parses. |
| More than 1,000,000 vertices | `FBX geometry budget exceeded`. |
| Exporter data scene with one skin and one clip | `exportGLB` output passes the validator and `Animation`'s constructor against a parsed `PBRModel` in the existing headless engine test style. |

The exporter's current validator tests stay untouched and still report zero warnings. A new exporter test covers joints, weights, one inverse-bind matrix, and one translation channel, and it does not import `@margoengine/fbx`. That keeps the writer honest without a parser.

The browser fixture behind `MARGOENGINE_FBX_FIXTURE` stays. It loads a real skinned file, checks that skins and clips survive, and checks that rendered pixels change after a seek. It is not a unit fixture and it is not added to the repo.

## Order of work

1. **Data-scene types and static writer behavior.** Add the optional fields. Do not write them yet. Existing exporter tests pass.
2. **Skin and morph accessors.** One data-scene test. Validator clean. No FBX yet.
3. **Animation accessors.** The `Move` channel, written from a data scene, not from FBX. Float32, strictly increasing times, TRS nodes.
4. **Binary and ASCII front ends.** Parse the existing triangle fixtures into the generic node tree. No glTF yet. Assert object ids, the vertex array, and the connection list.
5. **Mesh conversion.** `convertFBX` on the triangle fixtures returns the same GLB shape the tests already assert, through `exportGLB`.
6. **The `Move` clip.** Ticks, one axis, rest values on Y and Z.
7. **Materials, units, axes, pre-rotation.**
8. **Skin reduction and morphs.**
9. **Delete the Three imports, the Three devDependency usage in this package, and the prototype-patching test.** `npm test --workspace @margoengine/fbx` and `npm test --workspace @margoengine/exporters` both pass.

Each step is reviewable on its own. Steps 1–3 land in `@margoengine/exporters`. Steps 4–9 land in `@margoengine/fbx` and can start once step 3's writer API is merged.

## Explicit non-goals

These are real FBX features. They are out of this project, and the parser throws or ignores them as stated. Ignoring means the object is skipped and the rest of the file still loads. Throwing means the file is rejected.

| Feature | First slice |
| --- | --- |
| NURBS, patches, curves as renderable geometry | Ignored |
| Cameras and lights | Ignored |
| `RotationOrder` other than XYZ | Throws |
| `InheritType` other than 0 | Throws |
| More than four joint influences | Reduced to four, renormalized |
| `JOINTS_1` | Never written |
| Cubic curve tangents as `CUBICSPLINE` | Keys kept as `LINEAR` |
| Layer blending | Second layer on the same property throws |
| Multiple animation stacks | Each stack is its own glTF animation. The first slice can do this once one stack works. |
| Texture transforms, layered textures, procedural maps | Ignored |
| Metalness from specular | Not inferred. Metalness stays 0. |
| sRGB vertex colors | Written as linear, documented |
| `TEXCOORD_1` and above | Ignored |
| Draco, meshopt, KTX2 | Never written |
| FBX 6 and earlier | Throws on a version below 7400 |
| Encrypted or uncommon binary property types | Throws |
| A new package name | Not created |
| Core or stage changes | None |
| Replacing `@margoengine/exporters` | The writer is extended |

## Risks

The bind-matrix product `inverse(TransformLink) * Transform` is the usual cluster convention, and some exporters transpose one of the matrices. The skin test uses a cluster whose bind is a known translation, and the expected inverse bind is written out as sixteen numbers in the test. If a real DCC file disagrees, the fixture wins only after one real file is added under `MARGOENGINE_FBX_FIXTURE` and the product is corrected in one place, in `src/skin.ts`.

Float32 animation times cannot tell `46186158000` ticks from the next tick. Keys closer than about `1e-6` seconds collapse, fail the strictly-increasing check, and throw. That is the right failure.

Vertex splitting changes indexes. Weights and morph deltas are applied by control-point id before the split, then copied. A test that shares one control point across two UV islands locks that order.

`DecompressionStream` and the test inflate must accept the same deflate wrapper. The deflate test uses one vector checked against a known uncompressed `Vertices` array, not a round trip through a different library's defaults.
