# Phone and laptop Afterlight render-path audit

This is a read-only audit of current source and the archived, hash-verified live
island. No package source, build, GPU test, browser state or publication changed.

The user's physical live iPhone screenshot reports 60 FPS / 16.67 ms, **1M
selected**, 132 draws and 14 dispatches, with the island clock at 18:01. The
initial mobile default of 100k particles does not explain that selected-1M case.
The live selection path has no silent mobile capacity clamp. The screenshot
does not itself read the GPU's indirect live-particle count or pipeline formats;
those remain separate runtime facts to capture on that physical device.

## Identity and dependency boundary

The archived live entry is `test-results/live-afterlight-2026-10-13.js`, identical
to the public `gameplay-sandbox/assets/index-uuvsyWZj.js` preserved in
`test-results/site-live-pinned-2026-10-13T171926476Z/`. The bytes were hashed again
in this audit: **301,030 bytes**, SHA-256
`1d096ef1af9fc7b0d505d46e70d6e5bd1ee0de906590151f3e0b156977ce9fa1`.
The snapshot manifest records a matching public GET at 17:19:26 UTC and no
capture errors. Its HTML and CSS hashes are respectively
`34e70234a7fb97173f7df5964cbe4fb8ce48779221d7fd60b366b2ba75e3645d` and
`b02569acc2112e142d42798b188a0cf1b554e33d8fe2df4d6eeef703068f1a0e`.
This audit did not make a new network request. A screenshot's served/cached entry
identity must still be recorded before equating it with this archive.

The current island imports Core/extension, Sky, Shadows, Water, VFX, Input,
Cinematic, Post/Bloom, Stats, Procedural, Clustered and Controls/locomotion.
Scene/detail/settlement code also uses Geometry, Terrain, Scatter/ScatterInstances
and Lines, plus shared GPU, MSAA, quality, math, view and AgX helpers. The actual
page uses Core directly; the stage facade is not its renderer. Current source
entry imports are at `examples/gameplay-sandbox/src/main.ts:1` through line 18;
scene/detail imports are at `scene.ts:1` and `landscape-details.ts:1`.

The live archive predates several local changes: its landscape/details are
combined in the entry, VFX owns **two** 64-byte-per-particle state buffers, water
always copies opaque HDR color for refraction, and device creation requests only
supported `depth32float-stencil8`. Current source has deferred detail assembly,
one VFX state buffer, a 1x water color-borrowing path, and additionally requests
supported `timestamp-query`. The earlier read-only live/local comparison in
`test-results/live-island-build-current.json` records different entry bytes:
local `index-DPRIfg5U.js` SHA
`4186741f7639c2eafe9a3bdafbbf67ae93d376b1e4e3466be05610794a068edf`.
Do not compare the archived phone with current local code as though the builds
were identical.

## Every mobile user-agent branch in the island graph

A search of the runtime source directories listed above found exactly four
`/Mobi|Android/` tests. The archive contains exactly three occurrences because
its landscape and details share one function. There are no additional UA tests
in VFX, Water, Sky, Shadows, Scatter, terrain shaders, Bloom, Stats, Input,
Cinematic, Clustered or locomotion in this dependency graph.

| UA test and source | Desktop choice | Mobile choice | Archive evidence |
| --- | --- | --- | --- |
| Core `sceneSamples`, `packages/core/src/quality.ts:2` | 4x raster samples | 1x raster samples | Entry line 1, offset 13,038: shared `function c()` returns 1 or 4 |
| Main `mobile`, `examples/gameplay-sandbox/src/main.ts:36` | Shadows 1024; water segments 256; initial VFX selector 1M | Shadows 512; water segments 64; initial selector 100k | Entry line 956, offset 294,793: same choices in live boot |
| Landscape `mobile`, `examples/gameplay-sandbox/src/scene.ts:10` | Terrain resolution 192; heightmap 256 | Terrain resolution 96; heightmap 128 | Entry line 956, offset 289,745: combined live `qi` function |
| Details `mobile`, `examples/gameplay-sandbox/src/landscape-details.ts:13` | Grass request 110,000 | Grass request 25,000 | Same live `qi` UA flag controls grass; no fourth archive UA test |

