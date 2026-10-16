# Performance investigation: October 13, 2026

The reported regression followed changes that increased rendering work as well
as moving scene code into packages. Keeping the particle count is necessary for
a fair comparison. Desktop Afterlight still defaults to one million; phones keep
their existing 100,000 default. No production deployment was made in this investigation.

## The preceding 48 hours of Git history

Times below are Eastern. The repository is a complete clone, with `main` and
`origin/codex/margo-release`; `git log --all` starts at the root commit
`1e0e317` on October 11 at 3:19 AM. That initial commit already contains the
modern modular engine. The earlier inline HTML BASE/SCENE prototype is absent.
The public README also says earlier renderer/recovery archives are excluded.

| Commit | Time | Relevant rendering changes |
| --- | --- | --- |
| `7908ad3` | Oct 11, 11:27 PM | First committed Afterlight. Already imports VFX, Sky, Water, Shadows, Bloom and other packages. Defaults to 1M particles. Grass/rocks use simpler Lambert shading; HDR targets are single sampled. |
| `4aab554` | Oct 12, 3:52 AM | Moves local height, locomotion and rig code into shared packages, while also adding PBR/shadows on grass, settlement batches, clustered lighting, clouds, richer water and desktop 4× sampling. |
| `f4f1f31` | Oct 12, 5:57 AM | Extends multisampling through HDR targets and adds depth copies/resolves, terrain wetness and celestial/water lighting. Phones use 1× sampling. |
| `cc7aedb` | Oct 12, 5:13 PM | Replaces Citadel's custom renderer with engine packages. Adds viewport distance fog to Afterlight; reduces phone terrain, grass, water, shadow and particle tiers. |
| `5b24d1f` | Oct 12, 11:15 PM | Lifecycle/allocation/cache repairs and further package work. Desktop backing DPR is capped at 1, preserving 4× sampling. |

VFX's simulation shader has the same Git blob at `7908ad3` and the original
current release: `13ce459c707764a1beeb6052414965d61fd4b82f`. It already used
three-octave curl noise, atomic live-index compaction and six-index circular
billboards in that first Afterlight commit. The old `burst(capacity)` startup
became `initialCount:capacity`, preserving population. Publishing package names
alone did not introduce those simulation operations.

The original BASE/SCENE HTML is needed to compare the exact renderer the user
remembers. The available commits establish added work, not an exact comparison
to an absent source artifact or proof of performance on the original hardware.

## Confirmed Citadel bottleneck and local change

On Intel Arc 140V hardware WebGPU, Edge 154, a 2880×1462 drawing-buffer stress
test measured 20–22 submitted frames/second with 4× sampling, versus 56–60 when
changing only the scene pipeline descriptor to single sampling. Geometry,
desktop assets, lights, water grid, particles and buffer dimensions stayed equal.
Sparse timestamps put 4× haze at 11.27 ms and sampled GPU passes at 34.73 ms.
These are stress conditions; a physical screenshot's pixel dimensions alone
do not establish the actual browser drawing-buffer size.

The local fix retains 4× rendering and desktop detail. It evaluates haze once
per pixel and writes only covered coverage samples. Nearest-depth haze is shared
at subpixel depth boundaries; it is a documented approximation. A real GPU fixture
checks empty, partial, mixed-depth and full coverage at 1× and 4×, leaving every
uncovered sample unchanged. Maximum covered-color error was 0.000486 in rgba16.

Two native-window comparisons on this laptop (1432×768 CSS and drawing buffer,
device DPR 2) measured:

| Version | Average submitted frames/second, 60 target | Lowest one-second window |
| --- | ---: | ---: |
| Current production, run 1 | 56.91 | 43.55 |
| Local haze fix, run 1 | 60.03 | 59.37 |
| Current production, run 2 | 58.21 | 49.54 |
| Local haze fix, run 2 | 60.04 | 59.47 |

These short runs support approximately 60 FPS on this laptop, not a universal
minimum. Native callbacks capped at approximately 60 Hz even with the 120 target.
The controlled uncapped pacer reached 60.33/120.27 FPS. The full Citadel GPU
regression passed controls, waves, lighting, resizing, phone layout, coverage,
steady resource allocations and disposal without browser/GPU errors.

## Afterlight Android remains unresolved

The user reports that Chrome on an unidentified Android phone shows the island
at about 3 FPS; other demos run normally. Setting particles Off still yielded
3 FPS, so particle count alone does not explain that case.

Android UA/layout emulation on this laptop's Intel GPU reached approximately
60 FPS with 100k particles and with particles Off. It is not Android hardware
proof. The largest proxy passes were terrain/explorer and settlement PBR;
both retain 16 blocker-search and 32 PCF shadow samples per shaded fragment.
There was no steady-state GPU wait or shared 3 FPS throttle in the source.

An opt-in report button is prepared for `/gameplay-sandbox/?diagnostics`.
Normal visits do not load the collector. The button downloads twenty seconds
of local JSON with active device, canvas dimensions, native callback/CPU timing,
submissions, scene frame counts, visibility and current/future errors. It stays
usable if the scene fieldset is disabled. Actual Android capture remains necessary
to distinguish GPU work, driver failure and a frozen/stale FPS display. The route
is local until deployed; no remote telemetry endpoint or cookie is used.

## Startup work and limits

Desktop Earth textures retain 2048×1024 resolution while falling from 2,275,024
to 1,712,222 bytes, a 24.7% reduction. Normal/specular channels remain pixel-exact;
night/cloud quality-95 WebP encodes measure 44.27/45.62 dB PSNR. Original assets,
phone assets and attribution are retained. Desktop texture preloads and immutable
fingerprinted-asset cache rules are prepared, with HTML and credits excluded.

The sub-second complete-scene goal is not established. Cold production transfer
observations included 1.22 seconds for the helmet model alone and 2.07 seconds
for the original Earth cloud map. Local startup measurements varied too:
Citadel comparisons produced 839–854 ms after the fix, but a later all-demo run
measured 1,073 ms; Afterlight measured 5,842 ms, helmet 2,184 ms and character
1,652 ms. A first draw or a loading image must not be called a complete scene.

Raw reports and temporary harnesses are under ignored `test-results/`, including
`native-citadel-check.json`, `native-all-demos.json`, `gpu-passes-summary.json`,
`afterlight-pass-profile.json`, `afterlight-diagnostics-check.json`,
`earth-texture-transcode/selected-report.json` and `night-citadel.json`.
