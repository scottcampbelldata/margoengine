// Native WebGL2 drawing. Research and choices: docs/clean-room.md, batch 181 drawing.
// No runtime dependency from the root entry; no WebGPU shim, globals or source transpiler.
import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure, FigureOptions } from '@margoengine/sciviz';
import type { Drawable, GlContext } from './render.js';
import type { FallbackBackend, FallbackDraw } from './fallback-types.js';
import type { Colormap } from './colormaps.js';

/** Options for attaching native WebGL2 drawing. */
export interface WebGL2FigureOptions extends FigureOptions {
  /** Cancels waiting for the Figure module and prevents attachment. Default absent. Module fetching may continue. */
  readonly signal?: AbortSignal;
}

const header = `#version 300 es
precision highp float;
precision highp int;
uniform mat4 clip;
uniform mat4 model;
`;
const lighting = `
uniform vec3 eye;
vec3 toOutput(vec3 c) {
  vec3 x = clamp(c, 0.0, 1.0);
  return mix(1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, 12.92 * x, lessThanEqual(x, vec3(0.0031308)));
}
vec3 shade(vec3 albedo, vec3 normal, vec3 toEye) {
  vec3 n = dot(normal, toEye) >= 0.0 ? normal : -normal;
  vec3 key = normalize(toEye + vec3(0.35, 0.6, 0.2));
  float diffuse = max(dot(n, key), 0.0);
  float specular = pow(max(dot(n, normalize(key + toEye)), 0.0), 48.0) * 0.25;
  return albedo * (0.28 + 0.72 * diffuse) + vec3(specular);
}
`;

