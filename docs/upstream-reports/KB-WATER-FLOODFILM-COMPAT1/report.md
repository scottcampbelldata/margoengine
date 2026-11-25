# ANGLE D3D11 (Intel Arc): the same WebGL2 shaders and inputs give a different float result from one browser launch to the next (draft, no standalone repro yet)

Draft for the ANGLE issue tracker (and Intel). Not filed. Margo row: KB-WATER-FLOODFILM-COMPAT1 (flood film on the WebGL2 layer).

## Environment

Intel Arc 140V, Windows 11, Edge (ANGLE Direct3D 11), WebGL renderer string `ANGLE (Intel, Intel(R) Arc(TM) 140V GPU (16GB) (0x000064A0)
Direct3D11 vs_5_0 ps_5_0, D3D11)`, recorded 2026-11-21. Driver and browser versions not recorded yet.

## Steps

1. A WebGL2 page runs a fixed-step shallow-water solver as fragment passes: two programs (one per rgba32float target) that read only
   `texelFetch` of other textures and a std140 uniform block bound with `bindBufferRange`, and write only their own pixel, ping-ponging
   between textures, 2,400 ticks of 4 passes plus a record pass. Every input (uniform bytes, texture uploads, draw order) is fixed.
2. Read the final state back with `readPixels` and hash its bits.
3. Close the browser and repeat in a new launch (fresh profile).

Margo's version of these steps: `MARGO_COMPAT=1 node packages/water/test/flood-film.browser.mjs` in the Margo repository.

## Expected

The same hash in every launch, as native WebGPU on the same machine gives (20 of 20 launches identical).

## Actual

In 32 launches the state hashed eee49ae9 (26), c9b4539d (4), d9a15081 (1) and a1e8cf94 (1); the launches already differ at the first
readback, 480 ticks in. Inside a launch the result is nearly always one (31 of 32 launches agree across five reruns, including a new WebGL2
context after a restore). Across launches the GLSL is identical, the HLSL from `WEBGL_debug_shaders.getTranslatedShaderSource` hashed the same
in all 7 launches captured, and the uniform bytes, the texture uploads and the size uniforms hashed the same in all 7 launches measured. The
6 varying launches were the first 6 after a rebuild; later launches all gave eee49ae9.

## Result on this PC

Reproduced on 2026-11-21 (6 of 32 launches differ). Status: draft only. Missing before filing: a standalone page without Margo code, the
driver and browser versions, and a translated-HLSL capture from inside a varying launch (none of the captured launches varied).
