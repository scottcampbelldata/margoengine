import { fault, rangeError } from '../../shared/errors.js';
import { dataToClip, screenRay } from './pick.js';
import type { Figure } from './figure.js';
import type { SelectionStore } from './link.js';
import type { MultivariateData } from './parcoords.js';
import { frameWGSL, type Drawable, type GpuContext, type SciRenderer } from './render.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
const shader = `${frameWGSL}
struct Params{model:mat4x4f,info:vec4u,style:vec4f};
@group(1) @binding(0) var<uniform> p:Params;
@group(1) @binding(1) var<storage,read> values:array<f32>;
@group(1) @binding(2) var<storage,read> axes:array<vec2u>;
@group(1) @binding(3) var<storage,read> mask:array<f32>;
@group(1) @binding(4) var<storage,read> hist:array<f32>;
struct Out{@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) @interpolate(flat) weight:f32,@location(2) @interpolate(flat) mode:u32};
fn value(position:u32,row:u32)->f32{let a=axes[position];let v=values[a.x*p.info.x+row];return select(v,1.0-v,a.y>0u);}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) instance:u32)->Out{
var out:Out;out.weight=1.0;out.uv=vec2f(0.0);out.mode=0u;
var point=vec2f(0.0);let dims=p.info.y;
if(p.info.z==0u){
 let limit=p.info.x*(dims-1u);
 if(instance>=limit){let axis=instance-limit;point=vec2f(f32(axis),f32(v));out.mode=2u;}
 else{let row=instance/(dims-1u);let segment=instance%(dims-1u);let a=value(segment,row);let b=value(segment+1u,row);point=vec2f(f32(segment+v),select(a,b,v==1u));out.weight=mask[row];if(!(a>=0.0&&a<=1.0&&b>=0.0&&b<=1.0)){out.mode=3u;}}
}else{
 let limit=p.info.x*dims*dims;let corner=v%6u;let uv=vec2f(select(-1.0,1.0,corner==1u||corner==2u||corner==4u),select(-1.0,1.0,corner==2u||corner==4u||corner==5u));
 if(instance>=limit){let bar=instance-limit;let col=bar/32u;let bin=bar%32u;let axis=axes[col].x;let hbin=select(bin,31u-bin,axes[col].y>0u);point=vec2f(f32(col)+(f32(bin)+select(0.0,1.0,uv.x>0.0))/32.0,f32(dims-1u-col)+select(0.0,hist[axis*32u+hbin]*0.9,uv.y>0.0));out.mode=2u;}
 else{let row=instance/(dims*dims);let cell=instance%(dims*dims);let cx=cell%dims;let cy=cell/dims;let a=value(cx,row);let b=value(cy,row);point=vec2f(f32(cx)+a,f32(dims-1u-cy)+b);out.weight=mask[row];out.uv=uv;out.mode=1u;if(cx==cy||!(a>=0.0&&a<=1.0&&b>=0.0&&b<=1.0)){out.mode=3u;}}
}
out.clip=frame.clip*p.model*vec4f(point,0.0,1.0);
if(out.mode==1u){out.clip=vec4f(out.clip.xy+out.uv*p.style.x/frame.viewport.xy*out.clip.w,out.clip.zw);}
return out;}
@fragment fn fragment(in:Out)->@location(0) vec4f{
if(in.mode==3u||(in.mode==1u&&dot(in.uv,in.uv)>1.0)){discard;}
let brightness=select(p.style.y,1.0,in.weight>0.0);let color=select(vec3f(0.05,0.55,0.75)*brightness,vec3f(0.16,0.24,0.32),in.mode==2u);
return vec4f(toOutput(color),1.0);}`;

