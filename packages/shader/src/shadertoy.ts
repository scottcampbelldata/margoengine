/// <reference lib="esnext.disposable" preserve="true" />
// Shadertoy programs on Margo: an image source with `void mainImage(out vec4 fragColor, in vec2 fragCoord)` and the
// documented Shadertoy inputs (iResolution, iTime, iTimeDelta, iFrameRate, iFrame, iChannelTime, iChannelResolution,
// iMouse, iDate, iSampleRate, iChannel0 to iChannel3), wrapped as a GLSL ES 3.00 program and drawn as a PostStack
// pass, into a texture each frame, or as a mesh material, with the Common tab, Buffers A to D (rgba32float, each
// reading the others and its own last frame), Cube A (mainCubemap into the six faces of an rgba16float cube), the
// Sound tab (mainSound read back as samples), mainVR with each view's camera rays, keyboard, video and audio
// channels. Optional entry @margoengine/shader/shadertoy. Written clean room from Shadertoy's documented inputs and
// the GLSL ES 3.00 and OpenGL ES 3.0.6 specifications (docs/clean-room.md, "Shadertoy").
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { borrow, type BorrowSlot, fix, isOptionObject, lend, relend } from '../../shared/borrowed.js';
import { fault } from '../../shared/errors.js';
import { copyExternal } from '../../shared/copy-external.js';
import type { StageOutput } from '../../shared/stack.js';
import { ShaderPass, type ShaderPassOptions } from './glsl-pass.js';
import { GLSLMaterial, type ShaderMaterialOptions, type ShaderUniform, type ShaderUniformValue } from './glsl/material.js';
// The type only: a toy's material is the program core, which `instanceof ShaderMaterial` accepts.
import type { ShaderMaterial } from './glsl-material.js';
import type { GLSLTexelFilter } from './glsl/program.js';
import type { RawTextureInput, RawTextureSource } from './raw.js';
import type { BindableTexture } from './texture.js';
import type { ShadertoySound } from './shadertoy/sound.js';

export type { ShadertoySound };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number };
declare const GPUShaderStage: { FRAGMENT: number };

/** A buffer tab: Buffer A to D. */
export type ShadertoyBuffer = 'A' | 'B' | 'C' | 'D';
/** An image or video copied into a channel each frame (a video once it has a frame); iChannelTime is a video's `currentTime`. */
export type ShadertoyMedia = HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | HTMLImageElement;
/** Sound read as a 512 x 2 channel: row 0 (GL's lowest) its spectrum, row 1 its waveform, as an `AnalyserNode` gives them. */
export interface ShadertoyAudio {
  getByteFrequencyData(array: Uint8Array): void;
  getByteTimeDomainData(array: Uint8Array): void;
  /** iChannelTime is its `currentTime`. */
  readonly context?: { readonly currentTime: number };
}
/**
 * What a channel reads: a texture, `'input'` (the stack's colour, in a pass), a buffer (`'A'` to `'D'`), `'cubeA'`
 * (the Cube A tab, a samplerCube), `'keyboard'`, a video or image, an `AnalyserNode`, or null (opaque black, as GL's
 * unbound unit). A texture is a GPUTexture or view, a materials Texture, or `(device) => texture`, called once per
 * device so it comes back by itself after a device restore. A plain GPUTexture or view belongs to the device that made
 * it: after a restore the channel reads opaque black, `engine.onError` hears of it once (`'state'`, #borrowed-lost),
 * and `toy.setChannel(index, texture)` gives it a new one.
 */
export type ShadertoyInput = RawTextureInput | 'input' | ShadertoyBuffer | 'cubeA' | 'keyboard' | ShadertoyMedia | ShadertoyAudio | null;
/** One of iChannel0 to iChannel3 with its sampling. */
export interface ShadertoyChannel {
  /** What the channel reads. */
  readonly texture: ShadertoyInput;
  /**
   * The sampler type the program sees: `'2d'` (sampler2D), `'cube'` (samplerCube) or `'3d'` (sampler3D). Default `'3d'`
   * for a 3D GPUTexture, else `'2d'`; give it for a function that makes a 3D or cube texture.
   */
  readonly type?: '2d' | 'cube' | '3d';
  /** Default `'linear'`. `'mipmap'` is trilinear: buffers, videos, keyboard and audio get their mip levels made each frame; a texture brings its own. */
  readonly filter?: 'nearest' | 'linear' | 'mipmap';
  /** Default `'clamp'`. */
  readonly wrap?: 'clamp' | 'repeat';
  /** iChannelResolution of the channel in pixels. Default the source's size (a function's: the texture it made), or the target for `'input'` and buffers. */
  readonly resolution?: readonly [number, number, number?];
}
/** A pass's source and its four channels. */
export interface ShadertoyPassSource {
  /** GLSL with `void mainImage(out vec4 fragColor, in vec2 fragCoord)`, as written in Shadertoy's editor. */
  readonly source: string;
  readonly iChannel0?: ShadertoyChannel | ShadertoyInput;
  readonly iChannel1?: ShadertoyChannel | ShadertoyInput;
  readonly iChannel2?: ShadertoyChannel | ShadertoyInput;
  readonly iChannel3?: ShadertoyChannel | ShadertoyInput;
}
/** The Cube A tab: a source with `void mainCubemap(out vec4 fragColor, in vec2 fragCoord, in vec3 rayOri, in vec3 rayDir)`. */
export interface ShadertoyCubeSource extends ShadertoyPassSource {
  /** Pixels along each face's edge, a power of two from 1 to 2048. Default 1024. */
  readonly size?: number;
}
/** Options for `toy.sound(options)`. */
export interface ShadertoySoundOptions {
  /** Length in seconds, above 0 and at most 600. Default 180. */
  readonly seconds?: number;
  /** Stops the render: the promise rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}
/** Options for `new Shadertoy(options)`. */
export interface ShadertoyOptions {
  /** The Image tab. */
  readonly image: ShadertoyPassSource;
  /** The Common tab: GLSL placed before every pass's source. */
  readonly common?: string;
  /** Buffer tabs, drawn in the order A, B, C, D before the image each frame into rgba32float targets of the image's size. */
  readonly bufferA?: ShadertoyPassSource;
  readonly bufferB?: ShadertoyPassSource;
  readonly bufferC?: ShadertoyPassSource;
  readonly bufferD?: ShadertoyPassSource;
  /**
   * The Cube A tab, drawn after the buffers each frame into the six faces of an rgba16float cube: rayOri is 0, rayDir
   * the unit direction through the texel's centre (faces as OpenGL ES 3.0.6 Table 3.21), fragCoord the texel's place
   * in its face counted from the face's first row. A channel reads it as `'cubeA'`; Cube A reads its own last frame.
   */
  readonly cubeA?: ShadertoyCubeSource;
  /** The Sound tab: `vec2 mainSound(int samp, float time)` (or the older `vec2 mainSound(float time)`), rendered by `toy.sound()`. Its channels read textures only. */
  readonly sound?: ShadertoyPassSource;
  /**
   * Calls the Image tab's `void mainVR(out vec4 fragColor, in vec2 fragCoord, in vec3 fragRayOri, in vec3 fragRayDir)`
   * in a pass and on a mesh, with each pixel's ray from the camera that draws it (each eye's in an XR frame);
   * `toy.texture` keeps mainImage. Default false.
   */
  readonly vr?: boolean;
  /** Where a `'keyboard'` channel listens for keydown and keyup. Default `globalThis` (the window). */
  readonly keyboard?: EventTarget;
  /** Size in pixels of `toy.texture`, and the iResolution of `toy.material()`. Default `[512, 512]`. */
  readonly resolution?: readonly [number, number];
  /** iSampleRate. Default 44100. */
  readonly sampleRate?: number;
  /** Plugin and debug name. Default `'shader:shadertoy:<n>'`. */
  readonly name?: string;
}
type Kind = 'texture' | 'input' | 'buffer' | 'cubemap' | 'keyboard' | 'media' | 'audio';
type Channel = {
  kind: Kind;
  texture: ShadertoyInput;
  type: '2d' | 'cube' | '3d';
  filter: GLSLTexelFilter['filter'];
  wrap: GLSLTexelFilter['wrap'];
  sampler: GPUSamplerDescriptor;
  resolution?: readonly (number | undefined)[];
  /** A texture channel's texture, held as a borrowed object (shared/borrowed.js). */
  slot?: BorrowSlot<Lent, RawTextureInput>;
  /** The made texture whose dimension did not fit, reported once. */
  misfit?: unknown;
};
type Mode = 'screen' | 'mesh' | 'buffer' | 'cube' | 'sound';
/** A tab of a toy, as `toy.setChannel(index, texture, tab)` names it. */
export type ShadertoyTab = 'image' | 'bufferA' | 'bufferB' | 'bufferC' | 'bufferD' | 'cubeA' | 'sound';
type Tab = ShadertoyTab;
type Lent = GPUTexture | GPUTextureView;
// A ray per pixel for mainVR: the inverse view-projection of the camera drawing, and its position.
type Rays = { eye: number[]; position: readonly number[] };
const channelNames = ['iChannel0', 'iChannel1', 'iChannel2', 'iChannel3'] as const;
const letters = ['A', 'B', 'C', 'D'] as const;
const samplerType = { '2d': 'sampler2D', cube: 'samplerCube', '3d': 'sampler3D' } as const;
const sizes: Partial<Record<Kind, number[]>> = { keyboard: [256, 3, 1], audio: [512, 2, 1] };
const levels = (w: number, h: number) => Math.floor(Math.log2(Math.max(w, h))) + 1;
// The inverse of a 4 x 4 matrix (column-major) by Gauss-Jordan elimination with partial pivoting, into `out`.
function invert(m: ArrayLike<number>, out: number[]): void {
  const a = [0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4, 5, 6, 7].map((c) => (c < 4 ? m[c * 4 + r]! : +(c - 4 === r))));
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    const row = a[p]!,
      d = row[c]!;
    a[p] = a[c]!;
    a[c] = row;
    for (let k = 0; k < 8; k++) row[k] = row[k]! / d;
    for (const other of a) if (other !== row) for (let k = 0, f = other[c]!; k < 8; k++) other[k] = other[k]! - f * row[k]!;
  }
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[r]![4 + c]!;
}

