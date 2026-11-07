/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { finiteVector } from '@margoengine/math/validate';
import type { Vec3 } from '@margoengine/math';
import { fullscreen } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { applyView, viewRect } from '../../shared/view-rect.js';
import { sunlight } from './atmosphere.js';
import { depthWGSL, sceneDepth } from './depth.js';
import { CloudVolumes, cloudField, writeLayer, type VolumetricCloudOptions } from './volumetric-clouds.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/**
 * The sky {@link LightShafts} follow: `Sky` from `@margoengine/sky` (its sun, turbidity, exposure and model) or
 * `HillaireSky` from `@margoengine/sky/hillaire` (its sun, the sun's transmittance, illuminance and exposure).
 */
export interface ShaftSky {
  readonly sun: ArrayLike<number>;
  readonly options: { readonly turbidity?: number; readonly exposure?: number; readonly model?: string };
  readonly sunIlluminance?: number;
  readonly sunTransmittance?: ArrayLike<number>;
}
/** The clouds whose gaps the shafts come through: `VolumetricClouds` from `@margoengine/sky/volumetric-clouds`. */
export interface ShaftClouds {
  readonly options: VolumetricCloudOptions;
  readonly drift: ArrayLike<number>;
}
/** {@link LightShafts} settings, read every frame from `shafts.options`. */
export interface LightShaftOptions {
  /** The scene's reversed-Z depth each frame (for example `bloom.depthTexture`); nothing is drawn while it is undefined. */
  depth: () => GPUTexture | undefined;
  /** The sky to follow: its sun, the sun's colour through its air, its exposure. */
  sky?: ShaftSky;
  /** Direction toward the sun without a `sky`; normalized. Default [0.3, 0.6, 0.4]. */
  sunDirection?: Vec3;
  /** Volumetric clouds: the sky behind them is dark to the shafts by their transmittance, so light comes through the gaps. */
  clouds?: ShaftClouds;
  /** Share of the sunlight the lit air scatters toward the camera, 0 to 100. Default 0.1; 0 draws nothing. */
  intensity?: number;
  /** Henyey-Greenstein g of the air's scattering, 0 (even) to 0.95 (all forward). Default 0.6: shafts strongest near the sun. */
  anisotropy?: number;
  /** Weight kept from one sample to the next, walking from the pixel toward the sun, 0.5 to 1. Default 0.97. */
  decay?: number;
  /** Share of the way from each pixel to the sun's screen position that is sampled, 0.05 to 1. Default 0.9. */
  length?: number;
  /** Mask samples per pixel along that line, 8 to 128. Default 48. */
  samples?: number;
  /** Samples through the cloud layer for each mask texel, 2 to 64. Default 12. */
  cloudSamples?: number;
  /** Sun illuminance in the sky's units. Default the sky's own, 10 with the Preetham sky, else 20 (as the aerial perspective). */
  sunIlluminance?: number;
}
const defaults = { intensity: 0.1, anisotropy: 0.6, decay: 0.97, length: 0.9, samples: 48, cloudSamples: 12 } as const;
// Interleaved gradient noise (Jimenez 2014, "Next Generation Post Processing in Call of Duty: Advanced Warfare",
// SIGGRAPH Advances in Real-Time Rendering): a per-pixel offset of the first sample, so the steps do not band.
const common = /* wgsl */ `
struct Shafts {inverse:mat4x4f,eye:vec4f,sun:vec4f,color:vec4f,screen:vec4f,params:vec4f,rect:vec4f}
@group(0) @binding(0) var<uniform> shafts:Shafts;
fn shaftNoise(p:vec2f)->f32 {return fract(52.9829189*fract(dot(p,vec2f(0.06711056,0.00583715))));}
fn shaftRay(uv:vec2f)->vec3f {
 let a=shafts.inverse*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,0.000001,1);let b=shafts.inverse*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,1.0,1);
 return normalize(a.xyz/a.w-b.xyz/b.w);
}
`;
// The mask, at half the target's size: the share of each texel's 2 x 2 pixels where the scene is open sky, times the
// clouds' transmittance along that view ray. The exit distance of a ray from inside the shell at height h is the
// stable positive root of |o + t d| = R + h (the clouds' own form, Press et al.).
const cloudMask = /* wgsl */ `${cloudField}
@group(0) @binding(2) var<uniform> shaftClouds:Clouds;
@group(0) @binding(3) var shaftShape:texture_3d<f32>;
@group(0) @binding(4) var shaftErosion:texture_3d<f32>;
@group(0) @binding(5) var shaftSampler:sampler;
fn shaftExit(c:Clouds,p:vec3f,s:vec3f,h:f32)->f32 {
 let R=c.eye.w;let b=dot(p,s)+R*s.y;let k=dot(p,p)+2.0*R*(p.y-h)-h*h;let root=sqrt(max(b*b-k,0.0));
 return select(-b+root,-k/(b+root),b>0.0);
}
fn shaftCloudsOpen(d:vec3f,jitter:f32)->f32 {
 let c=shaftClouds;let e=c.eye.xyz;if(c.layer.z<=0.0){return 1.0;}
 let altitude=cloudAltitude(c,e);if(altitude>c.layer.y){return 1.0;}
 var start=0.0;
 if(altitude<c.layer.x){if(dot(d,normalize(vec3f(e.x,e.y+c.eye.w,e.z)))<=0.0){return 1.0;}start=shaftExit(c,e,d,c.layer.x);}
 let end=min(shaftExit(c,e,d,c.layer.y),start+c.shape.z);
 let n=u32(c.shape.w);let dt=(end-start)/f32(n);var od=0.0;
 for(var i=0u;i<n;i++){od+=cloudDensityAt(c,shaftShape,shaftErosion,shaftSampler,e+d*(start+(f32(i)+jitter)*dt),true)*dt;}
 return exp(-od*c.layer.w);
}
`;
const maskShader = (
  depth: string,
  clouds: boolean,
) => /* wgsl */ `${fullscreen}${common}${depth}${clouds ? cloudMask : ''}
@fragment fn mask(i:Vertex)->@location(0) vec4f {
 let full=vec2i(textureDimensions(sceneDepth));let base=vec2i(i.position.xy)*2;var open=0.0;
 for(var k=0;k<4;k++){if(sceneDepthAt(min(base+vec2i(k&1,k>>1),full-1))<=0.0){open+=0.25;}}
 ${clouds ? 'if(open>0.0){let view=(i.uv-shafts.rect.xy)/shafts.rect.zw;open*=shaftCloudsOpen(shaftRay(view),shaftNoise(i.position.xy));}' : ''}
 return vec4f(open,0,0,1);
}
`;
// Mitchell 2007 ("Volumetric Light Scattering as a Post-Process", GPU Gems 3 ch. 13): samples of the mask on the line
// from the pixel toward the sun's screen position, each weighted by decay^i; their weighted mean is the share of the
// air in front of the pixel that the sun lights. That share times the sunlight, Henyey-Greenstein phase over 4 pi,
// and the intensity is the light added.
const blurShader = /* wgsl */ `${fullscreen}${common}${displayShader}
@group(0) @binding(1) var shaftMask:texture_2d<f32>;
@group(0) @binding(2) var maskSampler:sampler;
@fragment fn composite(i:Vertex)->@location(0) vec4f {
 let f=shafts;let n=u32(f.screen.w);let step=(f.screen.xy-i.uv)*f.screen.z/f32(n);
 var uv=i.uv+step*shaftNoise(i.position.xy);var weight=1.0;var sum=0.0;var total=0.0;
 for(var k=0u;k<n;k++){
  sum+=textureSampleLevel(shaftMask,maskSampler,f.rect.xy+clamp(uv,vec2f(0),vec2f(1))*f.rect.zw,0.0).r*weight;
  total+=weight;weight*=f.params.x;uv+=step;
 }
 let g=f.params.y;let nu=dot(shaftRay(i.uv),f.sun.xyz);
 let phase=(1.0-g*g)/pow(max(1.0+g*g-2.0*g*nu,0.0001),1.5)/12.566371;
 var light=f.color.rgb*phase*(sum/total)*f.sun.w;
 if(f.color.w>0.5){light=toDisplay(light);}
 return vec4f(light,1);
}
`;
const inRange = (value: number, low: number, high: number) => Number.isFinite(value) && value >= low && value <= high;
/**
 * Light shafts: god rays from the sun past mountains, buildings and trees, and through the gaps in volumetric
 * clouds, in the sky itself (Mitchell 2007). A half-size mask marks where the sun can be seen, open sky by the scene's
 * depth times the clouds' transmittance; each pixel then walks the mask toward the sun's place on screen, and the
 * lit share of what it crosses, times the sunlight and the air's forward scattering, is added to the scene.
 * `LightShafts.attach(engine, {sky, depth: () => bloom.depthTexture, clouds})`.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'state'` when the camera matrix is not invertible.
 */
export class LightShafts implements EnginePlugin {
  readonly name: string = 'sky:shafts';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private cloudUniform?: GPUBuffer;
  private volumes?: CloudVolumes;
  private mask?: GPUTexture;
  private sampler?: GPUSampler;
  private maskPipeline?: GPURenderPipeline;
  private blurPipeline?: GPURenderPipeline;
  private maskGroup?: GPUBindGroup;
  private blurGroup?: GPUBindGroup;
  private maskKey = '';
  private blurKey = '';
  private bound?: GPUTexture | GPUTextureView;
  private disposed = false;
  private readonly values = new Float32Array(48);
  private readonly cloudValues = new Float32Array(64);
  private readonly scratch = new Float64Array(52);
  private readonly color = new Float32Array(3);
  constructor(readonly options: LightShaftOptions) {
    this.validate();
  }
  static attach(engine: EngineKernel, options: LightShaftOptions): LightShafts {
    const shafts = new LightShafts(options);
    engineRuntime(engine).use(shafts);
    return shafts;
  }
  private validate(): void {
    const o = this.options;
    if (typeof o !== 'object' || o === null || typeof o.depth !== 'function')
      throw new TypeError('LightShafts needs a depth function returning the scene depth texture; pass {depth}');
    if (o.sky !== undefined && (typeof o.sky !== 'object' || o.sky === null || !(o.sky.sun?.length >= 3)))
      throw new TypeError(
        'LightShafts sky must be a Sky (with a sun direction); pass the sky whose sun casts the shafts',
      );
    if (o.clouds !== undefined && (typeof o.clouds?.options !== 'object' || !(o.clouds.drift?.length >= 3)))
      throw new TypeError('LightShafts clouds must be VolumetricClouds; pass the clouds the light comes through');
    if (o.sunDirection) finiteVector(o.sunDirection, 3, 'LightShafts sunDirection');
    if (o.sunDirection && !(Math.hypot(...o.sunDirection) > 0))
      throw new RangeError('LightShafts sunDirection needs a nonzero length');
    const samples = o.samples ?? defaults.samples,
      cloudSamples = o.cloudSamples ?? defaults.cloudSamples;
    if (
      !inRange(o.intensity ?? defaults.intensity, 0, 100) ||
      !inRange(o.anisotropy ?? defaults.anisotropy, 0, 0.95) ||
      !inRange(o.decay ?? defaults.decay, 0.5, 1) ||
      !inRange(o.length ?? defaults.length, 0.05, 1) ||
      !Number.isInteger(samples) ||
      !inRange(samples, 8, 128) ||
      !Number.isInteger(cloudSamples) ||
      !inRange(cloudSamples, 2, 64) ||
      !inRange(o.sunIlluminance ?? 10, 0, 1e6)
    )
      throw new RangeError(
        'Invalid LightShafts options; keep intensity 0 to 100, anisotropy 0 to 0.95, decay 0.5 to 1, length 0.05 to 1, integer samples 8 to 128 and cloudSamples 2 to 64, and sunIlluminance 0 or more.',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'LightShafts requires WebGPU; attach new LightShafts to a WebGPU engine',
      );
    this.engine = engine;
    const d = engine.gpu;
    this.uniform = d.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }
  registerPasses(graph: FrameGraph): void {
    // After the clouds (3) and the aerial perspective (4), before the sky's fog (5) and the weather (6).
    graph.add({
      name: 'sky:shafts',
      order: 4.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    this.validate();
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid LightShafts delta; pass a finite delta of 0 or more seconds.');
  }
  // Fills the uniform; false when nothing would be added (no sunlight, no intensity, the sun behind the camera).
  private write(c: Context): boolean {
    const o = this.options,
      v = this.values,
      sky = o.sky,
      sun = sky?.sun ?? o.sunDirection ?? [0.3, 0.6, 0.4],
      length = Math.hypot(sun[0], sun[1], sun[2]) || 1,
      m = c.camera.matrix;
    if (!invertMatrixStable(m, v.subarray(0, 16), this.scratch))
      throw new MargoError('state', 'Invalid LightShafts camera; give the camera a finite, invertible projection');
    const s = [sun[0] / length, sun[1] / length, sun[2] / length],
      x = m[0] * s[0] + m[4] * s[1] + m[8] * s[2],
      y = m[1] * s[0] + m[5] * s[1] + m[9] * s[2],
      // The clip w of the direction to the sun is the cosine between it and the view axis: shafts fade out as the
      // sun passes 75 degrees off the axis and stop when it is behind the camera (or the camera is orthographic).
      w = m[3] * s[0] + m[7] * s[1] + m[11] * s[2],
      t = Math.min(1, Math.max(0, w / 0.25)),
      fade = t * t * (3 - 2 * t);
    if (sky?.sunTransmittance) for (let i = 0; i < 3; i++) this.color[i] = sky.sunTransmittance[i];
    else sunlight(s[1], 0.001, sky?.options.turbidity ?? 2, this.color);
    const illuminance =
        o.sunIlluminance ?? sky?.sunIlluminance ?? (sky && (sky.options.model ?? 'preetham') === 'preetham' ? 10 : 20),
      scale = illuminance * 2 ** (sky?.options.exposure ?? 0) * (o.intensity ?? defaults.intensity);
    if (!(fade > 0 && scale > 0 && Math.max(this.color[0], this.color[1], this.color[2]) > 0)) return false;
    v.set(c.camera.position, 16);
    v.set(s, 20);
    v[23] = fade;
    for (let i = 0; i < 3; i++) v[24 + i] = this.color[i] * scale;
    v[27] = +(c.format !== 'rgba16float');
    v[28] = (x / w) * 0.5 + 0.5;
    v[29] = 0.5 - (y / w) * 0.5;
    v[30] = o.length ?? defaults.length;
    v[31] = o.samples ?? defaults.samples;
    v[32] = o.decay ?? defaults.decay;
    v[33] = o.anisotropy ?? defaults.anisotropy;
    // The view's rectangle in the target's 0..1 coordinates, where the mask lives.
    const rect = viewRect(c);
    if (rect) v.set([rect[0] / c.width, rect[1] / c.height, rect[2] / c.width, rect[3] / c.height], 36);
    else v.set([0, 0, 1, 1], 36);
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    return true;
  }
  private writeClouds(c: Context, clouds: ShaftClouds): void {
    const v = this.cloudValues;
    v.set(c.camera.position, 16);
    writeLayer(v, clouds.options, clouds.drift);
    v[34] = clouds.options.maxDistance ?? 80000;
    v[35] = this.options.cloudSamples ?? defaults.cloudSamples;
    this.cloudUniform ??= c.device.createBuffer({
      size: v.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.volumes ??= new CloudVolumes(c.device);
    this.volumes.fill(c.device, c.encoder);
    c.device.queue.writeBuffer(this.cloudUniform, 0, v as Float32Array<ArrayBuffer>);
  }
  private draw(c: Context): void {
    if (!this.uniform) return;
    const depth = sceneDepth(c, this.options.depth, 'LightShafts');
    if (!depth || !this.write(c)) return;
    const d = c.device,
      clouds = this.options.clouds,
      width = Math.max(1, Math.ceil(c.width / 2)),
      height = Math.max(1, Math.ceil(c.height / 2));
    if (clouds) this.writeClouds(c, clouds);
    if (!this.mask || this.mask.width !== width || this.mask.height !== height) {
      this.mask?.destroy();
      this.mask = d.createTexture({
        size: [width, height],
        format: 'r16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.blurGroup = undefined;
      this.bound = undefined;
    }
    const maskKey = `${depth.samples}:${!!clouds}`;
    if (this.maskKey !== maskKey) {
      const module = d.createShaderModule({ code: maskShader(depthWGSL(1, depth.samples), !!clouds) });
      this.maskPipeline = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'mask', targets: [{ format: 'r16float' }] },
      });
      this.maskKey = maskKey;
      this.bound = undefined;
    }
    if (this.bound !== depth.texture) {
      this.maskGroup = d.createBindGroup({
        layout: this.maskPipeline!.getBindGroupLayout(0),
        // Without clouds the mask reads only the depth, so its 'auto' layout has no uniform.
        entries: [
          { binding: 1, resource: depth.resource },
          ...(clouds
            ? [
                { binding: 0, resource: { buffer: this.uniform } },
                { binding: 2, resource: { buffer: this.cloudUniform! } },
                { binding: 3, resource: this.volumes!.shape.createView() },
                { binding: 4, resource: this.volumes!.erosion.createView() },
                { binding: 5, resource: this.volumes!.sampler },
              ]
            : []),
        ],
      });
      this.bound = depth.texture;
    }
    const blurKey = `${c.format}:${c.descriptor.multisample?.count ?? 1}`;
    if (this.blurKey !== blurKey) {
      const module = d.createShaderModule({ code: blurShader });
      this.blurPipeline = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'composite',
          targets: [
            {
              format: c.format,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        multisample: c.descriptor.multisample,
      });
      this.blurKey = blurKey;
      this.blurGroup = undefined;
    }
    this.blurGroup ??= d.createBindGroup({
      layout: this.blurPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: this.mask.createView() },
        { binding: 2, resource: this.sampler! },
      ],
    });
    const maskPass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: this.mask.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
    });
    maskPass.setPipeline(this.maskPipeline!);
    maskPass.setBindGroup(0, this.maskGroup!);
    maskPass.draw(3);
    maskPass.end();
    const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] });
    applyView(pass, c);
    pass.setPipeline(this.blurPipeline!);
    pass.setBindGroup(0, this.blurGroup);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.uniform?.destroy();
    this.cloudUniform?.destroy();
    this.volumes?.dispose();
    this.mask?.destroy();
    this.uniform = this.cloudUniform = this.volumes = this.mask = this.sampler = undefined;
    this.maskPipeline = this.blurPipeline = this.maskGroup = this.blurGroup = this.bound = undefined;
    this.maskKey = this.blurKey = '';
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
