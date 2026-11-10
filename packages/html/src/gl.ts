import { margoError } from '../../shared/errors.js';

/** Internal clean-room GL program builder, shared by HTML's optional preview passes. */
export function htmlProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, code] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const reason = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw margoError('failed', `HTML preview shader failed: ${reason}; check WebGL2 support`);
  }
  return program;
}

/** Preserve every draw state changed by either HTML pass, including texture unit zero's sampler. */
export function htmlGLState(gl: WebGL2RenderingContext): () => void {
  const program = gl.getParameter(gl.CURRENT_PROGRAM), vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    viewport = gl.getParameter(gl.VIEWPORT), color = gl.getParameter(gl.COLOR_WRITEMASK),
    depth = gl.getParameter(gl.DEPTH_WRITEMASK), compare = gl.getParameter(gl.DEPTH_FUNC),
    srcRGB = gl.getParameter(gl.BLEND_SRC_RGB), dstRGB = gl.getParameter(gl.BLEND_DST_RGB),
    srcAlpha = gl.getParameter(gl.BLEND_SRC_ALPHA), dstAlpha = gl.getParameter(gl.BLEND_DST_ALPHA),
    eqRGB = gl.getParameter(gl.BLEND_EQUATION_RGB), eqAlpha = gl.getParameter(gl.BLEND_EQUATION_ALPHA),
    active = gl.getParameter(gl.ACTIVE_TEXTURE),
    enabled = [gl.BLEND, gl.CULL_FACE, gl.DEPTH_TEST].map((flag) => [flag, gl.isEnabled(flag)] as const);
  gl.activeTexture(gl.TEXTURE0);
  const texture = gl.getParameter(gl.TEXTURE_BINDING_2D), sampler = gl.getParameter(gl.SAMPLER_BINDING);
  return () => {
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.colorMask(color[0], color[1], color[2], color[3]);
    gl.depthMask(depth);
    gl.depthFunc(compare);
    gl.blendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha);
    gl.blendEquationSeparate(eqRGB, eqAlpha);
    for (const [flag, on] of enabled) on ? gl.enable(flag) : gl.disable(flag);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindSampler(0, sampler);
    gl.activeTexture(active);
  };
}
