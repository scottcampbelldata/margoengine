# Skip-audit research record

Research reviewed on 2026-11-09 before this continuation's changes. Public papers,
abstracts and standards only; no companion implementation or foreign engine
source was read. Existing Margo implementations and tests were inspected separately.

## Camera follow-up and item 5: examples and ownership

- Paul Haeberli and Kurt Akeley, *The Accumulation Buffer: Hardware Support for
  High-Quality Rendering*, SIGGRAPH 1990,
  https://graphics.stanford.edu/courses/cs248-06/haeberli-akeley-accumulation-buffer-sig90.pdf.
- Craig Kolb, Don Mitchell and Pat Hanrahan, *A Realistic Camera Model for Computer
  Graphics*, SIGGRAPH 1995, https://graphics.stanford.edu/papers/camera/.
- W3C GPU for the Web Working Group, *WebGPU*, 2026 working draft,
  https://www.w3.org/TR/webgpu/.

The first paper motivates subpixel image sampling; the second separates exposure
and optical camera parameters. Neither specifies Margo's plugin ownership. The
WebGPU attachment and resource rules, together with Margo's own PostStack contract,
support one scene capture shared by the documented effects. Item 5 exposes the
existing smooth option and physical-camera/terrain APIs; it adds no sampling or
optics algorithm and makes no lens-simulation claim.

## Item 5 follow-up: self-contained Cube input

- Adobe Systems, *Cube LUT Specification*, version 1.0, 2013,
  https://kono.phpage.fr/images/a/a1/Adobe-cube-lut-specification-1.0.pdf.
- Jeremy Selan, *Using Lookup Tables to Accelerate Color Transformations*,
  GPU Gems 2 chapter 24, 2005,
  https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-24-using-lookup-tables-accelerate-color.
- Academy of Motion Picture Arts and Sciences, *Common LUT Format Specification*,
  version 3.0, online September 2025 status note, https://docs.acescentral.com/clf/specification/.

The Adobe publication defines Cube's red-fastest sample order; CLF uses the
third component fastest, so its serialization cannot be substituted. Selan's
lattice description supports a complete identity transform as a minimal example.
The existing parser accepts a 2x2x2 Cube. Supplying all eight corners fixes the
missing input without changing parsing or grading. The actual first README block
is executed with fetch forbidden and the real parseCube function; it fails on
the old external input and verifies every RGBA corner, clearing and disposal on
the replacement. No implementation or companion code was read.
