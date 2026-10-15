# Demo cold-load measurements

Scope: all nine pages shipped by `scripts/build-site.js`, including both robot
entry points. Current local changes stage the complete principal island, helmet
and Earth before secondary detail. Their final authored features remain. These
changes have not been deployed; the earlier measurements below are historical, and their raw reports stayed in the ignored `test-results/` folder (a dated log, not a current claim; see [docs/whitepaper/claims.md](whitepaper/claims.md)).

Desktop drawing buffers now cap DPR at 1 while retaining 4× MSAA. Phones retain
their DPR 2 cap and single sampling. HTML/CSS overlays retain native display
density. The core/stage gzip gate remains below 20,000 bytes; the build measured
19,975 bytes then (19,543 at `3d845a0`).

## Method

`npm run benchmark:demo-loads` defaults to three fresh Edge/Chromium browser processes per
page, an Android layout user agent, 390 × 844 CSS pixels, DPR 3, touch input, 4× CPU
slowdown, 40 ms request latency and a 10 Mbps download cap. Browser cache is
disabled. A snapshot of `site/dist` keeps concurrent builds from changing assets
during a run. Run this benchmark without other GPU benchmarks for useful timings.

Current checks run on Windows with Intel Arc 140V; earlier results below used
NVIDIA Ampere. Neither host establishes physical phone GPU performance.
The latest native preview reports compressed JavaScript transfer bytes (94,776
including headers for the 94,476-byte gzip island entry). ResourceTiming records
the actual response transfer per request; asset formats remain independently
compressed. CDN DNS/TLS setup and actual mobile network latency are not included.
Fresh browser profiles do not clear driver-level
shader caches. These numbers are a reproducible proxy, not an iPhone guarantee.

First frame requires a nonempty draw into the canvas, or into an attachment that
resolves to the canvas, followed by GPU completion and two browser animation-frame
opportunities. Texture mip generation, shadow-only commands, clears and zero-count
draws do not count. A clear to the canvas plus an unrelated offscreen draw in the
same command buffer also does not count.

Scene ready is the later of a presented frame and the demo's controls-ready
signal. A first canvas draw is not proof that the main subject is visible:
Afterlight can draw its sky before constructing the island. The production
browser regression checks the complete castle, helmet and explorer with HTML
overlays hidden. There is no separate deferred-effects readiness signal now.

## Historical phased-startup results

The table below measured the phased-startup build on October 12, 2026, before
the rollback. It does not describe the current build. The results and explanation
are retained for comparison; current cold-load timings require a fresh run.

| Demo | Subject visible, median | Subject visible, worst | Full scene ready, median | Full scene ready, worst |
| --- | ---: | ---: | ---: | ---: |
| Night Citadel | 615 ms | 751 ms | 1,273 ms | 1,379 ms |
| Afterlight / gameplay sandbox | 708 ms | 810 ms | 1,858 ms | 2,058 ms |
| Damaged helmet | 907 ms | 939 ms | 1,406 ms | 1,500 ms |
| Character study | 904 ms | 981 ms | 933 ms | 1,011 ms |
| Robot Expressive | 938 ms | 965 ms | 969 ms | 995 ms |
| Windy meadow | 759 ms | 781 ms | 789 ms | 811 ms |
| Earth | 859 ms | 860 ms | 890 ms | 890 ms |

All seven show their subjects within one second in all three samples of the final
proxy run. Castle, helmet and Afterlight show real geometry before the remaining
effects finish. Afterlight's opening frame contains the terrain, explorer, a flat
ocean and a simple sky dome; the cabin and vegetation arrive with the effects.
Its complete world and controls still take about 1.9 seconds. Castle and helmet's
full scene times also include the transition and exceed one second. All pages
rendered without browser errors and requested only assets from their own origin.

A separate full run during concurrent workspace jobs was slower: castle's median
was 964 ms and Afterlight's was 1,068 ms. It is retained in
`test-results/demo-loads-concurrent-work.json`. The table uses the final complete
run, without selecting individual samples from different runs. These differences
are another reason to verify the deployed build on a real phone.

Immediately before decoupling effects, the corrected timing check measured castle
at 852 ms and helmet at 903 ms median on this same proxy. The user's observed
iPhone delays of about 5 seconds and 2 seconds are separate real-device results;
this local comparison does not establish their new iPhone times.

The initial single-sample run under the same throttle took 4,080 ms for the helmet,
2,846 ms for Earth, 1,471 ms for Character study, 1,465 ms for Robot Expressive and
1,872 ms for Afterlight. The final table uses repeated samples; the baseline did not.

## Retained loading optimizations

- Earth fetches its five maps concurrently, with sibling cancellation and complete
  cleanup if any map fails. It retains the image dimension and memory checks.
- Phones use 1024 × 512 Earth WebP maps: 381,276 bytes total, down from 2,275,024.
  Resized normal/specular maps use lossless encoding. Desktop maps retain 2K detail.
- Model demos use local, pinned GLBs and preload the selected assets. Their optional
  module imports overlap engine initialization instead of forming a request chain.
- The phone helmet uses 512-pixel maps and 6,179 triangles: 600,948 bytes versus
  3,773,916 for the original desktop asset. Source credits and licenses ship with it.
- Afterlight uses 100k particles, 25k grass instances, 96-cell terrain,
  a 128-cell heightmap, 64 water segments and 512-pixel shadows on phones.
  All particle tiers remain selectable.
