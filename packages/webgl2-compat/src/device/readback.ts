// Reading textures back, a chunk apart from the layer's base: only a page that copies a texture to a buffer, or runs
// compute, downloads it (queue.submit and device.loadReadback load it first). The format conversions are the larger part
// of it: every WebGPU layout a texture can be read in, from WebGL2's few readPixels formats.
import { type FormatInfo, toHalf } from './formats.js';
import { origin, type Replayer } from './render.js';
import type { CompatBuffer, CompatTexture, TextureStorage } from './resources.js';

/** Where readPixels reads a copy from: the bound read framebuffer, in this format and type; free() deletes it. */
interface ReadSource {
  readonly format: number;
  readonly type: number;
  readonly free?: () => void;
}

/**
 * Draws texels of a storage into a new RGBA32F, RGBA32UI or RGBA32I texture of w x h (texel (x, y) of the level and
 * layer at its (0, 0)) and returns the framebuffer that reads it: how formats readPixels cannot read are read back.
 */
export function fetchInto(
  r: Replayer,
  s: TextureStorage,
  level: number,
  layer: number,
  x: number,
  y: number,
  w: number,
  h: number,
): ReadSource {
  const gl = r.gl,
    state = r.device.state,
    kind = s.info.kind === 'uint' ? 'u' : s.info.kind === 'sint' ? 'i' : '';
  if (s.target === gl.TEXTURE_CUBE_MAP) {
    // GLSL ES 3.00 cannot fetch from a cube map: read the face's 2D copy.
    const t = s.texture,
      flat = t.sampled(t.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }));
    t.read(flat, level, 1, layer, 1, r.sync);
    return fetchInto(r, flat, level, layer, x, y, w, h);
  }
  const sampler =
    s.target === gl.TEXTURE_3D ? 'sampler3D' : s.target === gl.TEXTURE_2D_ARRAY ? 'sampler2DArray' : 'sampler2D';
  const coord = s.target === gl.TEXTURE_2D ? 'p' : 'ivec3(p, o.z)';
  const h_ = r.helper(
    `fetch:${kind}${sampler}`,
    `uniform highp ${kind}${sampler} t;\nuniform ivec4 o;\nout highp ${kind}vec4 c;\nvoid main() { ivec2 p = ivec2(gl_FragCoord.xy) + o.xy; c = ${kind}vec4(texelFetch(t, ${coord}, o.w)); }`,
  );
  const internal = kind === 'u' ? gl.RGBA32UI : kind === 'i' ? gl.RGBA32I : gl.RGBA32F;
  const target = gl.createTexture() as WebGLTexture;
  state.scratch(gl.TEXTURE_2D, target);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
  const fbo = gl.createFramebuffer() as WebGLFramebuffer;
  state.bindDrawFramebuffer(fbo);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  r.helperState(h_, w, h);
  state.unit(0, s.target, s.gl, r.device.loadSampler);
  const all = `0:${s.texture.mipLevelCount - 1}`;
  if (s.levels !== all) {
    state.activeUnit(0);
    gl.texParameteri(s.target, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(s.target, gl.TEXTURE_MAX_LEVEL, s.texture.mipLevelCount - 1);
    s.levels = all;
  }
  gl.uniform4i(
    h_.offset,
    x,
    y,
    s.target === gl.TEXTURE_2D ? 0 : layer - (s.target === gl.TEXTURE_3D ? 0 : s.layer),
    level,
  );
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  state.bindDrawFramebuffer(null);
  state.bindReadFramebuffer(fbo);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  return {
    format: kind ? gl.RGBA_INTEGER : gl.RGBA,
    type: kind === 'u' ? gl.UNSIGNED_INT : kind === 'i' ? gl.INT : gl.FLOAT,
    free: () => {
      state.bindReadFramebuffer(null);
      gl.deleteFramebuffer(fbo);
      state.forgetTexture(target);
      gl.deleteTexture(target);
    },
  };
}

