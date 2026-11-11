/**
 * Colour exports narrowed to binary16 by truncation (docs/known-bugs.md, "Radeon 680M D3D11 export truncates to
 * binary16"). A draw's float colour reaches a 16-bit float target, and on some drivers an 8-bit or 10-bit UNORM target
 * too, through a binary16 conversion. WGSL leaves the direction of an inexact narrowing to the implementation, and the
 * Radeon 680M's driver under ANGLE Direct3D 11 rounds toward zero (measured with raw WebGL2: 0.99999994 stores
 * 0.99951171875 in RGBA16F, packHalf2x16 truncates as well), where native WebGPU on the same GPU and every other GPU
 * the project has measured round to nearest. Truncation turns a one-ulp float32 difference just under a half-float
 * step into a whole step, so two shaders equal in exact arithmetic store different halves (environment fog-all, sky
 * afterlight). On such a device the layer rounds each such output to the nearest binary16 in the shader, which the
 * driver's truncation then keeps exactly.
 */

import type { GLSLLocation } from '../glsl/emit.js';

/** Formats whose colour export the driver narrows to binary16 first: 16-bit float, 8-bit and 10-bit UNORM. */
const NARROWED = /^((r|rg|rgba)16float|(r|rg|rgba|bgra)8unorm(-srgb)?|rgb10a2unorm)$/;

/**
 * True when this context's colour export truncates a float32 to binary16: one draw of 1 - 2^-24 into a 1 x 1 RGBA16F
 * target reads back below 1. Leaves the context's bindings, program and viewport as it found them (the default ones
 * before a device exists). False when the probe cannot run (a context without these calls, as a test stand-in).
 */
export function exportTruncatesHalf(gl: WebGL2RenderingContext): boolean {
  try {
    return probeExport(gl);
  } catch {
    return false;
  }
}

function probeExport(gl: WebGL2RenderingContext): boolean {
  const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array,
    texture = gl.createTexture(),
    framebuffer = gl.createFramebuffer(),
    program = gl.createProgram(),
    shaders = [
      [gl.VERTEX_SHADER, 'void main() { gl_Position = vec4(vec2(gl_VertexID == 1 ? 3 : -1, gl_VertexID == 2 ? 3 : -1), 0, 1); }'],
      [gl.FRAGMENT_SHADER, 'precision highp float;\nuniform float u;\nout vec4 o;\nvoid main() { o = vec4(u); }'],
    ].map(([stage, body]) => {
      const s = gl.createShader(stage as number) as WebGLShader;
      gl.shaderSource(s, `#version 300 es\n${body}`);
      gl.compileShader(s);
      gl.attachShader(program as WebGLProgram, s);
      return s;
    });
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.linkProgram(program as WebGLProgram);
    if (
      !gl.getProgramParameter(program as WebGLProgram, gl.LINK_STATUS) ||
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
    )
      return false;
    gl.useProgram(program);
    gl.uniform1f(gl.getUniformLocation(program as WebGLProgram, 'u'), 1 - 2 ** -24);
    gl.viewport(0, 0, 1, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, out);
    return out[0] < 1 && out[0] > 0.999;
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

/**
 * The nearest binary16 of each component, as a float32, by round half to even: the step is 2^(e - 10) for a value of
 * exponent e, at least 2^-24 (subnormal halves); scaling by powers of two and roundEven are exact. Values the half
 * range cannot hold, infinities and NaN pass through unchanged.
 * @internal
 */
export const HALF_ROUND_GLSL = `vec4 _margoHalf(vec4 v) {
  vec4 a = abs(v);
  uvec4 e = floatBitsToUint(max(a, vec4(6.103515625e-5))) & 0x7f800000u;
  vec4 r = roundEven(a * uintBitsToFloat(0x84000000u - e)) * uintBitsToFloat(e - 0x05000000u);
  r = uintBitsToFloat(floatBitsToUint(r) | (floatBitsToUint(v) & 0x80000000u));
  return mix(v, r, lessThan(a, vec4(65520.0)));
}
`;

/**
 * The fragment shader with every float output to a narrowed target rounded to the nearest binary16 after main runs
 * (main is renamed and wrapped, so an early return or discard keeps its meaning). Unchanged when no output needs it.
 * @internal
 */
export function roundHalfExports(
  source: string,
  targets: readonly (GPUColorTargetState | null | undefined)[],
  outputs: readonly GLSLLocation[],
): string {
  const writes = outputs.flatMap(({ location, kind, components }) => {
    const format = targets[location]?.format;
    if (kind !== 'float' || !format || !NARROWED.test(format)) return [];
    const o = `_o${location}`,
      widen = components === 4 ? o : `vec4(${o}${', 0.0'.repeat(components === 1 ? 0 : 4 - components)})`,
      pick = ['', '.x', '.xy', '.xyz', ''][components];
    return [`${o} = _margoHalf(${widen})${pick};`];
  });
  if (!writes.length || !source.includes('void main() {')) return source;
  return (
    source.replace('void main() {', `${HALF_ROUND_GLSL}void _margoHalfMain() {`) +
    `\nvoid main() { _margoHalfMain(); ${writes.join(' ')} }\n`
  );
}