/** @internal One instanced GPU layer; order and selection writes never replace column storage. */
export class MultivariateLayer implements Drawable {
  readonly dimensions = '2d' as const;
  readonly transparent = false;
  visible = true;
  readonly canvas: HTMLCanvasElement;
  readonly #figure: Figure;
  readonly #data: MultivariateData;
  readonly #selection: SelectionStore;
  readonly #matrix: boolean;
  readonly #uniform = new Float32Array(24);
  readonly #mask: Float32Array;
  readonly #hist: Float32Array;
  #buffers: GPUBuffer[] = [];
  #layout?: GPUBindGroupLayout;
  #group?: GPUBindGroup;
  #disposed = false;
  constructor(figure: Figure, data: MultivariateData, selection: SelectionStore, kind: 'parallel' | 'matrix', size: number) {
    if (!(size > 0) || !Number.isFinite(size)) throw rangeError('Scatter-matrix size must be finite and positive', 'sciviz');
    if (!figure.renderer.device) throw fault('unsupported', 'Multivariate GPU plots require WebGPU or the WebGL2 compatibility device', 'sciviz');
    this.#figure = figure; this.#data = data; this.#selection = selection; this.#matrix = kind === 'matrix';
    this.canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
    this.#mask = new Float32Array(data.table.length); this.#hist = new Float32Array(data.axes.length * 32);
    this.#uniform.set([size, 0.08, 0, 0], 20); new Uint32Array(this.#uniform.buffer).set([data.table.length, data.axes.length, Number(this.#matrix), 0], 16);
    this.selectionChanged(); this.restore(); figure.renderer.add(this);
  }
  get bounds(): [number, number, number, number, number, number] { return [0, this.#data.axes.length - Number(!this.#matrix), 0, this.#matrix ? this.#data.axes.length : 1, 0, 0]; }
  setModel(model: Float32Array): void { this.#uniform.set(model, 0); this.#uploadUniform(); }
  #uploadUniform(): void { const device = this.#figure.renderer.device; if (device && this.#buffers[0]) device.queue.writeBuffer(this.#buffers[0], 0, this.#uniform); }
  center(): readonly [number, number, number] { return [0, 0, 0]; }
  orderChanged(): void { if (this.#buffers[2]) this.#figure.renderer.device!.queue.writeBuffer(this.#buffers[2], 0, this.#data.order); }
  selectionChanged(): void {
    const n = this.#data.table.length;
    for (let i = 0; i < n; i++) this.#mask[i] = Number(this.#selection.has(this.#data.rowIds[i]));
    this.#hist.fill(0);
    if (this.#matrix) for (let axis = 0; axis < this.#data.axes.length; axis++) {
      let peak = 0; const offset = axis * 32;
      for (let i = 0; i < n; i++) if (this.#mask[i]) { const value = this.#data.values[axis * n + i]; if (value >= 0 && value <= 1) { const bin = offset + Math.min(31, Math.floor(value * 32)); this.#hist[bin]++; peak = Math.max(peak, this.#hist[bin]); } }
      if (peak) for (let b = 0; b < 32; b++) this.#hist[offset + b] /= peak;
    }
    if (this.#buffers[3]) { const q = this.#figure.renderer.device!.queue; q.writeBuffer(this.#buffers[3], 0, this.#mask); q.writeBuffer(this.#buffers[4], 0, this.#hist); }
  }
  /** Plane intersection using the same camera/model and CSS-pixel convention as Figure.pick. */
  point(x: number, y: number): readonly [number, number] | undefined {
    const ray = screenRay(dataToClip(this.#figure.engine.camera.matrix, this.#uniform), this.canvas.clientWidth || this.canvas.width, this.canvas.clientHeight || this.canvas.height, x, y);
    if (!ray || Math.abs(ray.direction[2]) < 1e-12) return undefined; const t = -ray.origin[2] / ray.direction[2]; return [ray.origin[0] + t * ray.direction[0], ray.origin[1] + t * ray.direction[1]];
  }
  restore(): void {
    if (this.#disposed) return;
    for (const buffer of this.#buffers) buffer.destroy();
    const device = this.#figure.renderer.device!;
    const storage = [this.#data.values, this.#data.order, this.#mask, this.#hist];
    if (storage.some((v) => v.byteLength > device.limits.maxStorageBufferBindingSize)) throw rangeError('Multivariate columns exceed this device storage binding limit; partition the table', 'sciviz');
    this.#buffers = [device.createBuffer({ size: this.#uniform.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), ...storage.map((values) => { const buffer = device.createBuffer({ size: Math.max(16, values.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); if (values.byteLength) device.queue.writeBuffer(buffer, 0, values); return buffer; })];
    this.#uploadUniform();
    this.#layout = device.createBindGroupLayout({ entries: this.#buffers.map((_, binding) => ({ binding, visibility: binding ? GPUShaderStage.VERTEX : GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: binding ? 'read-only-storage' as const : 'uniform' as const } })) });
    this.#group = device.createBindGroup({ layout: this.#layout, entries: this.#buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
  }
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    const key = this.#matrix ? 'scatter-matrix' : 'parallel-coordinates';
    const pipeline = renderer.pipeline(key, context, (target) => {
      const module = renderer.device!.createShaderModule({ code: shader, label: key });
      return { layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout!] }), vertex: { module, entryPoint: 'vertex' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format }] }, primitive: { topology: this.#matrix ? 'triangle-list' : 'line-list' }, multisample: target.multisample, depthStencil: { format: target.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' } };
    });
    pass.setPipeline(pipeline); pass.setBindGroup(1, this.#group!);
    const n = this.#data.table.length, d = this.#data.axes.length;
    pass.draw(this.#matrix ? 6 : 2, this.#matrix ? n * d * d + d * 32 : n * (d - 1) + d);
  }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#figure.renderer.remove(this); for (const b of this.#buffers) b.destroy(); this.#buffers = []; }
  [Symbol.dispose](): void { this.dispose(); }
}
