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
  Margo's display curve: Bloom, SSAO, SSR and DOF present with it, then the exact sRGB encoding, as core does.
- ACEScg is AP1 with a D60 white point: [ACES specification](https://docs.acescentral.com/encodings/acescg/). The AP1 to linear-sRGB matrix includes D60 to D65 adaptation.

Bloom references (our own code, written from the published talks)

- Downsample/upsample chain (13-tap downsample of five overlapping boxes, Karis-weighted first level, 3x3 tent
  upsample): Jorge Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014
  Advances in Real-Time Rendering.
- Triangular dither of up to one step before 8-bit output: Mikkel Gjøl and Mikkel Svendsen, "Low Complexity, High
  Fidelity: INSIDE Rendering", GDC 2016.

Anti-aliasing and screen-look references (our own code, written from the papers and public documentation)

- SMAA: Jorge Jimenez, Jose I. Echevarria, Tiago Sousa and Diego Gutierrez, "SMAA: Enhanced Subpixel Morphological
  Antialiasing", Computer Graphics Forum 31(2), Eurographics 2012. Its morphological model: Alexander Reshetov,
  "Morphological Antialiasing", High Performance Graphics 2009, and Jorge Jimenez et al., "Practical Morphological
  Antialiasing", GPU Pro 2, 2011. The area and search lookup tables are computed in code from those definitions; no
  published texture data or reference shader code is used. The quality presets' thresholds and search step counts
  follow the presets the SMAA authors publish.
- Glitch: bursts at random intervals, and a mode that glitches every frame. Random numbers: xorshift32,
  George Marsaglia, "Xorshift RNGs", Journal of Statistical Software 8(14), 2003. Per-pixel hash: PCG hash from Mark
  Jarzynski and Marc Olano, "Hash Functions for GPU Rendering", Journal of Computer Graphics Techniques 9(3), 2020.
- Afterimage: `max(current, history x damp)`, `damp` default 0.96.
