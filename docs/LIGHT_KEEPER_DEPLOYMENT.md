# Light Keeper production release

Published 2026-10-16 to [margoengine.com/demos/light-keeper/](https://margoengine.com/demos/light-keeper/), with a link from the homepage.

## Deployment identity

- Cloudflare Pages project: `margoengine`; production branch label: `main`; direct upload, not Git-triggered.
- Production deployment: `1c027e73`, https://1c027e73.margoengine.pages.dev.
- Tested preview deployment: `55ccc37f`, https://55ccc37f.margoengine.pages.dev.
- Current source checkpoint: `bafb657`, pushed on `codex/skinning-ik`; app/runtime checkpoint: `6794863`; source build integration: `6be773c`.
- Initial workshop deployment: `8d0427c6`, based on `347259f8`, including the Tokyo model update. It added the workshop folder and homepage link. The current hand repair preserves that release and replaces only the nested workshop HTML and build report.
- Exact deployed snapshot: `C:/Users/ScottCampbell/.codex/worktrees/skinning-ik/margoengine/test-results/light-keeper-hand-live/site`.
- Full snapshot manifest SHA256: `ebe42cfc53c61f7f6d8f9d48dfe236cadec9f48395abbbeef97dcdf6a4e2db96`.
- Standalone build-report SHA256: `11b0f89f30a6c6338459e5e4e5e5a17c160d027b19931d0fc494023a583ab097`.

The snapshot contains 193 files: 191 public files and two Cloudflare configuration files. Relative to the initial workshop release it retains 189 files unchanged, replaces the workshop HTML/build report, and adds the repaired model and its new hashed entry script. All 22 old workshop assets remain available. The homepage, Tokyo, `_headers`, `_redirects` and `404.html` remain unchanged. The largest new asset is 19,957,608 bytes, within the Pages per-file limit. Asset licenses are included. The previous exact snapshot remains in `test-results/light-keeper-live/site`.

## Verification

Both current preview and production passed full HTTPS verification of all **191 public files**: status, byte count, SHA256 and MIME. The homepage and canonical workshop route match their expected HTML, Tokyo's model/script references remain intact, and a missing asset returns 404 with `no-store`. Public reports are local ignored files under the current snapshot's parent folder: `preview-verification.json` and `production-verification.json`; both report success with no mismatches. Sanitized deployment metadata confirms production `1c027e73`, branch `main`, source `bafb657`.

The actual hosted workshop loaded in the in-app browser and uses `@margoengine/kinematics-constraints`. The initial production overhead/cross-body check reported a safe arm, grip error approximately 1.48e-8 and residual approximately 1.49e-8. The repaired-model preview cross-body check also reported a safe arm, zero residual, grip error approximately 1.29e-8 and torso yaw -0.85 radians. These are endpoint checks, not continuous swept-volume certification.

Before deployment, 307 selected tests passed, API reports stayed at 166 entries / 1,548 exports, all 85 tested GPU buffers matched CPU expectations, and the eight-case hardware motion suite passed. Core alone measures 18,192 gzip bytes; core plus stage remains **19,999 gzip bytes**, below the strict 20,000-byte gate.

This release is not a zero-GC claim. The pre-hand-repair warmed production-build drag capture measured 1.063 MB/s, seven minor/four major GCs and a 2.281 ms peak observed pause over approximately 30 seconds. No new allocation benchmark is attributed to the asset repair. Detailed evidence and limits are in [KINEMATICS_ALLOCATION_HANDOFF.md](KINEMATICS_ALLOCATION_HANDOFF.md).

## Resting hand repair

The resting `RightHand` originally contained only a teal housing and copper wrist bearing. Commit `bafb657` adds three relaxed fingers, an opposing thumb, curved palm and porcelain backplate in the existing four material assemblies. The editable Blender source, procedural helper and runtime GLB are updated together. There are no renderer, solver or public API changes.

An independent GLB comparison found every old triangle corner and winding unchanged, including positions, normals, UVs, tangents, joints and weights. Existing transforms, bones, inverse binds, animation samples, material semantics and embedded image bytes match. The 7,700 added triangles are rigidly assigned to `RightHand`. Five old exported tangent values were restored after Blender re-export rounding; no geometry was altered by that stabilization. Final model SHA256: `540d938269070d29ceca8c86f5dbedf721310eefdd30250b7dfd1ded7c6cc15d`.

Validation: **116/116 robot tests**, including five new geometry/attachment regressions; Khronos validation with zero errors/warnings; eight hardware browser motion cases and 14 transitions, with 638 published samples and no page errors or unmoving chase; and bit-exact CPU/GPU checks of 85 buffers / 83,968 bytes. Actual hand triangles clear fixed hips/thighs by at least **43.454 mm** in 14 sampled torso poses, including the -0.85 radian limit. The existing skinned head, torso and opposite-arm clearance tests also pass. These samples do not certify every possible trajectory.

Local evidence is under `test-results/hand-repair/` and `test-results/inactive-hand-regression/`; hosted release evidence is under `test-results/light-keeper-hand-live/`.

## Future releases

Start from this exact public snapshot, or deliberately integrate all currently deployed work before rebuilding the complete site. Deploying an older arbitrary checkout can roll back Tokyo or the workshop. Recheck the latest Cloudflare production deployment and public hashes before preparing the next snapshot. Keep credentials out of reports.

The durable source integration is committed on `codex/skinning-ik`: `site/index.html` links the workshop, and `scripts/build-site.js` runs the audited standalone builder then copies it under `demos/light-keeper/`. Direct upload does not merge that branch into Git `main`. The unchanged standalone builder is `scripts/build-skinning-ik.mjs`.