const surfaceVertex = `${header}
uniform sampler2D heights;
uniform mat4 normalModel;
uniform vec4 grid;
uniform ivec2 size;
out vec3 world;
out vec3 normal;
out float value;
out vec2 cell;
float heightAt(int i, int j) { return texelFetch(heights, clamp(ivec2(i, j), ivec2(0), size - 1), 0).r; }
void main() {
  int c = gl_VertexID / 6;
  int corner = gl_VertexID % 6;
  int i = c % (size.x - 1) + int(corner == 1 || corner == 2 || corner == 4);
  int j = c / (size.x - 1) + int(corner == 2 || corner == 4 || corner == 5);
  float h = heightAt(i, j);
  float gx = (heightAt(i + 1, j) - heightAt(i - 1, j)) / (grid.y * float(min(i + 1, size.x - 1) - max(i - 1, 0)));
  float gy = (heightAt(i, j + 1) - heightAt(i, j - 1)) / (grid.w * float(min(j + 1, size.y - 1) - max(j - 1, 0)));
  vec4 w = model * vec4(grid.x + float(i) * grid.y, grid.z + float(j) * grid.w, h, 1.0);
  world = w.xyz;
  normal = normalize((normalModel * vec4(-gx, -gy, 1.0, 0.0)).xyz);
  value = h;
  cell = vec2(i, j);
  gl_Position = clip * w;
  if (isnan(h)) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;
const surfaceFragment = `${header}${lighting}
uniform sampler2D colours;
uniform vec4 style;
uniform float gridEvery;
in vec3 world;
in vec3 normal;
in float value;
in vec2 cell;
out vec4 outputColour;
void main() {
  float t = clamp((value - style.x) / max(style.y - style.x, 1e-30), 0.0, 1.0);
  vec3 albedo = textureLod(colours, vec2(t, 0.5), 0.0).rgb;
  if (style.z > 0.0) {
    float level = t * style.z;
    float line = 1.0 - smoothstep(0.0, 1.5 * fwidth(level), abs(fract(level + 0.5) - 0.5));
    albedo = mix(albedo, albedo * 0.35, line * 0.8);
  }
  if (gridEvery > 0.0) {
    vec2 g = cell / gridEvery;
    vec2 w = fwidth(g);
    vec2 line = 1.0 - smoothstep(vec2(0.0), 1.2 * w, abs(fract(g + 0.5) - 0.5));
    albedo = mix(albedo, vec3(0.92), max(line.x, line.y) * 0.5);
  }
  outputColour = vec4(toOutput(shade(albedo, normalize(normal), normalize(eye - world))), style.w);
}`;
const rectVertex = `${header}
layout(location=0) in vec4 rectangle;
layout(location=1) in uint colour;
flat out vec3 rgb;
void main() {
  int c = gl_VertexID % 6;
  float x = c == 1 || c == 2 || c == 4 ? rectangle.z : rectangle.x;
  float y = c == 2 || c == 4 || c == 5 ? rectangle.w : rectangle.y;
  gl_Position = clip * (model * vec4(x, y, -0.5, 1.0));
  rgb = vec3(colour & 255u, (colour >> 8u) & 255u, (colour >> 16u) & 255u) / 255.0;
}`;
// Rectangles are already packed sRGB8 and unlit. The native WebGPU decode/encode is the identity at these bytes.
const rectFragment = `${header}
flat in vec3 rgb;
out vec4 outputColour;
void main() { outputColour = vec4(rgb, 1.0); }`;

// Scope every state we mutate, including uploads between frames. This permits other engine plugins before/after us.
function withState<T>(gl: WebGL2RenderingContext, run: () => T): T {
  const parameters = [
    gl.CURRENT_PROGRAM,
    gl.VERTEX_ARRAY_BINDING,
    gl.ARRAY_BUFFER_BINDING,
    gl.ACTIVE_TEXTURE,
    gl.VIEWPORT,
    gl.SCISSOR_BOX,
    gl.DEPTH_FUNC,
    gl.DEPTH_WRITEMASK,
    gl.DEPTH_RANGE,
    gl.BLEND_SRC_RGB,
    gl.BLEND_DST_RGB,
    gl.BLEND_SRC_ALPHA,
    gl.BLEND_DST_ALPHA,
    gl.BLEND_EQUATION_RGB,
    gl.BLEND_EQUATION_ALPHA,
    gl.UNPACK_ALIGNMENT,
    gl.UNPACK_ROW_LENGTH,
    gl.UNPACK_SKIP_PIXELS,
    gl.UNPACK_SKIP_ROWS,
    gl.PIXEL_UNPACK_BUFFER_BINDING,
    gl.COLOR_WRITEMASK,
    gl.UNPACK_FLIP_Y_WEBGL,
    gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
  ] as const;
  const s = parameters.map((p) => gl.getParameter(p));
  const flags = [
    gl.DEPTH_TEST,
    gl.CULL_FACE,
    gl.BLEND,
    gl.SCISSOR_TEST,
    gl.RASTERIZER_DISCARD,
    gl.STENCIL_TEST,
    gl.POLYGON_OFFSET_FILL,
    gl.SAMPLE_ALPHA_TO_COVERAGE,
    gl.SAMPLE_COVERAGE,
    gl.DITHER,
  ] as const;
  const enabled = flags.map((f) => gl.isEnabled(f));
  const units = [0, 1].map((unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    return [gl.getParameter(gl.TEXTURE_BINDING_2D), gl.getParameter(gl.SAMPLER_BINDING)];
  });
  try {
    return run();
  } finally {
    gl.useProgram(s[0]);
    gl.bindVertexArray(s[1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, s[2]);
    units.forEach(([texture, sampler], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindSampler(i, sampler);
    });
    gl.activeTexture(s[3]);
    gl.viewport(s[4][0], s[4][1], s[4][2], s[4][3]);
    gl.scissor(s[5][0], s[5][1], s[5][2], s[5][3]);
    gl.depthFunc(s[6]);
    gl.depthMask(s[7]);
    gl.depthRange(s[8][0], s[8][1]);
    gl.blendFuncSeparate(s[9], s[10], s[11], s[12]);
    gl.blendEquationSeparate(s[13], s[14]);
    [gl.UNPACK_ALIGNMENT, gl.UNPACK_ROW_LENGTH, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS].forEach((p, i) =>
      gl.pixelStorei(p, s[15 + i]),
    );
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, s[19]);
    gl.colorMask(s[20][0], s[20][1], s[20][2], s[20][3]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, s[21]);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, s[22]);
    flags.forEach((f, i) => (enabled[i] ? gl.enable(f) : gl.disable(f)));
  }
}

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw fault('failed', 'Cannot allocate a sciviz WebGL2 program', 'sciviz');
  const shaders: WebGLShader[] = [];
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw fault('failed', 'Cannot allocate a sciviz WebGL2 shader', 'sciviz');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw fault('failed', gl.getShaderInfoLog(shader) ?? 'sciviz WebGL2 compile failed', 'sciviz');
      gl.attachShader(p, shader);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw fault('failed', gl.getProgramInfoLog(p) ?? 'sciviz WebGL2 link failed', 'sciviz');
    return p;
  } catch (error) {
    gl.deleteProgram(p);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

class Resources implements FallbackDraw {
  readonly program: WebGLProgram;
  readonly vao: WebGLVertexArrayObject;
  readonly buffers: WebGLBuffer[] = [];
  readonly textures: WebGLTexture[] = [];
  readonly uniform = new Float32Array(48);
  readonly locations = new Map<string, WebGLUniformLocation | null>();
  #disposed = false;
  constructor(
    readonly gl: WebGL2RenderingContext,
    vertex: string,
    fragment: string,
    readonly count: number,
  ) {
    this.program = program(gl, vertex, fragment);
    const vao = gl.createVertexArray();
    if (!vao) {
      gl.deleteProgram(this.program);
      throw fault('failed', 'Cannot allocate a sciviz WebGL2 vertex array', 'sciviz');
    }
    this.vao = vao;
  }
  location(name: string): WebGLUniformLocation | null {
    if (!this.locations.has(name)) this.locations.set(name, this.gl.getUniformLocation(this.program, name));
    return this.locations.get(name)!;
  }
  texture(): WebGLTexture {
    const t = this.gl.createTexture();
    if (!t) throw fault('failed', 'Cannot allocate a sciviz WebGL2 texture', 'sciviz');
    this.textures.push(t);
    return t;
  }
  buffer(): WebGLBuffer {
    const b = this.gl.createBuffer();
    if (!b) throw fault('failed', 'Cannot allocate a sciviz WebGL2 buffer', 'sciviz');
    this.buffers.push(b);
    return b;
  }
  update(v: Float32Array): void {
    this.uniform.set(v);
  }
  draw(context: GlContext): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.location('clip'), false, context.camera.matrix as Float32Array<ArrayBuffer>);
    gl.uniformMatrix4fv(this.location('model'), false, this.uniform.subarray(0, 16));
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
    for (const b of this.buffers) this.gl.deleteBuffer(b);
    for (const t of this.textures) this.gl.deleteTexture(t);
  }
}

class SurfaceDraw extends Resources {
  constructor(
    gl: WebGL2RenderingContext,
    data: ArrayLike<number>,
    readonly nx: number,
    readonly ny: number,
    map: Colormap,
  ) {
    super(gl, surfaceVertex, surfaceFragment, 0);
    try {
      withState(gl, () => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture());
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, nx, ny);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this.setHeights(data instanceof Float32Array ? data : Float32Array.from(data));
        gl.bindTexture(gl.TEXTURE_2D, this.texture());
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.SRGB8_ALPHA8, 256, 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        const bytes = Uint8Array.from(map.table(256), (v) => Math.round(v * 255));
        this.#unpack();
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  #unpack(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (const p of [gl.UNPACK_ROW_LENGTH, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS]) gl.pixelStorei(p, 0);
  }
  setHeights(data: Float32Array): void {
    const gl = this.gl;
    withState(gl, () => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
      this.#unpack();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.nx, this.ny, gl.RED, gl.FLOAT, data as Float32Array<ArrayBuffer>);
    });
  }
  override draw(context: GlContext): void {
    const gl = this.gl,
      v = this.uniform;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.location('clip'), false, context.camera.matrix as Float32Array<ArrayBuffer>);
    gl.uniformMatrix4fv(this.location('model'), false, v.subarray(0, 16));
    gl.uniformMatrix4fv(this.location('normalModel'), false, v.subarray(16, 32));
    gl.uniform4fv(this.location('grid'), v.subarray(32, 36));
    gl.uniform2i(this.location('size'), this.nx, this.ny);
    gl.uniform1f(this.location('gridEvery'), new Uint32Array(v.buffer)[38]);
    gl.uniform4fv(this.location('style'), v.subarray(40, 44));
    gl.uniform3f(this.location('eye'), ...context.camera.position);
    for (const i of [0, 1]) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
      gl.bindSampler(i, null);
    }
    gl.uniform1i(this.location('heights'), 0);
    gl.uniform1i(this.location('colours'), 1);
    gl.drawArrays(gl.TRIANGLES, 0, (this.nx - 1) * (this.ny - 1) * 6);
  }
}

class WebGLBackend implements FallbackBackend {
  #gl!: WebGL2RenderingContext;
  setup(engine: Engine): void {
    const gl = engine.canvas.getContext('webgl2');
    if (!gl) throw fault('unsupported', 'A native WebGL2 engine context is required', 'sciviz');
    this.#gl = gl;
  }
  surface(data: ArrayLike<number>, nx: number, ny: number, map: Colormap): SurfaceDraw {
    const max = this.#gl.getParameter(this.#gl.MAX_TEXTURE_SIZE);
    if (nx > max || ny > max) throw rangeError(`WebGL2 surface dimensions exceed MAX_TEXTURE_SIZE ${max}`, 'sciviz');
    if ((nx - 1) * (ny - 1) * 6 > 0x7fffffff)
      throw rangeError('WebGL2 surface exceeds the signed vertex-count limit; use a coarser grid', 'sciviz');
    return new SurfaceDraw(this.#gl, data, nx, ny, map);
  }
  rects(rects: Float32Array, colours: Uint32Array): Resources {
    const gl = this.#gl,
      r = new Resources(gl, rectVertex, rectFragment, colours.length);
    try {
      withState(gl, () => {
        gl.bindVertexArray(r.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, r.buffer());
        gl.bufferData(gl.ARRAY_BUFFER, rects as Float32Array<ArrayBuffer>, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, r.buffer());
        gl.bufferData(gl.ARRAY_BUFFER, colours as Uint32Array<ArrayBuffer>, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 4, 0);
        gl.vertexAttribDivisor(1, 1);
      });
      return r;
    } catch (error) {
      r.dispose();
      throw error;
    }
  }
  render(context: GlContext, drawables: readonly Drawable[]): void {
    // Refuse unsupported custom layers before drawing any part of this pass.
    for (const d of drawables)
      if (!d.drawGL) throw fault('unsupported', 'This layer has no native WebGL2 drawing path', 'sciviz');
    const gl = this.#gl;
    if (gl.isContextLost()) return;
    withState(gl, () => {
      const { width, height, view } = context;
      const v = view?.viewport ?? [0, 0, width, height],
        s = view?.scissor ?? v;
      gl.viewport(v[0], height - v[1] - v[3], v[2], v[3]);
      gl.scissor(s[0], height - s[1] - s[3], s[2], s[3]);
      gl.enable(gl.SCISSOR_TEST);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      for (const f of [
        gl.RASTERIZER_DISCARD,
        gl.STENCIL_TEST,
        gl.POLYGON_OFFSET_FILL,
        gl.SAMPLE_ALPHA_TO_COVERAGE,
        gl.SAMPLE_COVERAGE,
        gl.DITHER,
      ])
        gl.disable(f);
      gl.colorMask(true, true, true, true);
      gl.depthFunc(gl.LEQUAL);
      gl.depthRange(0, 1);
      const draw = (d: Drawable) => {
        gl.depthMask(!d.transparent);
        if (d.transparent) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        d.drawGL!(context);
      };
      for (const d of drawables) if (!d.transparent) draw(d);
      const eye = context.camera.position;
      const distance = (d: Drawable) => {
        const c = d.center();
        return Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]);
      };
      for (const d of drawables.filter((d) => d.transparent).sort((a, b) => distance(b) - distance(a))) draw(d);
    });
  }
}

/**
 * Attaches surface, bar, histogram and heatmap drawing to a native WebGL2 engine.
 * This first drawing piece requires `axes: false`; the remaining layer paths are not yet implemented.
 * Root `Figure.create` still selects WebGPU. The caller owns the engine and its camera, controls and restore plugin.
 * @throws A coded `unsupported` error for another backend or axes. No compatibility shim is installed.
 */
export async function attachWebGL2(engine: EngineKernel, options: WebGL2FigureOptions = {}): Promise<Figure> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (engine.backend !== 'webgl2') throw fault('unsupported', 'attachWebGL2 needs a native WebGL2 engine', 'sciviz');
  if (options.axes !== false)
    throw fault(
      'unsupported',
      'Native WebGL2 axes are pending; pass axes: false for surface and rectangle drawing',
      'sciviz',
    );
  const module = import('@margoengine/sciviz');
  const { Figure, SciRenderer } = await (signal
    ? new Promise<typeof import('@margoengine/sciviz')>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        void module.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      })
    : module);
  signal?.throwIfAborted();
  return new Figure(engine, options, new SciRenderer({ fallback: new WebGLBackend() }));
}
