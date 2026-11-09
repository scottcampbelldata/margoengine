/// <reference lib="esnext.disposable" preserve="true" />
import { checkCamera, checkLayer } from './validation.js';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { Point2D } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number; COPY_SRC: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

let emissivePluginCount = 0;

/** Configuration for an emissive glowing sprite in 2D. */
export interface EmissiveSpriteItem2D {
  /** World x coordinate. Default 0. */
  x?: number;
  /** World y coordinate. Default 0. */
  y?: number;
  /** Shape of the emissive sprite: 'circle' or 'box'. Default 'circle'. */
  shape?: 'circle' | 'box';
  /** Radius in world units for circle sprites. Default 16. */
  radius?: number;
  /** Width in world units for box sprites. Default 32. */
  width?: number;
  /** Height in world units for box sprites. Default 32. */
  height?: number;
  /** Emissive hex color string (#rrggbb). Default '#ffffff'. */
  color?: string;
  /** Emission intensity multiplier (1.0 = standard, > 1.0 = HDR glow). Default 1.0. */
  intensity?: number;
  /** How far the emitted light reaches beyond the sprite boundary in world units. Default 48. */
  glowRadius?: number;
  /** Falloff exponent for emitted light: higher is steeper falloff. Default 2. */
  falloff?: number;
  /** Minimum luminance threshold above which light bleeds into bloom. Default 0.8. */
  bloomThreshold?: number;
  /** Bloom glow strength multiplier. Default 1.0. */
  bloomStrength?: number;
  /** Layer bitmask this emissive sprite belongs to. Default ~0. */
  layer?: number;
}

/** One emissive sprite item. */
export class EmissiveSprite2D implements Required<EmissiveSpriteItem2D> {
  x: number;
  y: number;
  shape: 'circle' | 'box';
  radius: number;
  width: number;
  height: number;
  color: string;
  intensity: number;
  glowRadius: number;
  falloff: number;
  bloomThreshold: number;
  bloomStrength: number;
  layer: number;

  constructor(options: EmissiveSpriteItem2D = {}) {
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.shape = options.shape ?? 'circle';
    this.radius = options.radius ?? 16;
    this.width = options.width ?? 32;
    this.height = options.height ?? 32;
    this.color = options.color ?? '#ffffff';
    this.intensity = options.intensity ?? 1.0;
    this.glowRadius = options.glowRadius ?? 48;
    this.falloff = options.falloff ?? 2;
    this.bloomThreshold = options.bloomThreshold ?? 0.8;
    this.bloomStrength = options.bloomStrength ?? 1.0;
    this.layer = options.layer ?? 0xffffffff;
    checkEmissiveSprite(this);
  }
}

/** Validates an {@link EmissiveSpriteItem2D}. Throws RangeError if invalid. */
export function checkEmissiveSprite(sp: EmissiveSpriteItem2D): void {
  if (sp.shape !== undefined && sp.shape !== 'circle' && sp.shape !== 'box') {
    throw rangeError('Unknown emissive sprite shape', 'pixel-lighting');
  }
  if (sp.x !== undefined && !Number.isFinite(sp.x)) throw rangeError('Invalid x', 'pixel-lighting');
  if (sp.y !== undefined && !Number.isFinite(sp.y)) throw rangeError('Invalid y', 'pixel-lighting');
  if (sp.radius !== undefined && (!Number.isFinite(sp.radius) || sp.radius <= 0)) {
    throw rangeError('Invalid sprite radius: must be positive', 'pixel-lighting');
  }
  if (sp.width !== undefined && (!Number.isFinite(sp.width) || sp.width <= 0)) {
    throw rangeError('Invalid sprite width: must be positive', 'pixel-lighting');
  }
  if (sp.height !== undefined && (!Number.isFinite(sp.height) || sp.height <= 0)) {
    throw rangeError('Invalid sprite height: must be positive', 'pixel-lighting');
  }
  if (sp.intensity !== undefined && (!Number.isFinite(sp.intensity) || sp.intensity < 0)) {
    throw rangeError('Invalid sprite intensity: must be non-negative', 'pixel-lighting');
  }
  if (sp.glowRadius !== undefined && (!Number.isFinite(sp.glowRadius) || sp.glowRadius < 0)) {
    throw rangeError('Invalid glow radius: must be non-negative', 'pixel-lighting');
  }
  if (sp.falloff !== undefined && (!Number.isFinite(sp.falloff) || sp.falloff <= 0)) {
    throw rangeError('Invalid falloff: must be positive', 'pixel-lighting');
  }
  for (const field of ['bloomStrength', 'bloomThreshold'] as const) {
    if (sp[field] !== undefined && (!Number.isFinite(sp[field]) || sp[field]! < 0)) {
      throw rangeError(`Invalid ${field}`, 'pixel-lighting');
    }
  }
  if (sp.layer !== undefined) checkLayer(sp.layer);
  if (sp.color !== undefined && !hexColor(sp.color)) {
    throw rangeError('Invalid emissive color', 'pixel-lighting');
  }
}

