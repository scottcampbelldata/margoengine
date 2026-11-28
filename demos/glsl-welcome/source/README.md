# GLSL Welcome

Exhibit 109 is an editable GLSL ES 3.00 fragment material rendered by Margo Engine. The starter examples are Iridescent silk, Signal interference, and Petal aperture. All three are original procedural designs. Their source is exactly what appears in the editor.

## Try the exhibit

1. Drag **Phase** to rotate the iridescent threads. Select **Signal** or **Petals** to load and run another fragment.
2. Replace the editor contents with the snippet below. Select **Run shader** or press Ctrl+Enter (Command+Enter on Mac). Drag Phase again to change the green channel of the output.
3. Change `vec4` to `vec2`. Run again to see the type error while the last successful frame stays visible. To recover, fix the type or select an example.

```glsl
vec3 ink = vec3(uv.x, 0.19 + 0.4*phase, 0.72);
color = vec4(ink, 1.0);
```

The editor accepts a full fragment with the displayed header, or a body that it inserts into the same `main`. The built-in fragment inputs are `vec2 uv` and `float phase`, and the output is `vec4 color`. UVs run from 0 to 1, with (0, 0) at the lower left. Phase runs from 0 to 1.

This exhibit uses a straight-line subset. It accepts float/vector locals and reassignments, numeric arithmetic, swizzles and the math functions in [fragment.js](./fragment.js). It allows a single assignment to `color`. The preflight excludes loops, custom functions, other preprocessing, samplers, arrays and other external bindings. It limits the source to 4,500 characters, 36 statements, 800 expression tokens and 12 nested parentheses. Compilations happen only after a Run gesture, keyboard shortcut, or example selection. The preview draws when the shader, phase or dimensions change.

## Rendering

Margo's `ShaderMaterial` translates the submitted fragment and its fixed vertex stage. `RawShaders` draws it on one screen-filling triangle. Material replacement keeps the previous mesh attached until the candidate has compiled and a frame has been submitted. Native WebGPU and full Margo WebGL2 compatibility use the same GLSL source, preview bounds and controls. The exhibit uses no texture, image or video backdrops. Device pixel ratio is capped at two, and the canvas is capped at 1,060 pixels wide on both routes.

The three sources use spatial sinusoids and palette interpolation to illustrate different classes of effects. Silk rotates and warps the UV field, layers two finer periodic functions into the weave, and blends warm and cool pigment colors. Signal combines sinusoidal gratings along different directions; a smoothed threshold separates its two inks. Petals varies the aperture radius with azimuth and layers fine contour lines inside that aperture.

## Verification

From the showcase checkout run `node qa-output/glsl-welcome/check.mjs` with `MARGO_ENGINE_CHECKOUT` pointing to the verified build. Set `GLSL_WELCOME_URL` to test a deployed route. The harness builds with the showcase resolver and uses fresh Chromium sessions with empty cache. Phone profiles are emulated at 390 × 844, DPR 2, 150 ms latency, 1.6 Mbps download and 4× CPU slowdown. Desktop profiles run native and forced compatibility at 1440 × 1000.

The first-control measurement ends at GPU queue completion after a trusted Run touch on a newly entered fragment. The harness verifies the expected RGB samples and reads back the green channel after a Phase change. It also checks keyboard execution, compiler recovery, workload rejection, all three examples, and that rejected submissions keep the previous canvas pixels. QA PNGs are rendered by the live app.

## References

- Robert J. Simpson, editor (2016). *The OpenGL ES Shading Language, version 3.00*, particularly sections 4–6 and 8. [Khronos specification](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)
- Kai Ninomiya, Brandon Jones and Jim Blandy, editors (2026). *WebGPU*, sections on computation resources and device/queue timelines. [W3C specification](https://www.w3.org/TR/2026/CRD-webgpu-20261116/)
- Josef Albers (1963). *Interaction of Color*. The original exhibit examples use neighboring fields with deliberately different values and pigments to study perceived color. [Josef & Anni Albers Foundation](https://www.albersfoundation.org/alberses/teaching/interaction-of-color)
- Exploratorium. *Moiré Patterns*. Its overlapping grating example informed the signal design. [Exploratorium](https://annex.exploratorium.edu/xref/phenomena/moire_patterns.html)
- Margo Engine public source pinned at `0efd9cff8230507a32deb49907ecd499d46925f5`. [Shader material documentation](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/shader/README.md#glsl-programs-as-materials-margoengineshaderglsl-material-356-kb-mingzip-on-its-own-rawmesh-included)
