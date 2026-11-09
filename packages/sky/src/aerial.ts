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
import { applyView } from '../../shared/view-rect.js';
import {
  AtmosphereTables,
  atmosphereCommon,
  atmosphereLookups,
  atmosphereParameters,
  type AtmosphereParameters,
} from './atmosphere-luts.js';
import { depthWGSL, sceneDepth } from './depth.js';
export { EARTH_ATMOSPHERE, atmosphereParameters, type AtmosphereParameters } from './atmosphere-luts.js';
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/**
 * The sky an {@link AerialPerspective} follows: `Sky` from `@margoengine/sky` fits (its sun, turbidity and exposure), and
 * so does `HillaireSky` from `@margoengine/sky/hillaire` (its sun, exposure, illuminance, atmosphere and scale).
 */
export interface AerialSky {
  readonly sun: ArrayLike<number>;
  readonly options: {
    readonly turbidity?: number;
    readonly exposure?: number;
    readonly model?: string;
    readonly metersPerUnit?: number;
    readonly altitude?: number;
  };
  /** A sky with its own sun illuminance (`HillaireSky`) lends it, so the air and the sky agree. */
  readonly sunIlluminance?: number;
  /** A sky with its own atmosphere (`HillaireSky`) lends it whole: the air then ignores turbidity. */
  readonly resolvedAtmosphere?: Readonly<Required<AtmosphereParameters>>;
}
/** {@link AerialPerspective} settings, read every frame from `aerial.options`. */
export interface AerialPerspectiveOptions {
  /** The scene's reversed-Z depth each frame (for example `bloom.depthTexture`); nothing is drawn while it is undefined. */
  depth: () => GPUTexture | undefined;
  /** The sky to follow: its sun, its haze (turbidity scales Mie scattering as the sky does) and its exposure. */
  sky?: AerialSky;
  /** Direction toward the sun without a `sky`; normalized. Default [0.3, 0.6, 0.4]. */
  sunDirection?: Vec3;
  /** Farthest distance the air is worked out to, metres, 1000 to 400,000; beyond it the air holds that value. Default 64,000. */
  maxDistance?: number;
  /** Metres per world unit, above 0 and at most 1,000,000. Default: the sky's, else 1; raise it to give a small scene the air of a large one. */
  metersPerUnit?: number;
  /** Metres added to the camera's height above the ground, 0 to 100,000. Default: the sky's, else 0. */
  altitude?: number;
  /**
   * Sun illuminance in the sky's units. Default: the sky's own when it has one; 20 with the Bruneton model, which is
   * built at that scale; 10 with the Preetham model, whose horizon at noon (turbidity 2) is 1.9 to 2.2 times dimmer than
   * this air's at 20; 20 without a sky.
   */
  sunIlluminance?: number;
  /** The planet's air, kilometres (Hillaire 2020); default the sky's own when it has one, else Earth. Read when it changes. */
  atmosphere?: AtmosphereParameters;
}
const SLICES = 32;
// The air between the camera and 32 slices at distances reach * ((k + 1) / 32)^2, for 32 x 32 screen columns: one
// thread per column marches on from slice to slice, two steps each, stopping at the ground (Hillaire 2020 sec. 5.3).
const volumeShader = /* wgsl */ `${atmosphereCommon}
@group(0) @binding(0) var<uniform> atmosphere:Atmosphere;
@group(0) @binding(1) var transmittanceTable:texture_2d<f32>;
@group(0) @binding(2) var multipleTable:texture_2d<f32>;
@group(0) @binding(3) var lutSampler:sampler;
@group(0) @binding(4) var scatterVolume:texture_storage_3d<rgba16float,write>;
@group(0) @binding(5) var transmitVolume:texture_storage_3d<rgba16float,write>;
${atmosphereLookups}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(${SLICES}))){return;}let a=atmosphere;
 let uv=(vec2f(id.xy)+0.5)/${SLICES}.0;let ndc=vec2f(uv.x*2.0-1.0,1.0-uv.y*2.0);
 let pf=a.inverse*vec4f(ndc,0.000001,1);let pn=a.inverse*vec4f(ndc,1.0,1);let d=normalize(pf.xyz/pf.w-pn.xyz/pn.w);
 let o=vec3f(0,a.view.y,0);let ground=sphereHit(o,d,a.radii.x);let stop=select(1e9,ground,ground>=0.0);
 var light=vec3f(0);var throughput=vec3f(1);var travelled=0.0;
 for(var k=0u;k<${SLICES}u;k++){
  let f=(f32(k)+1.0)/${SLICES}.0;let next=min(a.view.x*f*f,stop);
  if(next>travelled){let r=integrateScattering(a,o+d*travelled,d,next-travelled,2u,throughput);light+=r[0];throughput=r[1];travelled=next;}
  textureStore(scatterVolume,vec3i(vec3u(id.xy,k)),vec4f(light,1));textureStore(transmitVolume,vec3i(vec3u(id.xy,k)),vec4f(throughput,1));
 }
}
`;
// The scene pixel at distance d (km) reads the slice coordinate sqrt(d / reach) x 32 - 1 between texel centres;
// nearer than the first slice it fades from no air at the camera.
const compositeShader = (depth: string) => /* wgsl */ `${fullscreen}${atmosphereCommon}${displayShader}
@group(0) @binding(0) var<uniform> atmosphere:Atmosphere;
@group(0) @binding(1) var scatterVolume:texture_3d<f32>;
@group(0) @binding(2) var transmitVolume:texture_3d<f32>;
@group(0) @binding(3) var volumeSampler:sampler;
${depth}
fn aerialAt(i:Vertex)->array<vec3f,2> {
 let z=sceneDepthAt(vec2i(i.position.xy));if(z<=0.0){discard;}
 let a=atmosphere;let w=a.inverse*vec4f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0,z,1);
 let distance=length(w.xyz/w.w-a.eye.xyz)*a.eye.w;let s=sqrt(clamp(distance/a.view.x,0.0,1.0))*${SLICES}.0-1.0;
 let uvw=vec3f(i.uv,(max(s,0.0)+0.5)/${SLICES}.0);
 var light=textureSampleLevel(scatterVolume,volumeSampler,uvw,0.0).rgb;var through=textureSampleLevel(transmitVolume,volumeSampler,uvw,0.0).rgb;
 if(s<0.0){let f=s+1.0;light*=f;through=mix(vec3f(1),through,f);}
 return array<vec3f,2>(light*a.sun.w,through);
}
@fragment fn transmit(i:Vertex)->@location(0) vec4f {return vec4f(aerialAt(i)[1],1);}
@fragment fn inscatter(i:Vertex)->@location(0) vec4f {var light=aerialAt(i)[0];if(atmosphere.view.z>0.5){light=toDisplay(light);}return vec4f(light,1);}
`;
const inRange = (value: number, low: number, high: number) => Number.isFinite(value) && value >= low && value <= high;
/**
 * Physical aerial perspective: scene surfaces take the colour of the air in front of them and fade by its real
 * transmittance, so distant mountains turn blue and hazy (Hillaire 2020). The air is worked out each frame in a
 * 32 x 32 x 32 volume over the view from Rayleigh, Mie and ozone, single scattering toward the sun plus multiple
 * scattering, then every scene pixel is multiplied by its transmittance and given its in-scattered light.
 * `AerialPerspective.attach(engine, {sky, depth: () => bloom.depthTexture})`.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'state'` when the camera matrix is not invertible.
 */
