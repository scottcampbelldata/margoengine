# Principal scene startup audit

The accepted target is a complete principal 3D scene within 1,000 ms. Full desktop
detail and secondary effects may stream afterward. A sky, blank canvas, loading
image or DOM-ready flag does not establish that target.

This is a read-only audit of the seven site routes and the local build dated
2026-10-13 05:19 UTC. It does not verify the current hosted release. Exact assets,
conditional chunk inventory, source paths and prior measurements are recorded in
ignored `test-results/startup-path-map.json`. GPU compilation phase durations are
currently unmeasured; they must be captured before attributing startup to them.

## Payload limits

| Asset | Bytes | Complete initial detail | Transfer alone at 10 Mbps |
| --- | ---: | --- | ---: |
| Desktop helmet | 3,773,916 | 15,452 triangles; five 2048-square maps | 3,019 ms |
| Existing phone helmet | 600,948 | 6,179 triangles; all five maps at 512 square | 481 ms |
| Robot, shared by both character pages | 463,988 | 7,214 vertices; 14 clips, two skins, nine morph targets; no textures | 371 ms |
| Desktop Earth map set | 1,712,222 | All five channels at 2048 × 1024 | 1,370 ms |
| Existing phone Earth map set | 381,276 | All five channels at 1024 × 512 | 305 ms |

These arithmetic floors exclude HTML/JavaScript, RTT, parse, image decode, GPU
upload/compilation and presentation. The existing constrained test profile uses
10 Mbps, 40 ms latency, fourfold CPU throttling, 390 × 844 layout and DPR 3 on the
laptop GPU. It is not physical Android or iPhone performance proof. Full desktop
helmet/Earth payloads alone exceed the target in that cold profile.

Helmet image decode is also substantial: five desktop maps contain 83,886,080
RGBA bytes before mipmaps, compared with 5,242,880 for the initial phone asset.
`loadAsset` currently decodes glTF images sequentially; `PBRModel.setup` uploads
them and generates mipmaps before the first PBR scene render. Robot has no image
decode/upload cost. Earth fetches/decodes its five maps in parallel, but waits for
all of them before constructing the planet pass and returning.

## Route gates and candidates

| Route | Current readiness path | Complete initial scene candidate |
| --- | --- | --- |
| Night Citadel | Procedural geometry/effects are created before its first scheduled render; `stats.frames` increments afterward. | Principal architecture, ocean and night lighting first; fireflies and distant detail afterward. |
| Afterlight | Early render contains Bloom and Sky. Terrain, settlement, explorer, water and particles are constructed later; a later full render and queue wait precede `window.sandbox`. | Whole island/cabin/grove/explorer/ocean at initial detail; dense grass, distant decoration, particles, spray and refinements afterward. Sky-only readiness must fail. |
| Damaged helmet | Await full glTF images/GPU upload and SSAO setup; render, then mark viewport ready. | Existing complete phone helmet first on desktop while retaining desktop sampling; full PBR model asynchronously afterward. |
| Character animation | Await robot, Animation, floor, Shadows, Tonemap and facial controls; render, then mark ready. | Entire robot and studio first; attach animation, shadows/post refinements and facial controls afterward. |
| Robot expressive | Same source/asset path as character animation. | Share the same staged implementation; retain every clip, skin and morph target. |
| Windy meadow | Construct the selected GrassField and render before marking viewport ready. | Complete existing 35k-blade meadow first, then selected density/seeds/refinements. Floor or sky alone does not qualify. |
| Earth | Await all Planet maps and validation; mark body ready before first render. | Complete existing 1K sphere with every principal map channel/atmosphere first; full 2K detail afterward. |

These are proposals, not applied production changes or established sub-second
results. Initial and final visual captures must verify recognizable complete
objects, camera bounds, principal material channels and eventual full quality.

## Existing APIs and upgrade boundaries

Helmet can reuse public `loadGLTF`, `PBRModel.root.visible`, `PBRModel.dispose` and
the removal function returned by `SSAO.add`. Load the replacement while the old
model is visible, hide the new root before any beauty draw, then switch sources
and visibility before a single replacement scene submission. Preserve camera
state; retain the old model until replacement validation succeeds.

