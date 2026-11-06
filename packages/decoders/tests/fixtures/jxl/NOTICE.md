# JPEG XL fixtures

Real files from the libjxl conformance suite, https://github.com/libjxl/conformance, whose README says its test bitstreams and
reference images can be reproduced freely for testing purposes. All ten have CC0 sources by that README.

- `*.jxl`: the suite's `input.jxl` of the case of that name.
- `alpha_premultiplied-straight.png`: the suite's `ref.png` of that case, unchanged. It holds the straight form.
- `blendmodes-reference.png`: the suite's `reference_image.npy` of that case (sha256
  `6ef265631818f313a70cb23788d1185408ce07243db8d5940553e7ea7467b786`, the value in its `test.json`), clipped to 0 to 1 and rounded
  to 8 bits. The suite's own 8-bit `ref.png` of this case is not used: this file's blend modes push samples from -0.67 to 5.91,
  and that PNG differs from the array by up to 92 levels even in pixels that are wholly in range.

`records.json` holds the sha256 of the RGBA this package decoded, so a change shows. Each was compared, outside this repository,
with `djxl` of libjxl 0.12.0 on all 27 cases of the suite: within 1 level on 22, within 2.01 on 3 where `djxl` wrote linear samples
under an ICC profile and this package writes sRGB, `alpha_premultiplied` (which `djxl` leaves premultiplied) through the
reference files above, and `cmyk_layers` refused.