/**
 * Draws the stencil values of a level and layer into a new RGBA8 texture, one bit plane per draw (each draw passes
 * the stencil test where its bit is set and adds that bit's weight), and returns the framebuffer that reads it.
 */
function stencilInto(r: Replayer, s: TextureStorage, level: number, layer: number): ReadSource {
  const gl = r.gl,
    state = r.device.state,
    [w, h] = s.texture.levelSize(level);
  const h_ = r.helper('stencil', 'uniform float v;\nout vec4 c;\nvoid main() { c = vec4(v, 0.0, 0.0, 1.0); }');
  const target = gl.createTexture() as WebGLTexture;
  state.scratch(gl.TEXTURE_2D, target);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  const fbo = gl.createFramebuffer() as WebGLFramebuffer;
  state.bindDrawFramebuffer(fbo);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  r.sub(s, level, layer).attach(gl.DEPTH_STENCIL_ATTACHMENT);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  r.helperState(h_, w, h);
  gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
  state.enable(gl.STENCIL_TEST, true);
  gl.stencilMask(0);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE);
  for (let bit = 0; bit < 8; bit++) {
    gl.stencilFunc(gl.EQUAL, 0xff, 1 << bit);
    gl.uniform1f(h_.value, (1 << bit) / 255);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // The stencil and blend state the pipelines cache was changed by hand: forget it.
  for (const key of ['blend', 'stencilMask']) state.forget(key);
  for (const face of [gl.FRONT, gl.BACK])
    for (const k of ['stencilFunc', 'stencilOp', 'stencilMask']) state.forget(`${k}${face}`);
  state.enable(gl.STENCIL_TEST, false);
  state.bindDrawFramebuffer(null);
  state.bindReadFramebuffer(fbo);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  return {
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    free: () => {
      state.bindReadFramebuffer(null);
      gl.deleteFramebuffer(fbo);
      state.forgetTexture(target);
      gl.deleteTexture(target);
    },
  };
}

export function copyTextureToBuffer(
  r: Replayer,
  source: GPUTexelCopyTextureInfo & { texture: CompatTexture },
  destination: GPUTexelCopyBufferInfo & { buffer: CompatBuffer },
  [w, h, depth]: [number, number, number],
): void {
  const gl = r.gl,
    t = source.texture as CompatTexture,
    aspect = source.aspect ?? 'all';
  if (t.renderbuffer) throw r.device.unsupported('copying a multisampled texture');
  if (t.info.block)
    throw r.device.unsupported(`reading back a ${t.format} texture (WebGL2 cannot read compressed texels)`);
  const plan = readPlan(t.info, aspect);
  if (!plan)
    throw r.device.unsupported(
      `copying the ${aspect} aspect of a ${t.format} texture to a buffer (WebGPU does not allow it either)`,
    );
  const [x, y, z] = origin(source.origin);
  const level = source.mipLevel ?? 0;
  const p = t.primary as TextureStorage;
  const dst = destination.buffer,
    bytesPerRow = destination.bytesPerRow ?? w * plan.bytes,
    rowsPerImage = destination.rowsPerImage ?? h,
    base = destination.offset ?? 0;
  const is3d = t.dimension === '3d';
  t.read(p, level, 1, is3d ? 0 : z, is3d ? 1 : depth, r.sync);
  for (let slice = 0; slice < depth; slice++) {
    const layer = z + slice;
    let read: ReadSource;
    let rx = x,
      ry = y;
    if (plan.via === 'stencil') read = stencilInto(r, p, level, layer);
    else if (plan.via === 'fetch') {
      read = fetchInto(r, p, level, layer, x, y, w, h);
      rx = ry = 0;
    } else {
      r.device.state.bindReadFramebuffer(r.single(r.sub(p, level, layer)));
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      read = { format: r.device.enum(plan.format), type: r.device.enum(plan.type) };
    }
    const texel = plan.texel,
      total = w * h * texel;
    const pack = gl.createBuffer() as WebGLBuffer;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, total, gl.STREAM_READ);
    gl.readPixels(rx, ry, w, h, read.format, read.type, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    read.free?.();
    r.rebind();
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) as WebGLSync;
    const offset = base + slice * bytesPerRow * rowsPerImage;
    dst.readbacks.push({
      forcible: true,
      ready: () => gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED,
      apply: () => {
        const data = new Uint8Array(total);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteBuffer(pack);
        gl.deleteSync(sync);
        dst.land(offset, convertRows(data, t.info, plan, w, h, bytesPerRow));
      },
    });
  }
}

