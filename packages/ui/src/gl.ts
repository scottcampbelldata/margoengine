import { SDF_DEFAULTS, ShelfPacker, releaseSlot, type AtlasSlot, type GlyphBitmap } from '@margoengine/text';
import { fault, rangeError } from '../../shared/errors.js';
import type { DrawList } from './draw.js';
import { GLYPH_FLOATS, RECT_FLOATS, UiBatch, type GlyphPages, type PaintStats } from './painter.js';

const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
const COMMON = `uniform vec4 frame; // width, height, linear, 0
uniform vec2 sdf;
vec2 corner(int vi) { return vec2(float((0x32 >> vi) & 1), float((0x2c >> vi) & 1)); }
vec4 ndc(vec2 p) { return vec4(p.x / frame.x * 2.0 - 1.0, 1.0 - p.y / frame.y * 2.0, 0.0, 1.0); }
vec3 toLinear(vec3 c) { return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045)))); }
vec4 prep(vec4 c) { vec3 rgb = frame.z > 0.5 ? toLinear(c.rgb) : c.rgb; return vec4(rgb * c.a, c.a); }
`;
// The same rounded boxes and SDF glyphs as the WGSL shader (shader.ts), in GLSL ES 3.00 with instanced attributes.
const RECT_VERTEX = `${HEADER}${COMMON}
layout(location = 0) in vec4 box;
layout(location = 1) in vec4 fill;
layout(location = 2) in vec4 border;
layout(location = 3) in vec4 params;
out vec2 local;
flat out vec4 vBox;
flat out vec4 vFill;
flat out vec4 vBorder;
flat out vec4 vParams;
void main() {
  float pad = params.z * 2.0 + 2.0;
  vec2 p = mix(box.xy - vec2(pad), box.xy + box.zw + vec2(pad), corner(gl_VertexID));
  gl_Position = ndc(p);
  local = p - (box.xy + box.zw * 0.5);
  vBox = box; vFill = fill; vBorder = border; vParams = params;
}`;
const RECT_FRAGMENT = `${HEADER}${COMMON}
in vec2 local;
flat in vec4 vBox;
flat in vec4 vFill;
flat in vec4 vBorder;
flat in vec4 vParams;
out vec4 color;
void main() {
  vec2 ext = vBox.zw * 0.5;
  float radius = min(vParams.x, min(ext.x, ext.y));
  vec2 q = abs(local) - ext + vec2(radius);
  float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  float cover = clamp(0.5 - d, 0.0, 1.0);
  if (vParams.z > 0.0) cover = 1.0 - smoothstep(-vParams.z, vParams.z, d);
  float inner = 1.0;
  if (vParams.y > 0.0) inner = clamp(0.5 - (d + vParams.y), 0.0, 1.0);
  color = mix(prep(vBorder), prep(vFill), inner) * cover;
}`;
const GLYPH_VERTEX = `${HEADER}${COMMON}
layout(location = 0) in vec4 box;
layout(location = 1) in vec4 uv;
layout(location = 2) in vec4 tint;
layout(location = 3) in vec4 info;
out vec2 vUv;
flat out vec4 vTint;
flat out vec4 vInfo;
void main() {
  vec2 c = corner(gl_VertexID);
  gl_Position = ndc(mix(box.xy, box.zw, c));
  vUv = vec2(mix(uv.x, uv.z, c.x), mix(uv.y, uv.w, c.y));
  vTint = tint; vInfo = info;
}`;
const GLYPH_FRAGMENT = `${HEADER}${COMMON}
uniform highp sampler2DArray sdfAtlas;
uniform highp sampler2DArray colorAtlas;
in vec2 vUv;
flat in vec4 vTint;
flat in vec4 vInfo;
out vec4 color;
void main() {
  vec2 texels = vUv * vec2(textureSize(sdfAtlas, 0).xy);
  float w = max(0.5 * (length(dFdx(texels)) + length(dFdy(texels))), 1e-3);
  float texel = textureLod(sdfAtlas, vec3(vUv, vInfo.x), 0.0).r;
  vec4 t = textureLod(colorAtlas, vec3(vUv, vInfo.x), 0.0);
  if (vInfo.y > 0.5) {
    if (frame.z > 0.5 && t.a > 0.0) t = vec4(toLinear(t.rgb / t.a) * t.a, t.a);
    if (vInfo.y > 1.5) {
      vec3 tint = frame.z > 0.5 ? toLinear(vTint.rgb) : vTint.rgb;
      color = vec4(t.rgb * tint, t.a) * vTint.a;
      return;
    }
    color = t * vTint.a;
    return;
  }
  float d = ((1.0 - texel) - sdf.y) * sdf.x;
  float field = clamp(texel * 127.5, 0.0, 1.0);
  float cover = clamp(0.5 - (d - vInfo.z * w) / w, 0.0, 1.0) * field;
  color = prep(vec4(vTint.rgb, vTint.a * cover));
}`;

