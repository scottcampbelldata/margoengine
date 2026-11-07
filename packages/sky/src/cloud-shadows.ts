import { CloudVolumes, cloudField, writeLayer, type VolumetricCloudOptions } from './volumetric-clouds.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** The clouds a {@link volumetricCloudShadows} matches: `VolumetricClouds` from `@margoengine/sky/volumetric-clouds`. */
export interface VolumetricCloudSource {
  readonly options: VolumetricCloudOptions;
  readonly drift: ArrayLike<number>;
}
/** {@link volumetricCloudShadows} settings, read every frame from the effect's `options`. */
export interface VolumetricCloudShadowOptions {
  /** How much of the clouds' opacity toward the sun reaches the ground, 0 to 1. Default 1. */
  strength?: number;
  /** Samples through the layer along each receiver's ray to the sun, 2 to 64. Default 12. */
  samples?: number;
}
/** The frame a shadow effect is updated with: the WebGPU pass context (no pass open) and the unit direction to the light. */
export interface CloudShadowFrame {
  context: { device: GPUDevice; encoder: GPUCommandEncoder };
  light: ArrayLike<number>;
}
/**
 * A shadow effect for `Shadows` or `VirtualShadows` from `@margoengine/shadows` (their `effects` option). Its shapes are
 * internal; give it to the shadows as it is.
 */
export interface VolumetricCloudShadow {
  readonly options: VolumetricCloudShadowOptions;
  /** WGSL multiplying the light: the transmittance of the clouds between a receiver and the light. */
  readonly call: string;
  wgsl(group: number, binding: number): string;
  resources(): readonly GPUBindingResource[];
  setup(device: GPUDevice): void;
  update(frame: CloudShadowFrame): void;
  dispose(): void;
}
/**
 * The shadows of volumetric clouds on everything that receives shadows, moving and changing with them:
 * `Shadows.attach(engine, {effects: [volumetricCloudShadows(clouds)]})`. Each receiver marches the clouds' own density
 * field (same noise, same drift, same layer options, read every frame) from its position toward the light, so the
 * ground is dark where a viewer there would see cloud over the sun. The light is the shadows' own sun, which should be
 * the sky's. Throws TypeError without clouds.
 */
export function volumetricCloudShadows(
  clouds: VolumetricCloudSource,
  options: VolumetricCloudShadowOptions = {},
): VolumetricCloudShadow {
  if (!clouds || typeof clouds.options !== 'object' || !(clouds.drift?.length >= 3))
    throw new TypeError('volumetricCloudShadows needs VolumetricClouds; pass the clouds whose shadows these are');
  const values = new Float32Array(64);
  let uniform: GPUBuffer | undefined,
    volumes: CloudVolumes | undefined,
    owner: GPUDevice | undefined,
    binding = 0;
  return {
    options,
    get call() {
      return `vec3f(shadowFxVolume${binding}(position))`;
    },
    wgsl(group, at) {
      binding = at;
      const field = cloudField
        .replace(/\bcloud(Remap|Altitude|DensityAt|LightDepth)\b/g, `shadowFxCloud$1${at}`)
        .replace(/\bClouds\b/g, `ShadowFxClouds${at}`);
      // Distance from p to the shell at height h along the unit direction s, for p inside it: the positive root of
      // |o + t s| = R + h, written without cancellation (as the clouds' own shell roots).
      return /* wgsl */ `${field}
@group(${group}) @binding(${at}) var<uniform> shadowFxCloudFrame${at}:ShadowFxClouds${at};
@group(${group}) @binding(${at + 1}) var shadowFxCloudShape${at}:texture_3d<f32>;
@group(${group}) @binding(${at + 2}) var shadowFxCloudErosion${at}:texture_3d<f32>;
@group(${group}) @binding(${at + 3}) var shadowFxCloudSampler${at}:sampler;
fn shadowFxCloudExit${at}(c:ShadowFxClouds${at},p:vec3f,s:vec3f,h:f32)->f32 {
 let R=c.eye.w;let b=dot(p,s)+R*s.y;let k=dot(p,p)+2.0*R*(p.y-h)-h*h;let root=sqrt(max(b*b-k,0.0));
 return select(-b+root,-k/(b+root),b>0.0);
}
fn shadowFxVolume${at}(position:vec3f)->f32 {
 let c=shadowFxCloudFrame${at};let s=c.sun.xyz;
 if(c.layer.z<=0.0||c.flags.y<=0.0||s.y<=0.0){return 1.0;}
 let altitude=shadowFxCloudAltitude${at}(c,position);if(altitude>=c.layer.y){return 1.0;}
 let enter=select(0.0,shadowFxCloudExit${at}(c,position,s,c.layer.x),altitude<c.layer.x);
 let leave=shadowFxCloudExit${at}(c,position,s,c.layer.y);
 let n=u32(c.shape.w);let dt=(leave-enter)/f32(n);var od=0.0;
 for(var i=0u;i<n;i++){
  od+=shadowFxCloudDensityAt${at}(c,shadowFxCloudShape${at},shadowFxCloudErosion${at},shadowFxCloudSampler${at},position+s*(enter+(f32(i)+0.5)*dt),true)*dt;
 }
 return mix(1.0,exp(-od*c.layer.w),c.flags.y);
}
`;
    },
    resources() {
      return [{ buffer: uniform! }, volumes!.shape.createView(), volumes!.erosion.createView(), volumes!.sampler];
    },
    setup(device) {
      // Runs again after a new map size (same device: keep what is made) and after a device loss (make it anew).
      if (owner === device) return;
      this.dispose();
      owner = device;
      uniform = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      volumes = new CloudVolumes(device);
    },
    update(frame) {
      const { strength = 1, samples = 12 } = this.options,
        { device, encoder } = frame.context;
      if (!(strength >= 0 && strength <= 1)) throw new RangeError('Invalid cloud shadow strength; use a number from 0 to 1');
      if (!Number.isInteger(samples) || samples < 2 || samples > 64)
        throw new RangeError('Invalid cloud shadow samples; use an integer from 2 to 64');
      volumes!.fill(device, encoder);
      writeLayer(values, clouds.options, clouds.drift);
      for (let i = 0; i < 3; i++) values[20 + i] = frame.light[i];
      values[35] = samples;
      values[41] = strength;
      device.queue.writeBuffer(uniform!, 0, values as Float32Array<ArrayBuffer>);
    },
    dispose() {
      uniform?.destroy();
      volumes?.dispose();
      uniform = volumes = owner = undefined;
    },
  };
}
