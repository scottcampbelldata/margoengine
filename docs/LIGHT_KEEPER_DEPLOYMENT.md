# Light Keeper production release

Published 2026-10-16 to [margoengine.com/demos/light-keeper/](https://margoengine.com/demos/light-keeper/), with a link from the homepage.

## Deployment identity

- Cloudflare Pages project: `margoengine`; production branch label: `main`; direct upload, not Git-triggered.
- Production deployment: `feeb64de-fa35-4f9b-b66c-f2952a80f0b7`, https://feeb64de.margoengine.pages.dev.
- Tested preview deployment: `37bcc883-db76-4a68-ab21-8f2c87d45f45`, https://37bcc883.margoengine.pages.dev.
- Current source checkpoint: `ca5194b344d4742d43fd5ae5c31a5bf23036bbe2`, pushed on `codex/skinning-ik`; prior allocation checkpoint: `6794863`; source build integration: `6be773c`.
- Initial workshop deployment: `8d0427c6`, based on `347259f8`, including the Tokyo model update. It added the workshop folder and homepage link. The current eye release retains the resting-hand repair and all previous public files except the intentionally replaced nested workshop HTML/build report.
- Exact deployed snapshot: `C:/Users/ScottCampbell/.codex/worktrees/skinning-ik/margoengine/test-results/light-keeper-eye-live/site`.
- Full snapshot manifest SHA256: `f3d62c5867e43b67ed95f2bb5d40f5b704c4ac31802312d2e2d90a2c4faa2595`.
- Standalone build-report SHA256: `1ea983041bcf3d3ac87d0ee073c252ce3bc4ed0a50a551d76ca87dd8af5e0778`.

The snapshot contains **194 files: 192 public files and two Cloudflare configuration files**. Relative to the hand-release baseline it retains 191 files unchanged, replaces the workshop HTML/build report, and adds the new hashed entry script. All 24 old workshop assets remain available. The homepage, Tokyo, `_headers`, `_redirects` and `404.html` remain unchanged. The retained repaired model is 19,957,608 bytes, within the Pages per-file limit. Asset licenses are included. Previous exact snapshots remain in `test-results/light-keeper-live/site` and `test-results/light-keeper-hand-live/site`.

## Verification

Both current preview and production passed full HTTPS verification of all **192 public files**: status, byte count, SHA256 and MIME. The homepage and canonical workshop route match their expected HTML, Tokyo's model/script references remain intact, and a missing asset returns 404 with `no-store`. Evidence is under `test-results/light-keeper-eye-live/`: `preview-verification.json`, `production-verification.json`, `production-independent-audit.json` and `production-deployment-metadata.json`. The independent audit confirms all 191 retained baseline files and all 24 old workshop assets. Sanitized deployment metadata confirms production `feeb64de`, branch `main`, source `ca5194b`.

The actual hosted workshop loaded in the in-app browser and uses `@margoengine/kinematics-constraints`. A live pointer reproduction now conditions the near-face orb target, keeps the arm safe and points the eyes at the accepted orb. The exact live metrics and the distinction between requested and accepted targets are recorded below. These are discrete checks, not continuous swept-volume certification.

The final standalone build measures **703,335 raw JS bytes / 237,609 gzip bytes**, with **103 modules** and **21,716,983 scene-asset bytes**. Core plus stage remains **19,999 gzip bytes**, below the strict 20,000-byte gate. Final native GPU checks matched **85 buffers / 83,968 bytes** bit-for-bit against CPU expectations; the eight-case hardware motion suite covered 14 transitions and 612 published samples. Those samples are not an every-frame certification.

This release is not a zero-GC claim. A fresh capture of this exact production build used 30 seconds of warmup and approximately 30 seconds of measurement per phase on Edge 155 / NVIDIA RTX A6000. Idle sampled **0.784223 MB/s**, 28 minor/three major GCs, a **2.759 ms** peak observed GC pause and **2.655 ms** p95 RAF callback wall time. Continuous torso drag sampled **1.067418 MB/s**, 22 minor/four major GCs, a **3.713 ms** peak pause and **6.877 ms** p95 RAF callback wall time. Reflection reuse was 344/344 idle and 346/346 drag, with 938 trusted pointer moves during measured drag. Browser errors and source changes were empty. Report: `test-results/skinning-ik-profile-gaze-repair-production-idle-drag.json`.

These are current baseline observations, not a controlled performance comparison against the older pre-hand/pre-eye capture or proof that either visual fix reduced allocation. GC remains and the allocation objective is active and incomplete. Detailed evidence and limits are in [KINEMATICS_ALLOCATION_HANDOFF.md](KINEMATICS_ALLOCATION_HANDOFF.md).

## Near-face and cross-body eye tracking

The arm previously accepted a near-face orb pose because the head could avoid collision by looking away from it. The captured pointer reproduction produced approximately **103.46 degrees** of optical error. The fix conditions the demo's requested target against a moving head-pivot workspace and uses bounded tangent waypoints when a direct chase chord cuts through that workspace. It preserves the existing demo `HeadAim` implementation, public package API and numerical guards, and retains the existing head/orb/armor clearance checks. It does not move the neck or replace mesh clearance with the workspace proxy.

The exact captured replay now settles to approximately **4.55e-7 degrees** of optical error. In the independently checked live production pointer sample, `targetConditioned` is true: the requested target `[0.137600377, 1.181730628, -0.326119065]` becomes the held orb `[0.137600332, 1.181730628, -0.366465688]`. Optical error is **1.831486e-7 radians**, `limited` is false, the arm is safe, and grip error is approximately **1.3074e-8 m**. The reported head-clearance residual is **+0.001000026 m above the configured margin**, not the total surface gap. Reflection reuse was **650/650** in this sample; this is not an allocation benchmark. Evidence: `production-browser-metrics.json` and `production-browser.png` under `test-results/light-keeper-eye-live/`.

Validation passed **135/135 full robot tests before the final workspace-only opt-in**, followed by **35/35 affected tests after it**, including 120 bit-exact transformed cases. Nine full-rig integration cases include a 300-frame reversal sequence returning Home with zero gaze-away frames, moving-root and zero-delta revalidation, and conditioned route arrival. That reversal sequence has a maximum transient optical error of **14.657 degrees**; it is not exact gaze on every moving frame. Enabling look while the orb is already inside the workspace can initially show **91.76 degrees** of error and recovers in approximately **183 ms** in the tested sequence. Provenance and source fingerprints are in `test-results/head-crossbody/implementation-verification.json`.

The workspace is a necessary target-conditioning proxy, not a guarantee that every target is viewable. Existing bounded head travel and mesh checks still apply. Waypoint step limits exclude torso/base movement and are not physical actuator-speed certification. Discrete tests and sampled motion do not certify continuous swept clearance or arbitrary trajectories.

## Resting hand repair

This retained release was first published as production `1c027e73-37ee-4272-8173-690296f037b7` with preview `55ccc37f`, source `bafb657`. Its exact snapshot remains in `test-results/light-keeper-hand-live/site` (193 files / 191 public); manifest SHA256 `ebe42cfc53c61f7f6d8f9d48dfe236cadec9f48395abbbeef97dcdf6a4e2db96`, build-report SHA256 `11b0f89f30a6c6338459e5e4e5e5a17c160d027b19931d0fc494023a583ab097`. It retained 189 initial-release files and all 22 old workshop assets, replacing the nested HTML/report and adding the repaired model and its entry script.

The resting `RightHand` originally contained only a teal housing and copper wrist bearing. Commit `bafb657` adds three relaxed fingers, an opposing thumb, curved palm and porcelain backplate in the existing four material assemblies. The editable Blender source, procedural helper and runtime GLB are updated together. There are no renderer, solver or public API changes.

An independent GLB comparison found every old triangle corner and winding unchanged, including positions, normals, UVs, tangents, joints and weights. Existing transforms, bones, inverse binds, animation samples, material semantics and embedded image bytes match. The 7,700 added triangles are rigidly assigned to `RightHand`. Five old exported tangent values were restored after Blender re-export rounding; no geometry was altered by that stabilization. Final model SHA256: `540d938269070d29ceca8c86f5dbedf721310eefdd30250b7dfd1ded7c6cc15d`.

Validation: **116/116 robot tests**, including five new geometry/attachment regressions; Khronos validation with zero errors/warnings; eight hardware browser motion cases and 14 transitions, with 638 published samples and no page errors or unmoving chase; and bit-exact CPU/GPU checks of 85 buffers / 83,968 bytes. Actual hand triangles clear fixed hips/thighs by at least **43.454 mm** in 14 sampled torso poses, including the -0.85 radian limit. The existing skinned head, torso and opposite-arm clearance tests also pass. These samples do not certify every possible trajectory.

Historical hosted endpoint checks also remain available: the initial production overhead/cross-body check reported a safe arm, grip error approximately 1.48e-8 and residual approximately 1.49e-8; the repaired-model preview cross-body check reported a safe arm, zero residual, grip error approximately 1.29e-8 and torso yaw -0.85 radians. These did not certify exact optical aiming at every contact-limited pose.

Local evidence is under `test-results/hand-repair/` and `test-results/inactive-hand-regression/`; hosted release evidence is under `test-results/light-keeper-hand-live/`.

## Future releases

Start from this exact public snapshot, or deliberately integrate all currently deployed work before rebuilding the complete site. Deploying an older arbitrary checkout can roll back Tokyo or the workshop. Recheck the latest Cloudflare production deployment and public hashes before preparing the next snapshot. Keep credentials out of reports.

The durable source integration is committed on `codex/skinning-ik`: `site/index.html` links the workshop, and `scripts/build-site.js` runs the audited standalone builder then copies it under `demos/light-keeper/`. Direct upload does not merge that branch into Git `main`. The unchanged standalone builder is `scripts/build-skinning-ik.mjs`.
