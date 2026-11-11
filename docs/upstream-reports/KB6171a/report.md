# ANGLE Metal (Apple M6): a dead branch in a fragment shader changes the rounding of live arithmetic (draft, no standalone repro)

Draft for the ANGLE issue tracker (chromium, Internals>GPU>ANGLE) and Apple (Feedback Assistant, Metal shader compiler). Not filed. Margo row: KB6171a.
Status: draft only. The fault is Metal-specific; there is no Mac on this PC, so no standalone page could be built or run here.

## Environment (Margo's record, 2026-11-10)

Apple M6, Chrome 156, ANGLE with the Metal backend, WebGL2 context (reached through Margo's WebGL2 compatibility layer).

## What was seen

Two GLSL ES 3.00 fragment programs for the same sky pass (256x256 float16 target) differ only by a block of text that the frame never executes: the second adds the
functions `stylizedNight`, `hash21`, `nightPcg` and a uniform branch in `nightSky` (the uniform that selects it is 0 for the frame). Everything on the path that runs is the same text,
apart from the counters in local names (`lr_84` against `lr_110`, `qlookup_s15` against `qlookup_s16`). On ANGLE Metal the two programs give different results at two cloud pixels of the
second frame, blue channel only, one half-float step apart (0.84765625 against 0.84716796875 and 1.1298828125 against 1.12890625). Native WebGPU gives bit-identical pixels for
both texts.

Swapping the narrow program's GLSL just before `shaderSource` showed that the live cloud arithmetic rounds one way only when the program also calls the full
`stylizedNight` body from a branch the frame never takes: with the branch's callee reduced to `return vec3(footprint)` the result is as in the plain program. A dead
`if (x > 0.5) { return vec3(0.0); }` added to the plain program changes nothing. So the compiler (ANGLE's translation or Apple's Metal compiler) contracts or reassociates
floating-point expressions differently depending on code that is not executed.

## Expected

Dead code does not change the value computed by live code (or, if fast-math style contraction is allowed, GLSL ES 3.00 `precise` or an off switch exists and works).

## Not done / what is needed

A hand-minimised page: take the two emitted GLSL texts (Margo's `packages/sky/test/compat-night-probe.mjs` writes the differing pixels per frame for each swapped text) and cut
them down on a Mac until the two-pixel difference remains. That needs a Mac and is outside this PC. Until then the report would have to attach Margo's two GLSL texts, which
this folder does not include because they are produced by Margo's compatibility layer at run time.

## Result on this PC

Not run (Metal only). Margo leaves its test red under the compatibility layer on the M6 rather than steer the compiler with dead code.
