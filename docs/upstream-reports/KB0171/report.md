# AMD RDNA2 (Windows, D3D12 and D3D11): fixed-function blend `one, one-minus-src` on rgba8unorm lands off the rounded exact result

Draft for AMD (driver feedback) with notes for Dawn and ANGLE (the same bytes through both APIs). Not filed. Margo row: KB0171
(Radeon 680M, `screen` blend in the pixel package).

## Environment

- Margo's record: Radeon 680M (RDNA2), driver 32.0.21030.2001, Chrome on D3D12.
- Reproduced on this PC (2026-11-11): AMD Radeon (Raphael iGPU, RDNA2, device 0x13C0), driver 32.0.21042.62, Microsoft Edge 157.0.4341.42,
  Windows 11, WebGPU (Dawn D3D12) and WebGL2 (ANGLE D3D11). Control on the same PC: NVIDIA RTX A6000, driver 32.0.16.1742.

## Steps

1. Serve this folder over `http://localhost` and open `screen-blend.html?api=webgpu` (also `?api=webgl2`), choosing the AMD adapter
   (`?gpu=low-power` where the browser maps it to the iGPU; on Windows, Chromium's `--use-adapter-luid=<high>,<low>` picks it exactly).
   Or: `node docs/upstream-reports/run-page.mjs docs/upstream-reports/KB0171/screen-blend.html --luid=<high>,<low> --query="api=webgpu"`.
2. The page clears four rows of an rgba8unorm target to destinations 16, 100, 200 and 250, then draws source values 0 to 255 (one per column)
   with blend colour `srcFactor one, dstFactor one-minus-src, add` (screen).

## Expected

The result is `s + d * (255 - s) / 255`. No whole-byte pair gets within 1/510 of a rounding tie, so a unit that blends in float
(or a wider format) and rounds to nearest returns exactly `round(s + d * (255 - s) / 255)` for all 1024 pixels. For s = 151 and d = 16:
157.5255, so 158.

## Actual

| GPU / API | pixels not equal to the rounded exact value (of 1024) |
|---|---|
| AMD RDNA2 iGPU, WebGPU (D3D12) | 19 (16 one lower, 3 one higher); first: s 151, d 16, got 157, want 158 |
| AMD RDNA2 iGPU, WebGL2 (ANGLE D3D11) | 19, same first pixel |
| NVIDIA RTX A6000, WebGPU and WebGL2 | 0 |

The failing pixel is the one Margo's test found on the Radeon 680M (157 where the CPU model gives 158), so this is the same behaviour on another RDNA2 part.
It looks as if the destination product `d * (1 - s)` is rounded to a byte before the add.

WebGPU leaves blend arithmetic precision undefined, so this may be within the specification; the report asks the vendor whether the blend unit's
intermediate rounding is intended, and whether a more precise path exists. The WebGPU/WebGL2 APIs have no way to ask for it.

## Result on this PC

Reproduces on the AMD iGPU (19 pixels, 2026-11-11). Margo does not work around it (no extra pass or copy; the test's tolerance is unchanged).

## Files

`screen-blend.html` (the repro, no libraries), `../run-page.mjs` (optional Playwright driver).
