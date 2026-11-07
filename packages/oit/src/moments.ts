// Moment-based order-independent transparency (Muenstermann, Krumpen, Klein and Peters 2018, I3D). A first pass sums the
// optical depth of each pixel's layers and four power moments of their depth; a second shades every fragment and scales
// it by the transmittance in front of it, read back from the moments by the Hamburger bound of Peters and Klein 2015.
//
// Every target is rgba16float or r16float, which blend on every WebGPU device. Half precision costs bias, not layers: on
// a CPU model of 2, 4 and 8 random layers, bias 5e-5 on halves stays within 0.5 of 255 of float sums at bias 5e-7.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type PassContext } from '@margoengine/core/extension';
import type { PBRModel, PBRTransparency } from '@margoengine/gltf-pro';
import { applyView } from '../../shared/view-rect.js';
import { currentFrame, retire, writeUniform } from '../../shared/frame-resources.js';
import { alphaBlend, groupCode, type SurfaceTransparency } from '../../shared/pass.js';
import { TransparentPass, pbrLayer } from './pass.js';

export type { TransparentPass };

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** `MomentOIT` settings, fixed at construction. */
export interface MomentOITOptions {
  /** Frame graph order of the transparent passes, as in `OITOptions`. Default 8. */
  order?: number;
  /**
   * Nearest and farthest view depth the moments resolve, `[near, far]`, with 0 < near < far; layers outside blend as if
   * at the end they passed. A range close around the transparent parts is the sharpest. Default: the box round the added
   * models, as they stood on the first frame after `add` or `fit`, seen from each frame's camera; with an effect added
   * (`@margoengine/oit/vfx`), which has no box, the camera's near and far.
   */
  depthRange?: readonly [number, number];
}

// Group-2 bindings, beside weighted OIT's uniform (120), clear of transmission (124).
const BINDING = 120;
const add: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one' },
  alpha: { srcFactor: 'one', dstFactor: 'one' },
};
const warp = /* wgsl */ `
fn margoWarp(depth:f32)->f32 {
  return clamp(log(max(depth,1e-6))*margoOIT.x+margoOIT.y,-1.0,1.0);
}
`;
// Depth is warped to -1..1 by its logarithm (x, y of the uniform). Optical depth, not alpha, is what adds up.
const sums = (group: number) => /* wgsl */ `
struct MargoTransparent {@location(0) moments:vec4f, @location(1) optical:vec4f}
@group(${group}) @binding(${BINDING}) var<uniform> margoOIT:vec4f;
${warp}
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  let tau=-log(1.0-clamp(color.a,0.0,0.999)); let z=margoWarp(depth); let z2=z*z; var o:MargoTransparent;
  o.moments=tau*vec4f(z,z2,z2*z,z2*z2); o.optical=vec4f(tau); return o;
}
`;
// Hamburger bound with 4 moments: the Cholesky factors of the Hankel matrix give the kernel polynomial through z; its
// roots and z carry the three-point distribution that matches the moments, and the share below z is what lies in front.
// At z itself a quarter counts (the paper's overestimation), so a layer dims itself a little instead of half.
// The bias pulls the moments towards those of a fixed distribution, which keeps the matrix invertible on half sums.
const shade = (group: number) => /* wgsl */ `
struct MargoTransparent {@location(0) color:vec4f}
@group(${group}) @binding(${BINDING}) var<uniform> margoOIT:vec4f;
@group(${group}) @binding(${BINDING + 1}) var margoMoments:texture_2d<f32>;
@group(${group}) @binding(${BINDING + 2}) var margoOptical:texture_2d<f32>;
${warp}
fn margoInFront(b:vec4f,z:f32)->f32 {
  let m=mix(b,vec4f(0.0,0.375,0.0,0.375),5e-5);
  let d22=max(m.y-m.x*m.x,1e-7); let l32=(m.z-m.x*m.y)/d22; let d33=max(m.w-m.y*m.y-l32*l32*d22,1e-7);
  let y2=z-m.x; let y3=z*z-m.y-l32*y2;
  let c2=y3/d33; let c1=y2/d22-l32*c2; let c0=1.0-m.x*c1-m.y*c2;
  if(abs(c2)<1e-9){return 0.0;}
  let root=sqrt(max(c1*c1-4.0*c2*c0,0.0)); let r=vec2f(-c1-root,-c1+root)/(2.0*c2);
  let lo=min(r.x,r.y); let hi=max(r.x,r.y);
  let share=vec3f((m.y-(lo+hi)*m.x+lo*hi)/((z-lo)*(z-hi)),(m.y-(z+hi)*m.x+z*hi)/((lo-z)*(lo-hi)),(m.y-(z+lo)*m.x+z*lo)/((hi-z)*(hi-lo)));
  return clamp(select(0.0,share.y,lo<z)+select(0.0,share.z,hi<z)+0.25*share.x,0.0,1.0);
}
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  let q=vec2i(clip.xy); let total=textureLoad(margoOptical,q,0).r; var o:MargoTransparent;
  var t=1.0;
  if(total>1e-5){t=exp(-total*margoInFront(textureLoad(margoMoments,q,0)/total,margoWarp(depth)));}
  let w=clamp(color.a,0.0,1.0)*t; o.color=vec4f(color.rgb*w,w); return o;
}
`;
// As weighted OIT's composite: the weighted average colour at the coverage the optical depth gives.
const composite = /* wgsl */ `
@group(0) @binding(0) var colorMap:texture_2d<f32>;
@group(0) @binding(1) var opticalMap:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let q=vec2i(p.xy); let a=textureLoad(colorMap,q,0); return vec4f(a.rgb/max(a.a,1e-5),1-exp(-textureLoad(opticalMap,q,0).r));
}
`;

