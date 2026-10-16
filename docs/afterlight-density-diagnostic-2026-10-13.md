# Private Chrome compositor density comparison

Prepared command, **not executed**:

```powershell
node test-results/afterlight-density-abba.mjs --run --seconds=10 --label=phone-density-native-v1
```

Static preparation/immutable-asset verification, without browser/server:

```powershell
node test-results/afterlight-density-abba.mjs --seconds=10 --label=phone-density-native-v1
node --test test-results/afterlight-density-contract.test.mjs
```

Four foreground windows use separate fresh owned Chrome profiles/processes in ABBA order. A explicitly sets `--force-device-scale-factor=2` and Playwright deviceScaleFactor2. B sets the corresponding1 values. No vsync, frame-rate limit, fake VSync, shader-debug, display refresh or OS density change is bundled. Native default query-free old-live features remain intact.

All windows load `site-live-pinned-2026-10-13T171926476Z`, authored phone UA scene on the same laptop, full1M particle selection/capacity,1× sampling, engineDPR1, CSS1432×768 and actual WebGPU canvas texture1432×768. Phone terrain18432triangles, grass25000, water64, shadows512 and12settlements are asserted. Full initial indirect arguments `[6,1000000,0,0,0]` are read only after stopping the app. Camera/time/actions are fixed identically. The shader modules, encoded pipeline descriptors, application texture/buffer sizes, memory declarations, device requests/limits/features and scene parameters must match across all four conditions. A parity failure is retained and aborts the comparison.

One real successful native queue submit, one command buffer and one returned original Engine.render are required per counted app frame. Counts, one-second intervals, camera, visibility/focus, VFX uniform writes/full-capacity dispatch and zero measured query/buffer/texture/pipeline/shader resource allocation deltas are checked. No synthetic visibility, hidden-state workaround, render cap, modified frame delta or per-frame GPU await is used. GPU resource allocation assertions say nothing about JS/Wasm allocations.

Each window records Chrome version/revision, accepted flags, chrome://gpu DOM, raw Browser.getWindowForTarget bounds, page/screen/document-client/visualViewport/canvas dimensions, last native canvas texture descriptor, canvas configuration, application texture and buffer descriptors, pipeline descriptors, shader hashes, actual device features and errors/deviceLost. The read-only Windows helper verifies the exact browser PID command line contains the owned profile, then records only that browser's HWND roots and owned Chrome children: window/client rectangles, DPI, visibility and owning PID. Native helper errors are retained and invalidate foreground acceptance. These rectangles are not DXGI swapchain descriptors.

Native desktop calibration is mandatory. Before each browser launch the helper must observe an available input desktop named `Default` and a positive actual foreground PID. Before/after each timed window, `Default` plus an actual foreground PID belonging to this exact owned Chrome CDP process set is required. Page visibility/focus alone is insufficient. Unknown, secure/Winlogon or Screen-saver desktops and PID0 fail acceptance. The helper uses read-only [OpenInputDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop), [GetUserObjectInformationW(UOI_NAME)](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getuserobjectinformationw) and [GetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow) + owning PID. It never switches desktops, sends input, disables/kills screensavers or bypasses lock.

A separately owned read-only helper watches those native conditions every250ms during each real cadence window. Its preparation/compilation occurs while the app is stopped. A UUID ready/stop handshake in a unique run subdirectory brackets the measurement; capture is bounded15seconds and any missing handshake, observer gap over1second, unavailable observation or non-owned foreground sample invalidates the window. Every sample retains UTC and QPC ticks/frequency; those are native CPU clock metadata, not a GPU clock calibration. The watcher performs no GPU work. This small external observer still introduces some CPU overhead, identically across conditions.

