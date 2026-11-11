# Batch 273 job 2: browser and device evidence still required

This is the acquisition checklist for the coordinator. Job 2 stays open until
the actual browsers/devices run the matrix and every refusal or difference has
a receipt. Installation and a WebGL2 clear/readback do not prove package parity.
The 26 full-tier failures and T273-COVERAGE precede the full matrix execution.

## Required cells

Use the current stable browser and OS on each supplied device and record their
exact versions at execution. No specific commercial device model was named in
the brief; select models by the GPU/extension requirements below and record the
actual model. These are the concrete cells to obtain:

| Cell | Browser | Device and OS | Needed evidence/access |
| --- | --- | --- | --- |
| W-CH | Google Chrome | This Windows 11 x64 PC, RTX A6000; integrated AMD as a separate adapter row | Local installed browser; control and full/forced half-float/LDR runs |
| W-ED | Microsoft Edge | Same Windows PC, each adapter recorded separately | Local installed browser; independent Chromium control |
| W-FF | Firefox stable | Same Windows PC | Actual stable Firefox installation/driver for the release row; bundled patched Firefox is a separate supplemental row |
| M-SA | Safari stable | A real Mac with supported macOS and Apple GPU | Scott supplies Mac access or a real-device farm session; Safari/safaridriver and GPU/OS versions |
| I-SA | Safari | A real iPhone with supported iOS and Apple GPU | Scott supplies device or real-device farm session; mobile context, touch, orientation and loss/restore receipts |
| P-SA | Safari | A real iPad with supported iPadOS and Apple GPU | Scott supplies device or real-device farm session; tablet canvas/viewport and loss/restore receipts |
| A-AD | Chrome stable | A real Android phone/tablet with Qualcomm Adreno GPU | Scott supplies device + USB debugging/ADB or real-device farm session; exact Android/Chrome/driver versions |
| A-MA | Chrome stable | A real Android phone/tablet with Arm Mali GPU | Same access; separate mobile driver family and extension limits |

Across the physical mobile/Apple rows, obtain a device exposing only half-float
colour targets and one exposing only LDR targets if those are part of the
supported hardware population. Record a missing physical tier as missing,
without substituting forced extension masking. Run all three forced tiers on
each capable device as additional correctness evidence. A physical device that
cannot create WebGL2 must produce a measured refusal, not a passing render row.

Each row needs: UA, browser/OS/device/GPU/driver, WebGL renderer and extension
list, tier selected, full package/entry coverage including T273-COVERAGE,
unchanged image/numeric checks, attach-time refusal code/message, accepted
differences and their causes, error scopes, loss/restore and resource cleanup.
Record native WebGPU separately where available. Keep Bug 45's tracer work with
lane-U. Job 4's speed measurements remain deferred during the build phase.

## Actual local inventory, 2026-11-09

Windows 11 Pro x64 10.0.26300. Installed GPUs: NVIDIA RTX A6000, driver
32.0.16.1742; AMD Radeon(TM) Graphics, driver 32.0.21042.62. Driver and adapter
capabilities still need per-browser receipts; availability does not prove that
a particular browser selected that adapter.

- Chrome 157.0.8103.38 exists at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- Edge 157.0.4341.42 exists at
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.
- Shipped Firefox159.0.1 is now runnable through WebDriver BiDi. Its executable is supplied only by environment variable; no installed path is committed. The older patched-browser loader refusal remains historical evidence below.
- Playwright Chromium 1248/headless-shell 1248 are installed, supplemental only.
  No Playwright WebKit directory, `adb` or `safaridriver` was found locally.
  No connected physical Android or Apple device/farm access has been established.

Local clear/readback receipts confirm Chrome and Edge can execute real WebGL2
on the RTX A6000/D3D11 route. Both report versions matching the installed files,
zero GL errors and the exact endpoint pixel [255, 0, 255, 255]. Patched Firefox
157.0 is present but cannot launch: Playwright reports `spawn UNKNOWN`.
Its PE file is x64 (machine 0x8664), 1,140,736 bytes, with an MZ signature;
architecture mismatch is not shown. No Firefox render pass is claimed and no
browser was installed or repaired. The raw receipt is
`test-results/batch-273-browser-inventory.json`; the inventory process exits
nonzero for the Firefox refusal. An initial mid-range clear probe asserted an
unjustified exact quantization value (expected 128, observed 127 with default
dithering); it is retained as a failed diagnostic. The availability receipt
uses exact endpoint colours instead and makes no mid-range accuracy claim.
Windows viewport/UA emulation cannot certify iOS, iPadOS or Android GPU drivers;
Playwright WebKit cannot certify Safari.

