/// <reference lib="esnext.disposable" preserve="true" />
// Contact hardening for local lights: a short screen-space ray march toward each point and spot light, from every lit
// fragment, against scene depth, in the manner of screen-space ray tracing (McGuire & Mara 2014). It darkens the thin
// contact gaps a shadow map's texels miss. Start offset from interleaved gradient noise (Jimenez 2014).
// The lit pass cannot read the depth it is writing, so the march reads the previous frame's depth, copied after the frame
// into a storage buffer with that frame's camera (a physical material with shadows, IBL and LocalShadows already binds
// all 16 sampled textures a shader stage may have; docs/shader-contracts.md). A caster that moved this frame is
// marched where it was one frame ago. A depth sample is read back at its texel's centre, and one within `bias` plus one
// texel's width of the lit point's tangent plane (or below it) is taken as the receiver's own surface, not an occluder:
// the depth is known only to a texel (nearest texel, and a multisampled depth holds sample 0, off the pixel centre), and
// from a 45-degree view one texel spans more depth than the start offset, so the top of a pebble shadowed itself.

import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { acquireDepth } from '../../shared/gpu.js';
import type { Clustered, ClusteredLightTerm } from './index.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; COPY_SRC: number };

/** Options of {@link ContactLights}; the object is kept and read every frame. */
export interface ContactLightOptions {
  /** The clustered lighting whose point and spot lights get contact shadows. */
  lights: Clustered;
  /**
   * The scene's single-sample depth texture (a `PostStack.depthTexture`, for example), or a callback giving it each
   * frame. Omitted: a shared scene-depth capture (the one water and HTML panels use), which another effect that owns
   * scene capture (SSAO, depth of field) refuses; pass that stack's depth then.
   */
  depth?: GPUTexture | (() => GPUTexture | undefined);
  /** How far each ray reaches toward its light, world units, above 0 (capped at the light's distance). Default 0.3. */
  distance?: number;
  /** How thick a depth sample counts as, world units, above 0; larger joins gaps and can shade behind thin objects. Default 0.1. */
  thickness?: number;
  /** Share of a light a contact removes, 0 to 1, for lights without their own in {@link ContactLights.setStrengths}. Default 0.8. */
  strength?: number;
  /** March steps per ray, 1 to 64. Default 12. */
  steps?: number;
  /**
   * Start offset along the surface normal, world units, 0 or more, against self-shadowing; a depth sample no further than
   * this plus one depth texel's width above the lit point's tangent plane never shadows it (that is the receiver's own
   * surface, to the depth's resolution). Default 0.01.
   */
  bias?: number;
}

/** Lights with their own contact strength; later lights use the default. */
export const MAX_CONTACT_LIGHTS = 1024;
const BINDING = 145,
  // Header floats: view-projection, its inverse, size (width, height, valid, 0), march (distance, thickness, steps,
  // bias), then one strength per light.
  HEADER = 40 + MAX_CONTACT_LIGHTS,
  HEADER_BYTES = HEADER * 4;

const sampling = (group: number) => /* wgsl */ `
struct ClusterContactData {view:mat4x4f,inverse:mat4x4f,size:vec4f,march:vec4f,strength:array<f32,${MAX_CONTACT_LIGHTS}>,depth:array<f32>}
@group(${group}) @binding(${BINDING}) var<storage,read> clusterContactData:ClusterContactData;
fn clusterContact(index:u32,light:ClusterLight,l:vec3f,position:vec3f,n:vec3f,pixel:vec2f)->f32 {
  let size=clusterContactData.size;let march=clusterContactData.march;
  if(size.z<0.5||index>=${MAX_CONTACT_LIGHTS}u){return 1.0;}
  let strength=clusterContactData.strength[index];if(strength<=0.0){return 1.0;}
  let reach=min(march.x,distance(light.positionRange.xyz,position));let stride=reach/march.z;
  let shift=fract(52.9829189*fract(dot(pixel,vec2f(0.06711056,0.00583715))));
  let unit=n/max(length(n),0.000001);let start=position+unit*march.w;
  for(var i=0.0;i<march.z;i+=1.0){
    let q=start+l*stride*(i+shift);let clip=clusterContactData.view*vec4f(q,1);
    if(clip.w<=0.0){break;}
    let ndc=clip.xyz/clip.w;let uv=ndc.xy*vec2f(0.5,-0.5)+0.5;
    if(any(uv<vec2f(0))||any(uv>=vec2f(1))){break;}
    let texel=min(vec2u(uv*size.xy),vec2u(size.xy)-1u);
    let found=clusterContactData.depth[texel.y*u32(size.x)+texel.x];
    if(found>ndc.z){
      let uvc=(vec2f(texel)+0.5)/size.xy;let centre=vec2f(uvc.x*2.0-1.0,1.0-uvc.y*2.0);
      let back=clusterContactData.inverse*vec4f(centre,found,1);let side=clusterContactData.inverse*vec4f(centre.x+2.0/size.x,centre.y,found,1);
      let hit=back.xyz/back.w;let texelSize=distance(side.xyz/side.w,hit);
      if(distance(hit,q)<march.y&&dot(hit-position,unit)>march.w+texelSize){return 1.0-strength;}
    }
  }
  return 1.0;
}
`;
const copyShader = /* wgsl */ `
@group(0) @binding(0) var source:texture_depth_2d;
@group(0) @binding(1) var<storage,read_write> data:array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(source);if(id.x>=size.x||id.y>=size.y){return;}
  data[${HEADER}u+id.y*size.x+id.x]=textureLoad(source,id.xy,0);
}`;

