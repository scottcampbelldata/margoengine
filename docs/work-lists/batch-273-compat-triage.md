# Batch 273 compatibility triage, round 9

All failures 11 through 26 were inspected together against the original lane-S
logs and the owning fixtures and runtime. Groups below distinguish a proven
shared setup cause from symptoms that still need isolation. Each problem has
one round in this grouped pass; five rounds without closure means park it with
the evidence and next experiment. Failure 9 is already parked by coordinator.
No numerical assertion, work grid or timeout is relaxed.

| Failures | Group and evidence | Next action |
| --- | --- | --- |
| 11 wireframe | Existing feature built; four original1x hash/alpha quality failures of249 checks remain. Directional-control experiment regressed and was reverted. | DONE under rule22 at98.4%; original exact comparisons remain in finish-later for the fix phase. |
| 12 normal map | Resolved bitmap upload root cause: WebGL ignores unpack flip/alpha flags on ImageBitmap. | Normalize the copied rectangle to a drawable canvas, then honor the existing flags. Full native/compatibility tangent, lobe and round-trip checks pass unchanged; source regression fails the parent. |
| 13 ExactOIT | Explicit capability refusal. Its fragment atomic read/write linked lists cannot use the layer's read-only storage data textures. Weighted OIT passes. | Determine a complete equivalent route; do not substitute weighted OIT or count refusal as full parity. |
| 14 React XR, 26 root XR | Resolved setup plus presentation: React's incoming preparation passes its complete canonical suite. Root simulated bindings identify the actual selected device. XR page-backed devices and desktop offscreen devices previously tried incompatible output modes on one canvas. | Preserve the canvas output mode across either device transition. The regression fails on the parent. Complete root native/compat stereo, package pass, depth and AR assertions pass; actual installXR bridging remains in its dedicated native/compat comparison. |
| 15 scatter shadow-cull | Resolved fixture ownership: native cascadeCull and compatibility route.shadow each own a real GPU-written command buffer. | The actual-method regression fails on the parent and passes after selecting the owner. Complete canonical native/compatibility depth, frame and per-cascade/ring count checks pass unchanged. |
| 16 scenery | Resolved fixture race: compatibility may await lazy compute before presenting. | Await actual submitted work on compatibility, retain native task-local capture. Complete original native and compatibility suites pass at1x/4x; actual-method regression covers both contracts. |
| 17 selection, 19 sky | Bounded incomplete runs, not a shared cause yet. Selection stops after occlusion; sky after cloud shadows 4x. | Locate the next awaited operation and account for full work; no timing exemption established. |
| 18 shader readback | Resolved: compute pipeline construction omitted device binding limits; async pipeline errors also wrote a read-only DOMException name. | Aggregate all compute-visible bindings across groups before either execution route; five regressions and the unchanged complete native/compat readback leaf pass, including rejection and recovery. |
| 20 splats | All GPU assertions complete but process remains alive at body bound. | Dedicated teardown owner retains this issue; no local teardown hunting. |
| 21 terrain, 25 compat adapter | Proven shared harness cause: outer MARGO_COMPAT replaces navigator.gpu before each fixture's explicitly native baseline. openBrowser already supports compat:false. | Seven canonical comparison drivers now opt out of the outer shim and retain their own backend selection and every assertion. Regression executes their real setup calls with MARGO_COMPAT=1. Full compat test:gpu remains subject to the separate tracer hang owner. |
| 22 voxel, 23 slow compile, 24 slow mesh | Same bevel fixture needs layers 256 and 2047. limitsOf clamps MAX_ARRAY_TEXTURE_LAYERS to WebGPU default 256 before advertising adapter limits. Core already requests the adapter's max layer count. | Root repaired: actual adapter capacity and independent device negotiation. Full voxel and both slow-path commands pass all original assertions. The separate native-only synthetic delay gap is retained in known-bugs; no injected compatibility-delay proof is claimed. |

Receipts are attached to the fixing commit. Setup repairs do not establish
full-package parity or close later failures a canonical suite might reveal.
No tracer compilation, teardown investigation or speed benchmark is included.
