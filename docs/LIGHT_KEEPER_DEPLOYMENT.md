# Light Keeper production release

Published 2026-10-16 to [margoengine.com/demos/light-keeper/](https://margoengine.com/demos/light-keeper/), with a link from the homepage.

## Deployment identity

- Cloudflare Pages project: `margoengine`; production branch label: `main`; direct upload, not Git-triggered.
- Production deployment: `8d0427c6`, https://8d0427c6.margoengine.pages.dev.
- Tested preview deployment: `2fe32ffe`, https://2fe32ffe.margoengine.pages.dev.
- App/code checkpoint: `6794863`; source build integration: `6be773c`, pushed on `codex/skinning-ik`.
- Preserved production base: `347259f8`, including the Tokyo model update. This release adds the isolated workshop folder and edits only the existing homepage.
- Exact deployed snapshot: `C:/Users/ScottCampbell/.codex/worktrees/skinning-ik/margoengine/test-results/light-keeper-live/site`.
- Full snapshot manifest SHA256: `d30d8dcf6933dfe3c233171d9aa0f9460472a8d0745761c4d3be17375f6a8503`.
- Standalone build-report SHA256: `51059286af7bd20f3635cce59ba1155d4152523a18c4048aceec36805d0b1703`.

The snapshot contains 191 files: 189 public files and two Cloudflare configuration files. It retains 165 existing files unchanged, changes only the old homepage, and adds 25 files under `demos/light-keeper/`. `_headers`, `_redirects` and `404.html` remain unchanged. The largest new asset is 19,495,748 bytes, within the Pages per-file limit. Asset licenses are included.

## Verification

Both preview and production passed full HTTPS verification of all **189 public files**: status, byte count, SHA256 and MIME. The homepage and canonical workshop route match their expected HTML, Tokyo's model/script references remain intact, and a missing asset returns 404 with `no-store`. Public reports are local ignored files under the snapshot's parent folder: `preview-verification.json` and `production-verification.json`; both report success with no mismatches.

The actual hosted workshop loaded in the in-app browser, used `@margoengine/kinematics-constraints`, and passed overhead/cross-body controls. The production cross-body check reported `armSafe: true`, grip error approximately 1.48e-8 and residual approximately 1.49e-8. Screenshot: `test-results/light-keeper-live/production-browser.png` in the robot checkout.

Before deployment, 307 selected tests passed, API reports stayed at 166 entries / 1,548 exports, all 85 tested GPU buffers matched CPU expectations, and the eight-case hardware motion suite passed. Core alone measures 18,192 gzip bytes; core plus stage remains **19,999 gzip bytes**, below the strict 20,000-byte gate.

This release is not a zero-GC claim. Its warmed production-build drag capture measured 1.063 MB/s, seven minor/four major GCs and a 2.281 ms peak observed pause over approximately 30 seconds. Detailed evidence and limits are in [KINEMATICS_ALLOCATION_HANDOFF.md](KINEMATICS_ALLOCATION_HANDOFF.md).

## Future releases

Start from this exact public snapshot, or deliberately integrate all currently deployed work before rebuilding the complete site. Deploying an older arbitrary checkout can roll back Tokyo or the workshop. Recheck the latest Cloudflare production deployment and public hashes before preparing the next snapshot. Keep credentials out of reports.

The durable source integration is committed on `codex/skinning-ik`: `site/index.html` links the workshop, and `scripts/build-site.js` runs the audited standalone builder then copies it under `demos/light-keeper/`. Direct upload does not merge that branch into Git `main`. The unchanged standalone builder is `scripts/build-skinning-ik.mjs`.
