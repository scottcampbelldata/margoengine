# Desktop source trial with authored phone scene values

The matched desktop-UA A/B/B/A experiment completed on Chrome
**155.0.8059.40**, four fresh owned contexts and 10 seconds per timed window.
Both immutable fixtures used the same existing package distributions, including
the retained VFX implementation with one **64,000,000-byte particle state**.
Both kept the actual 1M particle capacity, initialCount1M, rate50000, lifetime
25–45, size.01 and actual indirect count1M at both boundaries. Native canvas
1432×768, engineDPR1 and 1× sampling were verified. The private compiled sampling
rewrite changed neither frozen Core/Stage source nor their public API/defaults.

| Window | Variant | Real render/submit Hz | Median gap ms | p95 ms | p99 ms | Max ms | >25 ms | >33.333 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| A1 | Desktop original | 52.3977 | 17.0 | 26.0 | 30.6 | 35.6 | 83 | 3 |
| B1 | Phone values on desktop | 63.4791 | 16.6 | 21.0 | 25.1 | 52.0 | 7 | 1 |
| B2 | Phone values on desktop | 57.9756 | 16.7 | 24.8 | 25.4 | 26.2 | 17 | 0 |
| A2 | Desktop original | 52.6997 | 16.8 | 25.8 | 26.3 | 27.8 | 95 | 0 |

The requested settings improved cadence and reduced long gaps. The candidate
windows differ (63.48 and57.98Hz), and their p95 gaps exceed16.67ms, so locked60
is not established. These timestamps observe returned Engine.render calls and
successful native submission, not GPU execution or physical presentation.
The five source setting changes remain a user-authorized provisional trial,
with guarded restoration in test-results/desktop-phone-settings-source-backup-20261013/restore.ps1.
Neither visual quality nor final speed acceptance is complete.

All five settings were verified from runtime geometry/options/native textures,
with the same desktop UA/input in both conditions:

| Setting | Desktop original | Phone values on desktop |
|---|---:|---:|
| Terrain grid resolution / triangles | 192 /73728 | 96 /18432 |
| Heightmap options and r32float texture | 256×256 | 128×128 |
| Grass instances | 110000 | 25000 |
| Shadow resolution | 1024 | 512 |
| Water segments | 256 | 64 |

Fieldstones stayed950 and settlement batches12. All windows kept132draws,
14dispatches, identical fixed cameras, visible foreground, desktop hover/input
and no mobile-width/touch-control layout. The laptop reports maxTouchPoints10
in both; no hardware/input equivalence to a phone is inferred. Timed solar time
was fixed18.016666666666666 hours with timeScale0. Startup ran the authored
initial solar settings before this timed-window pin was applied.

Estimated declared texture bytes fell91,009,040→61,714,448; declared GPU buffer
bytes87,564,148→75,659,380. Both used28 live tracked textures and174buffers,
including the exact64MB particle state. Neither number includes driver/internal
allocation overhead. The device features in every context included
depth32float-stencil8 and timestamp-query, but **zero query sets were created**:
profiling was off and capabilities were unchanged between variants.

Each 526 /637 /582 /529 counted frame had one successful native submission,
matched original app-frame counts and full million-slot simulation uniforms and
dispatches. There were zero timed query/buffer/pipeline/shader creation deltas,
no page/GPU/device-loss errors, and no device reboot. Every window required
principal readiness plus phase complete/details loaded before timing.

| Window | Principal submit ms | GPU completion ms | Presented opportunity ms | Full scene ready ms |
|---|---:|---:|---:|---:|
| A1 | 1366.7 | 2111.6 | 2120.9 | 2880.5 |
| B1 | 1201.5 | 2155.8 | 2169.6 | 2991.8 |
| B2 | 958.8 | 1936.1 | 1951.4 | 2828.8 |
| A2 | 1121.1 | 1811.6 | 1817.0 | 2636.1 |

These browser performance.now startup milestones remain separate from steady
cadence. The two-RAF presented opportunity is not a physical display-completion
measurement. These values do not establish a one-second startup improvement.

This is a separate build dimension from the old published 301030-byte entry
and its two-state ping-pong VFX particle-isolation matrix. Differences between
those experiments cannot be attributed solely to scene density, hardware or
particle count. Full actual shader sources, pipeline descriptors, geometry,
textures, options and features are retained for both source variants.

All four devices were destroyed exactly once, with zero live tracked textures
or buffers after retirement. Browser/preview closed, runner exited0, exact owned
native Chrome/runner processes were absent and no residual owned Chrome child
was found. No process termination or publication occurred.

Raw evidence: ignored test-results/afterlight-source-trial-scene-default-chrome-10s-desktop-phone-source-v1.json,
SHA256 `bffcd57294dedda88c2f26e66031501aaa887bb57ffb59c40ec6f3db3e177bd3`.
Adjacent .harness and .evidence.json preserve eleven executed helper copies,
immutable fixture manifest/hashes, full tails/conditions and terminal evidence.

## Subsequent native desktop calibration

Root later identified an ASUS OLED screen-saver instance starting at
18:34:07UTC. The source ABBA's final report write was at18:33:37UTC, before that
instance. The later screen-saver observation therefore does not explain the
B2 decline in this source comparison. Existing measured data and hashes remain
unchanged. Page visibility/focus and disabled focus emulation were checked in
these windows, but native OpenInputDesktop/owned Chrome foreground checks were
not captured during them; physical presentation remains unverified. Later
screen-saver-confounded blend timings are a separate experiment. Future physical
foreground runs must require the Default input desktop and the exact owned
Chrome window in native foreground after the user wakes/unlocks the display.

## Desktop detail restored after trial — 2026-10-13

The five-value mobile-settings source trial did not pass sustained60FPS, one-second principal visibility or desktop quality acceptance. All three pre-trial source files were restored with the existing all-files SHA-guarded restore, preserving earlier package/startup fixes. Desktop authored terrain/heightmap resolution, grass count, shadow resolution and water segments are again the pre-trial values. The immutable desktop/phone trial builds and every measured raw result remain available. Read-back hashes and decision: `test-results/desktop-phone-source-trial-restoration-20261013.json`. No deployment or new performance claim. The earlier807-test snapshot included the provisional values; the restored source requires its own targeted app checks.

Restored desktop source validation: island app10/10 targeted tests passed (no skips/failures), TypeScript and Vite production build passed. Source hashes match every pre-trial original; Core/Stage hashes remain unchanged from the19975-byte full-regression snapshot. Asset hashes and actual raw/gzip sizes are in `test-results/desktop-phone-source-restored-app-checks-20261013.json`. This is build/functionality evidence only, not a fresh FPS, physical-mobile or cold-load result.