/**
 * Contact shadows per local light for clustered lighting: each lit fragment marches a short ray toward each point and
 * spot light through the previous frame's scene depth, and a hit removes `strength` of that light, so small details
 * touching a surface stay grounded where the light's shadow map (if any) is too coarse. Works with or without
 * `shadows`; directional and area lights are unchanged. It reads one frame late: a moving caster's contact trails it by
 * a frame, and what was off screen casts nothing. Receivers added with `receiveShadow: false` skip it.
 * ```ts
 * const lights = Clustered.attach(engine);
 * lights.setLights([{ position: [0, 2, 0], range: 8 }]);
 * ContactLights.attach(engine, { lights, distance: 0.25 });
 * ```
 * @throws TypeError without the Clustered lights; RangeError for an option out of range (checked now and every
 * frame) or a multisampled depth; MargoError `'unsupported'` without WebGPU, `'disposed'` after `dispose()`, `'state'`
 * when the shared scene depth is owned by another effect.
 */
export class ContactLights implements EnginePlugin, ClusteredLightTerm {
  readonly name = 'clustered:contact';
  /** @internal ClusteredLightTerm: the factor in the light loop. */
  readonly term = 'clusterContact(index,light,l,position,n,pixel)';
  readonly lights: Clustered;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  // A buffer replaced mid-frame: this frame's lit passes still read it, so it is destroyed only on the next frame.
  private retired: GPUBuffer[] = [];
  private staging?: GPUBuffer;
  private pipeline?: GPUComputePipeline;
  private group?: GPUBindGroup;
  private source?: GPUTexture;
  private shared?: ReturnType<typeof acquireDepth>;
  private entries: GPUBindGroupEntry[] = [];
  private readonly header = new Float32Array(HEADER);
  private readonly workspace = new Float64Array(52);
  private strengths: readonly (number | null | undefined)[] = Object.freeze([]);
  private disposed = false;
  constructor(readonly options: ContactLightOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError('ContactLights needs the Clustered lights: new ContactLights({ lights })');
    this.lights = options.lights;
    this.validate();
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: ContactLightOptions): ContactLights {
    const effect = new ContactLights(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** The strengths last given to `setStrengths` (a frozen copy). */
  get list(): readonly (number | null | undefined)[] {
    return this.strengths;
  }
  /**
   * Entry i is the contact strength (0 to 1; 0 turns it off) of the light at index i of `Clustered.setLights`; null,
   * undefined and lights past the end use `options.strength`. At most {@link MAX_CONTACT_LIGHTS} entries; lights from
   * that index on always use the default.
   */
  setStrengths(values: readonly (number | null | undefined)[]): this {
    if (this.disposed) throw new MargoError('disposed', 'ContactLights is disposed; create new ContactLights');
    if (!Array.isArray(values) || values.length > MAX_CONTACT_LIGHTS)
      throw new RangeError(`Expected an array of at most ${MAX_CONTACT_LIGHTS} contact strengths`);
    for (const value of values)
      if (value !== null && value !== undefined && !(value >= 0 && value <= 1))
        throw new RangeError('A contact strength must be in 0..1, or null for the default');
    this.strengths = Object.freeze([...values]);
    return this;
  }
  private validate(): void {
    const o = this.options,
      above = (value: number | undefined) => value === undefined || (Number.isFinite(value) && value > 0);
    if (!above(o.distance) || !above(o.thickness))
      throw new RangeError('ContactLights distance and thickness must be finite and above 0; pass world units');
    if (o.strength !== undefined && !(o.strength >= 0 && o.strength <= 1))
      throw new RangeError('ContactLights strength must be in 0..1; pass a share of the light');
    if (o.steps !== undefined && !(Number.isInteger(o.steps) && o.steps >= 1 && o.steps <= 64))
      throw new RangeError('ContactLights steps must be a whole number from 1 to 64');
    if (o.bias !== undefined && !(Number.isFinite(o.bias) && o.bias >= 0))
      throw new RangeError('ContactLights bias must be finite and 0 or more; pass world units');
    if (o.depth !== undefined && typeof o.depth !== 'function' && typeof o.depth?.createView !== 'function')
      throw new TypeError('ContactLights depth must be a GPUTexture or a callback giving one');
  }
  /** @internal ClusteredLightTerm: WGSL defining `clusterContact`. */
  declarations(group: number): string {
    return sampling(group);
  }
  /** @internal ClusteredLightTerm: binding 145 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.buffer || this.disposed)
      throw new MargoError('state', 'ContactLights is not attached; engine.use(contact) first');
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'ContactLights is disposed; create new ContactLights');
    if (!engine.gpu)
      throw new MargoError(
        'unsupported',
        'ContactLights requires the WebGPU backend; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    if (this.options.depth === undefined) this.shared = acquireDepth(engine);
    this.staging = this.device.createBuffer({
      size: HEADER_BYTES,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.allocate(0, 0);
    this.lights.contact = this;
  }
  /** A buffer for the header and width x height depths: created zeroed, so the march stays off until the first copy. */
  private allocate(width: number, height: number): void {
    // A struct holding a runtime array binds at least its size rounded up to its 16-byte alignment (the mat4x4f).
    const size = Math.ceil((HEADER_BYTES + Math.max(1, width * height) * 4) / 16) * 16,
      limits = this.device!.limits;
    if (size > limits.maxStorageBufferBindingSize || size > limits.maxBufferSize)
      throw new RangeError('The contact depth copy exceeds the device storage buffer limit; render at a smaller size');
    if (this.buffer) this.retired.push(this.buffer);
    const buffer = (this.buffer = this.device!.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }));
    this.entries = [{ binding: BINDING, resource: { buffer } }];
    this.group = undefined;
  }
  /** The header for the next frame: this frame's camera, the copied size and the march settings. */
  private fill(matrix: ArrayLike<number>, width: number, height: number): void {
    const o = this.options,
      h = this.header,
      fallback = o.strength ?? 0.8;
    h.set(matrix as Float32Array, 0);
    const valid = invertMatrixStable(matrix, h.subarray(16, 32), this.workspace);
    h.set(
      [
        width,
        height,
        valid !== null && width > 0 ? 1 : 0,
        0,
        o.distance ?? 0.3,
        o.thickness ?? 0.1,
        o.steps ?? 12,
        o.bias ?? 0.01,
      ],
      32,
    );
    const strengths = this.strengths;
    for (let i = 0; i < MAX_CONTACT_LIGHTS; i++) h[40 + i] = strengths[i] ?? fallback;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      // After the frame (scene capture restores at 10000): the copy feeds the next frame's march.
      order: 10001,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.buffer || this.disposed) return;
        // Only the canvas's first view: one depth copy per frame.
        if (c.view && (c.view.index > 0 || c.view.target)) return;
        for (const old of this.retired.splice(0)) old.destroy();
        this.validate();
        const depth = this.options.depth,
          texture = typeof depth === 'function' ? depth() : (depth ?? this.shared?.texture());
        if (texture && texture.sampleCount > 1)
          throw new RangeError('ContactLights needs a single-sample depth texture; pass the resolved scene depth');
        const width = texture?.width ?? 0,
          height = texture?.height ?? 0;
        if (texture && this.buffer.size < HEADER_BYTES + width * height * 4) this.allocate(width, height);
        this.fill(c.camera.matrix, texture ? width : 0, texture ? height : 0);
        c.device.queue.writeBuffer(this.staging!, 0, this.header as Float32Array<ArrayBuffer>);
        // The header is copied in the encoder, after this frame's lit passes read the previous one.
        c.encoder.copyBufferToBuffer(this.staging!, 0, this.buffer, 0, HEADER_BYTES);
        if (!texture) return;
        this.pipeline ??= c.device.createComputePipeline({
          layout: 'auto',
          compute: { module: c.device.createShaderModule({ code: copyShader }), entryPoint: 'main' },
        });
        if (!this.group || this.source !== texture) {
          this.source = texture;
          this.group = c.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: texture.createView({ aspect: 'depth-only' }) },
              { binding: 1, resource: { buffer: this.buffer } },
            ],
          });
        }
        const pass = c.encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.group);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
      },
    });
  }
  private release(): void {
    if (this.lights.contact === this) this.lights.contact = undefined;
    this.buffer?.destroy();
    for (const old of this.retired.splice(0)) old.destroy();
    this.staging?.destroy();
    this.shared?.release();
    this.buffer = this.staging = this.pipeline = this.group = this.source = this.shared = undefined;
    this.entries = [];
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
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
