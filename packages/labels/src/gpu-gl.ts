import type { PassContext } from '@margoengine/core/extension';
import type { AtlasSlot, GlyphBitmap } from '@margoengine/text';
import { fault, rangeError } from '../../shared/errors.js';
import { glLabelVertex, glLabelFragment } from './gpu-shader.js';

export class LabelGL {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private texture?: WebGLTexture;
  private uploaded = -1;
  constructor(private readonly gl: WebGL2RenderingContext) {
    const shaders = [glLabelVertex, glLabelFragment].map((code, i) => {
      const shader = gl.createShader(i === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER)!;
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw fault('failed', `label shader compilation failed: ${message}; check WebGL2 support`, 'labels');
      }
      return shader;
    });
    this.program = gl.createProgram()!;
    for (const s of shaders) gl.attachShader(this.program, s);
    gl.linkProgram(this.program);
    for (const s of shaders) gl.deleteShader(s);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(this.program);
      gl.deleteProgram(this.program);
      throw fault('failed', `label shader linking failed: ${message}; check WebGL2 support`, 'labels');
    }
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
  }
  draw(
    context: Extract<PassContext, { backend: 'webgl2' }>,
    data: Float32Array,
    matrix: Float32Array,
    width: number,
    height: number,
    size: number,
    pages: number,
    records: { bitmap: GlyphBitmap; slot: AtlasSlot; pixels: Uint8Array }[],
  ): void {
    const gl = this.gl;
    if (size > gl.getParameter(gl.MAX_TEXTURE_SIZE) || pages > gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))
      throw rangeError('atlas exceeds WebGL2 limits; reduce atlasSize or font coverage', 'labels');
    const program = gl.getParameter(gl.CURRENT_PROGRAM),
      vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      buffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const active = gl.getParameter(gl.ACTIVE_TEXTURE),
      viewport = gl.getParameter(gl.VIEWPORT),
      scissor = gl.getParameter(gl.SCISSOR_BOX);
    const states = [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST].map(
      (cap) => [cap, gl.isEnabled(cap)] as const,
    );
    const blend = [
      gl.BLEND_SRC_RGB,
      gl.BLEND_DST_RGB,
      gl.BLEND_SRC_ALPHA,
      gl.BLEND_DST_ALPHA,
      gl.BLEND_EQUATION_RGB,
      gl.BLEND_EQUATION_ALPHA,
    ].map((p) => gl.getParameter(p));
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY),
      sampler = gl.getParameter(gl.SAMPLER_BINDING);
    const unpack = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
      alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
    const unpackParams = [
      gl.UNPACK_ROW_LENGTH,
      gl.UNPACK_IMAGE_HEIGHT,
      gl.UNPACK_SKIP_PIXELS,
      gl.UNPACK_SKIP_ROWS,
      gl.UNPACK_SKIP_IMAGES,
      gl.UNPACK_FLIP_Y_WEBGL,
      gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
    ];
    const unpackValues = unpackParams.map((p) => gl.getParameter(p));
    try {
      gl.bindSampler(0, null);
      if (this.uploaded !== records.length) {
        if (this.texture) gl.deleteTexture(this.texture);
        this.texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        for (const p of unpackParams) gl.pixelStorei(p, 0);
        gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, size, size, pages, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        for (const r of records)
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            r.slot.x,
            r.slot.y,
            r.slot.page,
            r.bitmap.width,
            r.bitmap.height,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            r.pixels,
          );
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.uploaded = records.length;
      } else gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture!);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      for (let i = 0; i < 5; i++) {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 80, i * 16);
        gl.vertexAttribDivisor(i, 1);
      }
      gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'matrix'), false, matrix);
      gl.uniform2f(gl.getUniformLocation(this.program, 'viewport'), width, height);
      gl.uniform1i(gl.getUniformLocation(this.program, 'atlas'), 0);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      const v = context.view?.viewport ?? [0, 0, context.width, context.height],
        s = context.view?.scissor ?? v;
      gl.viewport(v[0], context.height - v[1] - v[3], v[2], v[3]);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(s[0], context.height - s[1] - s[3], s[2], s[3]);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, data.length / 20);
    } finally {
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.bindSampler(0, sampler);
      gl.activeTexture(active);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpack);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      unpackParams.forEach((p, i) => gl.pixelStorei(p, unpackValues[i]));
      gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
      gl.scissor(scissor[0], scissor[1], scissor[2], scissor[3]);
      gl.blendFuncSeparate(blend[0], blend[1], blend[2], blend[3]);
      gl.blendEquationSeparate(blend[4], blend[5]);
      for (const [cap, enabled] of states) {
        if (enabled) gl.enable(cap);
        else gl.disable(cap);
      }
    }
  }
  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    if (this.texture) gl.deleteTexture(this.texture);
  }
}