/**
 * CPU reference form: computes [r, g, b] emitted light and bloom glow
 * from an emissive sprite at world point (x, y).
 */
export function emissiveLightAt(
  sprite: EmissiveSpriteItem2D,
  x: number,
  y: number,
  layerMask?: number,
  bloomIntensity: number = 1.0,
  bloomThreshold: number = 0.8,
): number[] {
  checkEmissiveSprite(sprite);
  if (![bloomIntensity, bloomThreshold].every(Number.isFinite) || bloomIntensity < 0 || bloomThreshold < 0) throw rangeError('Invalid bloomIntensity', 'pixel-lighting');
  const spLayer = sprite.layer ?? 0xffffffff;
  if (layerMask !== undefined && (spLayer & layerMask) === 0) return [0, 0, 0];

  const sx = sprite.x ?? 0,
    sy = sprite.y ?? 0,
    shape = sprite.shape ?? 'circle',
    radius = sprite.radius ?? 16,
    halfW = (sprite.width ?? 32) * 0.5,
    halfH = (sprite.height ?? 32) * 0.5,
    glowR = sprite.glowRadius ?? 48,
    falloff = sprite.falloff ?? 2,
    intensity = sprite.intensity ?? 1.0,
    threshold = Math.max(sprite.bloomThreshold ?? 0.8, bloomThreshold),
    strength = sprite.bloomStrength ?? 1.0,
    rgb = hexColor(sprite.color ?? '#ffffff')!;

  const dx = x - sx,
    dy = y - sy;

  let inside = false;
  let distFromEdge = 0;

  if (shape === 'circle') {
    const dist = Math.hypot(dx, dy);
    if (dist <= radius) {
      inside = true;
    } else if (dist < radius + glowR) {
      distFromEdge = dist - radius;
    }
  } else {
    const ox = Math.max(0, Math.abs(dx) - halfW);
    const oy = Math.max(0, Math.abs(dy) - halfH);
    const dist = Math.hypot(ox, oy);
    if (dist === 0) {
      inside = true;
    } else if (dist < glowR) {
      distFromEdge = dist;
    }
  }

  let amount = 0;
  let bloom = 0;

  if (inside) {
    amount = intensity;
    const peak = Math.max(rgb[0], rgb[1], rgb[2]) * intensity;
    if (peak > threshold) {
      bloom = intensity * (peak - threshold) / peak * strength * bloomIntensity;
    }
  } else if (distFromEdge > 0 && glowR > 0) {
    const atten = Math.max(0, 1 - distFromEdge / glowR) ** falloff;
    const added = intensity * atten;
    amount = added;
    const luma = Math.max(rgb[0] * added, rgb[1] * added, rgb[2] * added);
    if (luma > threshold) {
      bloom = added * (luma - threshold) / luma * strength * bloomIntensity;
    }
  }

  const total = amount + bloom;
  return [rgb[0] * total, rgb[1] * total, rgb[2] * total];
}

