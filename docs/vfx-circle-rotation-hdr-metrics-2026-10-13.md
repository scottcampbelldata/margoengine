# Private circle-rotation HDR diagnostic

The fresh native headless comparison records **large local HDR differences and changed particle-contribution footprints**, with an exact original A/A control. It does not support calling the rotation removal a harmless floating-point change. The previous strict failure remains a failure; no visible-quality acceptance threshold or production adoption was inferred.

The prior frozen raw `test-results/vfx-circle-rotation-quality-viewport-fixed-v2.json` reported9,514 differing HDR samples and zero depth differences at native yaw0. Its SHA `9c46820e72a1470f40949efa008820078c9e7cdf6ec812263155f2c35472380d`, original frozen helper SHA `22ae19d3814721b81941606508d330660569cc25f5442637d9f01f96ec6d568a`, and all original helper/raw bytes remain unchanged. That run did not retain decoded pixel words. The new run uses a fresh initialized native snapshot, so its9,661 differences cannot retrospectively assign magnitudes to the old9,514 exact locations.

`test-results/prepare-vfx-circle-metric-fixture.mjs` derives a guarded separate copy of the same frozen helper/launcher. It preserves the three native yaw views and eight synthetic bounds cases, adds one third original draw for A/A using identical state/order/background, and decodes the existing packed rgba16float+depth readback. Only the diagnostic copy continues after differences; each case explicitly records `exactGatePassed:false` when applicable and `qualityAcceptance:unassessed`. The default strict helper is untouched. The timing branch is removed, and no new renderer/framework was added. Five offline metric/copy checks passed before the authorized launch.

Executed command: `node test-results/vfx-circle-metric-fixture.mjs diagnostic metrics-v1 --run`. Native Intel `xe-2lpg`, fallbackfalse, headless Chrome155.0.8059.40, no custom GPU/shader-debug/window flags. Actual island canvas1432×768, engineDPR1, unchanged1M particles, nativeHDR4, terrain73,728 triangles, grass110,000, shadow1024, water256. Original billboard shader SHA `248709e18693f197cd0facd671d190942d624f01e72f410dce74d31406106ef2`; rotation-removal shader `6269d72a49b5863f0c1e3224fa35c85a57fc1b63d4aedc09f312fe616f15bb66`. Circle fixture keeps its existing canonical live order to isolate vertex/raster differences; it is not field-write/compaction atomic-order image proof.

## Measured error and coverage

Every HDR/depth sample was compared and every differing sample's index plus old/new packed RG/BA/depth words is stored in the raw report. IEEE binary16 decoding handles normal, subnormal, signed zero, infinity and NaN explicitly. Absolute errors below are in **linear HDR channel units**, before display tone mapping. Mean-all includes every finiteRGBA channel; mean-changed includes only finite channels with nonzero decoded error. Untouched background dominates the whole-frame mean, so it must not substitute for error on affected particles.

| Case | MSAA | HDR samples different | Maximum channel error | Mean all channels | Mean changed channels | Contribution lost/gained |
|---|---:|---:|---:|---:|---:|---|
|Native yaw0°|4|9,661|4.569336|0.000144548|0.0835834|625 /639|
|Native yaw90°|4|8,598|4.346199|0.000121725|0.0815259|530 /591|
|Native yaw180°|4|3,062|2.710236|0.000005125|0.0095291|96 /88|
|Perspective bounds|1|12,124|0.00390625|0.000012115|0.0005165|0 /0|
|Oblique-w bounds|1|5,903|0.00390625|0.000008318|0.0007207|0 /0|
|Orthographic bounds|1|30,509|0.0078125|0.000049934|0.0006954|0 /0|
|Large-coordinate bounds|1|57,939|0.0078125|0.000109992|0.0008202|0 /0|
|Perspective bounds|4|48,688|0.00390625|0.000012218|0.0005182|0 /0|
|Oblique-w bounds|4|23,626|0.00390625|0.000008330|0.0007213|0 /0|
|Orthographic bounds|4|122,444|0.0078125|0.000050205|0.0006947|45 /7|
|Large-coordinate bounds|4|231,772|0.0078125|0.000109976|0.0008201|0 /0|

Original A/A has **zero HDR and depth differences in all11 cases**. Candidate depth also has zero differences and decoded depth error in all11. No nonfiniteHDR/depth values occurred. Candidate strict HDR equality fails in all11. Native yaw0 has3,584 changed pixels out of1,099,776, spread over9,661 MSAA samples. Original/background-relative contribution count is9,670 versus candidate9,684 (net+14, comprising625 lost and639 gained); yaw90 is8,881→8,942; yaw180 is3,208→3,200. Nonzero RGB/RGBA totals include the already-lit background and do not change in these cases. Contribution here means packed color differs from the identical restored background; it is observable radiance contribution, not a dedicated geometric raster coverage mask. Near-zero contribution/FP16 rounding can affect this proxy.

These measurements separate native sparse/subpixel behavior from synthetic large billboards, where maximum errors are much smaller. They do not supply a display-referred perceptual metric, final post-processing screenshot, or user-approved tolerance. Mathematical radial symmetry alone does not establish equal sampled/rasterized output. The candidate remains unadopted pending a concrete preserved-quality assessment; no speed result was collected.

## Boundaries and cleanup

No timing queries were created. Ninety startup/capture RAF callbacks were counted only, without timestamps/cadence or a foregroundFPS claim; app loop was stopped for captures. Headless rendering/readback does not measure physical presentation, and the desktop/screensaver was not switched/dismissed. External GPU load cannot turn exact A/A/control image comparisons into a performance baseline.

Run exitedzero with no page/GPU/compile/validation/cleanup error. The owned device retired exactly once, browser/server closed, and all seven exact CDP-owned PIDs were absent in native query-only cleanup proof. Raw with frozen executed helpers and all sparse differences: `test-results/vfx-circle-metrics-diagnostic-metrics-v1.json`; full stdout `.log`; compact immutable `test-results/vfx-circle-metrics-diagnostic-metrics-v1-summary.json`, appended to the cross-run JSONL. Its source/fixture provenance differs from field-write compute proof and from the published older live ping-pong build. No package/public-source/Core change occurred.