The app stops before diagnostic readbacks and retirement. Its resource audit must show zero live tracked buffers/textures and one device destroy per owned device. Context/browser close is bounded. Exact PID plus creation-time identities from this browser's CDP process inventory are checked with targeted Get-Process after shutdown; another condition cannot launch while exact owned processes or cleanup failures remain. No process termination is implemented. User Chrome is untouched. Driver/GPU-resource retirement and native-process shutdown remain distinct recorded facts.

Every run creates a unique `test-results/afterlight-phone-density-abba-<label>-<time>` folder containing report, per-window chrome://gpu text, and reproduction copies/hashes of every consumed helper. Earlier reports are untouched. All three immutable snapshot assets are byte-length/hash verified before any browser/server launch, and exact HTTP readiness is checked afterward.

This deliberately changes compositor/UI presentation density while app physical render pixels remain equal. It is a diagnostic of presentation work, **not** a Core fix, displayed quality acceptance, package performance acceptance, physical-phone proof, or physical display-frame count. Four ordering-controlled windows still admit thermal/driver drift.

Preparation checks passed: Node syntax, no-run immutable asset/hash preflight, PowerShell syntax parse, embedded C# compilation without native-method invocation, and six offline contract tests. Tests replay the prior real full1M phone cadence and reject target resizing, altered density/AA/query capacity, fake submit counts and shader/resource/feature parity loss. Native guard tests reject Screen-saver/Winlogon/unknown input desktops, PID0, unrelated foreground processes, unverified profile, periodic coverage gaps and missing owned stop handshake. Native browser behavior, current desktop state and HWND access await execution; they are not claimed by static tests. Browser remains closed pending human wake/unlock and root's hardware-slot grant.

## Claim audit and decision table

Real preflight at19:07:12UTC rejected input desktop Screen-saver/foreground PID0 before Chrome launch. Preview closure was confirmed by ECONNREFUSED. [Terminal evidence](../test-results/afterlight-phone-density-abba-phone-density-native-guard-v2-2026-10-13T190710882Z/terminal-native-guard-proof.json) preserves this negative calibration result; it is not an engine speed result. Root's latest19:21UTC check reports the same condition; no new launch occurred.

