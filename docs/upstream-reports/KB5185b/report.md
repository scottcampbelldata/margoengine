# ANGLE D3D11 (NVIDIA): sciviz atmosphere on WebGL2 differs by one step between runs (draft, no standalone repro yet)

Draft for the ANGLE issue tracker (and NVIDIA). Not filed. Margo row: KB5185b (atmosphere WebGL2 zero-cloud hash). Same family as KB5822a and
KB5247d (4x MSAA resolve on ANGLE D3D11); use KB5822a's folder when it exists.

## Environment

RTX A6000, driver 32.0.16.1742 (617.42), Windows 11, Edge 157 (ANGLE Direct3D 11), recorded in Margo's notes of 2026-11-09 to 11-11.

## Observation

The sciviz atmosphere spec demo on the WebGL2 layer gave captures that differ by one half-float step on unchanged source, under a shared GPU queue
(the zero-cloud hash of `packages/sciviz/tests/atmosphere-browser.mjs`: expected 1630307923, actual -1597066215 once). The same pictures on native
WebGPU and on ANGLE Vulkan are exact. In later reruns it did not reproduce (one full run, 8 repeats, 6 page loads, 2 parallel probes: all byte-identical),
so the cause is not proven; it signs the same way as KB5247d.

## Standalone evidence

None for the atmosphere itself. The nearest page is `../KB3508/msaa-blend-repeat.html?api=webgl2` (see `../KB3508/report.md`): repeated identical
4x MSAA frames on ANGLE D3D11 + RTX A6000 return different bytes (10 of 299 frames), ANGLE Vulkan and D3D11on12 do not.

## Result on this PC

Not re-run (a failing run must first be captured with Margo's recorder). Status: draft only; if the KB5822a report is filed, close this entry with
its outcome.