// Opaque black for an unbound channel, as GL reads a texture unit with no texture (OpenGL ES 3.0.6, 3.8.13): one
// 1 x 1 texture per sampler type and device, owned by the program that binds it and destroyed with it.
class Blanks {
  /** The device the program draws on, once known. */
  device?: GPUDevice;
  private readonly made = new Map<GPUDevice, Partial<Record<Channel['type'], GPUTexture>>>();
  /** A 2D blank for any device, as a materials Texture binds; the channel's sampler samples it. */
  readonly flat: BindableTexture = { bind: (device) => [this.view(device, '2d'), undefined!] };
  /** The view of the blank of `type` on `device`, made once. */
  view(device: GPUDevice, type: Channel['type']): GPUTextureView {
    return viewOf(this.texture(device, type), type);
  }
  texture(device: GPUDevice, type: Channel['type']): GPUTexture {
    let held = this.made.get(device);
    if (!held) this.made.set(device, (held = {}));
    let texture = held[type];
    if (!texture) {
      const layers = type === 'cube' ? 6 : 1;
      texture = held[type] = device.createTexture({
        label: 'shader:shadertoy:blank',
        size: [1, 1, layers],
        dimension: type === '3d' ? '3d' : '2d',
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture }, new Uint8Array(layers * 4).fill(255).map((v, i) => (i % 4 === 3 ? v : 0)), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, layers]);
    }
    return texture;
  }
  /** The texture an unbound channel of `type` reads: null (raw's white) until the device is known for cube and 3D. */
  of(type: Channel['type']): RawTextureSource | null {
    return type === '2d' ? this.flat : this.device ? this.texture(this.device, type) : null;
  }
  destroy(): void {
    for (const held of this.made.values()) for (const t of Object.values(held)) t?.destroy();
    this.made.clear();
  }
}
// Mip levels made by a 2 x 2 box of texel loads, level by level (GL leaves generateMipmap's filter to the
// implementation, OpenGL ES 3.0.6 3.8.11; a box is the common one); loads work on any float format, filterable or not.
const mipCode = `@group(0) @binding(0) var src:texture_2d<f32>;
@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(f32(i&1u)*4.0-1.0,f32(i>>1u)*4.0-1.0,0.0,1.0);}
@fragment fn f(@builtin(position) p:vec4f)->@location(0) vec4f{let n=vec2i(textureDimensions(src))-1;let i=vec2i(p.xy)*2;
return (textureLoad(src,min(i,n),0)+textureLoad(src,min(i+vec2i(1,0),n),0)+textureLoad(src,min(i+vec2i(0,1),n),0)+textureLoad(src,min(i+vec2i(1,1),n),0))*0.25;}`;
class Mips {
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private layout?: GPUBindGroupLayout;
  private readonly groups = new WeakMap<GPUTexture, { group: GPUBindGroup; view: GPUTextureView }[]>();
  constructor(private readonly device: GPUDevice) {}
  make(encoder: GPUCommandEncoder, texture: GPUTexture): void {
    const device = this.device,
      format = texture.format;
    this.layout ??= device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }] });
    let pipeline = this.pipelines.get(format);
    if (!pipeline) {
      const module = device.createShaderModule({ label: 'shader:shadertoy:mips', code: mipCode });
      pipeline = device.createRenderPipeline({
        label: 'shader:shadertoy:mips',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        vertex: { module, entryPoint: 'v' },
        fragment: { module, entryPoint: 'f', targets: [{ format }] },
      });
      this.pipelines.set(format, pipeline);
    }
    let steps = this.groups.get(texture);
    if (!steps) {
      steps = [];
      for (let l = 1; l < texture.mipLevelCount; l++)
        steps.push({
          group: device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: texture.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) }] }),
          view: texture.createView({ baseMipLevel: l, mipLevelCount: 1 }),
        });
      this.groups.set(texture, steps);
    }
    for (const s of steps) {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: s.view, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, s.group);
      pass.draw(3);
      pass.end();
    }
  }
}
// One view per texture and sampler type, so a channel binds the same view every frame.
const views = new WeakMap<GPUTexture, Partial<Record<Channel['type'], GPUTextureView>>>();
function viewOf(texture: Lent, type: Channel['type']): GPUTextureView {
  if (typeof (texture as GPUTexture).createView !== 'function') return texture as GPUTextureView;
  let held = views.get(texture as GPUTexture);
  if (!held) views.set(texture as GPUTexture, (held = {}));
  return (held[type] ??= (texture as GPUTexture).createView({ dimension: type }));
}
// Whether a GPUTexture can be read as `type`: a 3D texture by sampler3D only, a cube from six layers.
function fits(texture: unknown, type: Channel['type']): boolean {
  const t = texture as Partial<GPUTexture> | null;
  if (!t || typeof t !== 'object' || typeof t.createView !== 'function' || typeof t.dimension !== 'string') return true;
  if ((t.dimension === '3d') !== (type === '3d')) return false;
  return type !== 'cube' || typeof t.depthOrArrayLayers !== 'number' || t.depthOrArrayLayers === 6;
}
const misfit = (name: string, type: Channel['type']) =>
  `Shadertoy ${name} is a ${type === '2d' ? 'sampler2D' : samplerType[type]} channel; give it ${type === '3d' ? 'a 3D texture' : type === 'cube' ? 'a 2D texture of six layers' : 'a 2D texture'}`;