The regex depends on the reported user-agent string, not GPU vendor, browser
capability, physical screen size, pointer type or a measured performance tier.
An iPhone's usual `Mobile` user agent matches `Mobi`; the actual screenshot's
user agent has not been collected by this audit.

## Selected 1M: exact authored capacity and dispatch route

Current `main.ts:57` starts the four-tier selection route (0/100k/500k/1M), disposes the previous
effect, and at line 62 passes **the selected number unchanged** as both
`capacity` and `initialCount`, with `rate=capacity/20`. The change listener at
line 90 invokes that route. Only line 64 assigns the initial mobile selector
value. The archive's line 956 has the same `T(t)` tier function and direct
`capacity:t,initialCount:t,rate:t/20`; its change listener calls `T(Number(value))`.

Live VFX at archive line 568, offset 133,895 assigns
`this.capacity=options.capacity??1e6`. It rejects invalid counts or insufficient
device limits, rather than silently selecting a lower count. At selected 1M,
live setup allocates two 64,000,000-byte states, a 4,000,000-byte live-ID buffer,
224-byte uniform, 20-byte indirect buffer, 8-byte respawn state and 24-byte index
buffer. Current `packages/vfx/src/index.ts:23` and lines 33–40 preserve the same
requested capacity but allocate one 64,000,000-byte state after the retained
in-place change. Core's island entity capacity 256 (`main.ts:29`) limits ordinary
mesh entities; it does not limit VFX's separately owned storage population.

Both versions write requested capacity into header word 52, budget into word 53,
clear only indirect instance count and respawn count, and execute one VFX
compute dispatch with `ceil(capacity/256)` workgroups. At 1M that is **3,907
workgroups**, with capacity guards on padding lanes. The archive's dispatch is
at line 568, offset 138,485; current source is `index.ts:52` and
`shader.ts:25`. Billboard rendering uses the GPU-produced live IDs and indirect
instance count. Capacity and instantaneous live occupancy are distinct; the
budget, expiry and respawn logic are the same for both UA branches.

The authored emitter parameters also match: extent `[80,3,80]`, position `[0,4,0]`,
velocity `[0,.03,0]`, zero gravity, spread .08, life 25–45 s, size .01, ground .35,
curl strength .035/frequency .22, color `[1,.85,.4,.5]`, intensity 5, and rate
50,000/s at 1M. There is no phone-only simulation, reduced curl octave count,
respawn rule, billboard shader, opacity, particle size or behind-eye culling.

Stats counts **dispatch commands**, not workgroups (`packages/stats/src/index.ts:13`).
Thus 14 dispatches can coexist with very different grid sizes. For a warmed
frame with fixed turbidity, the code is consistent with 6 coastal steps + 1 spray
+ 1 VFX + 2 grass/fieldstone culls + 1 clustered-light cull + 2 bloom filters
+ 1 sky reflection = 14. This is a source-derived decomposition, not a physical
phone pass capture. Draw-call counts likewise do not reveal triangles or live
instances. The reported 60 FPS is Stats' sampled `1000/frameTime` at lines 76–85;
it is not a separately measured GPU duration or display-presentation trace.

## Authored geometry, maps and effects