| Claim / question | Evidence and next diagnostic decision |
|---|---|
|120Hz refresh divisor explains40Hz | Active mode120.000294Hz/AC online/Intel Arc140V xe-2lpg are recorded. A25ms RAF median makes120/3 plausible, but physical scanout/divisor and native inner Present waits are unproved. Density ABBA changes no refresh/vsync/frame limit. |
| UAV→VB stall | State/alive are STORAGE, with no VERTEX usage or billboard vertex-input buffer. Compute-to-read/indirect ordering still exists; actual backend barrier/cache cost remains unmeasured. The [D3D12 UAV barrier contract](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_resource_uav_barrier) does not supply a fixed stall duration. |
| Add double buffering | Pinned old-live already has two64MB state buffers and matching ping-pong groups, with shared alive/indirect/respawn. Current local source is a separate single-state build. Do not describe a missing second live state or guaranteed overlap improvement. |
| TBDR or mobile tile flush | This capture uses Intel on Windows. [Intel Xe2 source](https://cdrdv2-public.intel.com/824434/2024_Intel_Tech%20Tour%20TW_Xe2%20and%20Lunar%20Lakes%20GPU.pdf) supports architecture context, not workload cache/tiling cost. Physical iPhone/Apple behavior and tile flush attribution were not measured. |
| Opaque must reach60 | Blend-off changes appearance. Its36.989/37.543/39.746/41.118Hz ON/OFF/OFF/ON capture is screensaver-confounded, not an idle-awake blend-cost or physical-FPS test. Retain ABI/count/cleanup checks only; repeat after native guard proof if authorized. |
| Remove compute/draw and add savings | Default isolation full43.697, compute-only54.083, frozen draw-only49.557, both-off65.107 real render/submitsHz. One native submit per returned render was verified. Costs cannot be added or extrapolated into a guaranteed60 result; both-off tails still exceed16.67ms. |
|19ms computed delta identifies culprit | Delta is elapsed RAF time supplied to simulation, not a GPU duration. Keep original delta/scene/pixels, measure the suspected path independently; no automatic cause or60 claim. |
| Browser density explains larger surface | Engine texture stays1432×768; recorded DPR2 dirtyRect2864×1505 is compositor imagery. Exact swapchain/client clipping is not proved by this rectangle. Matched native/PW DPR2/1 ABBA awaits human wake and actual native foreground proof; diagnostic changes UI/compositor density, not accepted displayed quality. |

See the [full cadence audit](afterlight-cadence-diagnostics-2026-10-13.md#diagnostic-claim-audit-2026-10-13) for saved evidence paths/build distinctions. Earlier source ABBA and CDP trace predate this particular screensaver instance; it is not assigned retroactively to those runs. No current measured state establishes all-package sustained60 or principal startup<=1000ms. No production defaults/APIs/source or executed frozen evidence changed.

Hardware clarification: this Core Ultra7 258V/Arc140V is an integrated GPU using shared system memory ([Intel processor specification](https://www.intel.com/content/www/us/en/products/sku/240957/intel-core-ultra-7-processor-258v-12m-cache-up-to-4-80-ghz/specifications.html), [integrated-memory explanation](https://www.intel.com/content/www/us/en/support/articles/000057824/graphics.html)). An Optimus/discrete PCIe/VRAM transfer explanation is unproved here. Blend work need not read/write external memory for every fragment; [Xe2 pixel-cache/prefetch behavior](https://cdrdv2-public.intel.com/824434/2024_Intel_Tech%20Tour%20TW_Xe2%20and%20Lunar%20Lakes%20GPU.pdf) prevents that blanket inference. Mobile tile benefits do not establish cause across unmatched AA/pixel profiles. No bandwidth or hardware ceiling was measured.

ComputeB/renderA with an added frame of latency does not magically overlap commands submitted to this one WebGPU queue. Shared alive/indirect/respawn dependencies remain, even with two particle states. Actual overlap and effect latency require a controlled exact-build test; no queue/resource change is included in density ABBA.

## Awake first-window result and retirement audit

The immutable [awake-v1 report](../test-results/afterlight-phone-density-abba-phone-density-awake-v1-2026-10-13T211531613Z/report.json) contains **only the first A/DPR2 window**. It does not contain B, B or the final A, so it cannot establish a density effect. The executed runner copy and its eleven-helper hash manifest remain in that run's `repro` directory; runner SHA256 is `f37cc523de2f1cca047f3353bfc86e882d59174f54a9fd76b8cc442c89a8a935`.

| First A observation | Recorded result |
|---|---|
| Actual window | 2026-10-13T21:15:57.807Z–21:16:07.901Z; measurement clock elapsed10,068ms |
| Original returned renders / native submits / command buffers | 558 /558 /558;55.423Hz; zero failed/unpaired renders or VFX dispatch/uniform mismatches |
| Returned-render gaps | median16.8ms, p9531.1ms, p9934.3ms, max37.1ms;32/557 gaps>25ms and17>33.333ms |
| One-second rate range |47.971–60.703Hz; first five51.772/47.971/50.959/49.890/54.150Hz, last five59.330/60.703/59.559/60.420/59.412Hz |
| Native foreground | Before/after Default input desktop, exact owned browser PID43040. All41 watcher samples also Default/43040; first21:15:57.6586074Z, last21:16:08.1437588Z bracket the window; maximum QPC sample gap345.237ms; UUID stop matched |
| Scene and application pixels | Authored phone branch, full1M indirect count before/after, sampling1×, engineDPR1, CSS/canvas/native canvas texture1432×768; fixed camera/time; focus emulation disabled |
| Device / allocations | Actual features depth32float-stencil8 plus core-features-and-limits; no timestamp query. Timed query/buffer/texture/pipeline/shader allocation deltas all zero |
| Resource retirement | One owned device destroyed once, zero tracked live textures/buffers, no recorded deviceLost/GPU errors |

Browser.getBrowserCommandLine confirmed `--force-device-scale-factor=2`, `--enable-automation`, the exact owned `--user-data-dir`, `--remote-debugging-pipe`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, and `--disable-features=CalculateNativeWinOcclusion`. The accepted command line contains a separate Playwright default `--disable-features=...` argument as well; acceptance is not a proof of how duplicate feature-list switches were combined internally. There was no disable-frame-rate-limit, disable-gpu-vsync, fake-vsync or shader-debug-symbol flag. The full command line is retained in the report and chrome://gpu text. Chrome was155.0.8059.40. CDP normal-window bounds were1448×902 at(10,10); native root DPI192/client1435×895 and visible child clients1432×768 were recorded. These are not DXGI swapchain dimensions. Render/submit cadence is not physical presentation or scanout cadence.

Shutdown chronology is ordered but not individually timestamped: the validated window and stopped-loop readbacks completed; native foreground after-check was21:16:09.9692542Z; tracked GPU resources retired; `context.close()` exceeded the runner's10,000ms wait; the following `browser.close()` call fulfilled and set `browserClosed:true`; the targeted native check still found11 matching PID/start-time identities, including browser43040. The next condition was refused. Preview closure was recorded and the original report finished21:16:26.390Z with context-close and native-proof cleanup errors. `browserClosed:true` therefore records that API call's fulfillment, **not** native-process absence. Root's separate [late cleanup observation](../test-results/afterlight-density-awake-v1-late-cleanup.json) at22:02:28.708Z contains no remaining exact owned PID identities. It does not identify their exit time/reason or convert the partial ABBA into a completed comparison.

The installed Playwright1.64.0 source makes the ownership distinction concrete. [Chromium context doClose](../node_modules/playwright-core/lib/coreBundle.js#L40162) returns `close-browser` for its persistent/default context; [server context close](../node_modules/playwright-core/lib/coreBundle.js#L53322) then closes that browser. A second runner `browser.close()` is redundant. [Browser close](../node_modules/playwright-core/lib/coreBundle.js#L54113) guards repeated initiation with `_startedClosing` and waits for disconnection when still connected. The runner's [bounded helper](../test-results/afterlight-phone-density-abba-phone-density-awake-v1-2026-10-13T211531613Z/repro/afterlight-cadence-http-readiness.mjs#L6) is Promise.race and does not cancel the original context-close promise when its timer rejects.

The exact installed [DEFAULT_PLAYWRIGHT_TIMEOUT](../node_modules/playwright-core/lib/coreBundle.js#L4733) is30,000ms. The [browser-process closeOrKill implementation](../node_modules/playwright-core/lib/coreBundle.js#L41244) races graceful process shutdown against `options.__testHookBrowserCloseTimeout || DEFAULT_PLAYWRIGHT_TIMEOUT`; on rejection it calls the dependency's `kill()` fallback. This is generic browser teardown, not a GPU-specific diagnosis. The private runner contains no explicit process termination, but that fact must not be broadened into a claim that its Playwright dependency can never force-close a hung owned process. No saved record proves whether this fallback caused this run's eventual disappearance.

For comparison, the general scene-profile runner uses normal `chromium.launch()` plus nonpersistent `browser.newContext()` windows: context retirement does not itself retire the shared browser. The four-window [live-scenes-v1 report](../test-results/afterlight-live-scene-default-chrome-10s-live-scenes-v1.json) shows four clean resource retirements but also a30,000ms final browser-close timeout. Its successful context retirements do not establish that persistent native browser shutdown should finish within10seconds.

Recommendation, not applied: retain one persistent-context close promise and one explicit bounded await that drains that operation, then require exact PID/start-time absence before any next launch. Remove the second misleading shutdown confirmation; record close start/settlement/disconnection separately from native-process absence. No blanket timeout increase, new wrapper, native-process kill, helper/source edit, browser run or benchmark was performed for this audit. Removing redundancy alone is not a demonstrated cure: the reason native shutdown exceeded the original bound remains unknown. Preserve the original partial result and run a separately authorized teardown check before attempting another full comparison.

## Future continuous power calibration

The current private native helper now calls read-only [GetSystemPowerStatus](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getsystempowerstatus) in each existing250ms desktop/foreground sample, including preflight, watcher readiness/terminal and window boundaries. The [SYSTEM_POWER_STATUS](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-system_power_status) layout is four one-byte fields followed by two32-bit fields:12bytes, battery-saver offset3 and lifetime offsets4/8. Offline checks compile the actual embedded C# and verify these offsets without invoking native methods.

Each future DesktopRow retains `PowerKnown`, `PowerError`, raw `ACLineStatus`, `SystemStatusFlag` and `BatteryLifePercent`. Unknown defaults are255. Acceptance requires a successful query, known online AC (`ACLineStatus=1`) and known battery saver off (`SystemStatusFlag=0`) at preflight and every native observation; missing fields, failures, offline/unknown AC and enabled/unknown saver reject acceptance. Battery percent255 remains explicitly unknown and does not independently reject otherwise proven AC/saver status. This changes measurement acceptance only and never changes Windows power settings.

Older executed helpers/reports are unchanged and lack these periodic power fields. Their foreground coverage cannot retrospectively certify uninterrupted AC or saver state. In particular, the stored22:06 awake trace records a point observation of Offline/60Hz, while the separately timestamped22:21 point is Online/120Hz. This difference does not prove that power caused an engine regression, nor establish either state throughout earlier timing windows. A future accepted run supplies periodic power calibration with the same observer coverage limitations; it does not prove a fixed hardware clock or absent thermal throttling.

## Awake compositor density ABBA — 2026-10-13

With the engine fixed at1432x768/DPR1/1x, full1M particles and authored phone scene, browser density2/1/1/2 measured **44.709 / 48.173 / 47.972 / 44.688Hz**. All4 native foreground observers pass, resources retire and exact owned PIDs are absent. Original execution exited1 at the last parity check solely because Chrome reordered its advertised-feature set; raw report is preserved. Corrected set-membership comparison passes all4 windows offline, with7/7 contract tests. Pooled browser2x **44.698Hz** vs1x **48.073Hz**, observed **7.55%** / **1.570ms** average cadence difference. This is application render/submit cadence, not isolated compositor GPU time or physical presentation. Every window has slow-frame tails; no sustained60 or startup acceptance and no quality-policy adoption. Full evidence/tails/guards/raw hashes: `test-results/afterlight-density-awake-v2-posthoc-verified.json`.

## Elevated ETW visibility and earlier density provenance — appended 2026-10-13

The fresh elevated worker PID44096 recorded active WPR at22:34:31.600UTC:
File mode, elapsed00:24:58, dropped events5,177,146. It correctly refused to
start or stop anything. That age suggests an approximate22:09:33 start, which
would overlap the22:11 awake-v2 DPR ABBA. This comparison must therefore **not
be described as an untraced baseline**. Recording identity/start continuity and
actual overlap remain provisional until elevated profile metadata or ETL time
coverage verifies them. Do not infer a causal performance penalty from this age
alone or alter the immutable four-window report and its posthoc verification.

The contradictory unelevated NOT RECORDING observation does not establish
absence of the administrator recording. The prior10s -start timeout also did
not establish failure to start: its command might have completed later. No
recording ownership is inferred from this chronology. A separate recovery save
requires explicit root authorization and matching elevated active profiles;
no global cancel is justified. Millions of dropped events also limit any later
claim of complete ETW phase coverage, even if an ETL is recovered successfully.
