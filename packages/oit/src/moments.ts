// Moment-based order-independent transparency (Muenstermann, Krumpen, Klein and Peters 2018, I3D). A first pass sums the
// optical depth of each pixel's layers and three trigonometric moments of their depth (the paper's Section 5); a second
// shades every fragment and scales it by the transmittance in front of it, read back from the moments by the paper's
// Algorithm 2.
//
// Every target is rgba16float, which blends on every WebGPU device. Trigonometric moments, not power moments: four power
// moments of two layers make a singular Hankel matrix, so one half-float step in the sums (or another GPU's rounding of
// log) moved a layer's transmittance a long way (moments-check.mjs, "one half-float step"; Apple M6, 2026-11-07). The
// paper stores trigonometric moments in 16 bits each with no transform (Section 5.3; supplementary Table 1, bias 6.5e-4
// for three in 112 bits of fixed point). Half floats are coarser near 1, a step up to 2^-10 of the value, so the moments
// of one layer can leave the unit disc after rounding: the bias here is 3e-3, which the check's half-step case needs.
// Two trigonometric moments (the five channels the power moments used) could not hold both that bias and the check's
// hand-set depthRange case; three can, at the paper's wrapping zone.
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
/** The paper's psi of the point at `angle` on the unit circle: monotonic in the angle, -1 at 0 up to 7 near 2pi. */
const psi = (angle: number): number => {
  const x = Math.cos(angle),
    y = Math.sin(angle);
  if (y >= 0) return x >= 0 ? y - x : 2 - x - y;
  return x >= 0 ? 6 + x + y : 4 + x - y;
};
// Depth is warped to -1..1 by its logarithm (x, y of the uniform), then to an angle on the unit circle (the paper's
// Equation 5). The wrapping zone THETA, the paper's pi/10, holds no depth: the far end wraps round to the near one
// continuously through it.
const THETA = Math.PI / 10;
const warp = /* wgsl */ `
fn margoWarp(depth:f32)->f32 {
  return clamp(log(max(depth,1e-6))*margoOIT.x+margoOIT.y,-1.0,1.0);
}
fn margoAngle(z:f32)->f32 {return ${(2 * Math.PI - THETA).toFixed(9)}*(z+1.0)*0.5;}
fn margoHalf(v:vec4f)->vec4f {
  let b=bitcast<vec4u>(v); let near=bitcast<vec4f>((b+vec4u(0xfffu)+((b>>vec4u(13u))&vec4u(1u)))&vec4u(0xffffe000u));
  return select(near,round(v*16777216.0)/16777216.0,abs(v)<vec4f(6.103515625e-5));
}
`;
// Optical depth, not alpha, is what adds up: tau times the angle's point on the circle and its square in one target, the
// optical depth and the cube in the other. Every output of both passes is rounded to a half float first (margoHalf): the
// Apple M6 adds the float output to the stored half and rounds once, so two layers summed in either order came out a
// step apart (vfx-check.mjs, splats added in either order, 1 of 255). Two halves sum the same either way. The rounding
// is done on the bits, to nearest even: under Chrome on that Mac, quantizeToF16 and a pack2x16float round trip left the
// value as it was.
const sums = (group: number) => /* wgsl */ `
struct MargoTransparent {@location(0) moments:vec4f, @location(1) optical:vec4f}
@group(${group}) @binding(${BINDING}) var<uniform> margoOIT:vec4f;
${warp}
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  let tau=-log(1.0-clamp(color.a,0.0,0.999)); let a=margoAngle(margoWarp(depth)); var o:MargoTransparent;
  o.moments=margoHalf(tau*vec4f(cos(a),sin(a),cos(2.0*a),sin(2.0*a)));
  o.optical=margoHalf(tau*vec4f(1.0,cos(3.0*a),sin(3.0*a),0.0)); return o;
}
`;
// Algorithm 2 with m = 3, in complex numbers held as vec2f. The moments b1..b3 (b0 = 1 after dividing by the optical
// depth) are biased towards (1, 0, 0, 0) by 3e-3. The Toeplitz system G q = (1, conj x0, conj x0^2, conj x0^3), with
// G[j][k] = b[k-j] and b[-k] = conj b[k], is solved by its LDL^H factors. The kernel polynomial q0 + q1 x + q2 x^2 + q3 x^3
// has its roots on the unit circle; they come from Cardano's formula, taking the larger of the two cube candidates to
// avoid cancellation, then one Newton step each and a projection back onto the circle. Those roots and x0 carry the
// four-point distribution with these moments; its weights come from the Vandermonde system as Lagrange sums. Points
// nearer than x0 count whole, x0 itself a quarter (the paper's overestimation), points in the wrapping zone in
// proportion (Equation 6, with its piecewise-linear psi).
const shade = (group: number) => /* wgsl */ `
struct MargoTransparent {@location(0) color:vec4f}
@group(${group}) @binding(${BINDING}) var<uniform> margoOIT:vec4f;
@group(${group}) @binding(${BINDING + 1}) var margoMoments:texture_2d<f32>;
@group(${group}) @binding(${BINDING + 2}) var margoOptical:texture_2d<f32>;
${warp}
fn margoMul(a:vec2f,b:vec2f)->vec2f {return vec2f(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
fn margoConj(a:vec2f)->vec2f {return vec2f(a.x,-a.y);}
fn margoDiv(a:vec2f,b:vec2f)->vec2f {return margoMul(a,margoConj(b))/max(dot(b,b),1e-30);}
fn margoSqrt(a:vec2f)->vec2f {
  let r=length(a); return vec2f(sqrt(max(0.5*(r+a.x),0.0)),select(1.0,-1.0,a.y<0.0)*sqrt(max(0.5*(r-a.x),0.0)));
}
fn margoCbrt(a:vec2f)->vec2f {let r=pow(max(length(a),1e-30),1.0/3.0); let t=atan2(a.y,a.x)/3.0; return r*vec2f(cos(t),sin(t));}
fn margoPsi(x:vec2f)->f32 {
  if(x.y>=0.0){return select(2.0-x.x-x.y,x.y-x.x,x.x>=0.0);}
  return select(4.0+x.x-x.y,6.0+x.x+x.y,x.x>=0.0);
}
// The weight of point l of four, the others a, b, c: the Lagrange polynomial of l applied to the moments.
fn margoWeight(l:vec2f,a:vec2f,b:vec2f,c:vec2f,m1:vec2f,m2:vec2f,m3:vec2f)->f32 {
  let ab=margoMul(a,b);
  let n=m3-margoMul(a+b+c,m2)+margoMul(ab+margoMul(a+b,c),m1)-margoMul(ab,c);
  return margoDiv(n,margoMul(margoMul(l-a,l-b),l-c)).x;
}
fn margoRoot(x:vec2f,q:array<vec2f,4>)->vec2f {
  let f=q[0]+margoMul(x,q[1]+margoMul(x,q[2]+margoMul(x,q[3])));
  let d=q[1]+margoMul(x,2.0*q[2]+3.0*margoMul(x,q[3]));
  let y=x-margoDiv(f,d); return y/max(length(y),1e-30);
}
fn margoInFront(m:vec4f,o:vec4f,z:f32)->f32 {
  var b:array<vec2f,4>; b[0]=vec2f(1.0,0.0); b[1]=0.997*m.xy/o.x; b[2]=0.997*m.zw/o.x; b[3]=0.997*o.yz/o.x;
  let a=margoAngle(z); let x0=vec2f(cos(a),sin(a));
  var l:array<array<vec2f,4>,4>; var d:array<f32,4>; var y:array<vec2f,4>; var q:array<vec2f,4>;
  var r=vec2f(1.0,0.0);
  for(var j=0;j<4;j++){
    for(var i=0;i<j;i++){
      var s=margoConj(b[j-i]);
      for(var k=0;k<i;k++){s-=margoMul(l[j][k],margoConj(l[i][k]))*d[k];}
      l[j][i]=s/d[i];
    }
    var e=1.0; for(var k=0;k<j;k++){e-=dot(l[j][k],l[j][k])*d[k];}
    d[j]=max(e,1e-7);
    var t=r; for(var k=0;k<j;k++){t-=margoMul(l[j][k],y[k]);}
    y[j]=t; r=margoMul(r,margoConj(x0));
  }
  for(var j=3;j>=0;j--){
    var t=y[j]/d[j]; for(var k=j+1;k<4;k++){t-=margoMul(margoConj(l[k][j]),q[k]);}
    q[j]=t;
  }
  // Monic x^3 + c2 x^2 + c1 x + c0, depressed by x = u - c2/3 to u^3 + p u + h.
  let c2=margoDiv(q[2],q[3]); let c1=margoDiv(q[1],q[3]); let c0=margoDiv(q[0],q[3]);
  let s=c2/3.0; let p=c1-margoMul(c2,s); let h=c0-margoMul(c1,s)+2.0*margoMul(s,margoMul(s,s));
  let w=margoSqrt(margoMul(h,h)/4.0+margoMul(p,margoMul(p,p))/27.0);
  let k=select(-h/2.0+w,-h/2.0-w,dot(-h/2.0-w,-h/2.0-w)>dot(-h/2.0+w,-h/2.0+w));
  let u=margoCbrt(k); let turn=vec2f(-0.5,0.866025404);
  let u1=margoMul(u,turn); let u2=margoMul(u1,turn);
  let x1=margoRoot(u-margoDiv(p,3.0*u)-s,q); let x2=margoRoot(u1-margoDiv(p,3.0*u1)-s,q); let x3=margoRoot(u2-margoDiv(p,3.0*u2)-s,q);
  let w0=margoWeight(x0,x1,x2,x3,b[1],b[2],b[3]); let w1=margoWeight(x1,x0,x2,x3,b[1],b[2],b[3]);
  let w2=margoWeight(x2,x0,x1,x3,b[1],b[2],b[3]); let w3=margoWeight(x3,x0,x1,x2,b[1],b[2],b[3]);
  let p0=margoPsi(x0); let edge=${psi(2 * Math.PI - THETA).toFixed(9)};
  let ps=vec3f(margoPsi(x1),margoPsi(x2),margoPsi(x3));
  let v=select(select(vec3f(0.0),(ps-edge)/(7.0-edge),ps>vec3f(edge)),vec3f(1.0),ps<vec3f(p0));
  return o.x*clamp(0.25*w0+dot(v,vec3f(w1,w2,w3)),0.0,1.0);
}
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  let q=vec2i(clip.xy); let o=textureLoad(margoOptical,q,0); var out:MargoTransparent;
  var t=1.0;
  if(o.x>1e-5){t=exp(-margoInFront(textureLoad(margoMoments,q,0),o,margoWarp(depth)));}
  let w=clamp(color.a,0.0,1.0)*t; out.color=margoHalf(vec4f(color.rgb*w,w)); return out;
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
const formats: readonly GPUTextureFormat[] = ['rgba16float', 'rgba16float', 'rgba16float'];

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
    { format: 'rgba16float', blend: add },
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