| Setting | Desktop | Mobile | Source and implications |
| --- | ---: | ---: | --- |
| Island terrain resolution | 192 | 96 | `scene.ts:11`; same 160x160 island height function/seed 731, but 73,728 vs 18,432 triangles and 37,249 vs 9,409 vertices |
| Terrain heightmap | 256x256 | 128x128 | `scene.ts:15`; same `r32float` cell-center sampling, `packages/terrain/src/heightfield.ts:49` |
| Grass requested placement count | 110,000 | 25,000 | `landscape-details.ts:17`; same seed 37, density .86, species/LOD meshes, LOD distances 18/42/105, wind, exclusions, slope/height/material rules |
| Grass culling workgroups | 1,719 | 391 | Derived from `ceil(count/64)`, `packages/scatter/src/index.ts:139`; one dispatch in both |
| Cascaded shadow map | 1024x1024x4 | 512x512x4 | `main.ts:44`; same four cascades, PCSS/light size .018, distance 115, lambda .7, normal bias .055 and caster margin 65 |
| Water mesh segments | 256 | 64 | `main.ts:55`; 131,072 vs 8,192 triangles, 66,049 vs 4,225 vertices; same 400x400 extent and horizon extension |
| Coastal simulation map | 256x256 | 128x128 | Inherits the terrain texture dimensions, `packages/water/src/coastal.ts:131`; each of six steady dispatches is 32x32 vs 16x16 groups of 8x8 threads |
| Coastal substeps | 3 | 3 | `coastal.ts:150`; same flow/integration equations, ping-pong state, foam and connectivity behavior |
| Spray | 2,048 droplets | 2,048 droplets | `packages/water/src/spray.ts:64`; same 32 groups of 64 threads per one dispatch, no UA branch |
| Fieldstones | 950 | 950 | `landscape-details.ts:19`; same placement/LOD/material |
| Hidden wireframe terrain | Resolution 64 | Resolution 64 | `landscape-details.ts:14`; hidden by default, same UI toggle |
| Sky / clouds / fog / reflection | Same authored options | Same authored options | `main.ts:41`; Bruneton, coverage .38, fog .008/start45, turbidity3.2, sun/moon/ambient options retained; LUT sizes128x32 and128x256, reflection64x32 (`packages/sky/src/index.ts:105`) |
| Clustered lights | Grid8x4x16 | Grid8x4x16 | `main.ts:129`; same porch light and day/night intensity scale |
| Bloom / AgX | Same authored options | Same authored options | `main.ts:39`; strength.2, threshold1.2, exposure.45; blur dimensions follow canvas size |

Cabin, tree/shrub/fern/rock placement, materials/contact AO, explorer rig,
locomotion and camera settings have no UA quality branch. Their visibility can
still depend on camera/frustum/time. Mesh/map resolution changes alter sampled
geometry, coastal cells and derivatives; they are real authored quality/workload
differences even though the algorithm and feature paths remain present.

## Pipeline, backend, format and layout paths

