# Local asset workload correctness

The six labeled asset workloads under `examples/package-benchmarks/` use actual
package operations and render their resulting geometry. Their native cadence,
GPU overhead, full-scene startup and physical-mobile/cold-hosted acceptance have
not been measured yet. No package source, dependency or production route changed
for these examples.

The CPU command
`node --test examples/package-benchmarks/asset-workloads.test.js examples/package-benchmarks/factory-loading.test.js`
passed all eight asset checks and three initialization/lifecycle checks on
2026-10-13. Total Node duration was 6.59 seconds, including module initialization;
it is not a page startup measurement. Resource ownership was closed afterward.

| Package | Actual operation and checked result | Limit |
| --- | --- | --- |
| Loaders | Parse checked PLY dolphins: 855 vertices/1,689 triangles; repeated parses preserve indices and replace real geometry. | PLY fixture, rather than every supported format. |
| Exporters | Knight written through GLB, binary PLY, STL and OBJ/MTL; visible geometry is parsed from emitted PLY. Khronos validator reports zero GLB errors, and STL length matches 1,000 triangles. | Static untextured fixture. |
| USDZ-export | Actual standalone aligned archive, parsed back into the 1,000-triangle knight geometry. | No Apple Quick Look acceptance. |
| FBX | Checked ASCII triangle converted by actual Three FBXLoader and GLTFExporter; emitted positions match and GLB validator reports zero errors. | Static triangle; no production texture/skin/clip claim. |
| IFC | Real web-ifc Wasm parses IFC4 wall with product ID25, name/global ID and original 0.2 × 3 × 4 meter extent; 12 triangles. Repeated parse closes model ownership, and caller API disposal is idempotent. | Wall fixture; no BIM property-set browser. |
| Decoders | Prepared actual Draco Avocado geometry worker decode, two-worker pool and accessor-count checks. Node test confirms honest rejection where browser workers are unavailable. | Worker/GPU proof pending; KTX2 is not exercised. |

Additional checks prove that asynchronous batches do not overlap, paused/page
ownership cannot publish late geometry, abort disposes once, display normalization
preserves the source arrays/topology, and rejected optional dependencies cannot
publish an empty workload. Only 1/4/9 models are allowed, and repeated asset
batches run at most once per simulation second.

Asynchronous decode/import/batch elapsed time is labeled separately from measured
synchronous frame CPU. The shared benchmark will retain actual rAF distributions,
GPU timing OFF/ON/ON/OFF results, readiness correlated to the assembled render's
last submission, viewport/visibility and cleanup evidence when its native slot
is granted. Browser workers and GPU pixels remain required acceptance steps.