/** Options for the {@link EmissiveLighting2D} plugin. */
export interface EmissiveLighting2DOptions {
  /** Target texture or function returning target texture. */
  target?: GPUTexture | (() => GPUTexture);
  /** Active emissive sprites. */
  sprites?: readonly EmissiveSpriteItem2D[];
  /** Camera configuration. Default { x: 0, y: 0, zoom: 1 }. */
  camera?: { x: number; y: number; zoom: number };
  /** Whether bloom glow calculation is enabled. Default true. */
  bloom?: boolean;
  /** Global bloom intensity multiplier. Default 1.0. */
  bloomIntensity?: number;
  /** Global bloom threshold. Default 0.8. */
  bloomThreshold?: number;
  /** Pass name. */
  name?: string;
  /** Pass order in frameGraph. Default 22. */
  order?: number;
  /** Layer mask for filtering sprites. Default ~0. */
  layer?: number;
}

const EMISSIVE_WGSL = /* wgsl */ `
struct EmissiveSpriteGPU{
pos:vec2f,size:vec2f,colorIntensity:vec4f,params:vec4f,flags:vec4u,}
struct Uniforms{
camX:f32,camY:f32,camZoom:f32,targetW:f32,targetH:f32,spriteCount:u32,passLayer:u32,enableBloom:u32,bloomThreshold:f32,bloomIntensity:f32,pad0:f32,pad1:f32,}
@group(0)@binding(0)var<uniform>uniforms:Uniforms;
@group(0)@binding(1)var<storage,read>sprites:array<EmissiveSpriteGPU>;
struct VertexOutput{
@builtin(position)position:vec4f,@location(0)uv:vec2f,}
@vertex fn vs_main(@builtin(vertex_index)index:u32)->VertexOutput{
var out:VertexOutput;
let x=f32((index<<1u)&2u);
let y=f32(index&2u);
out.position=vec4f(x*2.0 - 1.0,1.0 - y*2.0,0.0,1.0);
out.uv=vec2f(x,y);
return out;
}
struct EmissionOutput{
@location(0)emission:vec4f,@location(1)extracted:vec4f,}
@fragment fn fs_main(in:VertexOutput)->EmissionOutput{
let screenPos=in.position.xy;
let worldPos=vec2f(uniforms.camX+screenPos.x/uniforms.camZoom,uniforms.camY+screenPos.y/uniforms.camZoom);
var totalLight=vec3f(0.0);
var bloomGlow=vec3f(0.0);
for(var i=0u;
i<uniforms.spriteCount;
i=i+1u){
let sp=sprites[i];
if((sp.flags.y&uniforms.passLayer)==0u){
continue;
}
let d=worldPos - sp.pos;
var inside=false;
var distFromEdge=0.0;
let shape=sp.flags.x;
let glowR=sp.params.y;
let falloff=sp.params.x;
if(shape==0u){
let r=sp.size.x;
let dist=length(d);
if(dist<=r){
inside=true;
}
else if(dist<r+glowR){
distFromEdge=dist - r;
}
}
else{
let hw=sp.size.x;
let hh=sp.size.y;
let ox=max(0.0,abs(d.x)- hw);
let oy=max(0.0,abs(d.y)- hh);
let dist=length(vec2f(ox,oy));
if(dist==0.0){
inside=true;
}
else if(dist<glowR){
distFromEdge=dist;
}
}
let col=sp.colorIntensity.xyz;
let intens=sp.colorIntensity.w;
if(inside){
totalLight+=col*intens;
let peak=max(col.r,max(col.g,col.b))*intens;
if(uniforms.enableBloom==1u&&peak>max(sp.params.z,uniforms.bloomThreshold)){
bloomGlow+=col*(intens*(peak - max(sp.params.z,uniforms.bloomThreshold))/peak*sp.params.w*uniforms.bloomIntensity);
}
}
else if(distFromEdge>0.0&&glowR>0.0){
let atten=pow(max(0.0,1.0 - distFromEdge/glowR),falloff);
let added=intens*atten;
totalLight+=col*added;
let luma=max(col.r*added,max(col.g*added,col.b*added));
if(uniforms.enableBloom==1u&&luma>max(sp.params.z,uniforms.bloomThreshold)){
bloomGlow+=col*(added*(luma - max(sp.params.z,uniforms.bloomThreshold))/luma*sp.params.w*uniforms.bloomIntensity);
}
}
}
let finalColor=totalLight+bloomGlow;
var result:EmissionOutput;
result.emission=vec4f(finalColor,1.0);
result.extracted=vec4f(bloomGlow,1.0);
return result;
}
@group(1)@binding(0)var image:texture_2d<f32>;
@fragment fn present(in:VertexOutput)->@location(0)vec4f{
return textureLoad(image,vec2i(in.position.xy),0);
}
`;

