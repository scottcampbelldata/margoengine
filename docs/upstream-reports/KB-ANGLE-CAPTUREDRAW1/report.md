# ANGLE D3D11: a draw into a fresh texture is sometimes lost while the page is being captured

Goes to: ANGLE, Chromium, NVIDIA. Page: `lost-draw.html`, raw WebGL2 with no library.

## Environment

Windows 11, NVIDIA RTX A6000, ANGLE Direct3D 11, Edge 158.0.4370.33 and Chrome 158.0.8127.37.

## Steps

```
node docs/upstream-reports/run-page.mjs docs/upstream-reports/KB-ANGLE-CAPTUREDRAW1/lost-draw.html --browser=edge --shots=30 "--query=cycles=30&shots=1&v=bytes"
```

Each of the 30 cycles makes a texture, clears it, draws one full-target triangle into it that `texelFetch`es a source
texture and converts it, and reads it back. `--shots` takes a screenshot of the page's canvas between cycles.

## Expected

Every cycle reads 200,200,200,255.

## Actual

Some cycles read 0,0,0,0, the cleared texture, and `getError` is 0. 6 of 120 cycles in the first measurement and 4 of
120 in a second one the same day. The same page without screenshots: 0 of 180 and 0 of 120. In a lost cycle the source
texture reads correctly before the draw and the GL state read back with `getParameter` matches a kept cycle.

## What changes the rate

Knobs of the page (`?v=`), lost cycles with screenshots:

| Variant | Lost |
| --- | --- |
| plain `texelFetch` fragment shader | 0 of 180 |
| plain shader with a uniform offset | 0 of 120 |
| plain shader with a second sampler | 0 of 90 |
| converting shader without the second sampler | 2 of 90 |
| without the points draw before it | 1 of 90 |
| nothing deleted | 9 of 90 |
| a flush after the draw | 7 of 90 |
| an RGBA8 destination in place of sRGB | 2 of 50 |

Whether ANGLE's Direct3D 11 state or the NVIDIA driver drops the draw is not settled.