// A materials Texture (an object that binds itself; a function's own `bind` is Function.prototype's).
const isTexture = (v: unknown): v is BindableTexture => !!v && typeof v === 'object' && typeof (v as BindableTexture).bind === 'function';
const isBuffer = (v: unknown): v is ShadertoyBuffer => (letters as readonly unknown[]).includes(v);
function kindOf(texture: ShadertoyInput): Kind {
  if (texture === 'input') return 'input';
  if (texture === 'keyboard') return 'keyboard';
  if (texture === 'cubeA') return 'cubemap';
  if (isBuffer(texture)) return 'buffer';
  if (texture && typeof texture === 'object') {
    if ('getByteFrequencyData' in texture) return 'audio';
    if (!('createView' in texture) && !('bind' in texture) && ('videoWidth' in texture || 'width' in texture)) return 'media';
  }
  return 'texture';
}
function channelOf(given: ShadertoyChannel | ShadertoyInput | undefined, name: string, setter: string, tabs: readonly string[]): Channel {
  const c = (isOptionObject(given) && 'texture' in given ? given : { texture: (given ?? null) as ShadertoyInput }) as ShadertoyChannel;
  const texture = c.texture,
    kind = kindOf(texture),
    gpu = kind === 'texture' && texture && typeof texture === 'object' && 'createView' in texture ? (texture as GPUTexture) : undefined,
    fixedType = kind === 'cubemap' ? 'cube' : '2d',
    type = c.type ?? (kind === 'cubemap' ? 'cube' : gpu?.dimension === '3d' ? '3d' : '2d');
  if (!(type in samplerType)) throw new TypeError(`Shadertoy ${name} type must be '2d', 'cube' or '3d'`);
  if (kind === 'texture' && !fits(texture, type)) throw new TypeError(misfit(name, type));
  if (kind !== 'texture' && type !== fixedType)
    throw new TypeError(`Shadertoy ${name}: ${kind === 'cubemap' ? 'Cube A' : kind === 'buffer' ? 'a buffer' : kind === 'input' ? "the stack's colour" : 'this channel'} is a ${fixedType} channel; leave type out or use '${fixedType}'`);
  if (kind === 'buffer' && !tabs.includes(texture as string)) throw new TypeError(`Shadertoy ${name} reads Buffer ${texture as string}, which this toy does not have; add buffer${texture as string}`);
  if (kind === 'cubemap' && !tabs.includes('cubeA')) throw new TypeError(`Shadertoy ${name} reads Cube A, which this toy does not have; add cubeA`);
  const filter = c.filter ?? 'linear',
    wrap = c.wrap ?? 'clamp',
    address = wrap === 'repeat' ? 'repeat' : 'clamp-to-edge',
    linear = filter === 'nearest' ? 'nearest' : 'linear';
  if (filter !== 'nearest' && filter !== 'linear' && filter !== 'mipmap') throw new TypeError(`Shadertoy ${name} filter must be 'nearest', 'linear' or 'mipmap'`);
  if (wrap !== 'clamp' && wrap !== 'repeat') throw new TypeError(`Shadertoy ${name} wrap must be 'clamp' or 'repeat'`);
  // A texture channel's size is read from what it binds (Shadertoy.sizeOf); a given resolution wins.
  const resolution = c.resolution ?? sizes[kind];
  const sampler: GPUSamplerDescriptor = { magFilter: linear, minFilter: linear, addressModeU: address, addressModeV: address, addressModeW: address };
  // GL reads only the base level unless the min filter names mipmaps (OpenGL ES 3.0.6 section 3.8.10); a WebGPU
  // sampler would pick a level by the footprint, so a texture with mip levels is clamped to its base level here.
  if (filter === 'mipmap') sampler.mipmapFilter = 'linear';
  else sampler.lodMaxClamp = 0;
  const slot = kind === 'texture' ? borrow<Lent, RawTextureInput>(texture as RawTextureInput | null, `Shadertoy ${name}`, setter) : undefined;
  return { kind, texture, type, filter, wrap, sampler, resolution, ...(slot && { slot }) };
}
// The program around a tab: the documented inputs, then Common, then the source, then a main that calls mainImage at
// GL's window coordinates (OpenGL ES 3.0.6 section 3.5: gl_FragCoord counts from the lower left, pixel centres at
// .5), or at uv * iResolution on a mesh. The image writes opaque colour; a buffer keeps all four components. With vr
// the image calls mainVR with the pixel's ray: in a pass from a near-plane point of the inverse view-projection (Margo's
// reversed depth puts the near plane at z 1), on a mesh from the camera to the surface. Cube A and Sound draw with
// gl_FragCoord counting rows from the target's first row in memory (clipSpace 'webgpu'), as GL's window rows count
// from a framebuffer texture's first row, so their texels hold what GL's would. PRELUDE_LINES lines come before Common.
const PRELUDE_LINES = 3;
const calls = {
  screen: 'mainImage(shadertoyOut,gl_FragCoord.xy)',
  mesh: 'mainImage(shadertoyOut,shadertoyUv*iResolution.xy)',
  vrscreen:
    'vec4 shadertoyNear=shadertoyEye*vec4(gl_FragCoord.xy/iResolution.xy*2.0-1.0,1.0,1.0);mainVR(shadertoyOut,gl_FragCoord.xy,shadertoyEyePosition,normalize(shadertoyNear.xyz/shadertoyNear.w-shadertoyEyePosition))',
  vrmesh: 'mainVR(shadertoyOut,shadertoyUv*iResolution.xy,shadertoyRayOri,normalize(shadertoyRay))',
  // Faces in a 3 x 2 atlas, +X -X +Y in the first rows and -Y +Z -Z after them; s and t from the texel centre turned
  // back into a direction by the inverse of Table 3.21.
  cube:
    'float shadertoyS=iResolution.x;vec2 shadertoyA=gl_FragCoord.xy,shadertoyP=mod(shadertoyA,shadertoyS),shadertoyT=shadertoyP/shadertoyS*2.0-1.0;' +
    'int shadertoyF=int(shadertoyA.x/shadertoyS)+3*int(shadertoyA.y/shadertoyS);vec3 shadertoyD=vec3(-shadertoyT.x,-shadertoyT.y,-1.0);' +
    'if(shadertoyF==0)shadertoyD=vec3(1.0,-shadertoyT.y,-shadertoyT.x);else if(shadertoyF==1)shadertoyD=vec3(-1.0,-shadertoyT.y,shadertoyT.x);else if(shadertoyF==2)shadertoyD=vec3(shadertoyT.x,1.0,shadertoyT.y);' +
    'else if(shadertoyF==3)shadertoyD=vec3(shadertoyT.x,-1.0,-shadertoyT.y);else if(shadertoyF==4)shadertoyD=vec3(shadertoyT.x,-shadertoyT.y,1.0);' +
    'mainCubemap(shadertoyOut,shadertoyP,vec3(0.0),normalize(shadertoyD))',
  // Sample numbers run along the block's rows from its first row.
  sound: 'int shadertoyN=shadertoySoundBase+int(gl_FragCoord.y)*512+int(gl_FragCoord.x);shadertoyOut=vec4(clamp(mainSound(',
} as const;
// `vec2 mainSound(int samp, float time)`; the older form takes the time alone.
const soundTakesSample = (source: string) => /\bmainSound\s*\(\s*(?:(?:in|const|highp|mediump|lowp)\s+)*int\b/.test(source);
function wrap(source: string, channels: readonly Channel[], mode: Mode, common: string, vr = false): string {
  const samplers = channels.map((c, i) => `uniform ${samplerType[c.type]} iChannel${i};`).join(''),
    call =
      mode === 'sound'
        ? `${calls.sound}${soundTakesSample(source) ? 'shadertoyN,' : ''}float(shadertoyN)/iSampleRate),-1.0,1.0),0.0,1.0)`
        : mode === 'cube'
          ? calls.cube
          : vr && mode !== 'buffer'
            ? calls[`vr${mode as 'screen' | 'mesh'}`]
            : calls[mode === 'mesh' ? 'mesh' : 'screen'];
  return (
    '#version 300 es\n' +
    'precision highp float;precision highp int;precision highp sampler3D;' +
    'uniform vec3 iResolution;uniform float iTime;uniform float iTimeDelta;uniform float iFrameRate;uniform int iFrame;' +
    'uniform float iChannelTime[4];uniform vec3 iChannelResolution[4];uniform vec4 iMouse;uniform vec4 iDate;uniform float iSampleRate;' +
    samplers +
    (mode === 'sound' ? 'uniform int shadertoySoundBase;' : '') +
    (vr && mode === 'screen' ? 'uniform mat4 shadertoyEye;uniform vec3 shadertoyEyePosition;' : '') +
    (vr && mode === 'mesh' ? 'in vec3 shadertoyRayOri;in vec3 shadertoyRay;' : '') +
    (mode === 'mesh' ? 'in vec2 shadertoyUv;' : '') +
    'out vec4 shadertoyColor;\n' +
    '#define iGlobalTime iTime\n' +
    (common ? common + '\n' : '') +
    source +
    `\nvoid main(){vec4 shadertoyOut=vec4(0.0,0.0,0.0,1.0);${call};shadertoyColor=${mode === 'screen' || mode === 'mesh' ? 'vec4(shadertoyOut.rgb,1.0)' : 'shadertoyOut'};}\n`
  );
}
const meshVertex = (vr: boolean) =>
  `#version 300 es\nin vec3 position;in vec2 uv;out vec2 shadertoyUv;${vr ? 'out vec3 shadertoyRayOri;out vec3 shadertoyRay;' : ''}\n` +
  `void main(){shadertoyUv=uv;${vr ? 'shadertoyRayOri=cameraPosition;shadertoyRay=(modelMatrix*vec4(position,1.0)).xyz-cameraPosition;' : ''}gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}\n`;
// The channels that read buffers bind as unfilterable textures and filter by texel loads, so a buffer reads the same
// on every device, with or without float32-filterable.
const unfilterable = (channels: readonly Channel[]) =>
  Object.fromEntries(channels.flatMap((c, i) => (c.kind === 'buffer' ? [[channelNames[i]!, { filter: c.filter, wrap: c.wrap }]] : [])));
// A {value} whose value is read when the program draws.
const live = (read: () => ShaderUniformValue): ShaderUniform =>
  ({
    get value() {
      return read();
    },
    set value(_) {
      throw new TypeError('Shadertoy inputs are read only here; set toy.time, toy.frame, toy.mouse or toy.date instead');
    },
  }) as ShaderUniform;
const output = (): StageOutput => ({ view: undefined!, format: 'rgba32float', multisample: { count: 1 }, hdr: false });
type Held = { textures: GPUTexture[]; views: GPUTextureView[]; targets: GPUTextureView[]; front: number };

/** A program of a toy: a ShaderPass that runs the clock when the toy is not attached itself, and the buffers first. */
class ShadertoyPass extends ShaderPass {
  constructor(
    private readonly toy: Shadertoy,
    fragmentShader: string,
    /** iResolution: the size of the target drawn into. */
    private readonly size: number[],
    private readonly blanks: Blanks,
    uniforms: Record<string, ShaderUniform>,
    options: ShaderPassOptions,
    /** The buffers this pass draws before itself (toy.pass() only). */
    private readonly chain?: Chain,
    /** A buffer tab writes its values as they are; `'fixed'` (Cube A, Sound) also keeps iResolution as given. */
    private readonly buffer: boolean | 'fixed' = false,
    /** mainVR's rays, set from the camera of each draw. */
    private readonly rays?: Rays,
  ) {
    super({ fragmentShader, uniforms }, options);
  }
  /** Seconds on the toy's clock (iTime). */
  get time(): number {
    return this.toy.time;
  }
  /** One frame of the toy's clock without drawing; each frame update runs it, so `seek` from `@margoengine/cutscene/seek` replays it exactly. */
  advanceTime(delta: number): void {
    this.toy.tick(delta, this);
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  protected override encoding(format: GPUTextureFormat): number {
    return this.buffer ? 1 : super.encoding(format);
  }
  protected override render(c: Context, input: GPUTextureView, output: StageOutput): void {
    if (this.buffer !== 'fixed') {
      this.size[0] = c.width;
      this.size[1] = c.height;
    }
    if (this.rays) {
      invert(c.camera.matrix, this.rays.eye);
      this.rays.position = c.camera.position;
    }
    this.blanks.device = c.device;
    if (this.chain) {
      this.toy.refresh(c.device, c.encoder);
      this.chain.run(c, input);
    }
    super.render(c, input, output);
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    this.toy.adopt(engine);
  }
  override onDeviceRestored(): void {
    this.blanks.destroy();
    this.chain?.release();
    super.onDeviceRestored();
  }
  override dispose(): void {
    this.blanks.destroy();
    this.chain?.dispose();
    super.dispose();
  }
  /** @internal Draws into `output` with `c` as the frame. */
  drawInto(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.render(c, input, output);
  }
}
/**
 * The buffers of one consumer (a pass, or the attached toy's texture and materials), at its size: each buffer's two
 * rgba32float textures take turns, so a buffer reads its own last frame and the latest image of every other buffer.
 */
class Chain {
  readonly size = [0, 0, 1];
  readonly passes: { letter: ShadertoyBuffer; pass: ShadertoyPass; mips: boolean }[] = [];
  /**
   * Cube A: drawn into a 3 x 2 atlas of its faces (one draw), then copied face by face into the cube that channels
   * read, so the program reads its last frame from the cube while it draws. Mip levels are made in the atlas, where a
   * 2 x 2 box never crosses a face of a power of two size, and copied level by level.
   */
  cube?: { pass: ShadertoyPass; size: number; mips: boolean; atlas?: GPUTexture; target?: GPUTextureView; texture?: GPUTexture; view?: GPUTextureView };
  private readonly held = new Map<ShadertoyBuffer, Held>();
  private device?: GPUDevice;
  private step?: number;
  private mips?: Mips;
  private readonly out = output();
  private frame?: { base: Context; context: Context };
  constructor(
    private readonly toy: Shadertoy,
    /** Fixed size, or undefined to follow the target. */
    private readonly fixed?: readonly [number, number],
  ) {}
  /** The view a channel reading buffer `letter` binds: its latest image. */
  view(letter: ShadertoyBuffer): BindableTexture {
    return { bind: () => { const h = this.held.get(letter); return h && [h.views[h.front]!, undefined!]; } };
  }
  run(c: Context, input: GPUTextureView | undefined): void {
    const [width, height] = this.fixed ?? [c.width, c.height];
    if (this.device !== c.device || this.size[0] !== width || this.size[1] !== height) {
      this.release();
      this.device = c.device;
      this.size[0] = width;
      this.size[1] = height;
      for (const { letter, mips } of this.passes) this.held.set(letter, this.make(c.device, letter, mips));
      if (this.cube) this.makeCube(c.device, this.cube);
    }
    // Paused, the buffers hold until the frame is set.
    const step = this.toy.step();
    if (step === this.step) return;
    this.step = step;
    if (this.frame?.base !== c) this.frame = { base: c, context: Object.create(c, { width: { value: width }, height: { value: height }, view: { value: undefined } }) as Context };
    for (const { letter, pass, mips } of this.passes) {
      const h = this.held.get(letter)!;
      this.out.view = h.targets[1 - h.front]!;
      pass.drawInto(this.frame.context, input!, this.out);
      h.front = 1 - h.front;
      if (mips) (this.mips ??= new Mips(c.device)).make(c.encoder, h.textures[h.front]!);
    }
    const q = this.cube;
    if (q) {
      const s = q.size;
      this.half.view = q.target!;
      q.pass.drawInto(Object.create(c, { width: { value: 3 * s }, height: { value: 2 * s }, view: { value: undefined } }) as Context, input!, this.half);
      if (q.mips) (this.mips ??= new Mips(c.device)).make(c.encoder, q.atlas!);
      for (let l = 0; l < q.texture!.mipLevelCount; l++)
        for (let f = 0, e = s >> l; f < 6; f++)
          c.encoder.copyTextureToTexture({ texture: q.atlas!, mipLevel: l, origin: [(f % 3) * e, Math.floor(f / 3) * e, 0] }, { texture: q.texture!, mipLevel: l, origin: [0, 0, f] }, [e, e, 1]);
    }
  }
  private readonly half: StageOutput = { view: undefined!, format: 'rgba16float', multisample: { count: 1 }, hdr: false };
  private makeCube(device: GPUDevice, q: NonNullable<Chain['cube']>): void {
    const s = q.size,
      mipLevelCount = q.mips ? levels(s, s) : 1;
    q.atlas = device.createTexture({
      label: 'shader:shadertoy:cubeA:atlas',
      size: [3 * s, 2 * s],
      mipLevelCount,
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    q.target = q.atlas.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    q.texture = device.createTexture({
      label: 'shader:shadertoy:cubeA',
      size: [s, s, 6],
      mipLevelCount,
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    q.view = q.texture.createView({ dimension: 'cube' });
  }
  private make(device: GPUDevice, letter: ShadertoyBuffer, mips: boolean): Held {
    const [width, height] = this.size as [number, number],
      textures = [0, 1].map(() =>
        device.createTexture({
          label: `shader:shadertoy:buffer${letter}`,
          size: [width, height],
          mipLevelCount: mips ? levels(width, height) : 1,
          format: 'rgba32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
      );
    return { textures, views: textures.map((t) => t.createView()), targets: textures.map((t) => t.createView({ baseMipLevel: 0, mipLevelCount: 1 })), front: 0 };
  }
  /** Drops the textures (on a new device or size); they start again at zero. */
  release(): void {
    for (const h of this.held.values()) for (const t of h.textures) t.destroy();
    this.held.clear();
    const q = this.cube;
    if (q) {
      q.atlas?.destroy();
      q.texture?.destroy();
      q.atlas = q.target = q.texture = q.view = undefined;
    }
    this.device = this.mips = this.step = undefined;
  }
  ready(): Promise<unknown> {
    return Promise.all([...this.passes.map((p) => p.pass), this.cube?.pass].map((p) => p?.ready()));
  }
  dispose(): void {
    this.release();
    for (const p of this.passes) p.pass.dispose();
    this.cube?.pass.dispose();
  }
}
/** The material `toy.material()` returns, which owns the blanks of its unbound channels. */
class ShadertoyMaterial extends GLSLMaterial {
  constructor(
    private readonly blanks: Blanks,
    options: ShaderMaterialOptions,
  ) {
    super(options);
  }
  override dispose(): void {
    this.blanks.destroy();
    super.dispose();
  }
}
// The keyboard, video and audio channels' textures, made per device and filled once a frame.
type Feed = { texture?: GPUTexture; view?: GPUTextureView; copied?: unknown };
let toys = 0;
/**
 * A Shadertoy program: `new Shadertoy(source)` or `new Shadertoy({image: {source, iChannel0: 'A'}, bufferA: {source}})`.
 * Draw it as a pass (`PostStack.attach(engine, [toy.pass()])`), into a texture (`engine.use(toy)`, then read
 * `toy.texture`), or on a mesh (`engine.use(toy)` and `shaderMesh(geometry, toy.material())`). `toy.time`,
 * `toy.frame`, `toy.mouse` and `toy.date` are the inputs; the clock runs from the frame delta unless paused.
 */
export class Shadertoy implements EnginePlugin {
  readonly name: string;
  /** The Image tab's source. */
  readonly source: string;
  /** The GLSL ES 3.00 program around the Image source that a pass and the texture draw, mainImage at gl_FragCoord. */
  readonly fragmentShader: string;
  /** With `vr`: the program a pass draws, mainVR with each pixel's ray. */
  readonly vrShader?: string;
  /** The program `toy.material()` draws: mainImage (mainVR with `vr`) at the mesh's uv times `resolution`. */
  readonly meshShaders: { readonly vertexShader: string; readonly fragmentShader: string };
  /** The GLSL ES 3.00 program of each buffer tab given, drawn into its rgba32float target. */
  readonly buffers: Readonly<Partial<Record<ShadertoyBuffer, string>>>;
  /** The Cube A program, drawn into a 3 x 2 atlas of faces (+X -X +Y, then -Y +Z -Z) with gl_FragCoord rows from the top. */
  readonly cubeShader?: string;
  /** The Sound program: one sample per pixel, 512 per row from the first row, from the sample `shadertoySoundBase` on. */
  readonly soundShader?: string;
  /** Size of `toy.texture` and iResolution of `toy.material()`, in pixels. */
  readonly resolution: readonly [number, number];
  /** iTime in seconds. Settable. */
  time = 0;
  /** iFrame. Settable; while paused, setting it runs the buffers once. */
  frame = 0;
  /** iTimeDelta in seconds. Settable. */
  timeDelta = 0;
  /** iFrameRate. Default 60 until a frame has run; settable. */
  frameRate = 60;
  /** iSampleRate. */
  sampleRate: number;
  /** iMouse: xy the current pixel while a button is down, zw the pixel of the click. Settable. */
  mouse: [number, number, number, number] = [0, 0, 0, 0];
  private readonly common: string;
  private readonly tabs: { tab: Tab; source: string; channels: Channel[] }[];
  private readonly soundTab?: { tab: Tab; source: string; channels: Channel[] };
  private readonly vr: boolean;
  private readonly cubeSize: number;
  private readonly jobs = new Set<{ frame(c: Context): void; stop(reason: unknown): void }>();
  private readonly today: [number, number, number, number] = [0, 0, 0, 0];
  private dateSet?: readonly number[];
  private paused = false;
  private started = false;
  private ticker?: object;
  private ticks = 0;
  private drawn = -1;
  private refreshed?: number;
  private disposed = false;
  private engine?: Engine;
  // The engine of an attached toy.pass(), where texture channels report when the toy itself is not attached.
  private host?: Engine;
  private image?: ShadertoyPass;
  private materials = 0;
  private own?: Chain;
  private readonly targets = new Map<GPUDevice, { texture: GPUTexture; view: GPUTextureView; sampler: GPUSampler }>();
  private readonly output: StageOutput = { view: undefined!, format: 'rgba8unorm', multisample: { count: 1 }, hdr: false };
  private frameContext?: { base: Context; context: Context };
  private readonly made: { dispose(): void }[] = [];
  private readonly feeds = new Map<Channel, Feed>();
  private feedDevice?: GPUDevice;
  private mips?: Mips;
  private readonly keys = { down: new Uint8Array(256), pressed: new Uint8Array(256), toggled: new Uint8Array(256) };
  private keyTarget?: EventTarget;
  private readonly onKey = (e: Event) => {
    const k = (e as KeyboardEvent).keyCode;
    if (!(k >= 0 && k < 256)) return;
    if (e.type === 'keyup') this.keys.down[k] = 0;
    else if (!this.keys.down[k]) {
      this.keys.down[k] = this.keys.pressed[k] = 255;
      this.keys.toggled[k] ^= 255;
    }
  };
  /** Same as `engine.use(new Shadertoy(options))`: the attached toy runs the clock and draws `toy.texture`; returns it. */
  static attach(engine: EngineKernel, options: string | ShadertoyOptions): Shadertoy {
    const toy = new Shadertoy(options);
    engine.use(toy);
    return toy;
  }
  constructor(options: string | ShadertoyOptions) {
    const o: ShadertoyOptions = typeof options === 'string' ? { image: { source: options } } : options;
    const source = o?.image?.source;
    if (typeof source !== 'string' || !/\bmainImage\b/.test(source))
      throw new TypeError('Shadertoy needs the Image source with void mainImage(out vec4 fragColor, in vec2 fragCoord)');
    const [w, h] = o.resolution ?? [512, 512];
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 8192 || h > 8192)
      throw new RangeError('Shadertoy resolution must be two integers from 1 to 8192');
    if (o.common !== undefined && typeof o.common !== 'string') throw new TypeError('Shadertoy common must be GLSL text');
    this.source = source;
    this.common = o.common ?? '';
    this.resolution = [w, h];
    this.sampleRate = o.sampleRate ?? 44100;
    this.name = o.name ?? 'shader:shadertoy:' + toys++;
    const buffers = letters.filter((l) => o[`buffer${l}`] !== undefined),
      given: string[] = [...buffers];
    for (const l of buffers)
      if (typeof o[`buffer${l}`]?.source !== 'string' || !/\bmainImage\b/.test(o[`buffer${l}`]!.source))
        throw new TypeError(`Shadertoy buffer${l} needs a source with void mainImage(out vec4 fragColor, in vec2 fragCoord)`);
    const cube = o.cubeA,
      size = (this.cubeSize = cube?.size ?? 1024);
    if (cube !== undefined) {
      if (typeof cube?.source !== 'string' || !/\bmainCubemap\b/.test(cube.source))
        throw new TypeError('Shadertoy cubeA needs a source with void mainCubemap(out vec4 fragColor, in vec2 fragCoord, in vec3 rayOri, in vec3 rayDir)');
      if (!Number.isInteger(size) || size < 1 || size > 2048 || size & (size - 1)) throw new RangeError('Shadertoy cubeA size must be a power of two from 1 to 2048');
      given.push('cubeA');
    }
    if (o.sound !== undefined && (typeof o.sound?.source !== 'string' || !/\bmainSound\b/.test(o.sound.source)))
      throw new TypeError('Shadertoy sound needs a source with vec2 mainSound(int samp, float time)');
    this.vr = o.vr === true;
    if (this.vr && !/\bmainVR\b/.test(source))
      throw new TypeError('Shadertoy vr: true needs void mainVR(out vec4 fragColor, in vec2 fragCoord, in vec3 fragRayOri, in vec3 fragRayDir) in the Image source');
    const tab = (t: Tab, p: ShadertoyPassSource) => ({
      tab: t,
      source: p.source,
      channels: channelNames.map((n, i) => channelOf(p[n], `${t === 'image' ? '' : t + ' '}${n}`, `toy.setChannel(${i}, texture${t === 'image' ? '' : `, '${t}'`})`, given)),
    });
    this.tabs = [...letters.filter((l) => given.includes(l)).map((l) => tab(`buffer${l}`, o[`buffer${l}`]!)), ...(cube ? [tab('cubeA', cube)] : []), tab('image', o.image)];
    const image = this.tabs.at(-1)!.channels;
    this.fragmentShader = wrap(source, image, 'screen', this.common);
    if (this.vr) this.vrShader = wrap(source, image, 'screen', this.common, true);
    this.meshShaders = { vertexShader: meshVertex(this.vr), fragmentShader: wrap(source, image, 'mesh', this.common, this.vr) };
    this.buffers = Object.fromEntries(this.tabs.filter((t) => t.tab.startsWith('buffer')).map((t) => [t.tab.slice(6), wrap(t.source, t.channels, 'buffer', this.common)]));
    if (cube) this.cubeShader = wrap(cube.source, this.tabs.at(-2)!.channels, 'cube', this.common);
    if (o.sound) {
      const t = (this.soundTab = tab('sound', o.sound)),
        i = t.channels.findIndex((c) => c.kind !== 'texture');
      if (i >= 0) throw new TypeError(`Shadertoy sound iChannel${i} reads textures only; give it a texture or null`);
      this.soundShader = wrap(t.source, t.channels, 'sound', this.common);
    }
    if (this.tabs.some((t) => t.channels.some((c) => c.kind === 'keyboard'))) {
      this.keyTarget = o.keyboard ?? (globalThis as unknown as EventTarget);
      this.keyTarget.addEventListener?.('keydown', this.onKey);
      this.keyTarget.addEventListener?.('keyup', this.onKey);
    }
  }
  /** iDate: year, month (January is 0, as JavaScript's Date), day and seconds since midnight. Settable; default the clock's. */
  get date(): readonly [number, number, number, number] {
    if (this.dateSet) return this.dateSet as [number, number, number, number];
    const d = new Date();
    this.today[0] = d.getFullYear();
    this.today[1] = d.getMonth();
    this.today[2] = d.getDate();
    this.today[3] = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
    return this.today;
  }
  set date(value: readonly number[] | undefined) {
    if (value !== undefined && (value.length !== 4 || !Array.from(value).every(Number.isFinite)))
      throw new TypeError('Shadertoy date must be [year, month, day, seconds] or undefined for the clock');
    this.dateSet = value && [...value];
  }
  /** Stops the clock: time and frame stay until set or `play()`, and the buffers hold their images. */
  pause(): void {
    this.paused = true;
  }
  play(): void {
    this.paused = false;
  }
  /** Back to time 0, frame 0. */
  reset(): void {
    this.time = this.frame = this.timeDelta = 0;
    this.started = false;
  }
  /** @internal One frame of the clock; the first caller of a frame owns it. */
  tick(delta: number, owner: object): void {
    if ((this.ticker ??= owner) !== owner) return;
    this.ticks++;
    if (this.paused) return;
    if (this.started) {
      this.time += delta;
      this.frame++;
    }
    this.started = true;
    this.timeDelta = delta;
    if (delta > 0) this.frameRate = 1 / delta;
  }
  /** @internal What advances the buffers: the frame tick, or the frame number while paused. */
  step(): number {
    return this.paused ? -1 - this.frame : this.ticks;
  }
  /** @internal Fills the keyboard, video and audio channels once a frame. */
  refresh(device: GPUDevice, encoder: GPUCommandEncoder): void {
    // Once a frame of the toy: paused, the channels hold (and keys pressed stay pressed) until the frame is set.
    const step = this.step();
    if (this.refreshed === step && this.feedDevice === device) return;
    this.refreshed = step;
    if (this.feedDevice !== device) {
      this.releaseFeeds();
      this.feedDevice = device;
    }
    for (const t of this.tabs)
      for (const c of t.channels) {
        if (c.kind !== 'keyboard' && c.kind !== 'media' && c.kind !== 'audio') continue;
        let feed = this.feeds.get(c);
        if (!feed) this.feeds.set(c, (feed = {}));
        if (this.fill(device, c, feed) && c.filter === 'mipmap') (this.mips ??= new Mips(device)).make(encoder, feed.texture!);
      }
    this.keys.pressed.fill(0);
  }
  // One channel's texture for this frame: keyboard rows from GL's lowest (down, pressed this frame, toggled), audio
  // rows spectrum then waveform, a video's current frame. Margo stores rows from the top, so GL's row 0 is the last.
  private fill(device: GPUDevice, c: Channel, feed: Feed): boolean {
    let [w, h] = sizes[c.kind] ?? [0, 0];
    if (c.kind === 'media') {
      const m = c.texture as HTMLVideoElement;
      if ('readyState' in m && m.readyState < 2) return false;
      w = m.videoWidth ?? m.width;
      h = m.videoHeight ?? m.height;
      if (!w || !h) return false;
      if (feed.copied === m && !('readyState' in m) && !('getContext' in m)) return false;
    }
    if (!feed.texture || feed.texture.width !== w || feed.texture.height !== h) {
      feed.texture?.destroy();
      feed.texture = device.createTexture({
        label: 'shader:shadertoy:' + c.kind,
        size: [w, h],
        mipLevelCount: c.filter === 'mipmap' ? levels(w, h) : 1,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      feed.view = feed.texture.createView();
    }
    if (c.kind === 'media') {
      // A video in a browser that refuses one as the source (Firefox) goes through a canvas (shared/copy-external.js).
      copyExternal(device, { source: c.texture as ShadertoyMedia }, { texture: feed.texture }, [w, h]);
      feed.copied = c.texture;
    } else {
      const data = new Uint8Array(w * h * 4),
        rows =
          c.kind === 'keyboard'
            ? [this.keys.toggled, this.keys.pressed, this.keys.down]
            : (() => {
                const a = c.texture as ShadertoyAudio,
                  wave = new Uint8Array(512),
                  spectrum = new Uint8Array(512);
                a.getByteTimeDomainData(wave);
                a.getByteFrequencyData(spectrum);
                return [wave, spectrum];
              })();
      rows.forEach((row, y) => row.forEach((v, x) => data.set([v, 0, 0, 255], (y * w + x) * 4)));
      device.queue.writeTexture({ texture: feed.texture }, data, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h]);
    }
    return true;
  }
  private releaseFeeds(): void {
    for (const f of this.feeds.values()) f.texture?.destroy();
    this.feeds.clear();
    this.mips = this.feedDevice = undefined;
  }
  // The uniforms of one program: the shared inputs read live, iResolution of its own target, channels of its tab.
  private uniforms(size: readonly number[], blanks: Blanks, channels: readonly Channel[], chain?: Chain): Record<string, ShaderUniform> {
    const channelResolution = new Array<number>(12).fill(0),
      channelTime = [0, 0, 0, 0],
      out: Record<string, ShaderUniform> = {
        iResolution: live(() => size as number[]),
        iTime: live(() => this.time),
        iTimeDelta: live(() => this.timeDelta),
        iFrameRate: live(() => this.frameRate),
        iFrame: live(() => this.frame),
        iChannelTime: live(() => {
          channels.forEach((c, i) => {
            const t = c.texture as { currentTime?: number; context?: { currentTime?: number } };
            channelTime[i] = (c.kind === 'media' ? t.currentTime : c.kind === 'audio' ? t.context?.currentTime : 0) ?? 0;
          });
          return channelTime;
        }),
        iChannelResolution: live(() => {
          channels.forEach((c, i) => {
            const m = c.texture as HTMLVideoElement,
              r =
                c.kind === 'input' || c.kind === 'buffer'
                  ? (chain?.size ?? size)
                  : c.kind === 'cubemap'
                    ? [this.cubeSize, this.cubeSize, 1]
                    : c.kind === 'media' && !c.resolution
                      ? [m.videoWidth ?? m.width, m.videoHeight ?? m.height]
                      : c.kind === 'texture' && !c.resolution
                        ? this.sizeOf(c, blanks.device)
                        : (c.resolution ?? [0, 0, 0]);
            channelResolution[i * 3] = r[0] ?? 0;
            channelResolution[i * 3 + 1] = r[1] ?? 0;
            channelResolution[i * 3 + 2] = r[2] ?? 1;
          });
          return channelResolution;
        }),
        iMouse: live(() => this.mouse),
        iDate: live(() => this.date),
        iSampleRate: live(() => this.sampleRate),
      };
    channels.forEach((c, i) => {
      if (c.kind === 'input') return;
      const feed: BindableTexture = { bind: (d, srgb) => { const v = this.feeds.get(c)?.view; return v ? [v, undefined!] : blanks.flat.bind(d, srgb); } },
        // A texture channel binds what its slot lends on the device drawing (the blanks learn it before each draw), as a
        // view of its sampler type; a lost or missing one reads the blank.
        lent = (): RawTextureSource | null => {
          const device = blanks.device,
            value = c.slot!.value,
            v = device ? this.lent(c, device) : typeof value === 'function' ? undefined : value;
          if (v) return isTexture(v) ? v : viewOf(v as Lent, c.type);
          return device ? blanks.view(device, c.type) : blanks.of(c.type);
        },
        texture = c.kind === 'buffer' ? chain!.view(c.texture as ShadertoyBuffer) : feed;
      const pair = {
        // Cube A binds its cube view itself (a materials Texture is 2D only), once the chain has made it.
        get texture() {
          return (c.kind === 'cubemap' ? chain!.cube?.view : c.kind === 'texture' ? lent() : texture) ?? blanks.of(c.type);
        },
        sampler: c.sampler,
      };
      out[channelNames[i]!] = live(() => pair as ShaderUniformValue);
    });
    return out;
  }
  // What a texture channel binds on `device`: a materials Texture as given, else the slot's texture of this device.
  private lent(c: Channel, device: GPUDevice): Lent | BindableTexture | undefined {
    const slot = c.slot!,
      value = slot.value;
    if (isTexture(value)) return value;
    const got = lend(slot, device, this.engine ?? this.host);
    if (got && !fits(got, c.type)) {
      if (c.misfit !== got) {
        c.misfit = got;
        (this.engine ?? this.host)?.onError(fault('failed', misfit(slot.name.slice('Shadertoy '.length), c.type)));
      }
      return undefined;
    }
    return got;
  }
  // iChannelResolution of a texture channel: the size of what it binds, [0, 0, 0] when it binds nothing or a view.
  private sizeOf(c: Channel, device: GPUDevice | undefined): readonly number[] {
    const value = c.slot!.value,
      t = (device ? this.lent(c, device) : typeof value === 'function' ? undefined : value) as Partial<GPUTexture> | undefined;
    return typeof t?.width === 'number' && typeof t.height === 'number' ? [t.width, t.height, c.type === '3d' ? (t.depthOrArrayLayers ?? 1) : 1] : [0, 0, 0];
  }
  /** @internal A pass of this toy was attached to `engine`: its texture channels report there and belong to its device. */
  adopt(engine: Engine): void {
    this.host = engine;
    this.fixSlots(engine.gpu);
  }
  private fixSlots(device: GPUDevice | null | undefined): void {
    if (device) for (const t of [...this.tabs, ...(this.soundTab ? [this.soundTab] : [])]) for (const c of t.channels) if (c.slot) fix(c.slot, device);
  }
  /**
   * Gives channel `index` (0 to 3) of `tab` (default the Image tab) something new to read, of the kind it was made
   * with: a texture channel takes a GPUTexture or view of its sampler type, a materials Texture, `(device) => texture`
   * (called once per device) or null (opaque black); a video or image channel takes another, an audio channel another
   * `AnalyserNode`. The toy's own channels (`'input'`, a buffer, `'cubeA'`, `'keyboard'`) are fixed when it is made.
   * After a device restore a plain GPUTexture or view reads opaque black until this gives it a new one.
   * @throws TypeError for a missing tab, a channel of another kind, or a texture of another sampler type
   */
  setChannel(index: 0 | 1 | 2 | 3, texture: ShadertoyInput, tab: ShadertoyTab = 'image'): void {
    if (this.disposed) throw new MargoError('disposed', `${this.name} is disposed; create a new Shadertoy`);
    const t = tab === 'sound' ? this.soundTab : this.tabs.find((x) => x.tab === tab),
      c = t?.channels[index];
    if (!t) throw new TypeError(`Shadertoy has no ${tab} tab; give new Shadertoy({${tab}: ...}) one`);
    if (!c) throw new RangeError('Shadertoy setChannel index must be 0, 1, 2 or 3');
    const name = `${tab === 'image' ? '' : tab + ' '}iChannel${index}`,
      kind = kindOf(texture ?? null);
    if (c.kind === 'texture' && kind === 'texture') {
      if (!fits(texture, c.type)) throw new TypeError(misfit(name, c.type));
      relend(c.slot!, texture as RawTextureInput | null, (this.engine ?? this.host)?.gpu);
      c.texture = texture ?? null;
      c.misfit = undefined;
      return;
    }
    if ((c.kind === 'media' || c.kind === 'audio') && kind === c.kind) {
      c.texture = texture;
      const feed = this.feeds.get(c);
      if (feed) feed.copied = undefined;
      return;
    }
    const reads = { texture: 'a texture', media: 'a video or image', audio: 'an AnalyserNode', input: "the stack's colour", buffer: `Buffer ${String(c.texture)}`, cubemap: 'Cube A', keyboard: 'the keyboard' }[c.kind];
    throw new TypeError(
      c.kind === 'texture'
        ? `Shadertoy ${name} reads a texture; setChannel gives it a texture, a function or null`
        : c.kind === 'media' || c.kind === 'audio'
          ? `Shadertoy ${name} reads ${reads}; setChannel gives it ${reads}`
          : `Shadertoy ${name} reads ${reads}, which the toy draws itself; make a new Shadertoy to read something else`,
    );
  }
  private refuseInput(where: string): void {
    for (const t of this.tabs) {
      const i = t.channels.findIndex((c) => c.kind === 'input');
      if (i >= 0) throw new MargoError('failed', `Shadertoy ${t.tab} iChannel${i} reads the stack's colour, which only toy.pass() has; give ${where} a texture`);
    }
  }
  // A program of tab `t`; a syntax or link error names the line of its tab (or of Common), not of the program around it.
  private program<T>(t: { tab: Tab }, make: () => T): T {
    try {
      return make();
    } catch (error) {
      const e = error as { line?: unknown; stage?: unknown; tab?: string },
        common = this.common ? this.common.split('\n').length : 0;
      if (typeof e?.line === 'number' && e.stage === 'fragment' && e.line > PRELUDE_LINES) {
        e.tab = e.line > PRELUDE_LINES + common ? t.tab : 'common';
        e.line -= e.line > PRELUDE_LINES + common ? PRELUDE_LINES + common : PRELUDE_LINES;
      }
      throw error;
    }
  }
  // The buffers of one consumer, each a ShadertoyPass drawing its tab into rgba32float.
  private chain(fixed?: readonly [number, number]): Chain | undefined {
    if (this.tabs.length < 2) return undefined;
    const chain = new Chain(this, fixed);
    for (const t of this.tabs.slice(0, -1)) {
      const letter = t.tab.slice(6) as ShadertoyBuffer,
        blanks = new Blanks(),
        input = t.channels.findIndex((c) => c.kind === 'input'),
        mips = this.tabs.some((u) => u.channels.some((c) => c.filter === 'mipmap' && (t.tab === 'cubeA' ? c.kind === 'cubemap' : c.kind === 'buffer' && c.texture === letter)));
      if (t.tab === 'cubeA') {
        const size = [this.cubeSize, this.cubeSize, 1];
        const pass = this.program(t, () => new ShadertoyPass(this, this.cubeShader!, size, blanks, this.uniforms(size, blanks, t.channels, chain), {
          builtins: false,
          input: input < 0 ? null : channelNames[input]!,
          unfilterable: unfilterable(t.channels),
          name: `${this.name}:cubeA`,
          clipSpace: 'webgpu',
        } as ShaderPassOptions, undefined, 'fixed'));
        chain.cube = { pass, size: this.cubeSize, mips };
        continue;
      }
      const pass = this.program(t, () => new ShadertoyPass(this, this.buffers[letter]!, chain.size, blanks, this.uniforms(chain.size, blanks, t.channels, chain), {
        builtins: false,
        input: input < 0 ? null : channelNames[input]!,
        unfilterable: unfilterable(t.channels),
        name: `${this.name}:buffer${letter}`,
      }, undefined, true));
      chain.passes.push({ letter, pass, mips });
    }
    return chain;
  }
  private imageTab() {
    return this.tabs.at(-1)!;
  }
  /**
   * The program as a PostStack stage: `PostStack.attach(engine, [toy.pass()])`. iResolution is the target's size (the
   * buffers' too), and a channel given `'input'` reads the colour of the stage before. Runs the clock unless the toy is
   * attached itself.
   */
  pass(options: Omit<ShaderPassOptions, 'input' | 'builtins' | 'glslVersion' | 'unfilterable'> = {}): ShaderPass {
    const t = this.imageTab(),
      input = t.channels.findIndex((c) => c.kind === 'input'),
      size = [0, 0, 1],
      blanks = new Blanks(),
      chain = this.chain(),
      rays: Rays | undefined = this.vr ? { eye: new Array<number>(16).fill(0), position: [0, 0, 0] } : undefined;
    const pass = this.program(
      t,
      () =>
        new ShadertoyPass(this, this.vrShader ?? this.fragmentShader, size, blanks, {
          ...this.uniforms(size, blanks, t.channels, chain),
          ...(rays && { shadertoyEye: live(() => rays.eye), shadertoyEyePosition: live(() => rays.position as number[]) }),
        }, {
          ...options,
          builtins: false,
          input: input < 0 ? null : channelNames[input]!,
          unfilterable: unfilterable(t.channels),
        }, chain ?? this.feedless(), false, rays),
    );
    this.made.push(pass);
    return pass;
  }
  // A pass with no buffers still fills its keyboard, video and audio channels: an empty chain runs them.
  private feedless(): Chain | undefined {
    return this.tabs.some((t) => t.channels.some((c) => c.kind === 'keyboard' || c.kind === 'media' || c.kind === 'audio')) ? new Chain(this) : undefined;
  }
  /**
   * The program as a mesh material: fragCoord is the mesh's uv times `resolution`. Attach the toy
   * (`engine.use(toy)`) so its clock and buffers run. Options are ShaderMaterial's render state.
   */
  material(options: Omit<ShaderMaterialOptions, 'vertexShader' | 'fragmentShader' | 'uniforms' | 'builtins' | 'glslVersion' | 'unfilterable' | 'lights' | 'fog' | 'velocity'> = {}): ShaderMaterial {
    this.refuseInput('toy.material()');
    const t = this.imageTab(),
      blanks = new Blanks();
    // A material is drawn by RawShaders, so its unbound cube and 3D channels learn the device from the attached toy.
    Object.defineProperty(blanks, 'device', { get: () => this.engine?.gpu, set() {} });
    this.own ??= this.chain(this.resolution);
    const material = this.program(
      t,
      () =>
        new ShadertoyMaterial(blanks, {
          ...options,
          ...this.meshShaders,
          uniforms: this.uniforms([...this.resolution, 1], blanks, t.channels, this.own),
          builtins: 'modelViewMatrix',
          unfilterable: unfilterable(t.channels),
        }),
    );
    this.materials++;
    this.made.push(material);
    return material;
  }
  /**
   * The image, drawn once a frame at `resolution` while the toy is attached (`engine.use(toy)`), for any raw, node or
   * GLSL material; texels are the values mainImage writes, row 0 at the top as Margo's images.
   */
  get texture(): BindableTexture {
    this.refuseInput('toy.texture');
    if (!this.image) {
      const t = this.imageTab(),
        blanks = new Blanks();
      this.own ??= this.chain(this.resolution);
      this.image = this.program(t, () =>
        new ShadertoyPass(this, this.fragmentShader, [0, 0, 1], blanks, this.uniforms([...this.resolution, 1], blanks, t.channels, this.own), {
          builtins: false,
          input: null,
          unfilterable: unfilterable(t.channels),
          name: this.name + ':image',
        }),
      );
    }
    return this.view;
  }
  private readonly view: BindableTexture = {
    bind: (device) => {
      const t = this.target(device);
      return [t.view, t.sampler];
    },
  };
  private target(device: GPUDevice) {
    let t = this.targets.get(device);
    if (!t) {
      const [width, height] = this.resolution,
        texture = device.createTexture({
          label: this.name + ':texture',
          size: [width, height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });
      this.targets.set(device, (t = { texture, view: texture.createView(), sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) }));
    }
    return t;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', `${this.name} is disposed; create a new Shadertoy`);
    if (!engine.gpu) throw new MargoError('unsupported', 'Shadertoy requires WebGPU; use a WebGPU engine');
    this.engine = engine;
    this.fixSlots(engine.gpu);
  }
  /** One frame of the clock (iTime, iFrame) without drawing; each frame update runs it, so `seek` from `@margoengine/cutscene/seek` replays it exactly. */
  advanceTime(delta: number): void {
    this.tick(delta, this);
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  registerPasses(graph: FrameGraph): void {
    // Before the scene, so materials reading the texture or the buffers see this frame's images.
    graph.add({ name: this.name + ':texture', order: -50, execute: (c) => this.draw(c as Context) });
  }
  /**
   * Renders the Sound tab over the next frames while the toy is attached (`engine.use(toy)`), 262,144 samples a
   * frame: `mainSound` at each sample number and its time at `sampleRate`, left and right clamped to -1 to 1.
   */
  async sound(options: ShadertoySoundOptions = {}): Promise<ShadertoySound> {
    const t = this.soundTab,
      { seconds = 180, signal } = options;
    if (!t) throw new MargoError('failed', 'Shadertoy has no Sound tab; give new Shadertoy({image, sound: {source}}) a source with vec2 mainSound(int samp, float time)');
    if (!(seconds > 0 && seconds <= 600)) throw new RangeError('Shadertoy sound seconds must be above 0 and at most 600');
    if (!this.engine) throw new MargoError('state', 'toy.sound() renders while the toy is attached; call engine.use(toy) first');
    signal?.throwIfAborted();
    const { SoundJob, EDGE } = await import('./shadertoy/sound.js'),
      at = { base: 0 },
      size = [EDGE, EDGE, 1],
      blanks = new Blanks();
    const pass = this.program(t, () => new ShadertoyPass(this, this.soundShader!, size, blanks, { ...this.uniforms(size, blanks, t.channels), shadertoySoundBase: live(() => at.base) }, {
      builtins: false,
      input: null,
      name: this.name + ':sound',
      clipSpace: 'webgpu',
    } as ShaderPassOptions, undefined, 'fixed'));
    const job = new SoundJob(Math.ceil(seconds * this.sampleRate), this.sampleRate, (c, base, output) => {
      at.base = base;
      pass.drawInto(c, undefined!, output);
    }, signal);
    this.jobs.add(job);
    try {
      return await job.done;
    } finally {
      this.jobs.delete(job);
      pass.dispose();
    }
  }
  private draw(c: Context): void {
    for (const job of this.jobs) job.frame(c);
    if ((!this.image && !this.materials) || this.drawn === this.ticks) return;
    this.drawn = this.ticks;
    const [width, height] = this.resolution;
    if (this.frameContext?.base !== c)
      this.frameContext = { base: c, context: Object.create(c, { width: { value: width }, height: { value: height }, view: { value: undefined } }) as Context };
    this.refresh(c.device, c.encoder);
    this.own?.run(this.frameContext.context, undefined);
    if (!this.image) return;
    const t = this.target(c.device);
    this.output.view = t.view;
    this.image.drawInto(this.frameContext.context, t.view, this.output);
  }
  /** Resolves when the programs made so far have compiled. */
  async ready(): Promise<void> {
    await Promise.all([this.image, ...this.made, this.own].map((m) => (m as { ready?: () => Promise<unknown> } | undefined)?.ready?.()));
  }
  onDeviceRestored(): void {
    for (const t of this.targets.values()) t.texture.destroy();
    this.targets.clear();
    this.releaseFeeds();
    this.own?.release();
  }
  /** Releases the textures and the programs this toy made, and stops listening to the keyboard. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs) job.stop(new MargoError('disposed', `${this.name} was disposed during toy.sound(); create a new Shadertoy`));
    for (const t of this.targets.values()) t.texture.destroy();
    this.targets.clear();
    this.releaseFeeds();
    this.keyTarget?.removeEventListener?.('keydown', this.onKey);
    this.keyTarget?.removeEventListener?.('keyup', this.onKey);
    this.image?.dispose();
    this.own?.dispose();
    for (const m of this.made.splice(0)) m.dispose();
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
