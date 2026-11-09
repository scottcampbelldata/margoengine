/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/splats/lighting: a splat cloud that takes the scene's light and casts shadows on meshes, so a capture
// sits in a lit scene. Relighting: after the cloud projects, each splat's colour is scaled by the engine's directional
// light and ambient with core's diffuse terms (Lambert / pi times light colour and intensity, plus ambient). A splat's
// normal is the axis of its smallest covariance eigenvalue (the flat axis of the Gaussian), turned to the viewer: the
// shortest-axis normal of Jiang et al. 2024, "GaussianShader" (CVPR), and Gao et al. 2023, "Relightable 3D Gaussian";
// the eigenvalue is Smith's closed form, "Eigenvalues of a symmetric 3x3 matrix", CACM 4(4), 1961. Shadows: as a
// `@margoengine/shadows` source, each splat draws its EWA ellipse (Zwicker et al. 2001) in the light's clip space and
// writes the depth of its centre with probability equal to its Gaussian opacity at each texel, so overlapping splats
// block light as their accumulated opacity does on average: stochastic transparency, Enderton et al. 2010,
// "Stochastic Transparency" (I3D); hash: PCG of Jarzynski and Olano 2020, "Hash Functions for GPU Rendering" (JCGT).
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Splats } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link SplatLighting}. */
export interface SplatLightingOptions {
  /**
   * Shadow coverage. Unset (the default): stochastic, a splat blocks each shadow-map texel with the probability of its
   * opacity there, so a capture's many small overlapping splats shade as their combined opacity (noisy at a texel,
   * smoothed by the shadow filter). A number from 0 to 1: a splat blocks where its opacity reaches it, as `./depth`
   * (no noise, but a sparse capture leaves gaps). Live: `lighting.threshold`.
   */
  threshold?: number;
  /** Relight the cloud with the scene light (false keeps its captured colours; it still casts). Default true. Live. */
  relight?: boolean;
}

/** What `@margoengine/shadows` hands a custom caster for one cascade (its `ShadowContext`). */
export interface SplatShadowContext {
  context: { device: GPUDevice };
  pass: GPURenderPassEncoder;
  /** The cascade's light view-projection matrix, 16 floats, column-major. */
  matrix: Float32Array;
  /** Cascade index, 0 to 3. */
  cascade: number;
}

const covariance = `let a=covariances[index*2];let b=covariances[index*2+1];let cov=mat3x3f(vec3f(a.x,a.y,a.z),vec3f(a.y,a.w,b.x),vec3f(a.z,b.x,b.y));`;
/**
 * WGSL of the relight pass. Uniform: eye, light (xyz toward the light, unit; w intensity), radiance (rgb; w ambient),
 * ambient rgb, counts (x splats, y 1 to relight).
 */
export const relightShader = `struct Light {eye:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f,counts:vec4u}
@group(0) @binding(0) var<uniform> u:Light;
@group(0) @binding(1) var<storage,read> positions:array<vec4f>;
@group(0) @binding(2) var<storage,read> covariances:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> evaluated:array<vec4f>;
// Unit eigenvector of the smallest eigenvalue of a symmetric matrix; the view direction for a round splat.
fn flatAxis(m:mat3x3f,view:vec3f)->vec3f {
  let p1=m[0].y*m[0].y+m[0].z*m[0].z+m[1].z*m[1].z;let q=(m[0].x+m[1].y+m[2].z)/3.0;
  let p2=(m[0].x-q)*(m[0].x-q)+(m[1].y-q)*(m[1].y-q)+(m[2].z-q)*(m[2].z-q)+2.0*p1;let p=sqrt(p2/6.0);
  if(p<=1e-6*max(abs(q),1e-30)){return view;}
  let bm=(m-mat3x3f(vec3f(q,0,0),vec3f(0,q,0),vec3f(0,0,q)))*(1.0/p);let r=clamp(determinant(bm)*0.5,-1.0,1.0);
  let smallest=q+2.0*p*cos(acos(r)/3.0+2.0943951024);
  let s=m-mat3x3f(vec3f(smallest,0,0),vec3f(0,smallest,0),vec3f(0,0,smallest));
  let c0=cross(s[0],s[1]);let c1=cross(s[0],s[2]);let c2=cross(s[1],s[2]);
  var n=c0;if(dot(c1,c1)>dot(n,n)){n=c1;}if(dot(c2,c2)>dot(n,n)){n=c2;}
  if(dot(n,n)<1e-30){return view;}return normalize(n);
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {
  let index=id.x;if(index>=u.counts.x||u.counts.y==0u){return;}let world=positions[index];if(world.w<=0){return;}
  ${covariance}
  let view=normalize(u.eye.xyz-world.xyz);var n=flatAxis(cov,view);if(dot(n,view)<0){n=-n;}
  let nl=max(dot(n,u.light.xyz),0.0);let e=evaluated[index];
  evaluated[index]=vec4f(e.rgb*(u.radiance.rgb*u.light.w*nl/3.14159265+u.radiance.w*u.ambient.rgb),e.a);
}`;
/**
 * WGSL of the shadow caster: the colour pass's 3 sigma quad and falloff in the light's clip space, with the Jacobian
 * of clip/w by position. threshold.x: the coverage threshold (negative for stochastic); threshold.yz: the colour pass's
 * 0.3 px^2 dilation in shadow-map texels, so a capture's sub-texel splats still cover texels as they cover pixels.
 */
