# Kinematics and robot allocation handoff

Updated: 2026-10-16. This document records verified work, evidence locations, limits, and the next experiments. It is a checkpoint, not a completion claim.

## Active objective and current state

Fix the Light Keeper robot demo and its optional packages until sustained, warmed browser idle and continuous-drag captures show no allocation-driven GC or heap sawtooth. Preserve public APIs, numerical guards, full arm controls, and actual skinned-geometry clearance. Rebuild and verify the live preview. Keep improvements and revert regressions.

The objective remains **active and incomplete**. The recorded constraints-demo stalls have been corrected for the tested trajectories. The robot still allocates and triggers GC in measured captures.

The tested robot checkpoint is now [live on margoengine.com](https://margoengine.com/demos/light-keeper/), production `feeb64de-fa35-4f9b-b66c-f2952a80f0b7`, source `ca5194b`, preview `37bcc883`. It includes the near-face/cross-body eye fix and retains the resting-hand model repair. All **192 public files** were verified after publishing, including 191 unchanged baseline files and all 24 old workshop assets. See [LIGHT_KEEPER_DEPLOYMENT.md](LIGHT_KEEPER_DEPLOYMENT.md) for exact release identities, snapshot hashes, historical hand-release evidence and future deployment procedure.

Two different demos are involved:

- **Constraints lab:** http://127.0.0.1:5173/examples/kinematics-constraints.html. Its demo controller performs full-chain solve, pacing, contact recovery, and reach conditioning.
- **Light Keeper robot:** http://127.0.0.1:5192/. Its robot adapter integrates the library through resolveTarget(), then retains its analytical arm solve, grip orientation, torso assist, and detailed mesh/contact checks. The constraints lab's new recovery controller is not part of this robot render loop.

An allocation change in one demo does not establish the behavior of the other.

The reported near-face eye bug is fixed for the tested reproductions and live release. Arm candidates previously remained acceptable when the head found a collision-free rotation looking away from the orb; the captured live pointer case reached **103.46 degrees** of optical error. The demo now conditions requested targets against a moving head-pivot gaze workspace and uses bounded waypoints to avoid inward chase chords and recovery latching. The existing demo `HeadAim`, public package API and numerical guards are unchanged; existing head/orb/armor checks remain active. This is a demo adapter policy, not a new public package capability.

### Current eye release: evidence and limits

The exact deployed snapshot is `test-results/light-keeper-eye-live/site`: **194 files / 192 public**. Manifest SHA256: `f3d62c5867e43b67ed95f2bb5d40f5b704c4ac31802312d2e2d90a2c4faa2595`; final build-report SHA256: `1ea983041bcf3d3ac87d0ee073c252ce3bc4ed0a50a551d76ca87dd8af5e0778`. Only the nested workshop HTML/report replace baseline files; the new hashed entry script is added. Homepage, Tokyo, old assets and Cloudflare configuration remain intact. All public hashes/status/MIME, the canonical route and missing-asset 404/`no-store` behavior passed independent checks. Reports: `test-results/light-keeper-eye-live/production-verification.json`, `production-independent-audit.json` and `production-deployment-metadata.json`.

The final build is **703,335 raw / 237,609 gzip JS bytes**, **103 modules**, and **21,716,983 scene-asset bytes**; core plus stage remains **19,999 gzip bytes**. The exact captured bad-eye replay now settles to approximately **4.55e-7 degrees** optical error. The actual live pointer sample in `production-browser-metrics.json` has `targetConditioned: true`, requested target `[0.137600377, 1.181730628, -0.326119065]`, held orb `[0.137600332, 1.181730628, -0.366465688]`, optical error **1.831486e-7 radians**, a safe arm, `limited: false`, and grip error approximately **1.3074e-8 m**. The head-clearance residual is **+0.001000026 m above the configured margin**, not the total surface gap. Its **650/650** reflection reuse count is an observed sample, not an allocation benchmark. Screenshot: `test-results/light-keeper-eye-live/production-browser.png`.

Validation passed **135/135 full robot tests before the final workspace-only opt-in** and **35/35 affected tests after it**, including 120 bit-exact transformed cases. Nine full-rig integration cases cover the captured pointer target, a 300-frame Home/reversal sequence, conditioned route arrival, look toggling, moving roots and zero-delta/no-solve revalidation. The reversal sequence has zero gaze-away frames but a **14.657-degree maximum transient error**, not exact gaze throughout. A look-OFF to look-ON transition while already inside the workspace can initially be **91.76 degrees** away; the tested transition recovers in approximately **183 ms**. Eight hardware motion cases cover 14 transitions and 612 published samples; final native CPU/GPU checks match **85 buffers / 83,968 bytes** bit-for-bit. Provenance: `test-results/head-crossbody/implementation-verification.json`.

The gaze workspace is a necessary proxy bound and retains posed mesh checks; it does not guarantee exact gaze for every travel-limited or behind-head target. Waypoint step limits exclude torso/base motion, and discrete poses/sampled chords are not actuator certification or swept-volume CCD.

### Current production-build allocation baseline

After the eye release, the exact **703,335 raw / 237,609 gzip JS-byte** production build was profiled on Edge 155 / NVIDIA RTX A6000, with 30 seconds of warmup and approximately 30 seconds of measurement per phase. Report: `test-results/skinning-ik-profile-gaze-repair-production-idle-drag.json`.

| Phase | Sampled MB/s | Minor GC | Major GC | Peak observed GC pause ms | p95 RAF callback wall ms | Reflection reuse | Animation steps |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Idle defaults | 0.784223 | 28 | 3 | 2.759 | 2.655 | 344/344 | 1,828 |
| Continuous torso drag | 1.067418 | 22 | 4 | 3.713 | 6.877 | 346/346 | 1,856 |

Measured drag received 938 trusted pointer moves. Browser errors and source changes were empty. These are current baseline observations; different code, workloads and natural runtime variation prevent treating their difference from prior captures as an isolated improvement or regression. RAF callback wall time is not GPU completion time or a physical safety measure. These metrics do not identify allocation constructors or prove zero owned allocations. **GC remains, so the allocation objective is still active and incomplete.**

### Retained torso writer: owned-path reduction, scene-wide benefit unproven

The next demo-only change gives `TorsoAim` an explicit rotation writer, wired once at startup to its own retained `RigScratch`. Omitting it retains dynamic public `Mesh.setQuaternion()` dispatch, including overrides. Core, public packages, numerical checks, collision geometry and motion policy are unchanged. Failed writes do not advance the successful-commit cache. This change is retained in source but **is not included in production `feeb64de`**.

Validation: **17/17 focused tests**, including **2,400 bit-exact authored-rig frames / 1,590 actual writes**, default setter overrides, restoration, transformed roots, store growth, zero-delta repeats, resets and invalid/disposed guards. Eight hardware motion cases with 14 transitions and **616 published samples** also passed, without browser errors or an unmoving chase. The candidate build is 703,549 raw / 237,677 gzip JS bytes; core plus stage remains 19,999 bytes.

A controlled Node census of **10,000 actual commits** used separate matched default/opt-in control and kernel processes. All four measured windows had zero natural collections and unchanged sources; a separate parity run verified 10,000 bit-exact writes. After correcting the verified duplicate function-context row, the selected structural reduction is **5,278,560 bytes**; excess HeapNumbers fell from 161,817 to 20,363, a further **2,263,264 bytes**. These establish removal of the identified Node allocation shapes, not a browser byte-rate prediction.

Fresh-page hardware captures used 30 seconds warmup and 30 seconds measurement for each phase. Baseline B served the exact archived original build; the queue writer remained native throughout.

| Variant | Idle MB/s | Drag MB/s | Drag minor / major GC | Peak drag GC pause ms | Drag p95 RAF callback wall ms |
| --- | ---: | ---: | --- | ---: | ---: |
| Baseline A | 0.784223 | 1.067418 | 22 / 4 | 3.713 | 6.877 |
| Torso writer | 0.640472 | 1.065740 | 18 / 4 | 3.752 | 5.066 |
| Baseline B | 0.736045 | 1.046181 | 18 / 5 | 4.472 | 5.022 |

The torso commit subtree sampled approximately **1.790 MB** in each baseline drag capture and zero in the candidate. Zero samples is not proof of zero actual bytes. The full-scene totals do **not** establish repeatable lower drag allocation or a CPU improvement. Retention is based on the independently verified owned structural reduction, bit-exact behavior and narrow explicit opt-in; do not attribute the large idle difference to torso writes. GC remains. Evidence: `test-results/torso-writer-ablation/{focused-tests.log,parity.json,census-comparison.json,fresh-aba-summary.json,motion-browser.log}` and the three `skinning-ik-profile-*.json` reports named in that summary.

## Workspaces, commits, and constraints

| Item | Location / state |
| --- | --- |
| Primary checkout | C:/Development/Projects/margoengine, branch main |
| Robot checkout | C:/Users/ScottCampbell/.codex/worktrees/skinning-ik/margoengine, branch codex/skinning-ik |
| Native-gradient recovery | Primary 6c242ae; robot cherry-pick 4c17f5d |
| Generated-waypoint reach fix | Primary c8bb451; robot cherry-pick 8aff06f |
| Prior robot performance checkpoint | f33e094 |
| Core + stage freeze | No new features; combined gzip must remain strictly below 20,000 bytes |
| Latest verified core + stage size | **19,999 gzip bytes** |
| Latest public API check | **166 entries / 1,548 exports unchanged** |

The prior robot allocation code/test checkpoint is committed and pushed as **6794863** on **codex/skinning-ik**. It includes the Animation native-writer/backing-store guards, environment output identity retention, explicit demo-owned head writer, and additional unconditional PBR writer regressions. The current live source is **ca5194b**. The experimental PBR uniform cache remains reverted. These changes do not establish zero-GC operation.

Preserve unrelated untracked documents, including docs/NEXT_DEMO_HANDOFF.md and docs/package-opinion.md. Large diagnostic recordings and reports live in ignored test-results folders. Only compact numerical regression fixtures are tracked.

## Constraints-demo diagnosis and fixes

### Original contact stall

The original complete user recording contained 2,250 frames over approximately 37.5 seconds:

- 548 held frames, with a longest run of 108.
- Final solve statuses: 1,702 Success, 544 ObstacleOccluded, 4 SwivelRateLimitExceeded.
- The UI's original-request hold reason classified all 548 as obstacle holds; those status counts must not be added as separate extra frames.
- Small straight Cartesian chords cut into link clearance by approximately 0.05–0.19 mm.
- More angular samples did not fix the checked chord failures. Independent dense angular searches also found those local candidate poses blocked.
- There was no accumulated pacing queue: pacing was recomputed from the accepted hand each frame.

### First recovery policy: fixed forward bias

A bounded contact-tangent recovery was added after the original solve and four smaller straight retries failed. All retries used the same dt and retained swivel history. Only a complete successful pose was accepted.

The initial world +Z bias reduced original-recording holds from 548 to 121 but did not eliminate them.

A later user recording exposed a 55-frame hold. The final recorded candidate in each of those frames had:

| Proxy | Physical surface gap | Required |
| --- | ---: | ---: |
| Upper arm | 7.903–7.910 mm | 8.000 mm |
| Forearm | 12.551–12.926 mm | 8.000 mm |
| Hand | 106.718–107.352 mm | 8.000 mm |

The upper-arm deficit was approximately 0.09–0.10 mm. The hand was not the binding proxy.

Reconstructed intermediate trials for frame 4225 showed the fixed +Z reserve making the upper-link residual progressively worse: approximately -44.82, -47.80, -53.85, -66.20, and -91.95 micrometres.

These intermediate trials were reconstructed, not directly recorded. The terminal reconstruction matched the stored candidate within approximately one micrometre.

### Corrected recovery: measured full-chain gradient

The controller now estimates the full-chain clearance gradient near a rejected short step, removes the inward component of the local hand displacement, and adds a small outward reserve along that gradient.

This matters because the active upper-link normal can have negative Z. A fixed forward nudge can reduce clearance.

Verified results:

- Original complete 2,250-frame recording: **2,250 accepted / zero held**.
- 239 accepted contact detours; each reduced current requested-target error.
- Peak hand step: approximately 12.675 mm for that variable-dt recording.
- Every tested detour remained within its tested nominal pacing bound.
- Separate 55 held snapshots: **55/55 first corrected detours accepted**, zero swivel change, minimum independently measured reserve approximately +46.53 micrometres.
- The 55 snapshots were individual reconstructed states from a different recording. Their success alone was not a continuous-replay claim.

### Seven remaining singular diagnostics

A fresh complete live recording with gradient recovery contained 3,103 frames:

- 3,096 accepted and seven held.
- No final ObstacleOccluded or swivel-rate holds.
- The seven final statuses were SingularDeadZone at frames 1306–1312.
- All seven retained the displayed pose unchanged.

The actual displayed arm during those seven frames was not singular:

| Quantity | Measured value |
| --- | ---: |
| Upper-arm length | approximately 0.550 m |
| Forearm length | approximately 0.520 m |
| Accepted shoulder-to-hand distance | 1.001018 m |
| Accepted elbow bend, 0 degrees = straight | 41.38877 degrees |
| Requested reach | approximately 1.068998 m |
| Operational maximum reach | 1.069000 m |
| Generated inverse-damped input reach | 1.072658–1.073501 m |

Damping compensation pushed a generated solver input outside the operational reach band. The library correctly rejected that input.

The controller now conditions only its generated recovery input into the existing reach band, with a small Float32 inset, before calling the unchanged solver. Raw singular requests retain their prior hold behavior.

Verified after this fix:

- New complete recording replay: **3,103/3,103 accepted, zero held**.
- Original complete recording replay: **2,250/2,250 accepted, zero held**.
- 308 accepted recovery detours on the new recording; all tested detours reduced target error.
- New recording's peak hand step remained approximately 12.675 mm.
- Independent clearance, link-length, reach, swivel and held-pose checks pass.
- **98/98 dedicated package/controller/recorder tests pass.**
- Hardware browser regressions pass: torso drag, adversarial trajectories, overhead/waist transitions, singular boundaries, hold/release, mixed obstacles, target-only mode, configuration, recorder export, and pause behavior.

These are specific discrete-pose and trajectory regressions. They do not certify continuous swept-volume clearance, arbitrary target reachability, all actuator velocities, or physical robot safety. Nominal Cartesian pacing can receive small projection-band corrections; the measured peak is not a universal velocity certificate.

## Recorded sessions and trace semantics

All user recordings below were archived to disk before subsequent reloads.

Primary absolute directory: C:/Development/Projects/margoengine/test-results/

| File | Capture |
| --- | --- |
| user-constraints-capture-20261016.json | Original complete 2,250 frames, no overwritten or invalid frames |
| user-constraints-contact-detour-retest-20261016.json | Fixed-forward recovery; 3,600 retained of 4,859 total; first 1,259 overwritten; no invalid frames |
| user-constraints-contact-normal-retest-20261016.json | Complete gradient-recovery live test; 3,103 frames / 51.69 seconds; no overwritten or invalid frames |
| contact-detour-live-comparison-20261016.json | Agent's separate 1,108-frame live pointer comparison |

Important analyses in that same primary directory:

- user-constraints-contact-normal-2-replay-summary.json
- user-contact-normal-retest-continuous-replay-comparison.json
- user-contact-waypoint-reach-retest-comparison.json
- user-contact-waypoint-reach-fix-summary.json
- user-constraints-contact-normal-retest-independent-audit.json
- user-normal-retest-seven-singular-frames.json
- user-constraints-contact-detour-retest-independent-audit.json
- user-contact-detour-retest-analytic-occlusion.json
- user-retest-55-frame-last-waypoint-clearance.json
- user-retest-55-held-detour-waypoint-table.json
- user-contact-hold-55-normal-bias-independent-audit.json

The old gradient controller's replay matched all 3,103 live-recorded accepted hand/elbow values bit-for-bit and every status before the reach fix. The reach-conditioned change first affected the sequence at the original seven-frame stall.

The recorder is local and opt-in. It preallocates bounded typed-array rings, records scalar snapshots, and serializes only after Stop. Current default capacity is 3,600 frames, approximately 60 seconds at 60 Hz. Longer sessions overwrite the oldest samples and disclose that count.

Current exported controller revision: **contact-reach-3**.

Recorded fields include raw target, paced command, last solve input/root, accepted and candidate hand/elbow, pole angle and step, hand displacement, physical and residual clearances, original/final statuses, settings, timing, recovery state and the outwardDetour flag. The flag means a validated contact-gradient recovery was accepted; it does not mean displacement always points toward +Z.

There is no requested pole-angle input or exposed exact rate-limit overshoot. The recorder does not fabricate those values.

## Robot upload fixes and historical cache investigation

### PBR uniform reuse

The experimental optional gltf-pro change retained a per-resource Float32-bit snapshot and reused an upload when its bytes were unchanged. Transforms, validation, lighting callbacks and actual draws still executed. It was subsequently reverted after the comparisons below; the current PBR path uploads unconditionally.

A concrete custom-writer bug was found during review:

1. A custom writeBuffer hook temporarily changed a value from 0.80 to 0.37.
2. It copied the temporary bytes to the GPU, then restored the CPU array.
3. A pre/post CPU comparison incorrectly certified the cache.
4. The next unchanged draw skipped an upload and left the GPU at 0.37.

The experiment's corrected policy permitted reuse only for the captured ordinary same-realm native queue method. Custom, replaced, accessor and unknown writers retained unconditional calls and invalidated the cache across failure or reentry.

Native-source filtering runs once at module initialization, not per draw. It uses the intrinsic function-source operation rather than an arbitrary writer.toString property. This is a conservative compatibility filter, not a security boundary against replaced JavaScript intrinsics.

### Animation upload reuse

The existing palette/morph cache had analogous custom-writer correctness issues, including temporary mutation and post-copy mutation. Those are now covered by regressions and the same conservative native-only reuse policy.

Numerical validation and per-render deformation dispatch remain active. Device restoration, replacement views, signed zero, shared-memory inputs, failed writes and custom hooks retain guarded behavior.

### Environment output cache

ColorOutput's private three-entry identity array and .some closure were replaced with retained scalar identity fields. Group creation failure, resize, excess texture, pipeline and device invalidation are covered.

- 56 environment tests pass.
- A 10,000-frame CPU parity probe preserves uniforms and 53,844 GPU events.
- A 200,000-call CPU probe reduced sampled own allocation from approximately 22.5–24.2 MB to zero.
- **ColorOutput is not attached in the Light Keeper scene.** This is an optional-package improvement, not an explanation of the current robot's allocation rate.

### Hardware native-path proof

Robot worktree report: test-results/native-upload-cache-proof.json.

Hardware: Edge 155, WebGPU on NVIDIA RTX A6000, non-fallback adapter.

- Native queue writer remained untouched.
- 120 frozen renders still executed rendering and skinning.
- 720 PBR draw invocations; unchanged uniform revisions during the steady phase.
- 85 actual uniform/bone/morph buffers were checked, totalling 83,968 bytes.
- A supplemental real animated-triangle fixture covered morph weights absent from the robot.
- GPU compute/readback matched every checked CPU word.
- CPU/GPU SHA256: 5cc416146d3e17765724f4091bdf432d89b174d13aa5033ee2c568ebee6c049f.
- No GPU errors, source drift or reported scene errors.

This proves correctness and native-cache activity for that check. It is not an allocation or timing benchmark. Unchanged Animation inputs are branch-condition evidence, not an invented native write-call counter.

Other validation:

- PBR relevant suite: 95 passed, one existing skip; focused tests rerun after the final equivalent call-path adjustment.
- Animation focused suite: 25/25 passed.
- Broad selected robot/optional-package CPU batch: 300/300 passed, before the final demo-only reach regression was added.
- Public API reports unchanged.
- Standalone build: 697,912 raw JS bytes / 236,160 gzip bytes; core + stage 19,999 gzip; no Three.js runtime.
- Report for that historical build: robot test-results/skinning-ik-site/build-report.json at capture time. That generated path is overwritten by later builds; the current exact release report is in the eye-release snapshot above.

## Historical allocation captures and attribution

All paths in the rest of this section are relative to the robot checkout's test-results directory.

The captures use real hardware Edge, normal GC, explicit warmup, frozen source hashes, and sampled allocation stacks. Sampling and tracing can affect timing. Allocation estimates are statistical; heap range is not an allocation rate.

### Earlier rebuilt production preview

Report: skinning-ik-profile-native-cache-production.json. Each measured phase lasts approximately 12.2 seconds after 15 seconds of warmup.

| Phase | Sampled allocation | GC events | Maximum observed top-level pause |
| --- | ---: | --- | ---: |
| Idle/default | 0.798 MB/s | 7 minor, 2 major | 1.410 ms |
| Torso pointer drag | 1.474 MB/s | 10 minor, 2 major | 1.713 ms |

Reflection pose reuse remains 100%; no source changes or reported errors.

Earlier retained-material production capture: idle 0.848 MB/s, drag 1.613 MB/s. Those older and newer runs differ in reflection counts, so they do not establish a controlled causal improvement from upload caching.

**GC and heap churn remain. This does not meet the active objective.** Event counts alone do not establish retained growth, promotion, a leak, or browser-native causation.

### Source-attributed idle versus drag

Report: skinning-ik-profile-native-cache-source.json. This is a separate development-module capture, not the production rate above.

- Idle: 0.847 MB/s.
- Drag: 1.675 MB/s.
- Difference: approximately 0.828 MB/s.
- Maximum observed pause: idle 1.276 ms; drag 3.180 ms.
- No source drift or reported errors.

Additional sampled allocation during drag, attributed to the innermost recognized source:

| Source | Idle | Drag | Added |
| --- | ---: | ---: | ---: |
| Robot body IK | 2.7 KB/s | 97.8 KB/s | 95.1 KB/s |
| Target projection library | 0.0 KB/s | 92.8 KB/s | 92.8 KB/s |
| Head aiming | 27.5 KB/s | 115.6 KB/s | 88.1 KB/s |
| PBR drawing | 3.0 KB/s | 78.0 KB/s | 74.9 KB/s |
| Rig scratch math | 8.4 KB/s | 77.7 KB/s | 69.3 KB/s |
| Skinning | 21.1 KB/s | 85.8 KB/s | 64.6 KB/s |
| Target-motion filtering | 3.7 KB/s | 56.6 KB/s | 52.9 KB/s |
| Core engine | 190.0 KB/s | 233.4 KB/s | 43.3 KB/s |
| Matrix math | 10.5 KB/s | 50.0 KB/s | 39.5 KB/s |
| Browser / profiling attribution bucket | 3.9 KB/s | 110.9 KB/s | 107.0 KB/s |

The last bucket is not proven entirely native. These values come from a different capture than the production +0.676 MB/s delta.

Leading stack/function observations include:

- Core Mesh.setQuaternion.
- Stats beginRender / beginCompute and native pass wrapping.
- HeadAim.update/reset/commit through body clearance callbacks.
- BodyIK.solve/evaluate/place/poseQuery.
- TargetMotion.update and RigScratch.solve.
- Animation.deform and PBRModel.draw.
- GPU audit update, frame-graph execution, and reflection capture.

Inclusive ancestor totals overlap and must not be added to source-own totals.

### Browser constructor attribution remains unresolved; Node type census completed

**The current sampling profiles do not identify constructor names for BodyIK, target projection or HeadAim.**

Claims that these particular samples are Object literals, Array/Float32Array instances, closures, Contexts or HeapNumbers are currently hypotheses. The sampling weights, often around 4,104 bytes, are weighted samples, not actual allocation sizes or constructor evidence.

Several relevant routines already use retained outputs and scratch arrays. A function-entry sample is not proof of a newly allocated vector at a particular source expression.

An isolated Node 24.19.0 / V8 13.6.233.17-node.51 dead-type census has now completed with 10,000 warmup and 10,000 measured moving-target invocations per worker. Each kernel has a matched control performing identical precomputed target loads, authored-pose restoration, store ticks and checksum work. All eight measured windows had zero natural GC; source fingerprints were unchanged. Explicit GC occurred outside the measurement windows.

| Actual robot path | Excess HeapNumber bytes / invocation | Other excess transient types |
| --- | ---: | --- |
| BodyIK targetAvoidance.resolveTarget | 67.10 | No excess ordinary object/array/typed-array types |
| HeadAim | 294.51 | 568-byte raw row sum; 528 bytes after the context correction below |
| BodyIK without gaze callback | 26.36 | Some compilation artifacts; no matching head structural pattern |
| Integrated BodyIK + HeadAim | 428.89 | Head pattern occurred 15,434 times across 10,000 invocations |

The head pattern per occurrence is four JS_OBJECT, two FIXED_ARRAY, two reported FUNCTION_CONTEXT, one JS_FUNCTION, one ARRAY_ELEMENTS, one FIXED_DOUBLE_ARRAY, one JS_ARRAY_ITERATOR and one JS_ARRAY. These are actual V8 internal census rows, not JavaScript constructor names or line-level allocation stacks. Exact Node 24.19.0 V8 source inspection found that the two FUNCTION_CONTEXT entries describe one physical context: RecordVirtualContext records it in phase one without entering virtual_objects_, then phase two records it again. Deduplicating this row removes 40 bytes/call from the raw sum. Generic virtual ARRAY_ELEMENTS entries do enter virtual_objects_ and are excluded from the second pass. See [Node's exact object-stats implementation](https://github.com/nodejs/node/blob/v24.19.0/deps/v8/src/heap/object-stats.cc). HeadAim.commit calls Mesh.setQuaternion, whose implementation uses a map callback and destructuring; the controlled attribution below tests that source path.

Reports in the robot checkout: test-results/robot-type-census/reports/warm10k-moving.json and warm10k-moving-summary.json. The earlier 1,000-warmup census produced substantially more HeapNumbers, demonstrating that warmup/optimization state matters. Separate kernel workloads are not additive costs. Node counts do not certify Chromium allocation behavior or identify the browser upload cache's allocation types.

### Controlled head-setter attribution

The controlled public-setter versus RigScratch writer ablation has now completed: test-results/robot-type-census/reports/head-writer-ablation.json, with parity in head-writer-parity.json. Both variants executed exactly 10,000 setter calls after 10,000 warmup calls, with identical inputs, checksums and acceptance counters. All four measured census windows were free of natural GC and source fingerprints stayed unchanged.

The replacement removed the complete structural pattern (568 bytes/call in raw rows, 528 after context deduplication). Excess HeapNumbers fell from 184,460 to 16,440 instances across 10,000 calls, saving a further 268.832 bytes/call in this run. The selected-type reduction is approximately 798 bytes/call after the correction; the previously communicated approximately 838-byte raw-row sum overstated it. This establishes the actual normal-array HeadAim setter path as the source of the removed types; it does not imply all public setter inputs can use the same implementation or provide a direct Chromium allocation-rate measurement.

All 2,400 moving/contact trajectory frames matched bit-for-bit across every authored node's quaternion, Euler and world matrix plus HeadAim optical/clearance outputs, including transform-store growth. Nine invalid-input cases and disposed-mesh guard precedence prevented mutation as expected. Three Float32Array probes differed in the combined state snapshot, so preserve the existing public setter's typed-array/map behavior. This led to the demo-owned writer opt-in documented below; the default HeadAim path continues dispatching through the current public method, including overrides.

The actual writeRotation opt-in is now implemented in the robot demo and verified separately, without replacing Mesh.setQuaternion. Reports: head-optin-actual-moving.json, head-default-current-moving.json and head-writer-optin-parity.json. Its 10,000-call census has 15,430 excess HeapNumbers (24.688 bytes/call) and no excess structural head types; the current default has 183,902 excess HeapNumbers (294.243 bytes/call) plus the same raw structural pattern. The callback did not relocate those structural allocations. All 2,400 authored trajectory frames, nine invalid cases, disposal precedence and public Float32/Float64 setter probes match. Twenty-one focused head/cache/writer/rig tests pass. This is a demo-specific explicit writer choice; omission preserves dynamic public setter dispatch, including pre-existing and later overrides.

Static heap snapshots alone can miss short-lived allocations collected between snapshots.

## Upload-cache comparison and rollback decision

Matched method-swap capture: skinning-ik-profile-native-uniform-pair.json.

| Phase | Sampled allocation |
| --- | ---: |
| Baseline | 0.811 MB/s |
| Full cache candidate | 1.134 MB/s |
| Baseline repeat | 0.757 MB/s |

The candidate added sampled PBR and Animation function-entry allocations. The report does not prove which expression, constructor or JIT mechanism caused them.

A separate fixed-render native ablation compared old draw, guard-only draw, full cache, then baseline repeat:

| Variant | Sampled bytes / render |
| --- | ---: |
| Baseline | 33,997 |
| Guard-only | 32,706 |
| Full cache | 15,175 |
| Baseline repeat | 15,436 |

Report: native-upload-ablation.json. All phases preserved work and representative GPU bytes, but the large baseline-repeat improvement exposes an **order/warmup confound**. These numbers do not establish a cache win.

The globally warmed rerun has now completed (native-upload-ablation-warmed.json):

| Variant | First measured bytes / render | Repeat bytes / render |
| --- | ---: | ---: |
| Baseline | 9,113.5 | 13,894.8 |
| Guard-only | 14,048.5 | 14,234.1 |
| Full cache | 14,307.8 | 14,363.5 |

All variants received 600 warmup renders before measurement. Each phase retained 720 draws, 240 beauty draws, 120 deforms, 77 resources and bit-identical representative GPU uniforms. The first baseline remains markedly different from its repeat, so this same-document ablation still does not establish a stable cache allocation benefit. It did not collect GC counts or pause durations.

### Fresh-page comparison with 30-second warmup

Report: skinning-ik-profile-native-uniform-fresh-pages.json. Each phase created a fresh document, installed its implementation before scene creation, warmed for 30 seconds, and measured for approximately 12.2 seconds. Source hashes were unchanged and no browser errors were recorded.

| Phase | Sampled MB/s | Minor GC | Major GC | Peak pause ms | Script duration s | Script ms / animation tick |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline A | 0.805 | 10 | 1 | 1.040 | 1.320 | 1.805 |
| Cache candidate | 0.759 | 12 | 1 | 1.255 | 1.725 | 2.362 |
| Baseline B | 0.844 | 10 | 1 | 1.150 | 1.418 | 1.937 |

The candidate sampled lower allocation than both baselines in this comparison. The earlier 1.134 MB/s regression was not reproduced. That does not prove its cause was exclusively order effects, nor does fresh-page navigation eliminate every process-wide GC or JIT confound.

The candidate also used 0.425–0.557 ms more aggregate script time per animation tick. These are total ScriptDuration deltas divided by 730–732 animation ticks, not isolated cache timings or peak frame CPU durations. Total renderer work was close but not identical (175 candidate reflections versus 176–178 baseline reflections). Last published rolling frame p95 was 16.9 ms for the candidate versus 16.8 / 17.3 ms for the baselines, with all three average frame intervals approximately 16.67 ms. This is an idle/default-scene comparison; it does not establish the cache's active-drag frame cost or GPU staging savings.

GC counts alone do not identify temporary metadata, retained growth or allocation types. A matched active interaction comparison and concrete allocation attribution remain necessary before the final keep/revise decision.

### Fresh-page continuous drag, 30-second warmup and measurement

Report: skinning-ik-profile-native-uniform-fresh-drag-30s.json. Three fresh pages each ran 30 seconds of active warmup followed by 30 seconds of measured trusted pointer dragging. Head tracking, auto IK and reflections were enabled; idle animation and moving-light motion were disabled. Every warmup and measured phase received the same 938 screen-space commands at nominal 32 ms spacing. The diagnostic report's inherited generic method string still says the older drag phase disables head look; the actual per-phase conditions and controls in this comparison enable it.

| Phase | Sampled MB/s | Minor GC | Major GC | Peak GC pause ms | p95 RAF callback execution ms | Reflection bakes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline A | 1.301 | 22 | 4 | 5.684 | 6.210 | 416 |
| Cache candidate | 1.207 | 22 | 4 | 3.376 | 6.007 | 443 |
| Baseline B | 1.090 | 15 | 3 | 2.514 | 7.333 | 393 |

All sampled poses passed safety and grip checks; browser errors and source changes were empty. Native queue writer identity was preserved. Measured animation ticks were 1,838 / 1,848 / 1,840. Command scheduling was not exact wall-clock lockstep: maximum lateness was 15.6 / 23.5 / 52.4 ms. RAF callback wall execution is not GPU completion time or total frame CPU budget.

The candidate is between the two baselines on allocation and below both on p95 callback execution. The 393–443 reflection-bake spread is a material workload difference. This is not a clean isolated allocation win and does not establish that staging savings caused the callback difference. Neither matching major-GC counts nor pause maxima prove retained growth, promotion rate or an eventual stutter guarantee. Prefer a concrete source-path improvement over further claiming a cache benefit from these mixed results.

The fixed-render ablation script and diagnostics remain available:

- Script: test-results/profile-native-upload-ablation.mjs.
- Warm 600 renders of every variant before measurement.
- Measure baseline, guard-only and full cache, then repeat all three.
- Preserve native writer, work counts, buffer bits and source hashes.
- A zero revision delta in an unconditional baseline means no revision change, not zero uploads. The corrected diagnostic field is beautyNoRevisionChange.

### Decision: experimental PBR uniform cache reverted

The uncommitted PBR uniform cache has been removed from packages/gltf-pro/src/index.ts and its README because these comparisons did not establish a repeatable full-scene allocation benefit. Both files now match the committed unconditional-upload implementation. This preserves public behavior and removes the experimental comparison/guard bookkeeping. The rejected patch and original source/test are archived in ignored test-results/pbr-uniform-cache-rejected.patch, pbr-uniform-cache-rejected.ts and pbr-uniform-upload-reuse-rejected.test.js.

Ten useful custom-writer, Float32-bit, failure, reentrancy and validation cases remain in tests/gltf-pro-uniform-writers.test.js. The rebuilt package passed all 27 focused PBR draw/pass/shadow/resource/writer tests. The separate Animation custom-writer correctness repair remains necessary and is retained. The subsequent standalone production builds include this rollback and the head-writer change; historical native-cache proof reports describe the earlier implementation, not the current unconditional PBR source.

### Locked reflection work: retain the direct upload path

The requested fixed-work comparison completed on 2026-10-16. **Keep the experimental PBR uniform cache reverted.** Its mean sampled allocation was only **0.21% lower**, smaller than the **0.46% spread between the two direct runs**, and both cache phases had higher normal-render callback mean and p95 times. These four captures establish no useful repeatable allocation benefit to justify restoring the extra state.

Evidence: [pbr-locked-drag-results.json](pbr-locked-drag-results.json). Harness: [profile-pbr-locked-drag.mjs](../scripts/profile-pbr-locked-drag.mjs). The selected raw report is `test-results/pbr-locked-drag-quiet-abba-20261016/report.json` in the robot checkout. The earlier `pbr-locked-drag-abba-20261016` series is excluded: another hardware benchmark overlapped its first two phases. Its raw artifacts are retained locally. The quiet repeat used the exact same frozen bundles; all 34 executed JavaScript chunk hashes were checked against the report.

| Phase, in execution order | Sampled bytes / normal frame | Sampled MB/s | Minor / major GC | Peak GC pause ms | Normal callback mean / p95 ms | Bake completion p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct A | 20,696.65 | 0.828 | 43 / 4 | 2.299 | 3.591 / 6.1 | 18.5 |
| Cache A | 20,592.83 | 0.822 | 44 / 5 | 3.016 | 3.959 / 6.5 | 21.3 |
| Cache B | 20,621.31 | 0.817 | 43 / 5 | 3.122 | 4.172 / 6.6 | 26.0 |
| Direct B | 20,602.51 | 0.813 | 44 / 4 | 2.530 | 3.651 / 6.4 | 26.4 |

Each fresh page received 1,800 normal warmup frames and 450 real reflection bakes, then the same measured workload: **1,800 normal frames, 450 awaited six-face bakes (2,700 faces), 2,700 total renders, 18,900 PBR draw calls and 2,700 deforms**. PBR mode counts were identical: 8,100 beauty, 5,400 gbuffer and 5,400 ambient calls. The 413,100 primitive draws are beauty draws only. All 900 reflection pose-reuse attempts succeeded with zero fallbacks; no unsafe samples or browser errors were recorded. Each window used 900 trusted screen-space pointer moves along the same path. Ending transform hashes, command hashes and one representative primitive's 220 GPU uniform words matched across every phase; this does not verify every intermediate transform or every primitive's GPU buffer.

The diagnostic snapshot disables automatic RAF and adaptive/final reflection scheduling, preserves the registered frame callbacks, renders with delta 1/60, and awaits a bake every four normal frames. Each bake adds two zero-delta renders. Thus each window covers **30 simulated seconds**, taking **45.0–45.6 wall-clock seconds** for measured work. Head tracking and auto IK remain enabled; idle animation and moving-light motion are disabled. Both variants use otherwise identical frozen source inputs in a single hardware Edge 155 browser with an NVIDIA Ampere adapter. The native queue writer is never wrapped, and no forced GC or JIT flags are used.

Bytes per normal frame amortize an identical ratio of normal and reflection work; they are not an isolated reflection allocation cost. MB/s uses the separately recorded sampler window, including its small handshake overhead. The normal callback timings cover registered frame callbacks plus the normal render body, excluding reflection encode/readback completion, scheduling and harness overhead. They therefore differ from the earlier free-running trace's complete RAF callback timings. Bake p95 is reported separately; its order-dependent drift does not establish a cache-specific GPU effect.

Mean sampled allocation was 20,649.58 bytes/normal frame for direct and 20,607.07 for cache, a difference of 42.51 bytes versus 94.14 bytes between direct repeats. Mean normal callback time was 3.621 ms for direct and 4.066 ms for cache. The table preserves individual run p95s; no pooled p95 is inferred. Sampling includes browser/harness attribution and background timers, and natural GC varies between runs. This is a full-scene decision under the stated workload, not proof of allocation types, retention behavior, universal GPU performance or zero GC.

After capture, Node 24.19.0 passed all **20/20** focused PBR writer/pass/resource/hook and core-budget tests, with no skips. Core plus stage remains **19,999 gzip bytes**. This comparison changes diagnostic files and documentation only; the direct PBR implementation and the separate Animation writer repair remain in place.

Reproduce from the primary checkout with the robot checkout's archived `test-results/pbr-uniform-cache-rejected.ts` present:

```powershell
node scripts/profile-pbr-locked-drag.mjs --root=C:/Users/ScottCampbell/.codex/worktrees/skinning-ik/margoengine --label=pbr-locked-drag-new --frames=1800 --warmup-frames=1800 --order=direct,cache,cache,direct
```

Use the bundled Node 24 executable listed below. To repeat the exact captured inputs, also pass `--reuse-snapshot=pbr-locked-drag-quiet-abba-20261016` while that ignored local snapshot is available. A new build from later live sources is a new experiment. Raw bundles, source snapshots, heap profiles and traces remain in ignored local `test-results`; the committed evidence file records their provenance and the executed chunk/source hashes. The archived candidate and raw snapshots are prerequisites, not files supplied by a clean clone.

## Remaining investigation and rejected paths

### Retained optional Stats pass layout

`@margoengine/stats` now offers an **additive, opt-in API**,
`lowAllocationPasses: true`; the default remains false. It replaces the five
per-render-pass and three per-compute-pass own fields with frozen shared
prototypes for eligible native WebGPU passes. This changes reflection and
post-wrap extensibility semantics, explicitly documented in the package README.
It is suitable for this demo's owned passes, not an implicit replacement for
arbitrary application instrumentation. Core/stage and the existing public
default behavior are unchanged.

Eligibility retains native factory/receiver checks, all captured native-method
checks, accessor/writability guards and ordinary fallback for custom or foreign
passes. Review found an inherited-owner edge before the comparison completed;
the helper now rejects existing own **or inherited** owners without reading an
accessor. The first incomplete, unguarded baseline is excluded from evidence.

Verification passed 26/26 focused CPU tests and eight actual-native hardware
cases. The durable hardware regression is
`scripts/test-stats-native-passes.mjs`, using
`tests/browser/stats-native-passes.html`; it verifies actual GPU pixel and atomic
dispatch output, timestamps, overrides, foreign realms, frozen prototypes and
fallback getter/setter behavior. No fake native-positive fixture is substituted.
The robot's separate instrumented proof observed 9,625 native render and 4,664
compute fast-path hits, zero own fields on bounded pass samples, safe sampled
arm poses and grip errors below 2e-8 m. This instrumentation is absent from the
allocation runs. An overhead pose may remain head-travel-limited; this check
does not promise exact gaze for every pose.

Fresh production pages then ran default A, opt-in and default B against the
**same frozen bundle**, changing only `?passLayout=prototype`. Animator's new
writer remained omitted in every phase, so it did not affect this comparison.
Every phase had 30 seconds of warmup and approximately 30 seconds measured;
drag warmup and measurement each used the matched continuous pointer path.

| Layout | Phase | Sampled MB/s | Minor / major GC | Peak pause ms | p95 RAF callback ms |
| --- | --- | ---: | ---: | ---: | ---: |
| Default A | Idle | 0.741797 | 31 / 4 | 1.245 | 1.970 |
| Opt-in | Idle | 0.621088 | 23 / 4 | 1.561 | 2.289 |
| Default B | Idle | 0.812398 | 27 / 3 | 1.503 | 2.368 |
| Default A | Drag | 1.009091 | 16 / 4 | 1.495 | 4.883 |
| Opt-in | Drag | 0.906381 | 28 / 4 | 1.749 | 5.206 |
| Default B | Drag | 1.156624 | 20 / 5 | 3.491 | 6.457 |

**Retain the optional layout.** Sampled allocation is below both default runs,
consistent with the isolated native-pass own-field reduction. Candidate callback
p95 lies between the two baselines, so these captures do not establish a
repeatable CPU improvement or penalty. Drag minor-GC count is higher in the
candidate; no GC elimination or causal GC-pause improvement is established.
Automatic reflection cadence differs: idle bakes A/opt-in/B are 462/435/445 and
drag bakes 456/440/415. The candidate also stays below both baselines in bytes
per ordinary animation frame; this remains a free-running scene comparison,
not a fixed-bake workload experiment.

All six measured phases retained 100% reflection pose reuse (922, 911, 870,
878, 890 and 830 successful repeat attempts in execution order), with no source
changes or browser errors. Every drag measured 938 trusted commands. The native
queue writer identity remained unchanged. Host profiling/readback/pass wrappers
still allocate, and natural GC remains; the overall objective is incomplete.

The local summary is `test-results/stats-pass-prototype-fresh-aba-summary.json`;
raw report labels are `stats-pass-prototype-guarded-baseline-a`,
`stats-pass-prototype-guarded-candidate` and
`stats-pass-prototype-guarded-baseline-b`. Native reports are
`test-results/stats-native-passes.json` and
`test-results/scene-stats-prototype-proof.json`. Raw traces, heap profiles and
the production comparison harness remain ignored local artifacts. The API
reports explicitly include the new option; unchanged export counts do not mean
an unchanged API. This package change is not yet part of production feeb64de.

### Target-only projection boundary experiment: reverted

The current robot uses `resolveTarget()` with damping and compliance disabled and
one torso capsule. A fresh audit tested that exact entry path instead of borrowing
the earlier full-`solve()` or mixed-collider compiler evidence. The ordinary Node
census still observed boxed numbers, but the successfully optimized target,
projection and internal capsule paths had no numeric tagging/allocation sites;
`pointClearance` was inlined. A separate synchronous-recompilation diagnostic had
no excess numeric allocation over its control. These results do not establish a
permanent warmup duration or a universal allocation floor.

The candidate skipped an unused reach norm for the unbounded target-only path.
It preserved bit-exact outputs for 25,128 target calls, 4,800 full solves, 1,272
alias calls and 24 invalid calls, with identical custom-collider and IK callback
sequences across 223,132 collider calls. All 85 candidate tests passed. However,
four isolated baseline/candidate excess-HeapNumber pairs were 89,812/80,272,
75,502/81,172, 79,252/77,322 and 74,682/71,562. Timings were neutral and variation
was larger than the apparent benefit. The candidate also added nine gzip bytes.

**Revert the experiment.** The original source, declarations and package bundle
were restored bit-for-bit; the bundle SHA256 is
`64a16588de864218291da2943f4ca8ea917b3a80602fe073787b6dd60cb14d04`.
The original 82/82 tests passed after restoration. An instrumented reduction from
ten to nine square-root calls per query is not a production allocation result:
that instrumentation changes compilation, and the optimized path already removes
the dead norm. No public kinematics change remains from this experiment.

Raw census, compiler, parity, candidate and restoration evidence is archived in
the robot checkout's ignored `test-results/resolve-target-boundaries/`, including
`README.md` and `final-report.json`; these large local artifacts are not supplied
by a clean clone. Core plus stage remains 19,999 gzip bytes.

### Prior allocation checkpoint validation and production capture

This section records the warmed allocation checkpoint before the resting-hand and eye fixes. Its rates and GC counts are historical evidence for that source, not measurements of the current live release.

After push, the rebuilt checkpoint passed **307/307** selected package/demo tests with no skips; public API reports match **166 entries / 1,548 exports**. The standalone build is **697,008 raw JS bytes / 235,782 gzip bytes**, with 102 modules, no Three.js runtime, and frozen core + stage at **19,999 gzip bytes**. Logs: allocation-checkpoint-tests.log, allocation-checkpoint-api.log and allocation-checkpoint-build.log.

Hardware proof native-animation-checkpoint-proof.json verified the ordinary native queue and unconditional PBR writes, plus reuse of unchanged Animation inputs. All **85 buffers / 83,968 bytes** matched CPU expectations on the NVIDIA RTX A6000, including actual robot uniforms/bones and a supplemental real morph fixture. Matching CPU/GPU SHA256: 55f3f47c31c9f42444a79b1349fc54a754a7fd8235de18df9bde508abebf0f1c. Invalid morph, singular skin, signed-zero morph and changed-joint palette checks passed. Errors and source changes were empty. This is correctness evidence, not an allocation measurement.

The hardware motion suite passed all eight cases and 14 transitions, with eyes enabled/disabled, full side/height/near-far routes and rapid reversals. It produced 652 published samples at approximately 100 ms intervals, not per-frame CCD evidence. No browser errors or measured unmoving-chase periods occurred. Latest report: skinning-ik-motion-browser.json; prior report preserved as skinning-ik-motion-browser-before-checkpoint.json. The in-app preview was reloaded and manually checked at full cross-body reach; screenshot robot-allocation-checkpoint-preview.png.

The rebuilt **production** preview was then measured without implementation swaps, after 30 seconds of warmup per phase and approximately 30 seconds of measurement. Drag warmup itself used continuous trusted pointer input. Head tracking, auto IK and reflections were enabled during drag; idle animation and moving-light motion were disabled. Report: skinning-ik-profile-checkpoint-production-idle-drag.json.

| Phase | Sampled MB/s | Minor GC | Major GC | Peak GC pause ms | p95 RAF callback execution ms | Reflection bakes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Idle defaults | 0.716 | 29 | 4 | 1.731 | 2.427 | 390 |
| Active torso drag | 1.063 | 7 | 4 | 2.281 | 6.418 | 368 |

Drag completed 938 trusted commands, with maximum scheduling lateness 15.62 ms. All sampled poses/grips passed and reflection pose reuse stayed at 100%. Source changes and browser errors were empty; native writer identity was unchanged. Max observed RAF callback wall duration was 12.528 ms during drag. These captures still contain GC and do not meet the active zero-GC objective. They are not a strictly workload-matched causal comparison against earlier reports with different controls, durations and reflection counts. A stable rolling heap envelope alone does not prove the absence of retained leaks, and GPU pass timing is not the complete frame budget.

### Rejected native Stats descriptor batching

The isolated actual-native-pass experiment native-stats-pass-layout-checkpoint.json retained identical native prototypes and final property descriptors, with 16,384 passes and 256 encoder/finish/submit operations per phase. Raw native writer-subtree sampling was 15.71 / 15.39 / 17.62 bytes/pass. Five sequential own assignments sampled 68.57 / 68.40 bytes/pass, whereas a retained Object.defineProperties bag sampled 243.25 / 251.89 bytes/pass. Batched CPU time was 30.7 / 27.8 ms versus sequential 14.7 / 14.7 ms. No GPU/page errors or source changes occurred. **Reject descriptor batching; no production Stats change was made.**

1. Continue from the measured remaining allocation sites; do not revive rejected caches/layout changes without new evidence.
2. Identify actual allocation types/IR consumers for BodyIK, target projection, HeadAim and the other drag hotspots.
3. Reduce measured owned allocations, rerun numerical/mesh and interaction checks, and retain only improvements.
4. Rebuild the standalone robot and repeat sustained warmed idle/drag profiles, including GC and actual skinned clearance.
5. Keep the full objective active until its requested end state is verified.

Known boundaries:

- Generic Animator must preserve dynamic Mesh setter dispatch. A pre-import replacement can look canonical to a later method capture; bypassing it is not a safe generic optimization.
- Animator already avoids unchanged static-node commits; do not propose that as new work without measuring a remaining duplicate path.
- The demo-owned HeadAim scalar commit is implemented as an explicit opt-in using the verified rig helper. The default public path retains dynamic method dispatch; the prior checkpoint contains its parity and allocation evidence.
- Stats already shares wrapper functions and retains method records. It still adds five own fields to fresh native render passes and creates sampled timestamp descriptor copies. That instrumentation can allocate; it is not all browser-native.
- The previous Stats owner-WeakMap experiment showed no net allocation improvement and slower execution; it was rejected.
- The retained descriptor-bag batching experiment for Stats was measured and rejected; its native comparison is recorded above. It is not pending production work.
- Earlier core quaternion experiments exceeded the strict gzip gate or changed observable iteration/override behavior; they were rejected.
- Do not infer Maglev/TurboFan causality, fresh-angle boxing, or a stable allocation floor without direct evidence.

## Reproduction commands

Use the bundled Node 24 executable:

    C:/Users/ScottCampbell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe

From the primary checkout:

    node --test packages/kinematics-constraints/tests/*.test.js tests/kinematics-constraints-demo-controller.test.js tests/kinematics-constraints-recorder.test.js

The primary checkout lacks the robot checkout's browser-tool dependencies. Its ignored test-results/run-constraints-interactions.mjs imports the robot browser helper and runs the hardware constraints regression against primary files.

From the robot checkout:

    node scripts/api-report.js
    node scripts/build-skinning-ik.mjs
    node test-results/verify-native-upload-caches.mjs --label=native-upload-cache-proof --port=5259 --frames=120
    node scripts/profile-skinning-ik.js --label=native-cache-production --scene-url=http://127.0.0.1:5192/ --phases=default,torso-pointer-drag --duration-ms=12000 --warmup-ms=15000
    node scripts/profile-skinning-ik.js --label=native-cache-source --phases=default,torso-pointer-drag --duration-ms=12000 --warmup-ms=15000
    node test-results/profile-native-upload-ablation.mjs

Use fresh report labels for further captures. Keep source/dist frozen and avoid concurrent GPU work, builds or heavy CPU tests during allocation measurements. Archive any stopped user trace before reloading or editing its demo.

## Immediate handoff

The user requested an immediate commit/push checkpoint, followed by continued work, and then the rebuilt production drag allocation/GC results.

The current eye-fix source **ca5194b** is pushed and live as **feeb64de**, with the resting-hand repair retained. Its CPU/size, native GPU bytes, sampled hardware motion and full public-file deployment checks passed as detailed above. The fresh production-build idle/drag capture is recorded near the top of this document; its 0.784223 / 1.067418 MB/s rates still include GC and do not establish an allocation-free end state. Descriptor batching in Stats was measured and rejected. The constraints lab remains on the committed contact-reach-3 controller; both saved complete trajectories replay hold-free. Allocation-driven GC remains in the latest measured capture and the overall goal is active.

The user explicitly requested an immediate commit/push checkpoint even with unfinished work, followed by continued testing. Preserve that incomplete allocation status; do not present the current release's pointer sample or reflection reuse count as a sustained allocation benchmark. Large raw traces and diagnostic harnesses remain in ignored local test-results folders.

Package/demo boundary: reusable runtime changes are made in the owning optional packages. The contact-gradient sliding and generated-waypoint reach conditioning currently remain in examples/kinematics-constraints-controller.js, not the public kinematics-constraints solver. Recorder/profiler code is diagnostic-only. Do not present those demo adapter behaviors as current public package capabilities.