| Path | Difference trigger and behavior | Evidence |
| --- | --- | --- |
| Backend | Island explicitly requires WebGPU. No mobile WebGL fallback is selected; missing WebGPU/limits produces visible failure. Core's generic auto fallback exists but is not this boot route. | `main.ts:25,29`; `packages/core/src/engine.ts:106`; archive boot line956 |
| Device/format | Both request a high-performance adapter and browser-preferred canvas format. Main depth is `depth32float-stencil8` if enabled, otherwise `depth32float`. Capability-driven, not UA-driven. Live requests only that supported feature; current local additionally requests supported timestamp-query. Physical iPhone capability/format is unverified. | `packages/core/src/renderer.ts:55,57,59,66`; archive line24, offset16,964 |
| Canvas pixels | `min(devicePixelRatio,2,4/sceneSamples)` gives desktop effective DPR at most1 and mobile at most2, with each dimension capped4096. CSS viewport and orientation remain additional differences. Mobile can therefore render more pixels per CSS pixel. | `packages/core/src/engine.ts:173`; archive line25, offset37,636 |
| Core raster targets | 4x creates color+depth raster targets and resolves color to canvas; 1x uses canvas color directly plus a 1x depth target. Stencil load/store fields are present only for stencil formats. | `packages/core/src/renderer.ts:112,120,139,143,154` |
| HDR capture/resolve | Bloom owns `rgba16float` HDR color and matching main-depth format. Shared SceneTarget has a 1x direct-view/early-return path; 4x owns transient MSAA targets and depth-copy/color resolves. Reversed-Z depth coverage resolve takes maximum samples. | `packages/post/src/bloom.ts:119`; `packages/shared/msaa.js:20,37,48,55` |
| Water/foam/spray | Same optics, horizon, foam, refraction and spray features. Water surface depth matches scene samples/format; 4x adds MSAA `r8unorm` foam and resolve. Spray changes depth texture type/sample-index lookup for 4x. Live always captures opaque HDR copy; current source borrows it at1x only. | `packages/water/src/index.ts:223,230,240,244,245`; `spray.ts:70`; archive line513 (capture/surface/foam), line381 (spray) |
| Fog | Same fog model and density. Source depth sample count controls `texture_depth_2d` versus multisampled depth and `sample_index` lookup; inherited raster sample count is retained. | `packages/sky/src/index.ts:145,150`; archive line185 |
| Scene pipelines | Core, sky, Scatter, ScatterInstances, VFX and Bloom variants inherit/cache color, depth and sample-count choices. VFX source-alpha blending and reversed-Z depth compare stay the same. Shadows always use single-sample `depth32float` and less-equal. No separate mobile shader material graph. | Core renderer126; Sky167; Scatter151; instances122; VFX55–60; Shadows63,100 |
| Binding layouts | Render/compute paths use auto layouts and pipeline-specific bind groups; Lines uses explicit frame/style layouts. Neither choice is UA-specific. Changing sample/depth/color variants requires their matching pipeline layouts/groups. | `packages/vfx/src/index.ts:38,59`; `packages/lines/src/lines.ts:90,104` |
| CSS/input | Live and current CSS have max-width800/max-width560, coarse-pointer and reduced-motion media rules. They rearrange controls/telemetry; small screens hide the Stats graph canvas and reveal touch sticks in Explore. Both boot paths create sticks and bind keyboard/pointer/touch. These rules do not alter the 1M selection. | `examples/gameplay-sandbox/src/style.css:10`; archived CSS; `main.ts:72`; Input79–91 |

Reduced motion initializes the app paused (`main.ts:32`); visibility/pause stop
RAF and resume follows user state. Those are preference/lifecycle paths rather
than UA renderer quality branches. A matched comparison must record them.
The older `afterlight-diagnostics-phone.json` is **Android layout emulation on
Intel**, not the user's iPhone: viewport390x844, canvas780x1688, effective DPR2,
60 Hz callback cadence, 136 draws/14 dispatches. It cannot establish the physical
phone's selected capacity, GPU speed, adapter features or framebuffer formats.

## What the next matched experiment must isolate

The screenshot is evidence that the user's physical live phone reports 60 FPS
at selected1M. It does not determine which authored phone setting or browser
pipeline choice causes the laptop difference. No hardware ranking or bandwidth
ceiling follows from this source audit.

Use the exact pinned live build for both profiles, hold selected capacity and
indirect population at 1M, fix camera/time and match CSS viewport, actual canvas
pixels/DPR, sample count, scene composition, playback/visibility/focus and capture
length. Record physical user agent, enabled features, depth/canvas/HDR formats,
actual buffer sizes, group dimensions and live count. Keep unprofiled cadence
separate from pass profiling and avoid another shader candidate during this
attribution run.

Change one authored choice at a time on the laptop: terrain192→96, map256→128
(which also changes coastal simulation grid), grass110k→25k, shadows1024→512,
water256→64; return to the same control between changes. Keep VFX1M, all emitter
math and effect features intact. Sample count1 and matched pixels are separate
controls, not a complete mobile profile. Test the capability-driven depth format
only after recording the actual physical-phone format. CSS/control layout and
Stats graph can be isolated independently without changing scene quality.
Each result needs exact descriptor/state metadata, per-pass/whole-frame evidence
and unchanged controls/lifecycle before attributing any saving. None of these
experiments was run in this audit.
