# WebKit (Windows build): drawImage composites an unpremultiplied ImageBitmap as premultiplied

Draft for bugs.webkit.org, product WebKit, component Canvas. Not filed. Margo row: KB-WEBKIT-BITMAPALPHA1.

## Environment

- Playwright WebKit build 2370 (Version/27.2) on Windows 11. Edge 158 and Firefox 157 on the same PC are the controls.
  Not run on WebKitGTK, WPE or Safari with this page.

## Steps

1. Serve this folder over `http://localhost` and open `bitmap-alpha.html` (or
   `node docs/upstream-reports/run-page.mjs docs/upstream-reports/KB-WEBKIT-BITMAPALPHA1/bitmap-alpha.html --browser=webkit`).
2. The page makes `createImageBitmap(imageData, { premultiplyAlpha: 'none' })` from the pixels (11, 200, 7, 0) and
   (100, 201, 60, 1), draws it into a 2D canvas, transparent and filled opaque black, and reads `getImageData`.

## Expected

Over black, each colour weighted by its alpha: (0, 0, 0, 255) and (0, 1, 0, 255), within a level of rounding.

## Actual (2026-11-27)

| Browser | Transparent canvas | Over black |
| --- | --- | --- |
| WebKit 27.2, Windows | (0, 0, 0, 0), (255, 255, 255, 1) | (11, 200, 7, 255), (100, 201, 60, 255) |
| Edge 158 | (0, 0, 0, 0), (0, 255, 0, 1) | (0, 0, 0, 255), (0, 1, 0, 255) |
| Firefox 157 | (0, 0, 0, 0), (255, 255, 255, 1) | (0, 0, 0, 255), (1, 1, 1, 255) |

WebKit adds the straight colour at full strength, as if the bitmap were already premultiplied. The same happened with
`willReadFrequently`, the `copy` composite operation, a scaled draw, `createPattern`, `filter`, `globalAlpha` and a
second `createImageBitmap` of the bitmap. A WebGL2 upload of the bitmap itself gives its straight bytes, so the bitmap
is right and the 2D draw is wrong.

## Files

`bitmap-alpha.html` (the repro, no libraries), `../run-page.mjs` (optional Playwright driver).
