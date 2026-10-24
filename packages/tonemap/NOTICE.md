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
- ACES RRT/ODT fitted curve: [Stephen Hill](https://github.com/selfshadow/ltc_code/blob/master/webgl/shaders/ltc/ltc_blit.fs), with no extra exposure scale.
- Khronos PBR Neutral: [reference implementation](https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/pbrNeutral.glsl).
- ACEScg is AP1 with a D60 white point: [ACES specification](https://docs.acescentral.com/encodings/acescg/). The AP1 to linear-sRGB matrix includes D60 to D65 adaptation.
