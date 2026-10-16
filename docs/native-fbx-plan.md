# Native FBX implementation plan and progress

Updated: 2026-10-16. Status: first native implementation verified; real-DCC/rendered compatibility gates remain open. Gzip figures in this note are from the checks recorded here. The current build measures core at 18,192 bytes gzip and core plus stage at 19,999 bytes gzip. The gate rejects 20,000 or above.

Replace the Three.js bridge inside `@margoengine/fbx` with Margo-owned binary and ASCII readers, scene conversion, and the existing `@margoengine/exporters` glTF writer. Keep the public package and loading APIs. This file tracks the implementation and its verification; unchecked items remain outstanding.

## Boundaries and decisions

- Core and stage remain feature-frozen. This work also leaves the animation runtime unchanged: generated skins, clips, and morphs use its existing glTF contract.
- Extend the existing exporter data-scene API for skins, morphs, and animation. Do not introduce another glTF serializer. Engine-scene export stays static.
- Preserve `convertFBX`, `parseFBX`, `loadFBX`, `resourcePath`, and `signal`, including `string | URL` loading.
- Preserve 64 MiB input, 128 MiB converted GLB, 1,000,000 expanded position vertices summed across mesh instances, and 16,000,000 decoded texture pixels. Add cumulative decoded-array, topology, hierarchy, and animation work limits.
- Use platform `DecompressionStream('deflate')` for zlib arrays in supported browsers and Node. No extra test-only inflater: tests exercise the production decoder. Report an unsupported platform explicitly if the API is absent.
- Bound import-time allocations and reuse scratch storage in bulk loops. Asset buffers, metadata, and platform streams allocate; literal allocation-free import is not the contract.
- Remove Three from the FBX runtime dependency graph. Root development dependencies used by unrelated benchmarks are outside this change.
- Keep the existing CI check that fails at core + stage gzip **20,000 bytes or above**.

## Review incorporated from the supplied notes

Sources: [native-fbx.md](native-fbx.md), the original parser proposal, and the additional Gemini execution notes supplied in this chat. These are design inputs; the decisions and verified progress in this file govern this implementation.

Useful additions adopted: reuse `exportGLB`; extend the exporter before integration; keep public signatures and existing loading limits; share one document representation across encodings; retain vertex-to-control-point maps for skin/morph remapping; test the writer independently from FBX; validate generated GLBs with the Khronos validator.

Corrections to the notes:

- The binary prefix is 23 bytes and the version occupies bytes 23–26, making the complete file header 27 bytes.
- At version 7500 only node end offset, property count, and property-list length widen to uint64. Array count, encoding, and payload length remain uint32. Null records become 25 bytes instead of 13.
- Inflate reconstructs source bytes. Float64 arrays must be read as float64 before narrowing; they cannot be inflated directly into float32 values.
- IDs must remain exact signed 64-bit values; validate offsets before converting them to JavaScript numbers.
- FBX post-rotation is inverted. Parent inheritance is separate from the local pivot chain. Unsupported inheritance or unrepresentable shear must reject explicitly.
- Unit conversion applies to positions and translations, not dimensionless scale animation values. Missing global settings preserve raw coordinates.
- A polygon fan is valid only for convex faces. Concave triangulation must preserve original corner indices and have a work bound.
- Animation axes with distinct key times require interpolation at the union of times. Holding every missing axis at its previous key changes linear motion. Cubic or mixed interpolation must be faithfully baked or explicitly rejected, not silently relabeled LINEAR.
- A skin bind test must include a nonidentity mesh bind and geometric offsets. Establish the coordinate convention before applying `inverse(TransformLink) * Transform`.
- Signed axes are mapped directly: canonical Y-up is Coord X+, Up Y+, Front Z+. Blender Z-up is Coord X+, Up Z+, Front Y-, producing `(x,z,-y)` with positive determinant. Do not negate FrontAxisSign a second time.
- Fixture-derived numerical assertions and a required small runtime animation test complement optional real-DCC asset testing.

## Build checklist

### 1. Exporter data contract and writer

- [x] Add optional `MorphData`, `SkinData`, joints/weights, node morph weights, and animation channel types.
- [x] Validate and serialize ushort joint attributes, normalized Float32 weights, Float32 inverse bind matrices, and morph deltas.
- [x] Resolve skin joints and animation targets by visited node identity; reject missing/hidden references and duplicate targets.
- [x] Write validated STEP, LINEAR, and CUBICSPLINE data-scene clips, keeping animated nodes in TRS form.
- [x] Preserve existing static exporters and validate independent animated data scenes with Khronos.

### 2. Native binary and ASCII readers

- [x] Implement checked binary records, typed properties, exact IDs, 7400/7500 layouts, and bounded production zlib decoding.
- [x] Implement ASCII comments, strings, scientific numbers, nested nodes, and counted arrays.
- [x] Index Objects, Connections, and Properties70; reject duplicate IDs, missing references, and model hierarchy cycles.
- [x] Cover raw/compressed equivalence, 7500 arrays, IDs above 2^53, offset overflow, truncation, unknown tags, and decompression bounds.

### 3. Geometry and transforms

- [x] Decode polygons and preserve original corner/control-point correspondence through bounded triangulation.
- [x] Resolve normal, UV, tangent, color, and material layers; split seams; generate nonzero normals.
- [x] Implement unit/basis conversion, six Euler orders, pivots, inverse post-rotation, and mesh-only geometric transforms.
- [x] Reject unsupported inheritance and shear with object context.
- [x] Verify concave polygons, material groups, UV seams, reflected winding, units, and transform baselines.

