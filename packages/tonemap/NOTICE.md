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
- White balance (`temperature`, `tint`): the Planckian locus in CIE xy by the cubic-spline fit of Kim, Kang, Lee, Kim
  and Lee, "Design of advanced color temperature control system for HDTV applications", Journal of the Korean Physical
  Society 41(6), 2002 (unread here; its coefficients from the record), and a von Kries adaptation in the linearised
  Bradford cone space. The Bradford matrix is K. M. Lam's (PhD thesis, University of Bradford, 1985; unread here), as
  printed in S. Suesstrunk, J. Holm and G. D. Finlayson, "Chromatic adaptation performance of different RGB sensors",
  Proc. SPIE 4300, 2001 (https://infoscience.epfl.ch/record/34049, read), which compares von Kries in the cone,
  Bradford, Sharp and CMCCAT2000 spaces with von Kries applied directly to Rec.709 RGB (worse) on corresponding-colour
  data. Written for Margo from those descriptions.
- ACEScg is AP1 with a D60 white point: [ACES specification](https://docs.acescentral.com/encodings/acescg/). The AP1 to linear-sRGB matrix includes D60 to D65 adaptation.
- Contrast about 18% grey (`contrast`): display-linear 0.18 (x / 0.18)^k, a gain of k in log2 exposure about the
  pivot, which is what a contrast control does in a logarithmic grading encoding such as ACEScc
  ([Academy S-2014-003](https://docs.acescentral.com/encodings/acescc/): ACEScc is log2-based, so scaling its values
  about the pivot's code is a power in linear light) and the ASC CDL's power about a pivot (American Society of
  Cinematographers, ASC Color Decision List v1.2, 2009). Written for Margo from those definitions. A power keeps
  black at black and never clips it, where the linear form used until 2026-11-14 clipped everything below
  0.18 (1 - 1/k).
- Output dithering (`dither`): triangular-PDF noise of one code value either way, added to the encoded value just
  before quantisation and changing every frame, from M. Gjoel, "Banding in Games: A Noisy Rant", GDC 2016
  ([slides](https://loopit.dk/banding_in_games.pdf), read), which recommends triangular noise over [-1, 1) code values
  for GPUs that round; the reason triangular noise removes noise modulation is S. P. Lipshitz, R. A. Wannamaker and
  J. Vanderkooy, "Quantization and Dither: A Theoretical Survey", J. Audio Eng. Soc. 40(5), 1992 (from the record, not
  read). Narrowing the noise near 0 and 1 so black and white stay exact is Margo's own choice. Written for Margo.
- `.3dl` LUTs (`@margoengine/tonemap/3dl`): the layout from Autodesk's product help, "Formatting 3D LUTs" (Smoke 2011,
  download.autodesk.com/us/systemdocs/help/2011/smoke) and the Lustre 2011 3D LUT file format page
  (download.autodesk.com/us/systemdocs/help/2011/lustre), both read: the input code line, blue varying fastest, the
  `3DMESH` and `Mesh <input bits> <output bits>` header. Written for Margo; no reader or writer code was consulted.
- White point, toe and shoulder (`whitePoint`, `toe`, `shoulder`; `shapeCurve`): J. Hable, "Filmic Tonemapping Operators" (filmicworlds.com, 2010) and "Uncharted 2: HDR Lighting" (GDC 2010) for the idea of a toe, a shoulder and a white point on a filmic curve, the curve divided by its value at the white point; E. Reinhard, M. Stark, P. Shirley and J. Ferwerda, "Photographic Tone Reproduction for Digital Images" (SIGGRAPH 2002, https://doi.org/10.1145/566570.566575) for the white point of a global operator; F. N. Fritsch and R. E. Carlson, "Monotone Piecewise Cubic Interpolation" (SIAM J. Numer. Anal. 17(2), 1980, https://doi.org/10.1137/0717021) for the monotone range of the cubic Hermite slopes. Read on 2026-11-17: the Reinhard paper's full text (Eq. 4, Ld = L (1 + L / Lwhite^2) / (1 + L), Lwhite the smallest luminance mapped to white: the `reinhard` curve uses exactly it, the other curves divide by their value at the white point) and the Hable page (the curve is scaled by 1 / curve(W) with W 11.2; the page does not give toe and shoulder slope controls, so the Hermite toe and shoulder are Margo's own). The Fritsch and Carlson paper itself could not be obtained (paywalled); its monotone region was taken from secondary descriptions (the alpha, beta ellipse and the square 0..3 by 0..3 as a sufficient region) and checked directly: tests/shape.test.js tests the derivative of the cubic over the whole square. Written for Margo from the descriptions; no engine's code was read.
