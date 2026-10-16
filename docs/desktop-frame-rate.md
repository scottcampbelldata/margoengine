# Desktop frame-rate investigation

The earlier sections record successive historical checks. Current results are
in [Second deep package pass](#second-deep-package-pass); the shared
`test-results/deployed-bundle-integrity.json` is replaced on deployment and
now verifies only the current build. Gzip figures in this note are from these checks. The current build measures core at 18,192 bytes gzip and core plus stage at 19,999 bytes gzip. The gate rejects 20,000 bytes or above.

The user reported approximately 60 FPS on mobile and 19–30 FPS on multiple
desktop PCs and browsers after loading-time work. The screenshot's measured
browser callback cadence was 19 Hz. Callback cadence alone cannot distinguish
GPU backpressure from browser/display pacing.

The shared engine now caps desktop drawing-buffer DPR at 1, retaining 4× scene
MSAA. Previously DPR 2 combined with 4× MSAA used 16 attachment samples per CSS
pixel; the new policy uses 4. Fragment shader invocation counts do not necessarily
scale with MSAA sample counts. CSS sizing, page zoom and DOM overlay density are
unchanged. Phones retain single sampling and their DPR 2 cap. No core/stage API
or rendering feature was added.

Demo entry points also restore their complete-scene startup paths. Deferred
effect initialization, startup presentation waits and scene fades are no longer
used. Earlier phone assets and rendering-detail reductions remain. Reverted
working copies are preserved under `test-results/loading-rollback-backup/`.
This rollback does not establish which loading change caused the reported drop.

## Local GPU comparison

Edge 155, Windows, NVIDIA RTX A6000, hardware WebGPU, 1440×731 CSS viewport.
Each demo initializes its desktop geometry, textures and 4× MSAA in both cases.
Only the backing-density policy changes. The diagnostic manually pumps frames
to separate GPU work from the local Remote Desktop callback limit, warms GPU
work for 600 ms, then records 24 frames and discards the first four. GPU pass
timestamps are quantized, so these short durations are approximate.

| Demo | Previous backing size | New backing size | GPU work, previous | GPU work, new | Reduction |
| --- | --- | --- | ---: | ---: | ---: |
| Night Citadel | 2880×1462 | 1440×731 | 1.638 ms | 0.655 ms | 60% |
| Earth | 2240×1462 | 1120×731 | 0.393 ms | 0.131 ms | 67% |
| Damaged helmet | 2260×1462 | 1130×731 | 0.786 ms | 0.262 ms | 67% |
| Windy meadow | 2880×1462 | 1440×731 | 1.245 ms | 0.459 ms | 63% |

Raw data and the diagnostic are `test-results/gpu-diagnosis.json` and
`test-results/gpu-diagnosis.mjs`. These are local GPU-work comparisons, not
physical-display FPS measurements or measurements on the user's other PCs.

## Verification

- All 543 repository unit tests pass, including desktop/phone WebGPU and WebGL buffer
  dimensions; desktop DPR 1 and fractional DPR are covered.
- Citadel's hardware browser regression confirms device DPR 2 → drawing DPR 1,
  six allocated 4× attachments, and complete disposal. Its emulated phone retains
  DPR 2, with no multisampled attachments or pipelines.
- Citadel's controlled uncapped browser reaches about 59.5 FPS at the 60 target
  and 120.3 FPS at the 120 target. Native callbacks on this Remote Desktop host
  remain about 32 Hz; the user's direct-screen results remain to be retested.
- Citadel's sliders, displaced ocean waves, particles, lighting, resize and
  mobile gestures pass. Captured spires and ocean remain visible. Static images
  do not establish the absence of specular shimmer during motion.
- Afterlight's browser checks pass, including phone sampling, lighting,
  terrain/water HDR output and GPU restoration. Its 10 unit tests also pass.
- Production castle, helmet and explorer pixel checks pass, with DOM overlays
  hidden. The visible-frame audit rejects clears and unrelated offscreen draws.
- Package and production-site builds pass. Core plus stage measures 19,988 gzip
  bytes; CI continues rejecting 20,000 bytes and above.

The additional size reduction is 11 gzip bytes compared with the 19,999-byte
DPR build: 9 bytes from optional GLSL whitespace and 2 from extending the existing
private-member alias alphabet to uppercase letters. GLSL token sequences and
the required version-directive newline are preserved; WGSL text, shader math,
public members, checks, error messages and runtime operations are unchanged by
these two compaction changes. The build rejects private aliases that collide
with public members, including uppercase members.

The final local production build passes all seven desktop demo checks using Edge
155 on the hardware NVIDIA RTX A6000 at device DPR 2. Backing DPR remains 1 and
4× color/depth attachments remain active after resize. Complete scene captures,
controls and pagehide disposal pass with no browser, GPU or asset-loading errors.
The reusable check is `node scripts/desktop-demo-tests.js`; its report is
`test-results/desktop-demos-local.json`. WebGPU and WebGL stage rendering,
picking in both sampling modes, and Citadel's desktop/phone checks also pass.

Deployed on 2026-10-12 to Cloudflare Pages production (`main`):
`https://dc60fa82.margoengine.pages.dev`, also served at `https://margoengine.com`.
All seven live demo entry scripts and all 29 deployed JavaScript files match the
final local build in that deployment's integrity check.
All seven routes also pass the full strict desktop suite on the immutable
deployment URL, with zero browser, GPU or network errors, preserved 4× attachments
after resize and complete pagehide cleanup. Its report and scene/UI captures are
`test-results/desktop-demos-deployment.json` and `test-results/desktop-demos-deployment-*.png`.

The custom-domain desktop retest confirms all seven complete scenes, controls,
resizing, native DOM density, DPR 1 backing, active 4× MSAA and complete GPU
cleanup. It records no GPU errors or failed demo assets. Its strict browser/network
assertion does record Cloudflare's externally injected analytics beacon failing
DNS: this desktop's configured DNS resolves `static.cloudflareinsights.com` to
`0.0.0.0`. This failure remains visible in
`test-results/desktop-demos-production.json`; no DNS settings or analytics features
were changed. It does not prevent rendering or controls.

Native callback cadence remains approximately 31–32 Hz on this Remote Desktop
host. The live retest does not establish the original slowdown's cause or FPS on
the user's other PCs. Dynamic resolution or an adjustable density scalar would be
separate work under the v1.0.0 core freeze.

## Follow-up regression audit

Git history identifies two shared increases in desktop GPU work: `4aab554`
introduced 4× core MSAA, and `f4f1f31` extended multisampling through HDR scene
targets. Phones remain single sampled. These are plausible regression candidates;
the audit has not established which change caused the reported slowdown on the
same PCs. No shared frame-rate throttle, steady-state GPU wait, or new kernel
math change was found.

The follow-up changes remove four empty dynamic-shadow passes when all casters
are static and batch opaque/MASK PBR draws into one pass. Transparent beauty and
ambient draws retain their original separate pass boundaries: combining them
changed attachment-store rounding in the first candidate. The final candidate
matches the baseline exactly in the hardware beauty/SSAO pixel fixtures, with
4× sampling preserved. A tiny four-primitive benchmark measures lower CPU
encoding cost but no GPU-time improvement above timestamp quantization; this
does not establish an FPS improvement for the demos.

Optional feature entries preserve the existing whole-pack APIs and constructor
identities. Meadow and Earth now import their individual creative features,
removing 10,750 and 10,124 gzip bytes respectively from their initial local
bundles. Selecting only SSAO from the demo's dynamic post import removes another
867 gzip bytes from Meadow, while adding 24 bytes to each model page's initial
shared chunk and reducing their complete code closures by 861 bytes. Core plus
stage remains at 19,997 gzip bytes. The gate still rejects
20,000 bytes and above. All 581 unit tests and strict packed consumers for all
61 packages pass.

All seven final local and deployed desktop checks pass rendered-scene, control,
resize, native DOM density, 4× attachment and complete GPU-disposal assertions.
Production deployment `https://6226415f.margoengine.pages.dev` also serves at
`https://margoengine.com`; seven live entries and all 47 JavaScript files match
the local build. Reports are `test-results/desktop-demos-performance-final-local.json`,
`test-results/desktop-demos-performance-final-deployment.json`.

Source coverage and manual-review limits are recorded in
`test-results/perf-audit-coverage-core-review.json`,
`test-results/optional-render-source-audit.json` and
`test-results/perf-bundle-closure-verified-final.json` and
`test-results/perf-demo-audit-manifest.json`. This audit does not claim semantic
verification of every parser/math branch. Native callbacks on this host remain
about 31 Hz, including a blank page. Stable 60 FPS on the affected physical PCs
and the common slowdown's root cause remain unverified.

The combined inventory in `test-results/perf-audit-combined.json` accounts for
all 257 non-generated package runtime TypeScript/JavaScript, WGSL and Rust files;
each contributing report distinguishes structural review from manual source
review. Generated Wasm blueprints are verified losslessly by the package build.

## Complete package follow-up

The [package optimization audit](package-optimization-audit.md) records the later
full authored-file review across all 61 package manifests plus Kernel/shared,
compatible allocation/cache/parser/lifecycle fixes and narrower optional imports.
Core + Stage remains 19,997 gzip bytes. All 627 repository unit tests and all 61
packed consumer checks pass. The seven rebuilt and deployed desktop demos pass
rendering, controls, resize, 4× attachment and complete cleanup checks.

That pass deployed to `https://240fa177.margoengine.pages.dev`,
also served at `https://margoengine.com`; seven entries and 47 JavaScript files
match the tested build. This pass does not establish locked 60 FPS on the
affected physical PCs or prove the original common slowdown's cause.
## Second deep package pass

The final second audit covers all 734 visible package files across 61 manifests
plus Kernel/shared. It fixes reproduced allocation, cache, parser, cancellation
and lifecycle defects while retaining optional imports, features, shader math
and the existing density/sampling policy. Core + Stage measures **19,999 gzip
bytes / 47,983 raw bytes**. All **754 unit tests**, all 61 strict packed consumers,
28 sequential native browser programs and eight depth-format/sample combinations
pass. See [the current package audit](package-optimization-audit.md#second-deep-pass-2026-10-12)
for source coverage, changed diagnostic text and fixture-specific limits.

The current production deployment is
[73cbd49f](https://73cbd49f.margoengine.pages.dev), also served at
[margoengine.com](https://margoengine.com). All seven local and live demo suites
pass complete scenes, controls, resize, native DOM density, active 4× attachments
and complete GPU cleanup. Seven entries and all 47 deployed JavaScript files
match the tested build. Reports are
`test-results/desktop-demos-deep-second-local.json`,
`test-results/desktop-demos-deep-second-deployment.json` and
`test-results/deep-deployed-bundle-integrity.json`. One live startup run reports
first-frame times from 537 to 1,160 ms; this is not a network-independent guarantee.

The user confirms this machine is accessed through RDP. The final native timing
control reaches 31.62 Hz on a blank page, and all seven live demos have about
32 Hz callbacks. Microsoft documents frame-rate limits in Windows remote
sessions, including some RDP configurations:
[Microsoft Learn](https://learn.microsoft.com/en-us/troubleshoot/windows-server/remote/frame-rate-limited-to-30-fps).
Remote presentation can therefore limit the displayed FPS even when engine work
fits a 60 Hz budget. This does not establish the cause of the originally
reported regression on other PCs.

The final hardware timing run measures CPU callback medians of 0.20–0.60 ms
and GPU pass-span medians of 3.21–7.41 ms. All 12 sparse samples per demo are
below 16.67 ms in this run. The full table, timing-method limits and raw-report
reference are in [the current CPU/GPU measurements](package-optimization-audit.md#current-deployed-cpugpu-measurements).
These measurements retain native frame scheduling and do not establish sustained
60 FPS on a physical display. Confirming that outcome requires a browser test
on a PC's physical display outside RDP.
