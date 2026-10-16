# Kinematics and robot allocation handoff

Updated: 2026-10-16. This document records verified work, evidence locations, limits, and the next experiments. It is a checkpoint, not a completion claim.

## Active objective and current state

Fix the Light Keeper robot demo and its optional packages until sustained, warmed browser idle and continuous-drag captures show no allocation-driven GC or heap sawtooth. Preserve public APIs, numerical guards, full arm controls, and actual skinned-geometry clearance. Rebuild and verify the live preview. Keep improvements and revert regressions.

The objective remains **active and incomplete**. The recorded constraints-demo stalls have been corrected for the tested trajectories. The robot still allocates and triggers GC in measured captures.

Two different demos are involved:

- **Constraints lab:** http://127.0.0.1:5173/examples/kinematics-constraints.html. Its demo controller performs full-chain solve, pacing, contact recovery, and reach conditioning.
- **Light Keeper robot:** http://127.0.0.1:5192/. Its robot adapter integrates the library through resolveTarget(), then retains its analytical arm solve, grip orientation, torso assist, and detailed mesh/contact checks. The constraints lab's new recovery controller is not part of this robot render loop.

An allocation change in one demo does not establish the behavior of the other.

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

The robot checkout has pending optional-package changes in animation, gltf-pro, and environment. Their native correctness and allocation evidence are described below. They are not all proven allocation wins.

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

## Robot upload fixes: correctness verified, allocation benefit still under study

### PBR uniform reuse

The optional gltf-pro change retains a per-resource Float32-bit snapshot and reuses an upload when its bytes are unchanged. Transforms, validation, lighting callbacks and actual draws still execute.

A concrete custom-writer bug was found during review:

1. A custom writeBuffer hook temporarily changed a value from 0.80 to 0.37.
2. It copied the temporary bytes to the GPU, then restored the CPU array.
3. A pre/post CPU comparison incorrectly certified the cache.
4. The next unchanged draw skipped an upload and left the GPU at 0.37.

The corrected policy permits reuse only for the captured ordinary same-realm native queue method. Custom, replaced, accessor and unknown writers retain unconditional calls and invalidate the cache across failure or reentry.

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
- Latest standalone report: robot test-results/skinning-ik-site/build-report.json.

## Allocation captures: current measured results

All paths in the rest of this section are relative to the robot checkout's test-results directory.

The captures use real hardware Edge, normal GC, explicit warmup, frozen source hashes, and sampled allocation stacks. Sampling and tracing can affect timing. Allocation estimates are statistical; heap range is not an allocation rate.

### Latest rebuilt production preview

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

### Constructor/type telemetry is still unresolved

**The current sampling profiles do not identify constructor names for BodyIK, target projection or HeadAim.**

Claims that these particular samples are Object literals, Array/Float32Array instances, closures, Contexts or HeapNumbers are currently hypotheses. The sampling weights, often around 4,104 bytes, are weighted samples, not actual allocation sizes or constructor evidence.

Several relevant routines already use retained outputs and scratch arrays. A function-entry sample is not proof of a newly allocated vector at a particular source expression.

Next evidence should be a constructor/type census, allocation instrumentation with usable type attribution, or optimized-IR consumers tied to the actual hot path. Static heap snapshots alone can miss short-lived allocations collected between snapshots.

## Upload-cache comparison and unresolved regression

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

Prepared rerun, not yet executed at this checkpoint:

- Script: test-results/profile-native-upload-ablation.mjs.
- Warm 600 renders of every variant before measurement.
- Measure baseline, guard-only and full cache, then repeat all three.
- Preserve native writer, work counts, buffer bits and source hashes.
- A zero revision delta in an unconditional baseline means no revision change, not zero uploads. The corrected diagnostic field is beautyNoRevisionChange.

Keep or revise the PBR cache only after a controlled benefit is established. Preserve the independently required custom-writer correctness fixes.

## Remaining investigation and rejected paths

1. Run the globally warmed native-cache ablation and resolve the candidate regression.
2. Identify actual allocation types/IR consumers for BodyIK, target projection, HeadAim and the other drag hotspots.
3. Reduce measured owned allocations, rerun numerical/mesh and interaction checks, and retain only improvements.
4. Rebuild the standalone robot and repeat sustained warmed idle/drag profiles, including GC and actual skinned clearance.
5. Keep the full objective active until its requested end state is verified.

Known boundaries:

- Generic Animator must preserve dynamic Mesh setter dispatch. A pre-import replacement can look canonical to a later method capture; bypassing it is not a safe generic optimization.
- Animator already avoids unchanged static-node commits; do not propose that as new work without measuring a remaining duplicate path.
- A demo-owned HeadAim scalar commit using the existing verified rig helper is a possible next experiment, not an implemented or measured win.
- Stats already shares wrapper functions and retains method records. It still adds five own fields to fresh native render passes and creates sampled timestamp descriptor copies. That instrumentation can allocate; it is not all browser-native.
- The previous Stats owner-WeakMap experiment showed no net allocation improvement and slower execution; it was rejected.
- A retained descriptor-bag batching experiment for Stats remains only a proposal. Descriptor/accessor behavior and native allocation must be measured before changing production.
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

The latest user request was to put the work into Markdown and explain the next action. This document is that checkpoint.

At this checkpoint no native ablation is running. The improved warmed rerun is prepared and awaiting execution. The constraints lab is running the committed contact-reach-3 controller; both saved complete trajectories replay hold-free. The robot preview has been rebuilt, but allocation-driven GC remains and the pending upload changes still need their final controlled performance decision.

