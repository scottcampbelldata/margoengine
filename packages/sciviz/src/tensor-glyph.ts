import { invertMatrix } from '@margoengine/math/mat4';
import { tensorEigenGPU, type GpuTensorEigen } from './tensor-eigen.js';
import { tensorError } from './tensor-math.js';
import { checkTensorField, type TensorField } from './tensor-track.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { colormapTexture, resolveColormap, type Bounds, type ColormapSource } from './layer.js';
import { colorLookupWGSL } from './color-lookup.js';
import type { Figure } from './figure.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Arbitrarily positioned tensor samples. A regular TensorField is accepted too. */
export interface TensorSamples {
  readonly positions: ArrayLike<number>;
  readonly tensors: ArrayLike<number>;
  readonly mask?: ArrayLike<number>;
}
/** Kindlmann ellipsoids/superquadrics, instanced directly from GPU eigensystems. */
export interface TensorGlyphOptions {
  /** Default superquadric. */
  readonly shape?: 'ellipsoid' | 'superquadric';
  /** Largest radius in data units. Default .4 of the smallest voxel spacing, or .4 for scattered samples. */
  readonly size?: number;
  /** Normalize each tensor's largest absolute eigenvalue to size. Default true. */
  readonly normalize?: boolean;
  /** Superquadric sharpness exponent, default 3. */
  readonly gamma?: number;
  /** Default direction-fa; direction is RGB of the largest-magnitude axis, fa uses colormap. */
  readonly color?: 'direction' | 'fa' | 'direction-fa';
  readonly colormap?: ColormapSource;
  /** Regular sample stride, default 1. */
  readonly stride?: number;
  /** Polar subdivisions, default 16; azimuth uses twice this. Range 4..64. */
  readonly resolution?: number;
  /** Default 1. */
  readonly opacity?: number;
  /** Construction cancellation; the completed layer can later restore independently. */
  readonly signal?: AbortSignal;
}
interface Snapshot {
  positions: Float32Array;
  tensors: Float64Array;
  ids: Uint32Array;
  bounds: Bounds;
  size: number;
}
function snapshot(input: TensorSamples | TensorField, options: TensorGlyphOptions): Snapshot {
  const regular = 'dims' in input,
    count = regular ? checkTensorField(input) : input.positions.length / 3,
    stride = options.stride ?? 1,
    size =
      options.size ??
      (regular
        ? 0.4 * Math.min(...input.dims.map((n, k) => (input.bounds[k * 2 + 1] - input.bounds[k * 2]) / n))
        : 0.4);
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    input.tensors.length !== count * 6 ||
    (input.mask && input.mask.length !== count) ||
    !Number.isSafeInteger(stride) ||
    stride < 1 ||
    !(size > 0) ||
    !Number.isFinite(Math.fround(size))
  )
    tensorError('check tensor positions, coefficient/mask lengths, positive stride and size');
  const positions: number[] = [],
    tensors: number[] = [],
    ids: number[] = [],
    bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < count; i += stride) {
    if (i % 4096 === 0) options.signal?.throwIfAborted();
    if (input.mask && !input.mask[i]) continue;
    const p = regular
        ? [
            i % input.dims[0],
            Math.floor(i / input.dims[0]) % input.dims[1],
            Math.floor(i / input.dims[0] / input.dims[1]),
          ].map(
            (v, k) =>
              input.bounds[k * 2] + ((v + 0.5) * (input.bounds[k * 2 + 1] - input.bounds[k * 2])) / input.dims[k],
          )
        : [input.positions[i * 3], input.positions[i * 3 + 1], input.positions[i * 3 + 2]],
      t = Array.from({ length: 6 }, (_, k) => input.tensors[i * 6 + k]);
    if ([...p, ...t].some((v) => !Number.isFinite(v) || !Number.isFinite(Math.fround(v))))
      tensorError('selected glyph samples must be finite float32; mask missing voxels');
    let radius = size;
    if (options.normalize === false) radius *= 3 * Math.max(...t.map(Math.abs));
    positions.push(...p, i);
    tensors.push(...t);
    ids.push(i);
    for (let k = 0; k < 3; k++) {
      bounds[k * 2] = Math.min(bounds[k * 2], p[k] - radius);
      bounds[k * 2 + 1] = Math.max(bounds[k * 2 + 1], p[k] + radius);
    }
  }
  if (ids.length && bounds.some((v) => !Number.isFinite(Math.fround(v))))
    tensorError('glyph bounds exceed float32 range; rescale coordinates or size');
  return {
    positions: new Float32Array(positions),
    tensors: new Float64Array(tensors),
    ids: new Uint32Array(ids),
    bounds: (ids.length ? bounds : [0, 0, 0, 0, 0, 0]) as unknown as Bounds,
    size,
  };
}
/** @internal Parametric production surface in normalized turns, also used by GPU symmetry tests. */
export const tensorSurfaceWGSL = /* wgsl */ `
fn spow(x:f32,e:f32)->f32 {if(x==0.0){return 0.0;}return sign(x)*pow(abs(x),e);}
fn sineTurn(t:f32)->f32 {let f=fract(t);if(f==0.0 || f==0.5){return 0.0;}if(f==0.25){return 1.0;}if(f==0.75){return -1.0;}return sin(f*6.283185307179586);}
fn cosineTurn(t:f32)->f32 {let f=fract(t);if(f==0.25 || f==0.75){return 0.0;}if(f==0.0){return 1.0;}if(f==0.5){return -1.0;}return cos(f*6.283185307179586);}
fn surface(theta:f32,phi:f32,alpha:f32,beta:f32,planar:bool)->vec3f {
 let polarSine=spow(sineTurn(theta*0.5),beta);
 let p=vec3f(spow(cosineTurn(theta*0.5),beta),polarSine*spow(cosineTurn(phi),alpha),polarSine*spow(sineTurn(phi),alpha));
 return select(p,p.yzx,planar);
}`;
const shader = /* wgsl */ `${frameWGSL}
${colorLookupWGSL}
${tensorSurfaceWGSL}
struct Glyph {model:mat4x4f,inverse:mat4x4f,options:vec4f,style:vec4f}
@group(1) @binding(0) var<uniform> u:Glyph;
@group(1) @binding(1) var<storage,read> points:array<vec4f>;
@group(1) @binding(2) var<storage,read> systems:array<vec4f>;
@group(1) @binding(3) var colours:texture_2d<f32>;
struct Out {@builtin(position) position:vec4f,@location(0) world:vec3f,@location(1) normal:vec3f,@location(2) color:vec3f}
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out {
 let levels=systems[instance*4u];var basis=mat3x3f(systems[instance*4u+1u].xyz,systems[instance*4u+2u].xyz,systems[instance*4u+3u].xyz);
 var eigen=abs(levels.xyz);for(var i=0u;i<2u;i++){for(var j=i+1u;j<3u;j++){if(eigen[j]>eigen[i]){let value=eigen[i];eigen[i]=eigen[j];eigen[j]=value;let column=basis[i];basis[i]=basis[j];basis[j]=column;}}}
 let maximum=max(max(eigen.x,eigen.y),eigen.z);let scale=select(1.0,max(maximum,1e-30),u.style.z>0.5);let radii=eigen/scale*u.options.x;
 let sum=eigen.x+eigen.y+eigen.z;var cl=0.0;var cp=0.0;if(sum>0.0){cl=max(0.0,(eigen.x-eigen.y)/sum);cp=max(0.0,2.0*(eigen.y-eigen.z)/sum);}
 let planar=cp>cl;var alpha=1.0;var beta=1.0;if(u.options.z>0.5){alpha=pow(clamp(1.0-min(cl,cp),0.0,1.0),u.options.y);beta=pow(clamp(1.0-max(cl,cp),0.0,1.0),u.options.y);}
 let rings=u32(u.style.x);let segments=rings*2u;let cell=vertex/6u;let corners=array<vec2u,6>(vec2u(0u,0u),vec2u(0u,1u),vec2u(1u,1u),vec2u(0u,0u),vec2u(1u,1u),vec2u(1u,0u));let corner=corners[vertex%6u];
 let theta=f32(cell/segments+corner.x)/f32(rings);let phi=f32(cell%segments+corner.y)/f32(segments);
 let p=surface(theta,phi,alpha,beta,planar);let delta=0.001;
 let normalRadii=eigen/max(maximum,1e-30);
 let dt=(surface(theta+delta,phi,alpha,beta,planar)-surface(theta-delta,phi,alpha,beta,planar))*normalRadii;
 let dp=(surface(theta,phi+delta,alpha,beta,planar)-surface(theta,phi-delta,alpha,beta,planar))*normalRadii;
 var n=cross(dt,dp);if(dot(n,n)<1e-24){n=p;}n=basis*n;
 let physical=points[instance].xyz+basis*(p*radii);let world=u.model*vec4f(physical,1.0);
 var color=abs(basis[0]);if(u.options.w>1.5){color*=clamp(levels.w,0.0,1.0);}else if(u.options.w>0.5){color=colourLookup(colours,levels.w).rgb;}
 var out:Out;out.position=frame.clip*world;out.world=world.xyz;out.normal=vec3f(dot(u.inverse[0].xyz,n),dot(u.inverse[1].xyz,n),dot(u.inverse[2].xyz,n));out.color=color;return out;
}
@fragment fn fragment(in:Out)->@location(0) vec4f {
 let normal=select(vec3f(0.0,0.0,1.0),in.normal*inverseSqrt(max(dot(in.normal,in.normal),1e-30)),dot(in.normal,in.normal)>1e-30);
 return vec4f(toOutput(shade(in.color,normal,normalize(frame.eye.xyz-in.world))),u.style.y);
}`;