/**
 * How copyTextureToBuffer reads a format: `read` with readPixels in `format`/`type` straight from the texture,
 * `fetch` through a draw into a 32-bit target first (formats WebGL2 cannot attach or read: depth, snorm, shared
 * exponent), `stencil` through bit-plane draws. `texel` is the bytes per texel read; `bytes` WebGPU's.
 */
interface ReadPlan {
  readonly via: 'read' | 'fetch' | 'stencil';
  readonly format: string;
  readonly type: string;
  readonly texel: number;
  readonly bytes: number;
  /** What the buffer receives: the format's own bytes, a depth value or a stencil value. */
  readonly as: 'color' | 'depth' | 'stencil';
}

function readPlan(info: FormatInfo, aspect: GPUTextureAspect): ReadPlan | null {
  const plan = (via: ReadPlan['via'], format: string, type: string, texel: number, bytes: number, as: ReadPlan['as']) =>
    ({ via, format, type, texel, bytes, as }) as const;
  if (info.kind === 'stencil' || (info.kind === 'depth-stencil' && aspect === 'stencil-only'))
    return plan('stencil', 'RGBA', 'UNSIGNED_BYTE', 4, 1, 'stencil');
  if (info.kind === 'depth' || info.kind === 'depth-stencil') {
    // WebGPU copies depth16unorm and depth32float depth (also as the depth aspect of depth32float-stencil8).
    if (info.name === 'depth16unorm') return plan('fetch', 'RGBA', 'FLOAT', 16, 2, 'depth');
    if (info.name === 'depth32float' || (info.name === 'depth32float-stencil8' && aspect === 'depth-only'))
      return plan('fetch', 'RGBA', 'FLOAT', 16, 4, 'depth');
    return null;
  }
  if (!info.renderable || (info.kind === 'float' && info.channelBytes === 0))
    return plan(
      'fetch',
      info.kind === 'float' ? 'RGBA' : 'RGBA_INTEGER',
      info.kind === 'uint' ? 'UNSIGNED_INT' : info.kind === 'sint' ? 'INT' : 'FLOAT',
      16,
      info.bytes,
      'color',
    );
  if (info.kind === 'uint') return plan('read', 'RGBA_INTEGER', 'UNSIGNED_INT', 16, info.bytes, 'color');
  if (info.kind === 'sint') return plan('read', 'RGBA_INTEGER', 'INT', 16, info.bytes, 'color');
  if (info.channelBytes === 1) return plan('read', 'RGBA', 'UNSIGNED_BYTE', 4, info.bytes, 'color');
  return plan('read', 'RGBA', 'FLOAT', 16, info.bytes, 'color');
}

/** An unsigned float with `m` mantissa bits and 5 exponent bits (the 11- and 10-bit floats of rg11b10ufloat). */
function smallFloat(v: number, m: number): number {
  if (!(v > 0)) return 0;
  const h = toHalf(v);
  // A half's 5 exponent bits match; its 10 mantissa bits are cut to m (stored values convert exactly).
  return (h & 0x7fff) >> (10 - m);
}

