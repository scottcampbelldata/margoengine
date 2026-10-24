# Animation format fixtures

Written by `generate.mjs` in this folder (Margo Engine's own files, from the COLLADA 1.4.1 and glTF 2.0 /
KHR_animation_pointer specifications). Rerun `node examples/assets/animation-formats/generate.mjs` after changing it.

| File | What it is | Used by |
| --- | --- | --- |
| `bend-tube.dae` | a tube skinned to three joints, its upper two bending (LINEAR, 2 s) | `demos/animation-formats.html`, loaders `dae-fixture.test.js` |
| `pointer-cube.gltf` | base colour, emissive and translation by pointer (LINEAR, 2 s) | the demo, animation `pointer-samples.test.js` |
| `pointer-all.gltf` | one clip with 31 pointer channels: every material factor, texture transform, emissive strength, light, camera, node TRS, weights and visibility pointer the player supports, in STEP, LINEAR and CUBICSPLINE, plus one valid pointer it skips | animation `pointer-all.test.js` |
| `pointer-invalid.gltf` | the same plus a pointer glTF forbids (`/materials/0/alphaMode`), which must throw | animation `pointer-all.test.js` |
