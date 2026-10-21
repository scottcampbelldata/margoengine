Color transform references

- AgX: [Troy Sobotka's AgX](https://github.com/sobotka/AgX) display transform. Log2 encoding of middle grey 0.18 from
  -10 to +6.5 stops. Rec.2020 inset/outset matrices from Eary Chow's working-space parameters
  ([AgX_LUT_Gen](https://github.com/EaryChow/AgX_LUT_Gen), `AgXBaseRec2020.py`), the generator of Blender's AgX view; the
  derived inset equals the matrix Blender publishes in `release/datafiles/colormanagement/config.ocio` ("AgX Log").
  Default-contrast curve: Benjamin Wrensch's polynomial fit,
  ["Minimal AgX Implementation"](https://iolite-engine.com/blog_posts/minimal_agx_implementation). Rec.709/Rec.2020
  conversions from the ITU-R BT.709 and BT.2020 primaries and D65. `packages/tonemap/tests/agx.test.js` re-derives every matrix.
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

Anti-aliasing and screen-look references (our own code, written from the papers and three.js's documentation)

- SMAA: Jorge Jimenez, Jose I. Echevarria, Tiago Sousa and Diego Gutierrez, "SMAA: Enhanced Subpixel Morphological
  Antialiasing", Computer Graphics Forum 31(2), Eurographics 2012. Its morphological model: Alexander Reshetov,
  "Morphological Antialiasing", High Performance Graphics 2009, and Jorge Jimenez et al., "Practical Morphological
  Antialiasing", GPU Pro 2, 2011. The area and search lookup tables are computed in code from those definitions; no
  published texture data or reference shader code is used. The quality presets' thresholds and search step counts
  follow the presets the SMAA authors publish.
- Glitch: behaviour as three.js documents GlitchPass (bursts at random intervals, `goWild`). Random numbers: xorshift32,
  George Marsaglia, "Xorshift RNGs", Journal of Statistical Software 8(14), 2003. Per-pixel hash: PCG hash from Mark
  Jarzynski and Marc Olano, "Hash Functions for GPU Rendering", Journal of Computer Graphics Techniques 9(3), 2020.
- Afterimage: behaviour as three.js documents AfterimagePass (`damp`, default 0.96).
