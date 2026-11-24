/**
 * Inverse trigonometry a driver evaluates more than 1e-5 off (docs/known-bugs.md, "Radeon 680M, ANGLE Direct3D 11:
 * acos is 6.75e-5 off"). WGSL takes the accuracy of acos and asin from atan2 and GLSL ES 3.00 leaves it unspecified,
 * but Margo's shaders expect 1e-5 (shader's equirectUV and its test), which native WebGPU gives on every GPU measured.
 * The Direct3D 11 compiler under ANGLE evaluates acos and asin with a short polynomial: acos(0) is 1.5707288, 6.75e-5
 * below pi / 2, and atan reaches 1.1e-5. The adapter probes once: one draw evaluates acos, asin and atan at
 * {@link INVERSE_TRIG_PROBE}'s inputs into an integer target (float bits, no narrowing); where any result is more than
 * {@link INVERSE_TRIG_TOLERANCE} off, every shader calls the layer's own (glsl/helpers.ts `_acos`, `_asin`, `_atan2`,
 * error under 1e-6). Other drivers compile unchanged shaders.
 * The probe ends with three signed-zero atan2 inputs (docs/known-bugs.md, "Apple silicon Metal: atan2 with x = -0"):
 * Metal on Apple silicon, under ANGLE and Dawn alike, returns atan2(1, -0) = -pi / 2 and atan2(-1, -0) = pi / 2, a
 * half turn from the answer for either sign of that zero, and atan2(-0, -1) = pi.
 */

/** The largest error of the driver's acos, asin and atan the layer accepts (Scott's ruling, 2026-11-11). @internal */
export const INVERSE_TRIG_TOLERANCE = 1e-5;

/** How many of {@link INVERSE_TRIG_PROBE}'s inputs are smooth ones, before the signed-zero edges. @internal */
export const INVERSE_TRIG_SMOOTH = 65;

/**
 * The probe's inputs, one pixel each: x for acos and asin (-1 to 1 in steps of 1 / 32, so 0 and both ends are among
 * them), then y and x for atan2 (65 directions around the circle); then three signed-zero edges of atan2, (1, -0),
 * (-1, -0) and (-0, -1), whose IEEE-754 results are pi / 2, -pi / 2 and -pi (with acos and asin of 0). Float32 values.
 * @internal
 */
export const INVERSE_TRIG_PROBE: readonly (readonly [number, number, number])[] = [
  ...Array.from({ length: INVERSE_TRIG_SMOOTH }, (_, i) => {
    const angle = -Math.PI + (2 * Math.PI * (i + 0.5)) / INVERSE_TRIG_SMOOTH;
    return [Math.fround(i / 32 - 1), Math.fround(Math.sin(angle)), Math.fround(Math.cos(angle))] as const;
  }),
  [0, 1, -0],
  [0, -1, -0],
  [0, -0, -1],
];

/**
 * The largest error of the probe's results (acos, asin and atan2 of each input, four float32 values a pixel) against
 * the float64 functions; Infinity for a NaN. `count` limits it to the first inputs ({@link INVERSE_TRIG_SMOOTH}: the
 * smooth ones, which tell a driver's inverse trigonometry from a stand-in's zeros).
 * @internal
 */
export function inverseTrigError(results: ArrayLike<number>, count: number = INVERSE_TRIG_PROBE.length): number {
  let worst = 0;
  INVERSE_TRIG_PROBE.slice(0, count).forEach(([x, y, z], i) => {
    const want = [Math.acos(x), Math.asin(x), Math.atan2(y, z)];
    for (let c = 0; c < 3; c++) {
      const error = Math.abs(results[i * 4 + c] - want[c]);
      worst = Number.isNaN(error) ? Infinity : Math.max(worst, error);
    }
  });
  return worst;
}

/**
 * True when this context's acos, asin or atan misses {@link INVERSE_TRIG_TOLERANCE} at the probe's inputs. Leaves
 * the context's bindings, program and viewport as it found them. False when the probe cannot run or its smooth inputs
 * read nothing like an inverse trigonometric function (an error past {@link INVERSE_TRIG_IMPLAUSIBLE}: a test
 * stand-in context). A signed-zero edge may be off by any amount: Metal answers a half turn away there.
 */
export function inverseTrigInaccurate(gl: WebGL2RenderingContext): boolean {
  try {
    const results = probeInverseTrig(gl);
    return results !== null && inverseTrigVerdict(results);
  } catch {
    return false;
  }
}

/** The verdict of {@link inverseTrigInaccurate} on the probe's results (four float32 values a pixel). @internal */
export function inverseTrigVerdict(results: ArrayLike<number>): boolean {
  return inverseTrigError(results, INVERSE_TRIG_SMOOTH) < INVERSE_TRIG_IMPLAUSIBLE && inverseTrigError(results) > INVERSE_TRIG_TOLERANCE;
}

/** An error no driver's acos, asin or atan reaches: the probe read something else (zeros from a stand-in). @internal */
export const INVERSE_TRIG_IMPLAUSIBLE = 0.01;

/** The probe's results, four float32 values a pixel; null when it cannot run. */
function probeInverseTrig(gl: WebGL2RenderingContext): Float32Array | null {
  const n = INVERSE_TRIG_PROBE.length,
    viewport = gl.getParameter(gl.VIEWPORT) as Int32Array,
    texture = gl.createTexture(),
    framebuffer = gl.createFramebuffer(),
    program = gl.createProgram(),
    shaders = [
      [gl.VERTEX_SHADER, 'void main() { gl_Position = vec4(vec2(gl_VertexID == 1 ? 3 : -1, gl_VertexID == 2 ? 3 : -1), 0, 1); }'],
      [
        gl.FRAGMENT_SHADER,
        `precision highp float;\nprecision highp int;\nuniform vec3 u[${n}];\nout uvec4 o;\n` +
          'void main() { vec3 v = u[int(gl_FragCoord.x)]; o = uvec4(floatBitsToUint(vec3(acos(v.x), asin(v.x), atan(v.y, v.z))), 0u); }',
      ],
    ].map(([stage, body]) => {
      const s = gl.createShader(stage as number) as WebGLShader;
      gl.shaderSource(s, `#version 300 es\n${body}`);
      gl.compileShader(s);
      gl.attachShader(program as WebGLProgram, s);
      return s;
    });
  for (let i = 0; i < 16 && gl.getError() !== 0; i++);
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, n, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.linkProgram(program as WebGLProgram);
    if (
      !gl.getProgramParameter(program as WebGLProgram, gl.LINK_STATUS) ||
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
    )
      return null;
    gl.useProgram(program);
    gl.uniform3fv(gl.getUniformLocation(program as WebGLProgram, 'u'), INVERSE_TRIG_PROBE.flat());
    gl.viewport(0, 0, n, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bits = new Uint32Array(n * 4);
    gl.readPixels(0, 0, n, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, bits);
    if (gl.getError() !== 0) return null;
    return new Float32Array(bits.buffer);
  } finally {
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    for (const s of shaders) gl.deleteShader(s);
    gl.deleteProgram(program);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    // At most a few flags are set; the bound keeps a stand-in context whose getError never clears from spinning.
    for (let i = 0; i < 16 && gl.getError() !== 0; i++);
  }
}