Planet has a fixed plugin name and no map-reload API. It cannot attach a second
Planet on the same engine while the first remains attached. One existing-API
option is to prefetch full map bytes after the initial presentation, retain the
last visible 1K frame while briefly stopping rendering, then dispose/recreate the
planet and resume only after the complete replacement is ready. This must prove
no blank submitted frame, unchanged controls/rotation/cloud offset, cancellation
and resource cleanup. It is not an automatic guarantee of seamless upgrade.

## Correct first-scene measurement

`installDemoLoadAudit` identifies an arbitrary first canvas-visible submission,
then independently polls DOM/application readiness. Taking
`max(firstFrame, ready)` does not identify which later submission contains the
complete principal scene. Afterlight demonstrates why that distinction matters.

The principal-ready marker must be armed only after the required objects/maps
and camera are assembled, correlate the specific render to an actual queue
submission, record that submission's GPU completion, then record a later browser
presentation opportunity. Two requestAnimationFrame callbacks after queue
completion provide an opportunity, not proof of physical display. A capture and
nonempty principal-object/draw assertions provide the content check. Keep later
effect/asset readiness separate so optional streaming does not inflate this gate.

Capture navigation/JS readiness, WASM/device/core async pipeline completion,
principal asset fetch/decode/geometry setup, synchronous optional pipeline setup,
identified principal submit, GPU completion and presentation opportunity. A
`createRenderPipeline` CPU duration alone does not measure driver work deferred
to the first submission. Re-run native and constrained cold/warm profiles with
these gates before claiming the 1,000 ms target.

## Applied local changes and current limits

The route table above records the earlier audit and proposals. Helmet now submits
the complete existing 512-map model before SSAO setup and its original desktop
model upgrade. Afterlight submits its complete terrain, settlement, explorer and
ocean before its existing secondary-detail module. Both preserve original final
counts and materials; their functional staging checks pass. Afterlight's five
local source principal opportunities were 1,390/939/852/1,508/1,530 ms, so staging
has not yet established consistent sub-second loading.

All seven production routes now use the correlated principal-scene marker.
Earth now starts with all five existing 1K maps and atomically upgrades to the
original desktop 2K maps through the optional Planet module. The production benchmark now requires
this marker instead of treating any early background draw as the full world.
The visible-frame regression passes; rebuilt production and hosted cold-load
verification remain pending. None of these changes is deployed.

## Current source streaming checks

The rebuilt package distributions were tested again with the actual Intel Arc
140V WebGPU adapter in headless Edge 154.0.4258.62. These are functional local
source tests, separate from cold production loading and physical Android proof.

- `node scripts/test-afterlight-streaming.js`: all five cases pass. The complete
  authored principal terrain, twelve settlement batches, ten trees, fourteen
  explorer parts and ocean are present before secondary loading. Pre-load
  controls, secondary failure and departure cleanup pass. Principal presentation
  opportunities were 2,661 / 1,380 / 1,287 / 1,619 / 1,492 ms; all fail 1,000 ms.
- `node scripts/test-helmet-streaming.js`: five scenarios pass. The full original
  15,452-triangle desktop model after streaming is pixel-exact against loading it
  directly, both with SSAO disabled and enabled. Desktop preview presentation
  opportunities were 477 / 524 ms; the Android-layout host-GPU case was 486 ms.
  Failed detail preserves the complete preview and camera; departure disposes
  the engine/model without publishing a late replacement. These warmed local
  source observations do not establish a cold network load guarantee.

The helmet fixture initially used an unbound global in its direct-model wait,
before the demo had published that global. It was corrected to check the window
property, and the original failure report was preserved. No production change
was needed for that fixture failure.

The subsequent first-water-frame check exposed a real initialization-order error.
Sky runs before Water, but Water's first reflection getter request occurred only
inside its later draw. The identified principal frame therefore dispatched zero
`reflectSky` computations. A browser instrumentation assertion failed on the
original source and preserved `afterlight-first-reflection-before.json`. The demo
now requests the existing Sky reflection texture before its principal render,
arming the original compute pass without changing Core or package APIs. The same
assertion then verifies a real reflection dispatch before principal presentation;
no placeholder reflection is treated as complete quality. This repairs the first
frame, rather than establishing a frame-rate gain.