/** The formats of the three targets, in the order `targets` makes them. */
const formats: readonly GPUTextureFormat[] = ['rgba16float', 'r16float', 'rgba16float'];

/**
 * Moment-based order-independent transparency: `oit.add(model)` draws the model's BLEND primitives (gltf-pro) or a
 * transparent materials mesh twice, once to sum the moments of each pixel's layers and once to shade each layer by the
 * transmittance in front of it, so a near layer really does hide a far one. Closer to exact than `OIT` with several
 * layers, at about twice its geometry cost, and with fixed memory, unlike `ExactOIT`. Still an approximation. Models not
 * added keep sorted blending. WebGPU only.
 * @throws RangeError from the constructor for an `order` or `depthRange` out of range.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` from `add` before
 * `attach`.
 */
export class MomentOIT extends TransparentPass {
  readonly targets: readonly GPUColorTargetState[] = [
    { format: 'rgba16float', blend: add },
    { format: 'r16float', blend: add },
  ];
  private readonly range?: readonly [number, number];
  /** World box of the added models: min x, y, z, max x, y, z. */
  private box?: number[];
  readonly layout: readonly GPUBindGroupLayoutEntry[] = [{ binding: BINDING, visibility: 2, buffer: {} }];
  private readonly code = new Map<number, string>();
  private readonly surfaceCode = new Map<number, string>();
  private readonly shadeCode = new Map<number, string>();
  private readonly shadeSurface = new Map<number, string>();
  private readonly values = new Float32Array(4);
  private uniform?: GPUBuffer;
  /** This view's uniform binding while its models draw (a frame-arena slice for a second view). */
  private binding?: GPUBufferBinding;
  /** Resolved targets (moments, optical depth, colour), then their multisampled draw targets. */
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private size = '';
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly groups = new Map<GPURenderPipeline, GPUBindGroup>();
  private shading?: GPURenderPassEncoder;
  /** The second draw of each model, a hook of its own because its shader and target differ. */
  private readonly shader: PBRTransparency & SurfaceTransparency = {
    targets: [{ format: 'rgba16float', blend: add }],
    layout: [
      ...this.layout,
      { binding: BINDING + 1, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
      { binding: BINDING + 2, visibility: 2, texture: { sampleType: 'unfilterable-float' } },
    ],
    declarations: (group) => groupCode(this.shadeCode, group, (g) => this.shader.surface(g) + pbrLayer),
    surface: (group) => groupCode(this.shadeSurface, group, shade),
    bindings: () => [
      { binding: BINDING, resource: this.binding ?? { buffer: this.uniform! } },
      { binding: BINDING + 1, resource: this.views[0] },
      { binding: BINDING + 2, resource: this.views[1] },
    ],
    begin: () => (this.shading ??= this.open('oit:shade', [2], [[0, 0, 0, 0]])),
  };

  static attach(engine: EngineKernel, options?: MomentOITOptions): MomentOIT {
    const value = new MomentOIT(options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor({ order = 8, depthRange }: MomentOITOptions = {}) {
    if (depthRange && !(depthRange[0] > 0 && depthRange[1] > depthRange[0] && Number.isFinite(depthRange[1])))
      throw new RangeError('Invalid MomentOIT depthRange; use [near, far] with 0 < near < far');
    super(order);
    this.range = depthRange;
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    this.uniform = engine.gpu!.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  override add(model: PBRModel): () => void {
    this.box = undefined;
    return super.add(model);
  }
  /** Measures the added models again on the next frame; call it after moving them far. Measuring reads every vertex. */
  fit(): void {
    this.box = undefined;
  }
  /** The view depths the box round the added models spans from this camera, a little wider so its faces stay inside. */
  private depthSpan(c: Context): [number, number] {
    if (this.effects.size) return [c.camera.near, c.camera.far];
    let box = this.box;
    if (!box) {
      box = this.box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const model of this.models.keys())
        if (model.primitives.length) {
          const b = model.bounds;
          for (let k = 0; k < 3; k++) {
            box[k] = Math.min(box[k], b[k]);
            box[k + 3] = Math.max(box[k + 3], b[k + 3]);
          }
        }
    }
    const { position, target, near } = c.camera,
      axis = position.map((p, k) => target[k] - p),
      length = Math.hypot(...axis) || 1;
    let least = Infinity,
      most = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
      let depth = 0;
      for (let k = 0; k < 3; k++) depth += (box[(corner >> k) & 1 ? k + 3 : k] - position[k]) * (axis[k] / length);
      least = Math.min(least, depth);
      most = Math.max(most, depth);
    }
    const start = Math.max(least * 0.98, near);
    return [start, Math.max(most * 1.02, start * 1.01)];
  }
  /** @internal gltf-pro transparency hook. */
  declarations(group: number): string {
    return groupCode(this.code, group, (g) => this.surface(g) + pbrLayer);
  }
  /** @internal Effect hook. */
  surface(group: number): string {
    return groupCode(this.surfaceCode, group, sums);
  }
  /** @internal gltf-pro transparency hook. */
  bindings(): GPUBindGroupEntry[] {
    return [{ binding: BINDING, resource: this.binding ?? { buffer: this.uniform! } }];
  }
  /** @internal gltf-pro transparency hook: the moment pass, begun on the first transparent draw of the frame. */
  begin(): GPURenderPassEncoder {
    return (this.pass ??= this.open(
      'oit:moments',
      [0, 1],
      [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    ));
  }
  /** A pass on the targets at `slots`: with MSAA the multisampled ones, which resolve as the pass ends. */
  private open(label: string, slots: number[], clears: number[][]): GPURenderPassEncoder {
    const c = this.context!,
      msaa = this.views.length > 3,
      v = this.views;
    const pass = c.encoder.beginRenderPass({
      label,
      colorAttachments: slots.map((slot, i) => ({
        view: msaa ? v[slot + 3] : v[slot],
        resolveTarget: msaa ? v[slot] : undefined,
        clearValue: clears[i],
        loadOp: 'clear',
        storeOp: msaa ? 'discard' : 'store',
      })),
      depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
    });
    applyView(pass, c);
    return pass;
  }
  protected render(c: Context): void {
    // This view draws in the frame: what it releases waits while another view's commands still need it.
    currentFrame(c.device, c.view ?? c);
    if (this.disposed || this.empty) return;
    const samples = c.descriptor.multisample?.count ?? 1,
      size = c.width + 'x' + c.height + 'x' + samples,
      device = c.device;
    if (size !== this.size) {
      this.release();
      this.size = size;
      for (const count of samples > 1 ? [1, 1, 1, samples, samples, samples] : [1, 1, 1]) {
        const format = formats[this.textures.length % 3];
        const texture = device.createTexture({
          label: 'oit:' + format,
          size: [c.width, c.height],
          format,
          sampleCount: count,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | (count === 1 ? GPUTextureUsage.TEXTURE_BINDING : 0),
        });
        this.textures.push(texture);
        this.views.push(texture.createView());
      }
    }
    const [near, far] = this.range ?? this.depthSpan(c);
    // log(z) * x + y runs from -1 at near to 1 at far.
    this.values[0] = 2 / Math.log(far / near);
    this.values[1] = -1 - this.values[0] * Math.log(near);
    // A second view in the same frame gets its own copy of the uniform.
    this.binding = writeUniform(device, this.uniform!, this.values, c.view ?? c);
    try {
      if (!this.drawModels(c)) return;
      this.context = c;
      this.shading = undefined;
      try {
        for (const model of this.models.keys()) model.drawTransparent(c, this.shader);
        for (const effect of this.effects.keys()) effect.drawTransparent(c, this.shader);
      } finally {
        (this.shading as GPURenderPassEncoder | undefined)?.end();
        this.shading = undefined;
        this.context = undefined;
      }
    } finally {
      this.binding = undefined;
    }
    const key = c.format + samples;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: composite });
      this.pipelines.set(
        key,
        (pipeline = device.createRenderPipeline({
          label: 'oit:composite',
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format, blend: alphaBlend }] },
          multisample: { count: samples },
        })),
      );
    }
    let group = this.groups.get(pipeline);
    if (!group)
      this.groups.set(
        pipeline,
        (group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.views[2] },
            { binding: 1, resource: this.views[1] },
          ],
        })),
      );
    const out = c.encoder.beginRenderPass({
      label: 'oit:composite',
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
    });
    applyView(out, c);
    out.setPipeline(pipeline);
    out.setBindGroup(0, group);
    out.draw(3);
    out.end();
  }
  protected release(): void {
    for (const t of this.textures) retire(this.device!, t);
    this.textures = [];
    this.views = [];
    this.size = '';
    this.groups.clear();
  }
  protected freeDevice(): void {
    this.release();
    this.pipelines.clear();
    retire(this.device!, this.uniform);
    this.uniform = undefined;
  }
}
