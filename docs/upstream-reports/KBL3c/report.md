# Firefox: every texSubImage2D from a pixel unpack buffer warns "final row ... smaller than the row stride"

Draft for bugzilla.mozilla.org, product Core, component Graphics: CanvasWebGL. Not filed. Margo row: KBL3c in docs/known-bugs.md.

## Environment

- Firefox 157.0 (the harness's Firefox, WebGL2 on ANGLE Direct3D 11), Windows 11. Firefox reports the renderer as
  "ANGLE (NVIDIA, NVIDIA GeForce 8800 GTX Direct3D11 vs_5_0 ps_5_0), or similar" (the GPU is an NVIDIA RTX A6000).
- Edge 157 and Chrome print no warning for the same calls.

## Steps

1. Serve this folder over `http://localhost` and open `pbo-upload.html` in Firefox with the console open (or run
   `node docs/upstream-reports/run-page.mjs docs/upstream-reports/KBL3c/pbo-upload.html --browser=firefox` from the Margo
   repository, which prints the console).
2. With `?wait` the page starts when `window.run()` is called, so a driver can listen to the console first.
3. The page makes a 4 x 4 RGBA8 texture with `texStorage2D` and fills all of it with one `texSubImage2D` from a
   `PIXEL_UNPACK_BUFFER` of exactly 64 bytes (4 rows of 16 bytes), with `UNPACK_ALIGNMENT` 1, 4 and 8; then the same
   from a `Uint8Array`; then an RGBA32UI 2,048 x 12 texture from an exact 393,216-byte buffer. Each case has its own
   context, and reads the texels back.

## Expected

No warning. Every row of every upload is a full row of `width x bytes per texel`, which is already a multiple of every
alignment used, so the final row is exactly as long as the row stride, and the buffer holds exactly the bytes read.

## Actual

Every upload from the buffer prints, once per call, at every alignment:

```
WebGL warning: texSubImage: Uploads from a buffer with a final row with a byte count smaller than the row stride can incur extra overhead.
```

The `Uint8Array` uploads print nothing. Every upload lands (texels read back equal, no GL error).

## Analysis

The advisory seems to compare the final row against a stride that is not the one the upload uses, or to fire on any
upload from a buffer. Uploads whose last row is shorter than the stride exist (an `UNPACK_ROW_LENGTH` larger than the
width, say), but none of these has one. Code that streams GPU-side data into textures through pixel unpack buffers,
as WebGL2 offers no other GPU-only path, cannot avoid it, and pages that treat console warnings as test failures
cannot tell it from a real problem.

## Result on this PC (2026-11-11)

Still reproduces: Firefox 157.0 through Margo's harness (`MARGO_BROWSER=firefox`, the page opened with `?wait`, then
`window.run()`): five of the six buffer uploads (two cases x three alignments) warn, all but the very first case of
the page, which printed nothing in that run; the three array uploads do not. Every case lands with `glError` 0.
Playwright's own Firefox driver (`run-page.mjs`) does not pass WebGL warnings on, so it shows only the results.

## Files

`pbo-upload.html` (the repro, no libraries), `../run-page.mjs` (optional Playwright driver).