export const shadowShader = `struct Caster {m:mat4x4f,threshold:vec4f}
@group(0) @binding(0) var<uniform> u:Caster;
@group(0) @binding(1) var<storage,read> positions:array<vec4f>;
@group(0) @binding(2) var<storage,read> covariances:array<vec4f>;
struct Out {@builtin(position) clip:vec4f,@location(0) corner:vec2f,@location(1) @interpolate(flat) opacity:f32,@location(2) @interpolate(flat) index:u32}
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) index:u32)->Out {
  let corners=array<vec2f,4>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(1,1));let world=positions[index];var o:Out;
  o.corner=corners[vertex];o.opacity=world.w;o.index=index;o.clip=vec4f(2,2,0,1);
  let c=u.m*vec4f(world.xyz,1);if(world.w<=0||world.w<u.threshold.x||c.w<=0){return o;}
  ${covariance}
  let rw=vec3f(u.m[0].w,u.m[1].w,u.m[2].w);
  let jx=(vec3f(u.m[0].x,u.m[1].x,u.m[2].x)-rw*(c.x/c.w))/c.w;let jy=(vec3f(u.m[0].y,u.m[1].y,u.m[2].y)-rw*(c.y/c.w))/c.w;
  let xx=dot(jx,cov*jx)+u.threshold.y;let xy=dot(jx,cov*jy);let yy=dot(jy,cov*jy)+u.threshold.z;let mid=(xx+yy)*0.5;
  let radius=sqrt(max(0.0,(xx-yy)*(xx-yy)*0.25+xy*xy));let major=max(mid+radius,0.0);let minor=max(mid-radius,0.0);
  var axis=vec2f(1,0);if(abs(xy)>1e-12){axis=normalize(vec2f(xy,major-xx));}else if(yy>xx){axis=vec2f(0,1);}
  let first=axis*(3*sqrt(major));let second=vec2f(-axis.y,axis.x)*(3*sqrt(minor));
  o.clip=vec4f(c.xy/c.w+first*o.corner.x+second*o.corner.y,c.z/c.w,1);return o;
}
fn hash(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
@fragment fn fragment(i:Out) {let power=-4.5*dot(i.corner,i.corner);if(power<-4.5){discard;}let alpha=min(0.99,i.opacity*exp(power));
  // Stochastic (threshold < 0): block with probability alpha, from a hash of the splat and the texel.
  var cut=u.threshold.x;if(cut<0){let t=vec2u(i.clip.xy);cut=f32(hash(hash(hash(i.index)^t.x)^t.y)>>8u)/16777216.0;}if(alpha<cut){discard;}}`;

/**
 * Scene light and shadows for a splat cloud: `const lit = SplatLighting.attach(engine, cloud)` relights it with
 * `engine.lighting` every frame, and `shadows.add(lit)` (a `@margoengine/shadows` `Shadows`) makes it cast on meshes.
 * WebGPU only, as `Splats`.
 * @throws RangeError for a threshold outside 0 to 1 (unset is stochastic); TypeError when `cloud` is not a Splats.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` when attached after `dispose()`.
 */