/** rgb9e5ufloat bits of three values (the shared-exponent encoding of the WebGPU and OpenGL ES specifications). */
function rgb9e5(r: number, g: number, b: number): number {
  const max = (511 / 512) * 2 ** 16,
    c = [r, g, b].map((v) => Math.min(Math.max(v || 0, 0), max));
  const top = Math.max(...c);
  let e = Math.max(-16, Math.floor(Math.log2(top || 2 ** -17))) + 1 + 15;
  if (Math.round(top / 2 ** (e - 15 - 9)) === 512) e++;
  const scale = 2 ** (e - 15 - 9),
    [mr, mg, mb] = c.map((v) => Math.round(v / scale));
  return ((e << 27) | (mb << 18) | (mg << 9) | mr) >>> 0;
}

/** Converts rows read as RGBA into WebGPU's layout of the format, `bytesPerRow` apart. */
function convertRows(
  data: Uint8Array,
  info: FormatInfo,
  plan: ReadPlan,
  w: number,
  h: number,
  bytesPerRow: number,
): Uint8Array {
  const n = plan.bytes,
    out = new Uint8Array(bytesPerRow * (h - 1) + w * n),
    view = new DataView(out.buffer);
  const f32 = new Float32Array(data.buffer, data.byteOffset, data.byteLength >> 2),
    u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2),
    i32 = new Int32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
  for (let row = 0; row < h; row++)
    for (let x = 0; x < w; x++) {
      const px = row * w + x,
        o = row * bytesPerRow + x * n;
      if (plan.as === 'stencil') {
        out[o] = data[px * 4];
        continue;
      }
      if (plan.as === 'depth') {
        const d = f32[px * 4];
        if (n === 2) view.setUint16(o, Math.round(Math.min(Math.max(d, 0), 1) * 65535), true);
        else view.setFloat32(o, d, true);
        continue;
      }
      const f = (c: number) => f32[px * 4 + c];
      switch (info.name) {
        case 'rgb10a2unorm': {
          const q = (c: number, bits: number) => Math.round(Math.min(Math.max(f(c), 0), 1) * (2 ** bits - 1));
          view.setUint32(o, (q(0, 10) | (q(1, 10) << 10) | (q(2, 10) << 20) | (q(3, 2) << 30)) >>> 0, true);
          continue;
        }
        case 'rgb10a2uint': {
          const u = (c: number) => u32[px * 4 + c];
          view.setUint32(
            o,
            ((u(0) & 1023) | ((u(1) & 1023) << 10) | ((u(2) & 1023) << 20) | ((u(3) & 3) << 30)) >>> 0,
            true,
          );
          continue;
        }
        case 'rg11b10ufloat':
          view.setUint32(
            o,
            (smallFloat(f(0), 6) | (smallFloat(f(1), 6) << 11) | (smallFloat(f(2), 5) << 22)) >>> 0,
            true,
          );
          continue;
        case 'rgb9e5ufloat':
          view.setUint32(o, rgb9e5(f(0), f(1), f(2)), true);
          continue;
      }
      for (let c = 0; c < info.channels; c++) {
        const src = info.bgra && c < 3 ? 2 - c : c;
        if (plan.type === 'UNSIGNED_BYTE') out[o + c] = data[px * 4 + src];
        else if (info.kind === 'uint' || info.kind === 'sint') {
          const v = info.kind === 'uint' ? u32[px * 4 + src] : i32[px * 4 + src];
          if (info.channelBytes === 4) view.setUint32(o + c * 4, v >>> 0, true);
          else if (info.channelBytes === 2) view.setUint16(o + c * 2, v & 0xffff, true);
          else out[o + c] = v & 0xff;
        } else if (info.name.includes('snorm'))
          view.setInt8(o + c, Math.round(Math.min(Math.max(f(src), -1), 1) * 127));
        else if (info.channelBytes === 4) view.setFloat32(o + c * 4, f(src), true);
        else view.setUint16(o + c * 2, toHalf(f(src)), true);
      }
    }
  return out;
}