/** A glyph atlas as a WebGL2 texture array; growing reallocates it and uploads every placed glyph again. */
class GlAtlas implements GlyphPages {
  readonly packer: ShelfPacker;
  readonly slots = new Map<GlyphBitmap, AtlasSlot>();
  generation = 0;
  texture: WebGLTexture | null = null;
  private layers = 0;
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly rgba: boolean,
    size: number,
    maxPages: number,
  ) {
    this.packer = new ShelfPacker(size, maxPages, 1);
  }
  get size(): number {
    return this.packer.size;
  }
  /** The texture, a 1 by 1 placeholder until the first glyph arrives. */
  bind(unit: number): void {
    const gl = this.gl;
    // Unit first: making the placeholder binds it to the active unit, which must be this atlas's own.
    gl.activeTexture(gl.TEXTURE0 + unit);
    if (!this.texture) this.allocate(0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
  }
  place(glyph: GlyphBitmap): AtlasSlot {
    let slot = this.slots.get(glyph);
    if (slot) return slot;
    const packed = this.packer.pack(glyph.width, glyph.height);
    if (!packed)
      throw rangeError(
        `Glyph atlas is full (${this.packer.maxPages} pages of ${this.size}px); raise maxPages or atlasSize in UiRenderer options`,
        'ui',
      );
    slot = packed;
    this.slots.set(glyph, slot);
    if (slot.page >= this.layers)
      this.allocate(Math.min(this.packer.maxPages, Math.max(slot.page + 1, this.layers * 2)));
    else this.upload(glyph, slot);
    return slot;
  }
  /** Drops an image's slot once it is no longer drawn; a page left with no slot is freed for new bitmaps. */
  release(glyph: GlyphBitmap): boolean {
    return releaseSlot(this.slots, this.packer, glyph) !== undefined;
  }
  private allocate(layers: number): void {
    const gl = this.gl,
      size = layers ? this.size : 1;
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, this.rgba ? gl.RGBA8 : gl.R8, size, size, Math.max(1, layers));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.layers = layers;
    // The 1 by 1 placeholder holds no glyph, so making it changes nothing a batch placed: no new generation.
    if (layers) this.generation++;
    if (layers) for (const [glyph, slot] of this.slots) this.upload(glyph, slot);
  }
  private upload(glyph: GlyphBitmap, slot: AtlasSlot): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    // Tightly packed rows, read as given: a glyph is not flipped or premultiplied, and comes from memory, not a buffer.
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // A caller's row length, skip rows, skip pixels or image height would shift every glyph row.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      slot.x,
      slot.y,
      slot.page,
      glyph.width,
      glyph.height,
      1,
      this.rgba ? gl.RGBA : gl.RED,
      gl.UNSIGNED_BYTE,
      glyph.data,
    );
  }
  dispose(): void {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.layers = 0;
    this.slots.clear();
  }
}

interface GlProgram {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  frame: WebGLUniformLocation | null;
  sdf: WebGLUniformLocation | null;
  capacity: number;
}

/**
 * The WebGL2 drawing core of the screen UI, for core's WebGL2 preview backend: the same instances as the WebGPU
 * painter (one {@link UiBatch}), drawn with instanced attributes, the attribute offsets moved to each run's first
 * instance since WebGL2 has no base instance, and one scissor per clip region.
 * @internal
 */
export class GlUiPainter {
  private readonly batch = new UiBatch();
  private readonly sdfAtlas: GlAtlas;
  private readonly colorAtlas: GlAtlas;
  private readonly rect: GlProgram;
  private readonly glyph: GlProgram;
  private uploaded = -1;
  private uploadedAtlas = '';

  constructor(
    readonly gl: WebGL2RenderingContext,
    options: { atlasSize: number; colorAtlasSize: number; maxPages: number },
    private readonly stats: PaintStats,
  ) {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      layers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    this.sdfAtlas = new GlAtlas(gl, false, Math.min(options.atlasSize, max), Math.min(options.maxPages, layers));
    this.colorAtlas = new GlAtlas(gl, true, Math.min(options.colorAtlasSize, max), Math.min(options.maxPages, layers));
    this.rect = this.program(RECT_VERTEX, RECT_FRAGMENT);
    this.glyph = this.program(GLYPH_VERTEX, GLYPH_FRAGMENT);
    gl.useProgram(this.glyph.program);
    gl.uniform1i(gl.getUniformLocation(this.glyph.program, 'sdfAtlas'), 0);
    gl.uniform1i(gl.getUniformLocation(this.glyph.program, 'colorAtlas'), 1);
  }