/** An owned, unattached image effect, such as a new Bloom from @margoengine/post/bloom. */
export interface EmissiveBloom2D {
  encodeImage(context: { device: GPUDevice; encoder: GPUCommandEncoder; width: number; height: number }, input: GPUTextureView, output: GPUTextureView): void;
  dispose(): void;
}

/**
 * 2D Emissive Sprites & Bloom hookup plugin.
 * Adds glowing emissive sprites and isolates high-luminance light for bloom.
 */
export class EmissiveLighting2D implements EnginePlugin, Disposable {
  readonly name: string;
  readonly order: number;
  readonly #sprites = new Set<EmissiveSprite2D>();
  #engine: Engine | null = null;
  #pipeline: GPURenderPipeline | null = null;
  #presentation: GPURenderPipeline | null = null;
  #createBloom?: () => EmissiveBloom2D;
  #bloomPass?: EmissiveBloom2D;
  #filtered: GPUTexture | null = null;
  #uniformBuffer: GPUBuffer | null = null;
  #storageBuffer: GPUBuffer | null = null;
  #bindGroupLayout: GPUBindGroupLayout | null = null;
  #device: GPUDevice | null = null;
  #format: string | null = null;
  #disposed = false;
  #target?: GPUTexture | (() => GPUTexture);
  /** Owned rgba16float emission and local glow, excluding all other scene lighting. Replaced on resize/restore. */
  emissiveTexture: GPUTexture | null = null;
  /** Owned rgba16float local threshold extraction, before spatial filtering. */
  bloomTexture: GPUTexture | null = null;
  camera: { x: number; y: number; zoom: number };
  bloom: boolean;
  bloomIntensity: number;
  bloomThreshold: number;
  layer: number;

  constructor(options: EmissiveLighting2DOptions = {}) {
    this.name = options.name ?? `emissive-lighting2d-${++emissivePluginCount}`;
    this.order = options.order ?? 22;
    this.#target = options.target;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.bloom = options.bloom ?? true;
    this.bloomIntensity = options.bloomIntensity ?? 1.0;
    this.bloomThreshold = options.bloomThreshold ?? 0.8;
    this.layer = options.layer ?? 0xffffffff;
    this.#validate();

    if (options.sprites) {
      for (const sp of options.sprites) this.addSprite(sp);
    }
  }

