Color transform references

- AgX: [Troy Sobotka's AgX](https://github.com/sobotka/AgX) display transform. Log2 encoding of middle grey 0.18 from
  -10 to +6.5 stops. Rec.2020 inset/outset matrices from Eary Chow's working-space parameters
  ([AgX_LUT_Gen](https://github.com/EaryChow/AgX_LUT_Gen), `AgXBaseRec2020.py`), the generator of Blender's AgX view; the
  derived inset equals the matrix Blender publishes in `release/datafiles/colormanagement/config.ocio` ("AgX Log").
  Default-contrast curve: Benjamin Wrensch's polynomial fit,
  ["Minimal AgX Implementation"](https://iolite-engine.com/blog_posts/minimal_agx_implementation). Rec.709/Rec.2020
  conversions from the ITU-R BT.709 and BT.2020 primaries and D65. `tests/agx.test.js` re-derives every matrix.
- ACES RRT/ODT fitted curve: [Stephen Hill](https://github.com/selfshadow/ltc_code/blob/master/webgl/shaders/ltc/ltc_blit.fs), with no extra exposure scale.
- Khronos PBR Neutral: [reference implementation](https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/pbrNeutral.glsl).
- ACEScg is AP1 with a D60 white point: [ACES specification](https://docs.acescentral.com/encodings/acescg/). The AP1 to linear-sRGB matrix includes D60 to D65 adaptation.