export class AerialPerspective implements EnginePlugin {
  readonly name: string = 'sky:aerial';
  private engine?: Engine;
  private tables?: AtmosphereTables;
  private scatter?: GPUTexture;
  private transmit?: GPUTexture;
  private sampler?: GPUSampler;
  private volume?: { pipeline: GPUComputePipeline; group: GPUBindGroup };
  private passes?: { transmit: GPURenderPipeline; inscatter: GPURenderPipeline };
  private binds?: [GPUBindGroup, GPUBindGroup];
  private key = '';
  private bound?: GPUTexture | GPUTextureView;
  private parameters?: Required<AtmosphereParameters>;
  private parameterSource?: AtmosphereParameters;
  private disposed = false;
  private readonly scratch = new Float64Array(52);
  constructor(readonly options: AerialPerspectiveOptions) {
    this.validate();
  }
  static attach(engine: EngineKernel, options: AerialPerspectiveOptions): AerialPerspective {
    const aerial = new AerialPerspective(options);
    engineRuntime(engine).use(aerial);
    return aerial;
  }
  private validate(): void {
    const o = this.options;
    if (typeof o !== 'object' || o === null || typeof o.depth !== 'function')
      throw new TypeError('AerialPerspective needs a depth function returning the scene depth texture; pass {depth}');
    if (o.sky !== undefined && (typeof o.sky !== 'object' || o.sky === null || !(o.sky.sun?.length >= 3)))
      throw new TypeError('AerialPerspective sky must be a Sky (with a sun direction); pass the sky to follow');
    if (o.sunDirection) finiteVector(o.sunDirection, 3, 'AerialPerspective sunDirection');
    if (o.sunDirection && !(Math.hypot(...o.sunDirection) > 0))
      throw new RangeError('AerialPerspective sunDirection needs a nonzero length');
    if (
      !inRange(o.maxDistance ?? 64000, 1000, 400000) ||
      !inRange(o.metersPerUnit ?? 1, 1e-9, 1e6) ||
      !(o.metersPerUnit === undefined || o.metersPerUnit > 0) ||
      !inRange(o.altitude ?? 0, 0, 100000) ||
      !inRange(o.sunIlluminance ?? 20, 0, 1e6)
    )
      throw new RangeError(
        'Invalid AerialPerspective options; keep maxDistance 1000 to 400000, metersPerUnit above 0 to 1000000, altitude 0 to 100000 and sunIlluminance 0 or more.',
      );
    if (this.parameterSource !== o.atmosphere || !this.parameters) {
      this.parameters = atmosphereParameters(o.atmosphere);
      this.parameterSource = o.atmosphere;
    }
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'AerialPerspective requires WebGPU; attach a new AerialPerspective to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    const d = engine.gpu,
      volume = () =>
        d.createTexture({
          size: [SLICES, SLICES, SLICES],
          dimension: '3d',
          format: 'rgba16float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
    this.tables = new AtmosphereTables(d);
    this.scatter = volume();
    this.transmit = volume();
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }
  registerPasses(graph: FrameGraph): void {
    // After opaque surfaces and the clouds (3), before the sky's fog (5) and the effects drawn over the scene.
    graph.add({
      name: 'sky:aerial',
      order: 4,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    this.validate();
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid AerialPerspective delta; pass a finite delta of 0 or more seconds.');
  }
  private write(c: Context): void {
    const o = this.options,
      t = this.tables!,
      v = t.values,
      sun = o.sky?.sun ?? o.sunDirection ?? [0.3, 0.6, 0.4],
      length = Math.hypot(sun[0], sun[1], sun[2]) || 1,
      perUnit = o.metersPerUnit ?? o.sky?.options.metersPerUnit ?? 1,
      lent = o.atmosphere ? undefined : o.sky?.resolvedAtmosphere,
      a = lent ?? this.parameters!;
    if (!invertMatrixStable(c.camera.matrix, v.subarray(0, 16), this.scratch))
      throw new MargoError(
        'state',
        'Invalid AerialPerspective camera; give the camera a finite, invertible projection',
      );
    // The sky's own haze: its turbidity scales Mie scattering by max(0.25, (T - 1) / 2) (atmosphere.ts).
    t.medium(a, o.sky && !lent ? Math.max(0.25, ((o.sky.options.turbidity ?? 2) - 1) / 2) : 1);
    v[34] =
      o.sunIlluminance ??
      o.sky?.sunIlluminance ??
      (o.sky && (o.sky.options.model ?? 'preetham') === 'preetham' ? 10 : 20);
    for (let i = 0; i < 3; i++) v[36 + i] = sun[i] / length;
    v[39] = 2 ** (o.sky?.options.exposure ?? 0);
    v.set(c.camera.position, 40);
    v[43] = perUnit / 1000;
    v[44] = (o.maxDistance ?? 64000) / 1000;
    // The planet's centre lies under the camera: radius = ground + height (km), at least a metre up.
    v[45] =
      a.bottomRadius +
      Math.max(0.001, (c.camera.position[1] * perUnit + (o.altitude ?? o.sky?.options.altitude ?? 0)) / 1000);
    v[46] = +(c.format !== 'rgba16float');
  }
  private draw(c: Context): void {
    if (!this.tables) return;
    const depth = sceneDepth(c, this.options.depth, 'AerialPerspective');
    if (!depth) return;
    this.write(c);
    const t = this.tables,
      d = c.device;
    t.upload(c.encoder);
    this.volume ??= (() => {
      const pipeline = d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code: volumeShader }), entryPoint: 'main' },
      });
      return {
        pipeline,
        group: d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: t.uniform } },
            { binding: 1, resource: t.transmittance.createView() },
            { binding: 2, resource: t.multiple.createView() },
            { binding: 3, resource: t.sampler },
            { binding: 4, resource: this.scatter!.createView() },
            { binding: 5, resource: this.transmit!.createView() },
          ],
        }),
      };
    })();
    const compute = c.encoder.beginComputePass();
    compute.setPipeline(this.volume.pipeline);
    compute.setBindGroup(0, this.volume.group);
    compute.dispatchWorkgroups(SLICES / 8, SLICES / 8);
    compute.end();
    const key = `${c.format}:${c.descriptor.multisample?.count ?? 1}:${depth.samples}`;
    if (this.key !== key) {
      const module = d.createShaderModule({ code: compositeShader(depthWGSL(4, depth.samples)) }),
        pipeline = (entryPoint: string, blend: GPUBlendState) =>
          d.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex' },
            fragment: { module, entryPoint, targets: [{ format: c.format, blend }] },
            multisample: c.descriptor.multisample,
          });
      // The scene times the air's transmittance, per channel, then plus the light the air scatters toward the camera.
      this.passes = {
        transmit: pipeline('transmit', {
          color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        }),
        inscatter: pipeline('inscatter', {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        }),
      };
      this.key = key;
      this.bound = undefined;
    }
    if (this.bound !== depth.texture) {
      // Each pipeline's 'auto' layout is its own, so each gets its own group over the same resources.
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: t.uniform } },
        { binding: 1, resource: this.scatter!.createView() },
        { binding: 2, resource: this.transmit!.createView() },
        { binding: 3, resource: this.sampler! },
        { binding: 4, resource: depth.resource },
      ];
      this.binds = [
        d.createBindGroup({ layout: this.passes!.transmit.getBindGroupLayout(0), entries }),
        d.createBindGroup({ layout: this.passes!.inscatter.getBindGroupLayout(0), entries }),
      ];
      this.bound = depth.texture;
    }
    const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] });
    applyView(pass, c);
    pass.setPipeline(this.passes!.transmit);
    pass.setBindGroup(0, this.binds![0]);
    pass.draw(3);
    pass.setPipeline(this.passes!.inscatter);
    pass.setBindGroup(0, this.binds![1]);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.tables?.dispose();
    this.scatter?.destroy();
    this.transmit?.destroy();
    this.tables = this.scatter = this.transmit = this.sampler = undefined;
    this.volume = this.passes = this.binds = this.bound = undefined;
    this.key = '';
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