  private program(vertex: string, fragment: string): GlProgram {
    const gl = this.gl,
      program = gl.createProgram()!;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
      throw fault(
        'failed',
        `@margoengine/ui could not build its WebGL2 shaders (${gl.getProgramInfoLog(program)}); report this with your browser and GPU`,
        'ui',
      );
    const vao = gl.createVertexArray()!,
      buffer = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    return {
      program,
      vao,
      buffer,
      frame: gl.getUniformLocation(program, 'frame'),
      sdf: gl.getUniformLocation(program, 'sdf'),
      capacity: 0,
    };
  }

  private upload(p: GlProgram, data: Float32Array, floats: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, p.buffer);
    if (floats > p.capacity) {
      p.capacity = Math.max(floats, p.capacity * 2, 1024);
      gl.bufferData(gl.ARRAY_BUFFER, p.capacity * 4, gl.DYNAMIC_DRAW);
    }
    if (floats) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, floats);
  }

  /** Draw `list` into `framebuffer` (default: canvas), `width` by `height` pixels. */
  draw(
    list: Pick<DrawList, 'commands' | 'version'>,
    width: number,
    height: number,
    framebuffer: WebGLFramebuffer | null = null,
  ): void {
    const gl = this.gl,
      batch = this.batch,
      stats = this.stats;
    stats.rects = stats.glyphs = stats.drawCalls = stats.uploads = 0;
    const key = () => `${this.sdfAtlas.generation}|${this.colorAtlas.generation}`;
    if (this.uploaded !== list.version || this.uploadedAtlas !== key()) {
      batch.build(list, this.sdfAtlas, this.colorAtlas);
      this.upload(this.rect, batch.rects, batch.rectCount * RECT_FLOATS);
      this.upload(this.glyph, batch.glyphs, batch.glyphCount * GLYPH_FLOATS);
      stats.uploads++;
      this.uploaded = list.version;
      this.uploadedAtlas = key();
    }
    stats.rects = batch.rectCount;
    stats.glyphs = batch.glyphCount;
    if (!batch.runs.length) return;
    const depth = gl.isEnabled(gl.DEPTH_TEST),
      cull = gl.isEnabled(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.blendEquation(gl.FUNC_ADD);
    gl.enable(gl.SCISSOR_TEST);
    this.sdfAtlas.bind(0);
    this.colorAtlas.bind(1);
    // Empty atlases allocate their placeholder on bind, after batch upload.
    this.uploadedAtlas = key();
    let current: GlProgram | undefined;
    for (const run of batch.runs) {
      const p = run.glyphs ? this.glyph : this.rect,
        stride = (run.glyphs ? GLYPH_FLOATS : RECT_FLOATS) * 4;
      if (p !== current) {
        gl.useProgram(p.program);
        gl.uniform4f(p.frame, width, height, 0, 0);
        gl.uniform2f(p.sdf, SDF_DEFAULTS.radius, SDF_DEFAULTS.cutoff);
        gl.bindVertexArray(p.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, p.buffer);
        current = p;
      }
      const c = run.clip,
        x = c ? Math.max(0, Math.min(width, c[0])) : 0,
        y = c ? Math.max(0, Math.min(height, c[1])) : 0,
        w = c ? Math.max(0, Math.min(width - x, c[2] - (x - c[0]))) : width,
        h = c ? Math.max(0, Math.min(height - y, c[3] - (y - c[1]))) : height;
      if (!w || !h) continue;
      gl.scissor(x, height - y - h, w, h);
      for (let i = 0; i < 4; i++) gl.vertexAttribPointer(i, 4, gl.FLOAT, false, stride, run.first * stride + i * 16);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, run.count);
      stats.drawCalls++;
    }
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    if (depth) gl.enable(gl.DEPTH_TEST);
    if (cull) gl.enable(gl.CULL_FACE);
  }

  /** Delete the GL objects; skipped work on a lost context is harmless. */
  dispose(): void {
    const gl = this.gl;
    for (const p of [this.rect, this.glyph]) {
      gl.deleteProgram(p.program);
      gl.deleteVertexArray(p.vao);
      gl.deleteBuffer(p.buffer);
    }
    this.sdfAtlas.dispose();
    this.colorAtlas.dispose();
  }
}