/** One instanced draw, with each glyph's shape and orientation derived from GPU eigenvectors. */
export class TensorGlyphLayer implements Drawable {
  visible = true;
  /** Data bounds, including the maximum glyph radii. */ readonly bounds: Bounds;
  /** Source sample ID per instance. */ readonly ids: Uint32Array;
  /** Current-device packed eigensystems, owned by this layer. */ get eigen(): GpuTensorEigen {
    return this.#eigen;
  }
  /** @internal */ get transparent(): boolean {
    return (this.#options.opacity ?? 1) < 1;
  }
  #figure: Figure;
  #snapshot: Snapshot;
  #options: TensorGlyphOptions;
  #eigen: GpuTensorEigen;
  #model = new Float32Array(16);
  #values = new Float32Array(40);
  #uniform!: GPUBuffer;
  #points!: GPUBuffer;
  #colours!: GPUTexture;
  #layout!: GPUBindGroupLayout;
  #group!: GPUBindGroup;
  #disposed = false;
  /** @internal Construct through tensorGlyphs, which validates and decomposes before publication. */
  constructor(figure: Figure, data: Snapshot, eigen: GpuTensorEigen, options: TensorGlyphOptions) {
    this.#figure = figure;
    this.#snapshot = data;
    this.#options = options;
    this.#eigen = eigen;
    this.bounds = data.bounds;
    this.ids = data.ids;
    try {
      this.#build();
    } catch (error) {
      this.#release();
      throw error;
    }
  }
  #build(): void {
    const d = this.#figure.renderer.device!;
    this.#uniform = d.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (!this.ids.length) return;
    this.#points = d.createBuffer({
      size: Math.max(16, this.#snapshot.positions.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (this.#snapshot.positions.length) d.queue.writeBuffer(this.#points, 0, this.#snapshot.positions);
    this.#colours = colormapTexture(d, resolveColormap(this.#options.colormap ?? 'viridis'));
    this.#layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ...[1, 2].map((binding) => ({
          binding,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' as const },
        })),
        { binding: 3, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.#group = d.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: { buffer: this.#points } },
        { binding: 2, resource: { buffer: this.#eigen.frames.buffer } },
        { binding: 3, resource: this.#colours.createView() },
      ],
    });
  }
  /** The figure's data-to-scene matrix. */ setModel(model: Float32Array): void {
    this.#model.set(model);
  }
  /** @internal */ center(): readonly [number, number, number] {
    const b = this.bounds,
      p = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
    return [0, 1, 2].map(
      (k) => this.#model[k] * p[0] + this.#model[4 + k] * p[1] + this.#model[8 + k] * p[2] + this.#model[12 + k],
    ) as [number, number, number];
  }
  /** @internal */ prepare(): void {
    if (this.#disposed) return;
    const v = this.#values,
      o = this.#options;
    v.set(this.#model);
    invertMatrix(this.#model, v.subarray(16, 32));
    const normalIndices = [16, 17, 18, 20, 21, 22, 24, 25, 26],
      normalScale = Math.max(...normalIndices.map((k) => Math.abs(v[k])));
    if (normalScale) for (const k of normalIndices) v[k] /= normalScale;
    v.set(
      [
        this.#snapshot.size,
        o.gamma ?? 3,
        o.shape === 'ellipsoid' ? 0 : 1,
        o.color === 'direction' ? 0 : o.color === 'fa' ? 1 : 2,
      ],
      32,
    );
    v.set([o.resolution ?? 16, o.opacity ?? 1, o.normalize === false ? 0 : 1, 0], 36);
    this.#figure.renderer.device!.queue.writeBuffer(this.#uniform, 0, v);
  }
  /** @internal */ draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (this.#disposed || !this.ids.length) return;
    const transparent = this.transparent,
      pipeline = renderer.pipeline('tensor glyphs|' + transparent, context, (target) => {
        const module = renderer.device!.createShaderModule({ code: shader, label: 'sciviz tensor glyphs' });
        return {
          layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout] }),
          vertex: { module, entryPoint: 'vertex' },
          fragment: {
            module,
            entryPoint: 'fragment',
            targets: [
              {
                format: target.format,
                blend: transparent
                  ? {
                      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                    }
                  : undefined,
              },
            ],
          },
          primitive: { topology: 'triangle-list' },
          multisample: target.multisample,
          depthStencil: { format: target.depth, depthWriteEnabled: !transparent, depthCompare: 'greater-equal' },
        };
      });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group);
    const rings = this.#options.resolution ?? 16;
    pass.draw(rings * rings * 12, this.ids.length);
  }
  #release(): void {
    this.#uniform?.destroy();
    this.#points?.destroy();
    this.#colours?.destroy();
  }
  /** @internal */ async restore(): Promise<void> {
    if (this.#disposed) return;
    const next = await tensorEigenGPU(await this.#figure.renderer.compute(), this.#snapshot.tensors);
    if (this.#disposed) {
      next.dispose();
      return;
    }
    this.#release();
    this.#eigen.dispose();
    this.#eigen = next;
    this.#build();
  }
  /** Release eigensystems and render resources and detach this layer. */ dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#figure.renderer.remove(this);
    this.#release();
    this.#eigen.dispose();
    this.#figure.remove(this);
  }
  /** Same as dispose(), for using. */ [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Snapshot selected tensors, decompose on the figure's compute device, then publish one instanced glyph draw. */
export async function tensorGlyphs(
  figure: Figure,
  input: TensorSamples | TensorField,
  options: TensorGlyphOptions = {},
): Promise<TensorGlyphLayer> {
  requireGPU(figure.renderer);
  options.signal?.throwIfAborted();
  const gamma = options.gamma ?? 3,
    resolution = options.resolution ?? 16,
    opacity = options.opacity ?? 1;
  if (
    !(gamma > 0) ||
    !Number.isFinite(Math.fround(gamma)) ||
    !Number.isSafeInteger(resolution) ||
    resolution < 4 ||
    resolution > 64 ||
    !(opacity >= 0 && opacity <= 1) ||
    (options.shape !== undefined && !['ellipsoid', 'superquadric'].includes(options.shape)) ||
    (options.color !== undefined && !['direction', 'fa', 'direction-fa'].includes(options.color))
  )
    tensorError('check glyph shape, colour, positive gamma, opacity and resolution 4..64');
  const data = snapshot(input, options),
    eigen = await tensorEigenGPU(await figure.renderer.compute(), data.tensors, options);
  let layer: TensorGlyphLayer | undefined;
  try {
    options.signal?.throwIfAborted();
    layer = new TensorGlyphLayer(figure, data, eigen, options);
    figure.renderer.add(layer);
    return figure.addLayer(layer);
  } catch (error) {
    if (layer) layer.dispose();
    else eigen.dispose();
    throw error;
  }
}