The coordinator should request the real Mac, iPhone, iPad and both Android GPU
families above, with the Firefox scoped row now measured below.
Physical lower-tier hardware and the integrated AMD browser rows are still
unmeasured. Chrome and Edge availability is not a completed matrix row.

## Sources and clean-room boundary

Microsoft / Playwright contributors, *Browsers* and *Emulation* (2026),
https://playwright.dev/docs/browsers and https://playwright.dev/docs/emulation:
bundled patched Firefox, branded channels and device-parameter emulation are
different evidence from the shipped platform browser on a physical device.
Khronos WebGL Working Group, *EXT_color_buffer_float* (2016) and
*EXT_color_buffer_half_float* (2022),
https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/ and
https://registry.khronos.org/webgl/extensions/EXT_color_buffer_half_float/:
32-bit and 16-bit renderability are distinct capabilities. Combine actual
extension inventories with physical devices and forced-tier correctness, rather
than inferring physical tier coverage from a desktop result. The matrix is an
evidence plan, without a new performance or rendering claim. No rival source
or paper companion implementation was read.

Apple, *Enable WebDriver on macOS* and *WebDriver* (2026),
https://developer.apple.com/documentation/safari-developer-tools/macos-enabling-webdriver
and https://developer.apple.com/documentation/safari-developer-tools/webdriver:
Safari automation needs the Apple driver; iOS/iPadOS use a connected Mac.
Microsoft / Playwright contributors, *Android* (2026),
https://playwright.dev/docs/api/class-android: Android automation needs an
authenticated ADB connection. Request that access with the physical devices.

### Read-only Firefox spawn UNKNOWN diagnosis

Direct hidden Process.Start of the installed Firefox with --version also fails
before execution: Windows native error 14001, incorrect side-by-side configuration.
Application/SideBySide event 33 names missing dependent assembly mozglue 1.0.0.0.
Both executable and DLL are x64. The executable's RT_MANIFEST ID 1 requires
mozglue; mozglue.dll embeds its assembly manifest only at ID 2, and no external
mozglue.manifest is installed. Microsoft's [Assembly Searching Sequence](https://learn.microsoft.com/en-us/windows/win32/sbscs/assembly-searching-sequence)
requires resource ID 1 for a private assembly DLL. Thus the installed browser's
manifest packaging explains this loader refusal and Playwright's generic spawn
UNKNOWN, before renderer/GPU startup. The [resource documentation](https://learn.microsoft.com/en-us/windows/win32/sbscs/using-side-by-side-assemblies-as-a-resource)
distinguishes IDs 1 and 2. No installation, binary, registry or setting was changed;
that historical diagnostic claimed no Firefox pixel pass. Evidence with hashes, resource IDs, manifest
text and event: docs/whitepaper/results/batch-273-firefox-diagnosis.json.

## Shipped Firefox row, completed under rule22

Shipped Firefox159.0.1 now passes full/forced16F/forcedLDR device numeric checks, the scoped10-scene lower-tier package grid and destroy-after-submit checks. Its default native WebGPU adapter is null. All46 feature/ordinary-compute/strict-CSP cases execute on Firefox compatibility against native Chromium references with unchanged tolerances. The final corpus draws733 render pipelines, dispatches477 compute pipelines and rejects one intended invalid10-storage-binding pipeline on an8-binding device. Initial eleven-driver failures are retained, not relabeled: seven drivers require unavailable native Firefox WebGPU; the original corpus reached an extra transport bound before the repaired final replay passed.

Receipt: docs/whitepaper/results/batch-273-firefox-matrix.json. This closes the requested scoped Firefox work under rule22, with native adapter availability and full-package/physical-device certification remaining in finish-later.md. The overall physical browser/device matrix remains open. No local binary path, patched-browser substitution or forced-tier-as-hardware claim.

## Firefox package certification rerun (KB5076)

Each package suite is rerun alone on Firefox (`MARGO_BROWSER=firefox node scripts/gpu-package-tests.mjs --no-build --only=<suite>`, 3 GPU slots), from a clean head equal to `origin/main`. Failures found so far and how they closed:

- KB-FF2, cache `test:browser`: the service worker step failed with "NetworkError when attempting to fetch resource" on every Firefox run. Cause: Playwright's Firefox offline mode (`context.setOffline`) cancels a page request before the service worker sees it; a diagnostic log in the worker showed no fetch event offline, while the same restarted worker answered the same range online. The step now makes the network fail under the worker by dropping every connection at the test server, which is the same failure on every browser. It asserts that no byte came from the server and that the worker tried the network at least once (browsers retry a reset idempotent request 5 to 10 times). Test: `packages/cache/scripts/test-browser.js`; passes on Firefox, Chromium and WebKit.
