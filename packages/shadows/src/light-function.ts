// Light functions: what shapes the sun between the sky and the ground, given to `Shadows` or `VirtualShadows` in `effects`.
// Both are one world-position lookup per lit pixel, multiplied into the sun by the shadow pass's shadowLit.
import type { ShadowEffect, ShadowEffectFrame } from './shader.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** The clouds a {@link cloudShadows} matches: `Sky` from `@margoengine/sky` with the `clouds` feature. */
export interface CloudLayerSource {
  readonly cloudLayer: { field: string; coverage: number; drift: number; height: number } | undefined;
}
/** {@link cloudShadows} settings, read every frame from the returned effect's `options`. */
export interface CloudShadowOptions {
  /** How much of the sky's own cloud opacity reaches the ground, 0 to 1. Default 1: the cloud the sun shows through. */
  strength?: number;
  /** The sun's angular diameter in radians, which blurs the shadow's edge, 0 or more. Default 0.0093, the real sun. */
  sunSize?: number;
}
/** {@link lightPattern} settings. Everything except `texture` is read every frame from the effect's `options`. */
export interface LightPatternOptions {
  /** The mask: its colour multiplies the sun. Any filterable 2D texture view. */
  texture: GPUTextureView;
  /** World units one repeat of the mask spans, across the light, > 0. Default 10. */
  size?: number;
  /** Mask repeats it has moved, along its own u and v. Default [0, 0]. */
  offset?: readonly [number, number];
  /** Mask repeats per second it scrolls, along u and v. Default [0, 0]. */
  speed?: readonly [number, number];
  /** How much of the mask applies, 0 to 1. Default 1. */
  strength?: number;
}
/** An effect with live `options`. */
export interface LightFunction<Options, Context = unknown> extends ShadowEffect<Context> {
  readonly options: Options;
}
const unit = (value: number, name: string) => {
  if (!(value >= 0 && value <= 1)) throw new RangeError(`Invalid ${name}; use a number from 0 to 1`);
};
/** One small uniform buffer an effect owns. */
class EffectUniform {
  readonly values: Float32Array<ArrayBuffer>;
  buffer?: GPUBuffer;
  constructor(floats: number) {
    this.values = new Float32Array(floats);
  }
  setup(device: GPUDevice): void {
    this.buffer ??= device.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  write(device: GPUDevice): void {
    device.queue.writeBuffer(this.buffer!, 0, this.values);
  }
  dispose(): void {
    this.buffer?.destroy();
    this.buffer = undefined;
  }
}
/**
 * The shadows of `sky`'s clouds, moving with them: `Shadows.attach(engine, {effects: [cloudShadows(sky)]})`. A ground point
 * looks up the sky's own cloud field where its ray to the sun meets the cloud shell, at the sky's own clock, so a viewer
 * there would see the cloud that shades it. World units are metres, as the sky takes them. Throws TypeError without a sky.
 */
export function cloudShadows<Context extends { device: GPUDevice }>(
  sky: CloudLayerSource,
  options: CloudShadowOptions = {},
): LightFunction<CloudShadowOptions, Context> {
  if (!sky || !('cloudLayer' in sky)) throw new TypeError('cloudShadows needs a Sky; pass the sky whose clouds they match');
  const uniform = new EffectUniform(8);
  let binding = 0;
  return {
    options,
    get call() {
      return `vec3f(shadowFxClouds${binding}(position))`;
    },
    wgsl(group, at) {
      binding = at;
      const field = (sky.cloudLayer?.field ?? 'fn cloudOctaves(p:vec2f,footprint:f32,first:u32,last:u32)->f32 {return 0.0;}\n').replace(
        /\bcloud(Hash|Noise|Octaves)\b/g,
        `shadowFx$1${at}`,
      );
      // Sky's cloudSky from the ground point towards the sun, with no aerial fade: the sky's shell and the same coverage
      // remap and erosion, so the opacity here is the opacity of that cloud seen against the sun.
      return /* wgsl */ `struct ShadowFxClouds${at} {sun:vec4f,layer:vec4f}
@group(${group}) @binding(${at}) var<uniform> shadowFxCloudFrame${at}:ShadowFxClouds${at};
${field}fn shadowFxClouds${at}(position:vec3f)->f32 {
  let u=shadowFxCloudFrame${at};let s=u.sun.xyz;let R=6360.0;
  if(u.layer.x<=0.0||u.layer.w<=0.0||s.y<=0.0){return 1.0;}
  let r=R+clamp(position.y*0.001,0.001,99.9);let shell=R+u.layer.z*0.001;let mu=s.y;
  if(r>=shell){return 1.0;}
  let t=-r*mu+sqrt(r*r*(mu*mu-1.0)+shell*shell);let slant=max((r*mu+t)/shell,0.03);
  let p=position.xz*0.001+s.xz*t+normalize(vec2f(1,0.35))*u.layer.y*0.001;let footprint=u.sun.w*t/slant;
  let cover=clamp((shadowFxOctaves${at}(p,footprint,0u,2u)-1.0+u.layer.x)/max(u.layer.x,0.001),0.0,1.0);
  let erode=shadowFxOctaves${at}(p,footprint,2u,4u)*0.35;let density=clamp((cover-erode)/(1.0-erode),0.0,1.0);
  return 1.0-(1.0-exp(-density*3.0/max(slant,0.25)))*u.layer.w;
}
`;
    },
    resources() {
      return [{ buffer: uniform.buffer! }];
    },
    setup(device) {
      uniform.setup(device);
    },
    update(frame: ShadowEffectFrame<Context>) {
      const { strength = 1, sunSize = 0.0093 } = this.options,
        layer = sky.cloudLayer,
        v = uniform.values;
      unit(strength, 'cloud shadow strength');
      if (!(sunSize >= 0)) throw new RangeError('Invalid cloud shadow sunSize; use 0 or more radians');
      for (let i = 0; i < 3; i++) v[i] = frame.light[i];
      v[3] = sunSize;
      v[4] = layer?.coverage ?? 0;
      v[5] = layer?.drift ?? 0;
      v[6] = layer?.height ?? 1500;
      v[7] = strength;
      uniform.write(frame.context.device);
    },
    dispose() {
      uniform.dispose();
    },
  };
}
/**
 * A mask over the sun, what a stage light's gobo does: stained light, window frames, leaves' dapple, scrolling water
 * caustics. The mask lies across the light and travels along it, so `size` is its repeat on a surface facing the sun;
 * `up` in the image is the world's up as the sun sees it. `Shadows.attach(engine, {effects: [lightPattern({texture})]})`.
 * Adds one sampled texture and one sampler to every receiver. Throws TypeError without a texture.
 */
export function lightPattern<Context extends { device: GPUDevice }>(
  options: LightPatternOptions,
): LightFunction<LightPatternOptions, Context> {
  if (!options?.texture) throw new TypeError('lightPattern needs a texture; pass a GPUTextureView');
  const uniform = new EffectUniform(12);
  let binding = 0,
    sampler: GPUSampler | undefined,
    time = 0,
    last = 0;
  return {
    options,
    get call() {
      return `shadowFxPattern${binding}(position)`;
    },
    wgsl(group, at) {
      binding = at;
      return /* wgsl */ `struct ShadowFxPatternFrame${at} {right:vec4f,up:vec4f,place:vec4f}
@group(${group}) @binding(${at}) var<uniform> shadowFxPatternData${at}:ShadowFxPatternFrame${at};
@group(${group}) @binding(${at + 1}) var shadowFxPatternMap${at}:texture_2d<f32>;
@group(${group}) @binding(${at + 2}) var shadowFxPatternSampler${at}:sampler;
fn shadowFxPattern${at}(position:vec3f)->vec3f {
  let u=shadowFxPatternData${at};
  let uv=vec2f(dot(position,u.right.xyz),-dot(position,u.up.xyz))/u.place.x+0.5+u.place.yz;
  return mix(vec3f(1),textureSampleLevel(shadowFxPatternMap${at},shadowFxPatternSampler${at},uv,0.0).rgb,u.place.w);
}
`;
    },
    resources() {
      return [{ buffer: uniform.buffer! }, this.options.texture, sampler!];
    },
    setup(device) {
      uniform.setup(device);
      sampler ??= device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      });
    },
    update(frame: ShadowEffectFrame<Context>) {
      const { size = 10, offset = [0, 0], speed = [0, 0], strength = 1 } = this.options,
        v = uniform.values,
        l = frame.light,
        now = performance.now() / 1000;
      if (!(size > 0)) throw new RangeError('Invalid light pattern size; use a number above 0');
      unit(strength, 'light pattern strength');
      time += last ? now - last : 0;
      last = now;
      // A basis across the light: right is world up crossed with it, or +X for a sun straight overhead.
      const flat = Math.hypot(l[0], l[2]) < 1e-4,
        rx = flat ? 1 : l[2],
        rz = flat ? 0 : -l[0],
        length = Math.hypot(rx, rz);
      v[0] = rx / length;
      v[1] = 0;
      v[2] = rz / length;
      v[4] = l[1] * v[2];
      v[5] = l[2] * v[0] - l[0] * v[2];
      v[6] = -l[1] * v[0];
      v[8] = size;
      v[9] = offset[0] + speed[0] * time;
      v[10] = offset[1] + speed[1] * time;
      v[11] = strength;
      uniform.write(frame.context.device);
    },
    dispose() {
      uniform.dispose();
      sampler = undefined;
    },
  };
}
