# DOF and Tonemap work with the current engine

The two optional packages at their own version 1.0.0 are `@margoengine/dof` and
`@margoengine/tonemap`. Both already accept Core `^0.1.0 || ^1.0.0`. A semver audit
of all 61 package manifests found no incompatible workspace dependency/peer range
against current Core/Stage 0.1.0. Their source has no runtime engine-version gate,
and they are included in workspace builds, strict packed-consumer tests, release
checks and CI. Package version 1.0 does not require Engine 1.0.

The actual immediate-use gap was that production assembly and the package catalog
had no runnable links for these existing standalone demos. The narrow integration
now builds `/demos/dof/` and `/demos/tonemap/` from their actual published-layout
`dist` imports. Source versions, valid WebGPU/backend/capture checks, effect options
and Core/Stage remain unchanged. Costly optional effects are not added to Afterlight.

Catalog entries now link those built routes and clearly state current Core 0.1
compatibility. Their modular compiled pages require bundled assets, so the catalog
hides the complete-copyable-HTML panel for these two entries. Existing genuinely
single-file examples keep that panel. The local catalog preview serves only the
two built demo route prefixes inside its path guards. Landing-page links and
package guides provide direct discovery. Source/npm publication labels remain
accurate: no npm publication or credential change occurred.

Each demo records a complete-scene submission, GPU completion and two later
animation callbacks. `window.dofDemo` and `window.tonemapDemo` publish stage,
effect, principal count and readiness only afterward. Early pagehide aborts before
stage creation finishes and disposes a late stage without publication. Owned resize
observers and control listeners retire with the page. A narrow mobile field of
view adjustment keeps all 15 DOF spheres plus ground, or 5 Tonemap spheres plus
ground, in the narrow layout while retaining the desktop framing and all geometry.
An actual phone-layout test caught the former DOF crop (14/16 visible) before that
fix. LUT file reads preserve later Clear choices and cannot mutate a closed page.

Verification performed:

- `npm run modern:test:postfx:packages` packs current Core 0.1.0 and both optional
  packages, imports actual exports and compiles a strict consumer. Local archives
  are under `test-results/postfx-packages/`; the isolated consumer is generated
  under `test-results/postfx-consumer-*`. This is local use, not public npm proof.
- `node scripts/build-site.js` builds all current production assembly routes,
  including the two new standalone effects.
- `node scripts/test-postfx-site.js` completes six actual built WebGPU cases:
  native and Android layout for both effects, plus two held-device early-pagehide
  cases. Nonblank pixels, actual object/draw counts, controls, valid/invalid LUTs,
  late-file Clear protection, resize and cleanup pass with zero GPU/page errors.
  Every one of 198 owned buffers/textures destroys exactly once; all six devices
  retire, with no default timestamp-query allocations. Android layout uses the
  Intel Arc 140V laptop, not a physical Android GPU.
- Source catalog/preview checks pass 2/2; the catalog browser copy/link check is
  queued separately from current hardware timing. Core/Stage remains 47,934 raw /
  19,975 gzip bytes under the strict 20,000-byte limit.

The final functional run measured principal opportunities of 3,064.6 ms for native
DOF and 1,157.1 ms for native Tonemap, versus 602.5/604.3 ms in Intel phone layout.
Those native startup misses remain failures against the one-second goal. The
first pre-framing run's native DOF opportunity was 1,220.7 ms, so whole-page drift
is recorded rather than assigned a cause. These are unthrottled functional fixture
times; native cold-network load and sustained cadence are separate queued checks.
Root's production load audit now includes both routes and their exact demo globals.

Evidence: `test-results/postfx-immediate-use-site.json`, named PNGs and the
preserved phone-framing failure report; portable script is
`scripts/test-postfx-site.js`. Changes are local, uncommitted and not deployed.
Optional packages remain open in the optimization log until the independent
speed/load/quality requirements and further candidate audits are complete.

## Current optional-effect cold-load check

The current built DOF and Tonemap routes were each measured in three fresh
native Chrome contexts with cache disabled, 10 Mbps and 40 ms latency. DOF's
complete-principal median was 1553 ms and worst 1704 ms; Tonemap's median was
902 ms and worst 1327 ms. Both fail the strict worst-case one-second gate.
All browser/server processes closed and no page/GPU error was reported. These
are local built-site results on Intel Arc 140V, not hosted/mobile acceptance.
NavigationTiming and the resource waterfall are retained in
`test-results/demo-loads-native-chrome-postfx-20261013.json`.

## Current full correctness and build checkpoint

`npm run test:all` completed with exit 0 on 2026-10-13: 803 tests passed,
zero failed/cancelled/skipped/todo. The current package build and catalog browser
search/copy/link tests are included; the DOF/Tonemap current-version routes are
covered. The executed suite also includes the private Animation numerical/error
and mutation tests, without adopting its size-increasing candidates.

The test body took 50,624.6 ms after builds. Complete output is preserved in
`test-results/test-all-20261013-current.log`. Correctness/build success does not
establish steady 60 FPS, one-second principal loading, physical Android, a hosted
release or total-consumer size acceptance. All optimization statuses remain open.