export class SplatLighting implements EnginePlugin {
  private static next = 0;
  readonly name = 'splats-lighting:' + SplatLighting.next++;
  readonly cloud: Splats;
  /** Relight with the scene light; false keeps the captured colours. */
  relight: boolean;
  private value: number | undefined;
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private casterUniform?: GPUBuffer;
  private readonly data = new Float32Array(20);
  private readonly integers = new Uint32Array(this.data.buffer);
  private readonly caster = new Float32Array(20);
  private compute?: GPUComputePipeline;
  private group?: { group: GPUBindGroup; colors: GPUBuffer; positions: GPUBuffer };
  private shadow?: { pipeline: GPURenderPipeline; groups: GPUBindGroup[]; positions: GPUBuffer; device: GPUDevice };
  private shadows?: { options?: { resolution?: number | readonly [number, number] } };
  private dead = false;
  constructor(cloud: Splats, options: SplatLightingOptions = {}) {
    if (!cloud || typeof cloud !== 'object' || !('gpuState' in cloud))
      throw new TypeError('SplatLighting needs a Splats cloud');
    this.cloud = cloud;
    this.value = options.threshold === undefined ? undefined : check(options.threshold);
    this.relight = options.relight ?? true;
  }
  /** Same as `engine.use(new SplatLighting(cloud, options))`; returns it. */
  static attach(engine: EngineKernel, cloud: Splats, options: SplatLightingOptions = {}): SplatLighting {
    const lighting = new SplatLighting(cloud, options);
    engineRuntime(engine).use(lighting);
    return lighting;
  }
  /** Opacity a splat must reach at a shadow-map texel to block the light (0 to 1), or undefined for stochastic. */
  get threshold(): number | undefined {
    return this.value;
  }
  set threshold(value: number | undefined) {
    this.value = value === undefined ? undefined : check(value);
  }
  /** True once disposed (`@margoengine/shadows` then drops it). */
  get disposed(): boolean {
    return this.dead;
  }
  setup(engine: Engine): void {
    if (this.dead || !engine.gpu)
      throw new MargoError(
        this.dead ? 'disposed' : 'unsupported',
        'SplatLighting needs WebGPU; attach a new SplatLighting to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  registerPasses(graph: FrameGraph): void {
    // After the cloud projects and sorts (order -7), before it draws (3): the colours it draws are relit.
    graph.add({
      name: this.name,
      order: -6.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.light(c);
      },
    });
  }
  private light(c: Context): void {
    if (!this.relight || !this.cloud.attached) return;
    const state = this.cloud.gpuState,
      d = c.device;
    this.compute ??= d.createComputePipeline({
      layout: 'auto',
      compute: { module: d.createShaderModule({ code: relightShader }), entryPoint: 'main' },
    });
    // A restored device or a re-attached cloud hands new buffers: the group follows them.
    if (!this.group || this.group.colors !== state.colors || this.group.positions !== state.positions)
      this.group = {
        group: d.createBindGroup({
          layout: this.compute.getBindGroupLayout(0),
          entries: [this.uniform!, state.positions, state.covariances, state.colors].map((buffer, binding) => ({
            binding,
            resource: { buffer },
          })),
        }),
        colors: state.colors,
        positions: state.positions,
      };
    const { direction, radiance, ambient } = this.engine!.lighting,
      v = this.data,
      length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    v.set(c.camera.position, 0);
    for (let k = 0; k < 3; k++) v[4 + k] = direction[k] / length;
    v[7] = direction[3];
    v.set(radiance, 8);
    if (ambient) v.set(ambient, 12);
    else v[12] = v[13] = v[14] = 1;
    this.integers[16] = this.cloud.count;
    this.integers[17] = 1;
    d.queue.writeBuffer(this.uniform!, 0, v);
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.compute);
    pass.setBindGroup(0, this.group.group);
    pass.dispatchWorkgroups(Math.ceil(this.cloud.count / 256));
    pass.end();
  }
  /**
   * Called by `Shadows.add(lighting)`: the shadow map size, read each frame, sets the splats' smallest footprint there.
   * Returns the remover.
   */
  addLighting(shadows: { options?: { resolution?: number | readonly [number, number] } }): () => void {
    this.shadows = shadows;
    return () => {
      if (this.shadows === shadows) this.shadows = undefined;
    };
  }
  /** Draws the cloud's depth into one shadow cascade (the `ShadowSource` contract of `@margoengine/shadows`). */
  drawShadow({ context, pass, matrix, cascade }: SplatShadowContext): void {
    if (this.dead || !this.cloud.attached) return;
    const state = this.cloud.gpuState,
      d = context.device;
    if (!this.shadow || this.shadow.positions !== state.positions || this.shadow.device !== d) {
      this.casterUniform?.destroy();
      // One 256-byte slot per cascade: every cascade's matrix is written before the frame is submitted.
      this.casterUniform = d.createBuffer({ size: 1024, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const module = d.createShaderModule({ code: shadowShader }),
        pipeline = d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [] },
          primitive: { topology: 'triangle-strip' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
        }),
        layout = pipeline.getBindGroupLayout(0),
        groups = [0, 1, 2, 3].map((slot) =>
          d.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer: this.casterUniform!, offset: slot * 256, size: 80 } },
              { binding: 1, resource: { buffer: state.positions } },
              { binding: 2, resource: { buffer: state.covariances } },
            ],
          }),
        );
      this.shadow = { pipeline, groups, positions: state.positions, device: d };
    }
    this.caster.set(matrix);
    this.caster[16] = this.value ?? -1;
    const r = this.shadows?.options?.resolution ?? 2048,
      [w, h] = typeof r === 'number' ? [r, r] : r;
    this.caster[17] = 0.3 * (2 / w) ** 2;
    this.caster[18] = 0.3 * (2 / h) ** 2;
    d.queue.writeBuffer(this.casterUniform!, cascade * 256, this.caster);
    pass.setPipeline(this.shadow.pipeline);
    pass.setBindGroup(0, this.shadow.groups[cascade]);
    pass.draw(4, this.cloud.count);
  }
  onDeviceRestored(engine: Engine): void {
    this.compute = this.group = this.shadow = this.casterUniform = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.engine?.removePlugin(this.name);
    this.uniform?.destroy();
    this.casterUniform?.destroy();
    this.uniform = this.casterUniform = this.engine = this.compute = this.group = this.shadow = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

function check(value: number): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1))
    throw new RangeError('SplatLighting threshold must be 0 to 1');
  return value;
}