- The latest local Afterlight entry now defers dense grass, fieldstones, shadows,
  clustered light and particles until its complete island/cabin/explorer/ocean
  principal render. Helmet presents the complete existing smaller model first,
  then adds SSAO and desktop detail. Original final features remain; functional
  streaming checks and current production timing are tracked separately.
- Earth now prepares a complete five-map 1K preview before its desktop 2K atomic
  upgrade in the optional Planet module. Functional lifecycle and final-image
  parity checks pass; upload/frame pacing and cold-load acceptance remain open.
  Phone maps are unchanged.

## Verification and reproduction

Build package distributions, then run:

```sh
node scripts/build-site.js
npm run benchmark:demo-loads
node scripts/demo-subject-tests.js
```

The benchmark now requires the identified principal-scene submission, GPU
completion and subsequent presentation opportunity. An early sky/background or
DOM ready flag cannot satisfy it. Earlier numbers above used the previous audit
and must not be treated as verification of the new gate. Any worst observation
over 1,000 ms fails the command after preserving the complete report.

The default `phone-layout-cold` profile uses Android layout on the host GPU,
10 Mbps/40 ms latency and fourfold CPU throttling. Reports are named
`test-results/demo-loads-<profile>.json`. Pass selected production paths for a
focused run; its filename ends in `-focused.json`. The native Chrome profile
uses the actual desktop viewport and no CPU slowdown; the Fast 4G profile uses
1.6 Mbps/150 ms and phone layout. These local profiles do not prove physical
Android/iPhone or CDN behavior. At 1.6 Mbps, even the 381 KB preview maps alone
need about 1.9 seconds of transfer, so they cannot meet the one-second gate.

```powershell
$env:LOAD_PROFILE = 'native-chrome-cold'
node scripts/benchmark-demo-loads.js /gameplay-sandbox/ /demos/earth/
$env:LOAD_PROFILE = 'android-layout-fast-4g'
node scripts/benchmark-demo-loads.js /demos/earth/
```

The subject regression writes
`test-results/demo-subject-report.json` and captures complete-scene images.
`node scripts/optimize-demo-assets.js` regenerates the checked-in phone assets using
the workspace's installed sharp, meshoptimizer and gltf-validator tools.

The Planet unit tests cover concurrent requests, sibling failure, late decode
cleanup, caller cancellation, GPU validation failures and device restoration.
Earth, model and Afterlight browser checks cover rendered pixels, mobile controls,
animation, SSAO, HDR, shader errors and GPU recovery. The sandbox typecheck and
package-boundary test pass. The generated helmet passes glTF validation.

The subject regression verifies actual castle, helmet and explorer pixels after
complete initialization, and GPU cleanup on departure. CI builds the production
pages and runs its small WebGPU timing
fixture with SwiftShader, guarding against false visible-frame signals. CI does
not use software GPU timings as an iPhone performance guarantee.

Core and stage received no features. Their existing CI gzip gate still rejects
20,000 bytes and above.

## Fresh native Chrome principal-view gate

The current staged build was checked with three fresh Chrome 154 processes per
route, actual desktop viewport/DPR, Intel Arc 140V, no CPU slowdown, cache disabled,
10 Mbps download cap and 40 ms latency. These sequential runs used an immutable
copy of `site/dist`; no other agent GPU workload ran concurrently. All nine pages
reported no browser errors, but every route failed the worst-observation gate:

| Principal scene | Median presentation opportunity | Worst | Result |
| --- | ---: | ---: | --- |
| Afterlight | 2,305 ms | 4,497 ms | Fail |
| Earth | 1,284 ms | 3,201 ms | Fail |
| Helmet | 996 ms | 1,127 ms | Fail |

The island's identified submit-to-queue-completion waits were 2,211 / 1,223 /
1,193 ms. They include any unfinished earlier warm submission, so this is not
isolated principal shading cost. Its entry response was already gzip-compressed.
Earth's first observation has delayed resource start times above two seconds;
its later samples still take 1,208 / 1,284 ms. Helmet's existing complete smaller
model transfers 600,948 bytes, placing most of its network budget in that asset.

The command correctly exited with failure after saving every observation to
`test-results/demo-loads-native-chrome-cold-focused.json`; a preserved copy is
`test-results/demo-loads-native-chrome-before-reflection.json`. No consistent
sub-second or physical-phone claim follows from the earlier warmed source passes.

The DOF and Tonemap standalone routes are now included in the same principal-view
gate at `/demos/dof/` and `/demos/tonemap/`. Their own package version is 1.0.0;
they accept the existing engine 0.1.0. Adding these opt-in routes does not change
the island's effect stack or let early DOM readiness satisfy their load target.

Real-device iPhone Safari and deployed CDN timing remain unverified. Phone detail
is reduced, and startup still depends on device compilation and network speed.

## Current optional-effect cold-load check

The current built DOF and Tonemap routes were each measured in three fresh
native Chrome contexts with cache disabled, 10 Mbps and 40 ms latency. DOF's
complete-principal median was 1553 ms and worst 1704 ms; Tonemap's median was
902 ms and worst 1327 ms. Both fail the strict worst-case one-second gate.
All browser/server processes closed and no page/GPU error was reported. These
are local built-site results on Intel Arc 140V, not hosted/mobile acceptance.
NavigationTiming and the resource waterfall are retained in
`test-results/demo-loads-native-chrome-postfx-20261013.json`.
