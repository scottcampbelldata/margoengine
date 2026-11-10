# AVIF decoder review fixes (2026-11-10)

Clean-room research compared the format binding's container boundaries with AV1's
OBU syntax and color semantics. No companion or rival source was read or copied.

- Cyril Concolato, Dimitri Podborski and Wan-Teh Chang (editors), *AV1 Codec ISO
  Media File Format Binding*, v1.3.0 (2024), sections 2.3.4 and 2.4:
  https://aomediacodec.github.io/av1-isobmff/v1.3.0.html
- Peter de Rivaz and Jack Haughton, *AV1 Bitstream & Decoding Process
  Specification* (2018, errata through 2023), OBU header, extension header and
  color config syntax/semantics:
  https://aomediacodec.github.io/av1-spec/
- Yannis Guyon, Leo Barnes and Wan-Teh Chang (editors), *AV1 Image
  File Format (AVIF)*, v1.2.0 (2025), sections 2.1 and 2.2.1:
  https://aomediacodec.github.io/av1-avif/v1.2.0.html

## M1: final OBU without an explicit size

Confirmed. AVIF section 2.1 binds item data to an AV1 sync sample. Sample
iteration now consumes the remainder of the item when its last
OBU omits the size field. Configuration OBUs still require explicit sizes under
section 2.3.4. Sized payloads and extension headers retain their truncation checks.
The composition regression builds small idat/iloc fixtures around the existing
standard white sample, removes only the final OBU's size, and compares exact RGBA
with the original, with and without an extension header. It also checks sized and
unsized av1C sequence headers. The test failed with Invalid before the fix.
An iterator regression proves that bytes resembling another OBU remain payload
and that an empty last OBU terminates. No GPU code, TypeScript API or import graph
changes; the decoder stays in its lazily loaded optional Wasm asset.

The dependent CPU gate exposed existing duplicate fileURLToPath imports in the
navmesh border and Wasm tests (both failed to parse). Removed only the duplicate
declarations so the existing regressions can run. This follows Ecma TC39,
*ECMAScript 2025 Language Specification*, Module early errors (2025),
https://tc39.es/ecma262/2025/#sec-module-semantics-static-semantics-early-errors.
No navmesh runtime or assertions changed. Missing local game/web workspace links
were also restored inside this worktree's node_modules; no manifest changed.

## M2: CSP_VERTICAL chroma axes

Confirmed against AV1 color_config semantics. Position 1 is horizontally co-sited
at zero and vertically centered at half a luma sample. Corrected both offsets;
position 0 keeps the decoder's centered default and position 2 remains co-sited
on both axes. The Rust test constructs a 4x4 10-bit 4:2:0 plane fixture with an
independent U horizontal ramp and V vertical ramp. Hand-derived interpolated
values and BT.709 equations check every RGBA16 pixel exactly at positions 0, 1
and 2, including edge clamping. Before the fix position 1 at (1, 0) produced blue
25192 instead of 32800. No GPU path, public TypeScript API or import graph changes.