### 4. Materials, skin, morphs, and clips

- [x] Map Lambert/Phong to dielectric PBR; load embedded or bounded HTTP(S) PNG/JPEG textures.
- [x] Resolve clusters, validate bind matrices, reduce to four strongest influences deterministically, normalize, and remap split vertices.
- [x] Expand sparse blend shapes and default weights; reject unsupported progressive shape combinations.
- [x] Convert FBX ticks and model/morph curves into supported clips; evaluate axes at common times and maintain quaternion continuity.
- [x] Verify bind-pose identity, nonidentity mesh binds, five-influence reduction, morph seams, and sampled motion.

### 5. Integration and dependency removal

- [x] Replace Three imports with native conversion through `exportGLB`.
- [x] Preserve load/parse cancellation, texture pixel accounting, cleanup, and output bounds.
- [x] Rewrite prototype-mocking tests to use actual first-party FBX fixtures.
- [x] Update package dependency policy, lockfile, README, and consumer declarations.

### 6. Verification and follow-up compatibility

- [x] `npm test --workspace @margoengine/exporters` (17 tests; plus 3 USDZ/subpath regressions).
- [x] `npm test --workspace @margoengine/fbx` (52 tests, zero failures or skips).
- [x] Existing dependency-policy tests (5 tests).
- [x] Packed-package checks: all 62 packages import without browser globals; strict Bundler and NodeNext consumers compile.
- [x] Core + stage gzip remains below 20,000 bytes (19,999 bytes).
- [x] Required small headless skin + morph + clip integration test, with real PBRModel/Animation attachment and seek.
- [ ] Rendered WebGPU skin + morph + clip integration with a real asset.
- [ ] Licensed real Blender/DCC fixture coverage and broader FBX 7.x certification.
- [ ] Faithful cubic/mixed interpolation, additional inheritance modes, and progressive morphs, if not included in the first implementation.

## Implementation status

- Built and verified: exporter skin/morph/clip support; bounded binary/ASCII readers; geometry/transform modules; native skin/morph/material/animation conversion; public API replacement; dependency removal; source caches and preallocation checks; loading/material regressions.
- Final full verification under Node 24.22.0: **903 passed, zero failures, zero skips**, including all 52 FBX tests. Log: `test-results/native-fbx-full-node24.log` (ignored local evidence). The earlier intermediate Node 24 run had 888 passing tests; the final count includes 15 additional loading/material and budget regressions.
- The first full source build passed. The subsequent host Node 26 test run passed 883/884 tests; its remaining CAD initialization test uses `stripTypeScriptTypes({mode:'transform'})`, removed in Node 26. The complete final suite passes under CI's Node 24 major; no unrelated core/test source was changed.
- Full source-build size measurement: core + stage 19,999 bytes gzip, with the existing strict 20,000-byte rejection threshold intact.
- The budget boundary test accepts 19,999 and rejects 20,000/20,001. Scene tests exercise cumulative allocation/work/morph thresholds, rejection before scratch/output allocation, repeated-source caching, and source reduction/remapping across material primitives.
- Packed consumer verification passed for all 62 packages. Log: `test-results/native-fbx-packages.log`. Focused FBX result: `test-results/native-fbx-focused.log`.
- Parser limits: 64 MiB cumulative arrays and 128 MiB allocation accounting. Scene limits: 128 MiB cumulative allocation accounting, 128 million work units, and 64 MiB total morph outputs. Animation additionally limits cumulative output values, baking work, sampled evaluations, and Float32 key spacing.

## Primary format references

- [Blender binary reader](https://github.com/blender/blender-addons/blob/main/io_scene_fbx/parse_fbx.py): node-width transition, array record layout, zlib arrays.
- [Compression Standard](https://compression.spec.whatwg.org/): zlib deflate streams and output byte chunks.
- [Autodesk FBX cluster API](https://help.autodesk.com/cloudhelp/2019/ENU/FBX-Developer-Help/cpp_ref/class_fbx_cluster.html): mesh/joint bind spaces and link modes.
- [Blender FBX axis definitions](https://github.com/blender/blender/blob/main/scripts/addons_core/io_scene_fbx/fbx_utils.py): signed Y-up/Z-up conventions.

## Supported subset and remaining work

The FBX reader accepts version headers 7400 through 7700, with synthetic tests at both header layouts and the upper endpoint. This is structural support, not DCC certification. Six Euler orders and adaptive LINEAR rotation/pivot baking are implemented. Cubic/mixed/constant-next curves, additional inheritance modes, nonuniform ancestor scales, TotalOne/Additive/nonlinear skins, progressive shapes, and layer blending reject explicitly. Extra UV/layer sets and unsupported material maps are omitted. Multi-material geometry uses child mesh nodes under its model because the existing data-scene writer has one geometry/material per node.

The existing downstream glTF runtime accepts at most 64 MiB of GLB/buffer data. `convertFBX` retains its 128 MiB export ceiling, but larger results cannot be attached through `parseFBX` without separate optional-runtime work. Import allocations are bounded/accounted; they are not zero and accounting is not a peak-heap measurement. CPU abort checks cannot process a newly dispatched abort while JavaScript is executing a synchronous section.

## Completion gates

The first implementation is usable when native binary and ASCII inputs produce valid static and animated GLBs, all public API regression tests pass without Three, unsupported features reject explicitly, and core/stage budgets pass. Broad DCC compatibility remains a separate, visible gate until real exported assets and runtime rendering checks pass. Record exact test results and remaining limitations here rather than treating a synthetic triangle as full FBX compatibility.
