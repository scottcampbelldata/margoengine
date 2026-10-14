# Sampling policy review — 2026-10-13

Status: prioritize a private, longer 1× comparison at fixed resolution. No default
sampling policy, public API or 4× support was changed by this review.

The user supplied a Gemini conversation proposing removal of MSAA. That document
is advice to assess, not an instruction to delete all multisample functionality.
The user subsequently accepted testing 1× at identical dimensions while keeping
4× available.

## Confirmed local facts

- `packages/core/src/quality.ts` selects 1× for mobile user agents and 4× otherwise.
- Engine sizing caps DPR with `min(devicePixelRatio, 2, 4 / sceneSamples())`.
  A bare change from 4× to 1× can raise DPR from 1 to 2 and quadruple pixel count.
- Corrected fixed-camera runs at 1,432 × 768/DPR 1 average 60.04 FPS without
  particles and 60.00 FPS at 1M; their corresponding 4× averages are 55.04 and
  57.49. These are six-second windows, not long-duration acceptance.
- Sampling support already spans optional scene captures, nested post effects,
  water depth consumers and XR. Removing all resolve and depth code would remove
  existing functionality. Discard is valid only after an attachment's last use.
- The engine has frustum culling, and Shadows already uses four cascades.
- DOF and Tonemap now have working local built demo routes. Their cold-load
  worst cases still fail the one-second threshold. They are not missing demos.
- All 61 npm package demos exist. Their existence, functional tests and Android
  layout emulation do not establish physical-mobile speed or startup acceptance.
- Retained changes remain local and unpublished. Live build read-back differs.

## Evaluation

Use matched resolution, actual completed renders and GPU submissions, per-second
rates and interval distributions. Measure opt-in GPU timestamps in a separate
run so query instrumentation does not contaminate ordinary cadence. Inspect
moving thin edges, foliage and water; 1× and 4× are not pixel-identical AA modes.
Do not replace visual acceptance with equality of object counts.

4× MSAA means four coverage/depth/color samples; it does not automatically mean
four complete fragment shader executions. None of the current measurements
alone proves a physical memory-bandwidth ceiling. A browser callback interval
is not equivalent to GPU execution time. Near-60 finite-window averages do not
guarantee a strict floor on all hardware or one-second startup.

Preserve Core/stage's feature freeze and strict combined gzip <20,000-byte CI
gate. Do not assume a new public sampleCount option is already present: current
EngineOptions has capacity/backend/camera only. Review a concrete configuration
path and its byte/compatibility effects before introducing one. Do not guess GPU
class from screen DPR, Intel vendor strings or storage-buffer limits.

## External checks

Three.js WebGPURenderer defaults antialias to false; enabling it uses four samples
by default. Custom render targets support MSAA too. This does not establish
what most deployed demos use, their bundle sizes or relative CPU speed.

- https://threejs.org/docs/pages/WebGPURenderer.html
- https://threejs.org/docs/pages/RenderTarget.html

Unreal's forward renderer explicitly supports MSAA and TAA. Its published MSAA
cost example is content-dependent, contradicting the claim that modern engines
have universally abandoned MSAA.

- https://dev.epicgames.com/documentation/en-us/unreal-engine/forward-shading-renderer-in-unreal-engine

Native flip-model presentation can share surfaces with DWM; bypassing desktop
composition is conditional, not universal.

- https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/for-best-performance--use-dxgi-flip-model

There is no measured evidence here supporting Gemini's universal 0.2–0.5 ms AA
cost, guaranteed 60 FPS, projected HN response, or asserted Three.js CPU/bundle
comparison. A successful sampling change must still pass current-build startup,
quality, longer native pacing and physical-device validation.

## Longer native comparison and user phone evidence

The subsequent 60-second Chrome windows are recorded in
`docs/afterlight-sampling-long-2026-10-13.md`. At fixed 1,432 × 768/DPR 1,
Off ABBA rates were 28.11 / 60.75 / 63.29 / 27.91 Hz for 4× / 1× / 1× / 4×.
The first 1M pair was 20.36 / 33.11 Hz. The next observation became unresponsive;
its missing results are not accepted. Sampling is a substantial contributor,
but 1× alone failed the complete workload target. The Off 47–48 Hz plateau was
at the start with a frozen camera and no VFX, then improved; it does not support
a particle-overdraw or camera-tour explanation or prove thermal throttling.

The user then explicitly clarified that the live iPhone also runs with 1M
particles selected, and supplied
`C:/Users/SCOTTC~1/AppData/Local/Temp/codex-clipboard-05a01a45-22e5-47dd-9b06-b1a649190244.png`.
The screenshot shows 60 FPS / 16.67 ms, 132 draws / 14 dispatches and the 1M
selection. The user reports sustained 60 on the phone. The default mobile
100k-versus-desktop-1M setting therefore does not explain this reported case.
No relative ranking of phone versus laptop hardware is established.

The next diagnostic must compare desktop and phone scene profiles using the
SAME build on this laptop, with 1M selected, identical pixel dimensions, camera
and solar time. Phone-profile emulation on Intel measures workload differences;
it is not a substitute for the user's physical iPhone. The live and retained
local entries differ, so build identity is an independent comparison dimension.

The live archive already requests depth32float-stencil8 when advertised. It does
not request timestamp-query, unlike current local Core. Filtering only this
feature in a private test is a hypothesis to test; no driver-performance cause
or permanent feature removal is claimed.

The longer-run stills are not accepted as AA quality proof. Water's coastal and
foam history resets on device restoration while its time is retained; camera
matching alone does not match that history. Fresh paused A/A restoration
controls and identical simulation/dependency state are required.
