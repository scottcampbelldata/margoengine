Color transform references

- AgX: Troy Sobotka's [AgX](https://github.com/sobotka/AgX) display transform with Eary Chow's parametric "AgX Base"
  formation, written for Margo from public descriptions only (no AgX code, LUT or configuration from any engine or
  application was used). Source of the parameters: Eary Chow's [AgX_LUT_Gen](https://github.com/EaryChow/AgX_LUT_Gen)
  write-up (working-space rotations and insets, the outset, the -10 to +6.5 stop log2 range around 0.18, the
  sigmoid's pivot, slope 2.4 and powers 1.5, 60% hue restoration, the lower guard rail). Steps: linear Rec.709 to
  Rec.2020 and a luminance-preserving lift of negative channels; the inset; log2 encoding; the sigmoid (a hyperbola
  t / (1 + t^p)^(1/p) on each side of grey, scaled to end at 0 and 1); the 2.4 display power; hue moved 60% back to
  the inset colour's HSV hue; the outset; Rec.2020 to Rec.709 and the guard rail again. Rec.709/Rec.2020 matrices and
  luminance weights from the ITU-R BT.709 and BT.2020 primaries and D65. `packages/tonemap/tests/agx.test.js` derives
  every matrix, weight and curve constant from those definitions and checks the shader's numbers. One implementation,
  `packages/shared/agx.js`, serves Tonemap, ImagePost and the voxel path tracer.
- ACES-style fitted curve (`curve: 'acescg'`, `packages/shared/aces.js`): Margo's own fit; no published fit's
  constants. Form: a 3x3 mix in with rows summing to 1, then per channel 1.002 * (w / (w + s))^q with w = x^k (a
  scaled Dagum, or Burr type III, distribution function: 0 at black, strictly rising, reaching display white at a
  finite input), a 3x3 mix out with rows summing to 1, then a clamp to 0..1; no extra exposure scale. Its numbers come
  from least squares, then an L^p polish toward minimax, on the error in 8-bit sRGB codes against sampled outputs (a
  grey ramp, primaries, secondaries and mixed colours) of the curve the engine used before, an approximation of the
  ACES 1.x RRT + sRGB 100-nit ODT (the Academy's [aces-dev](https://github.com/ampas/aces-dev) reference transforms).
  `packages/tonemap/tests/aces.test.js` holds that table and measures the fit: at most 1.27 codes (grey ramp 1.11,
  colours 1.27), mean 0.42 codes. It has not been measured against the Academy reference itself.
- Khronos PBR Neutral: [reference implementation](https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/pbrNeutral.glsl).
- ACEScg is AP1 with a D60 white point: [ACES specification](https://docs.acescentral.com/encodings/acescg/). The AP1 to linear-sRGB matrix includes D60 to D65 adaptation.
