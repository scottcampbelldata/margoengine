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
- Desktop Firefox is absent from the standard Program Files locations,
  StartMenuInternet registry entries and PATH. Playwright's patched Firefox
  157.0 exists at
  `\AppData\Local\ms-playwright\firefox-1555\firefox\firefox.exe`.
  This corrects the previous handoff's claim that no Firefox binary was present.
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
families above, plus stable Firefox access or permission to repair/install it.
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