  static attach(instance: EngineKernel, options: EmissiveLighting2DOptions = {}): EmissiveLighting2D {
    const emissive = new EmissiveLighting2D(options);
    const runtime = engineRuntime(instance);
    if (!runtime.gpu || typeof runtime.gpu.createShaderModule !== 'function') {
      throw fault('unsupported', 'WebGL2 is not supported for @margoengine/lighting2d/emissive; use WebGPU', 'pixel-lighting');
    }
    runtime.use(emissive);
    return emissive;
  }

  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', 'EmissiveLighting2D disposed; create a new one');
    if (engine.backend !== 'webgpu' || !engine.gpu) {
      throw fault('unsupported', 'WebGL2 is not supported for @margoengine/lighting2d/emissive; use WebGPU', 'pixel-lighting');
    }
    this.#engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.order,
      execute: (c: PassContext) => {
        if (c.backend === 'webgpu') this.render(this.#target, c.encoder);
      },
    });
  }

  /** Adds an emissive sprite. */
  addSprite(options: EmissiveSpriteItem2D = {}): EmissiveSprite2D {
    if (this.#disposed) throw typeError('EmissiveLighting2D has been disposed', 'pixel-lighting');
    const sprite = new EmissiveSprite2D(options);
    this.#sprites.add(sprite);
    return sprite;
  }

  /** Removes an emissive sprite. */
  removeSprite(sprite: EmissiveSprite2D): boolean {
    return this.#sprites.delete(sprite);
  }

  /** Takes ownership of an unattached Bloom made per device. Called again after restoration. */
  connectBloom(create: () => EmissiveBloom2D): void {
    if (this.#disposed) throw typeError('EmissiveLighting2D has been disposed', 'pixel-lighting');
    if (typeof create !== 'function') throw typeError('connectBloom needs a factory returning an unattached Bloom', 'pixel-lighting');
    this.#bloomPass?.dispose();
    this.#bloomPass = undefined;
    this.#createBloom = create;
  }

  /** Renders the emissive pass onto target texture. */
  render(targetTexture: GPUTexture | (() => GPUTexture) | undefined, commandEncoder?: GPUCommandEncoder): void {
    if (!this.#engine || !this.#engine.gpu || this.#disposed) return;
    const device = this.#engine.gpu;
    const target = typeof targetTexture === 'function' ? targetTexture() : targetTexture;
    if (!target) return;
    this.#validate();
    for (const sprite of this.#sprites) checkEmissiveSprite(sprite);

    if (this.#device !== device || this.#format !== target.format) {
      this.#release();
      this.#device = device;
      this.#format = target.format;
    }
    if (!this.emissiveTexture || this.emissiveTexture.width !== target.width || this.emissiveTexture.height !== target.height) {
      this.emissiveTexture?.destroy();
      this.bloomTexture?.destroy();
      this.#filtered?.destroy();
      const descriptor = {
        size: [target.width, target.height], format: 'rgba16float' as const,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      };
      this.emissiveTexture = device.createTexture({ ...descriptor, label: 'emissive HDR' });
      this.bloomTexture = device.createTexture({ ...descriptor, label: 'emissive threshold extraction' });
      this.#filtered = device.createTexture({ ...descriptor, label: 'emissive spatial bloom' });
    }
    if (!this.#pipeline) {
      const module = device.createShaderModule({ code: EMISSIVE_WGSL });
      this.#bindGroupLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 48 } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        ],
      });
      this.#pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.#bindGroupLayout] }),
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }],
        },
      });
      this.#presentation = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'present', targets: [{ format: target.format }] },
      });
    }

    const spriteList = Array.from(this.#sprites);
    const count = spriteList.length;
    const bufferSize = Math.max(64, count * 64);
    if (bufferSize > device.limits.maxStorageBufferBindingSize) {
      throw rangeError('Emissive sprites exceed maxStorageBufferBindingSize', 'pixel-lighting');
    }
    if (!this.#storageBuffer || this.#storageBuffer.size < bufferSize) {
      this.#storageBuffer?.destroy();
      this.#storageBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }

    const spriteFloats = new Float32Array(bufferSize / 4);
    const spriteU32 = new Uint32Array(spriteFloats.buffer);

    for (let i = 0; i < count; i++) {
      const sp = spriteList[i];
      const base = i * 16;
      spriteFloats[base + 0] = sp.x;
      spriteFloats[base + 1] = sp.y;

      if (sp.shape === 'box') {
        spriteFloats[base + 2] = sp.width * 0.5;
        spriteFloats[base + 3] = sp.height * 0.5;
      } else {
        spriteFloats[base + 2] = sp.radius;
        spriteFloats[base + 3] = 0;
      }

      const rgb = hexColor(sp.color) ?? [1, 1, 1];
      spriteFloats[base + 4] = rgb[0];
      spriteFloats[base + 5] = rgb[1];
      spriteFloats[base + 6] = rgb[2];
      spriteFloats[base + 7] = sp.intensity;

      spriteFloats[base + 8] = sp.falloff;
      spriteFloats[base + 9] = sp.glowRadius;
      spriteFloats[base + 10] = sp.bloomThreshold;
      spriteFloats[base + 11] = sp.bloomStrength;

      spriteU32[base + 12] = sp.shape === 'box' ? 1 : 0;
      spriteU32[base + 13] = sp.layer;
      spriteU32[base + 14] = 0;
      spriteU32[base + 15] = 0;
    }

    device.queue.writeBuffer(this.#storageBuffer, 0, spriteFloats);

    if (!this.#uniformBuffer) {
      this.#uniformBuffer = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    const uniFloats = new Float32Array(12);
    const uniU32 = new Uint32Array(uniFloats.buffer);

    uniFloats[0] = this.camera.x;
    uniFloats[1] = this.camera.y;
    uniFloats[2] = this.camera.zoom;
    uniFloats[3] = target.width ?? 32;
    uniFloats[4] = target.height ?? 16;
    uniU32[5] = count;
    uniU32[6] = this.layer;
    uniU32[7] = this.bloom ? 1 : 0;
    uniFloats[8] = this.bloomThreshold;
    uniFloats[9] = this.bloomIntensity;
    uniFloats[10] = 0;
    uniFloats[11] = 0;

    device.queue.writeBuffer(this.#uniformBuffer, 0, uniFloats);

    const encoder = commandEncoder ?? device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.emissiveTexture!.createView(),
        loadOp: 'clear',
        clearValue: [0, 0, 0, 1],
        storeOp: 'store',
      }, { view: this.bloomTexture!.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
    });
    pass.setPipeline(this.#pipeline);

    const bindGroup = device.createBindGroup({
      layout: this.#bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.#uniformBuffer } },
        { binding: 1, resource: { buffer: this.#storageBuffer } },
      ],
    });

    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    let shown = this.emissiveTexture!;
    if (this.#createBloom) {
      this.#bloomPass ??= this.#createBloom();
      this.#bloomPass.encodeImage({ device, encoder, width: target.width, height: target.height }, shown.createView(), this.#filtered!.createView());
      shown = this.#filtered!;
    }
    const presentation = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    presentation.setPipeline(this.#presentation!);
    presentation.setBindGroup(1, device.createBindGroup({ layout: this.#presentation!.getBindGroupLayout(1), entries: [{ binding: 0, resource: shown.createView() }] }));
    presentation.draw(3);
    presentation.end();

    if (!commandEncoder) {
      device.queue.submit([encoder.finish()]);
    }
  }

  dispose(): void {
    this[Symbol.dispose]();
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sprites.clear();
    this.#engine?.removePlugin(this.name);
    this.#engine = null;
    this.#release();
  }

  onDeviceRestored(): void {
    this.#release();
  }

  #validate(): void {
    checkCamera(this.camera);
    checkLayer(this.layer);
    if (!Number.isFinite(this.order)) throw rangeError('Invalid emissive order', 'pixel-lighting');
    for (const value of [this.bloomThreshold, this.bloomIntensity]) {
      if (!Number.isFinite(value) || value < 0) throw rangeError('Invalid emissive pass value', 'pixel-lighting');
    }
  }

  #release(): void {
    this.#uniformBuffer?.destroy();
    this.#storageBuffer?.destroy();
    this.#uniformBuffer = this.#storageBuffer = null;
    this.#pipeline = this.#bindGroupLayout = this.#device = this.#format = null;
    this.emissiveTexture?.destroy();
    this.bloomTexture?.destroy();
    this.#filtered?.destroy();
    this.emissiveTexture = this.bloomTexture = this.#filtered = null;
    this.#bloomPass?.dispose();
    this.#bloomPass = undefined;
    this.#presentation = null;
  }
}
