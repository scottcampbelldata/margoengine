import { invertMatrix } from '@margoengine/math/mat4';
import type { PDBMolecule } from '@margoengine/loaders/pdb';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { dataToClip, screenRay } from './pick.js';
import {
  moleculeSnapshot,
  moleculeError,
  pickMoleculeSnapshot,
  type MoleculeSnapshot,
  type MoleculeOptions,
  type MoleculePick,
} from './molecule-data.js';
import type { Bounds } from './layer.js';
import type { Figure } from './figure.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
/** @internal Production analytic intersection shader, exposed internally for numerical GPU tests. */
export const moleculeIntersectionWGSL = /* wgsl */ `
struct Primitive {a:vec4f,b:vec4f,ca:vec4f,cb:vec4f}
struct Hit {t:f32,n:vec3f}
fn roots(a:f32,b:f32,c:f32)->vec3f {
 let discriminant=b*b-a*c;if(a<=0.0 || discriminant<0.0){return vec3f(0.0);}
 let q=-b-select(-1.0,1.0,b>=0.0)*sqrt(discriminant);
 if(q==0.0){return vec3f(-b/a,-b/a,1.0);}return vec3f(q/a,c/q,1.0);
}
fn intersect(p:Primitive,origin:vec3f,direction:vec3f)->Hit {
 var hit=Hit(1e30,vec3f(0.0));let o=origin-p.a.xyz;let radius=p.a.w;
 if(p.b.w<0.5){
  let r=roots(dot(direction,direction),dot(o,direction),dot(o,o)-radius*radius);
  if(r.z>0.0){for(var i=0u;i<2u;i++){let t=r[i];if(t>=0.0 && t<hit.t){hit=Hit(t,(o+t*direction)/radius);}}}return hit;
 }
 let axis=p.b.xyz-p.a.xyz;let size=length(axis);let n=axis/size;let od=dot(o,n);let dd=dot(direction,n);
 let op=o-od*n;let dp=direction-dd*n;let r=roots(dot(dp,dp),dot(op,dp),dot(op,op)-radius*radius);
 if(r.z>0.0){for(var i=0u;i<2u;i++){let t=r[i];let h=od+t*dd;if(t>=0.0 && t<hit.t && h>=0.0 && h<=size){hit=Hit(t,(op+t*dp)/radius);}}}
 if(dd!=0.0){for(var i=0u;i<2u;i++){let t=(f32(i)*size-od)/dd;let radial=op+t*dp;
  if(t>=0.0 && t<hit.t && dot(radial,radial)<=radius*radius){hit=Hit(t,select(-n,n,i==1u));}}}
 return hit;
}`;
const shader = /* wgsl */ `${frameWGSL}
${moleculeIntersectionWGSL}
struct Molecule {model:mat4x4f,inverse:mat4x4f}
@group(1) @binding(0) var<uniform> u:Molecule;
@group(1) @binding(1) var<storage,read> primitives:array<Primitive>;
struct Out {@builtin(position) position:vec4f,@location(0) ndc:vec2f,@location(1) @interpolate(flat) index:u32}
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out {
 let p=primitives[instance];let radius=vec3f(p.a.w);let low=min(p.a.xyz,p.b.xyz)-radius;let high=max(p.a.xyz,p.b.xyz)+radius;
 var minimum=vec2f(1e30);var maximum=vec2f(-1e30);var crossesNear=false;
 for(var corner=0u;corner<8u;corner++){
  let q=select(low,high,vec3u(corner&1u,corner&2u,corner&4u)!=vec3u(0u));let clip=frame.clip*u.model*vec4f(q,1.0);
  if(clip.w<=0.0 || clip.z>clip.w){crossesNear=true;}else{let xy=clip.xy/clip.w;minimum=min(minimum,xy);maximum=max(maximum,xy);}
 }
 if(crossesNear){minimum=vec2f(-1.0);maximum=vec2f(1.0);}
 minimum=clamp(minimum,vec2f(-1.0),vec2f(1.0));maximum=clamp(maximum,vec2f(-1.0),vec2f(1.0));
 let corners=array<vec2f,6>(vec2f(0.0,0.0),vec2f(1.0,0.0),vec2f(0.0,1.0),vec2f(0.0,1.0),vec2f(1.0,0.0),vec2f(1.0,1.0));
 var out:Out;out.ndc=mix(minimum,maximum,corners[vertex]);out.position=vec4f(out.ndc,0.0,1.0);out.index=instance;return out;
}
struct Fragment {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
@fragment fn fragment(in:Out)->Fragment {
 let near=frame.inverse*vec4f(in.ndc,1.0,1.0);let mid=frame.inverse*vec4f(in.ndc,0.5,1.0);
 let a=u.inverse*vec4f(near.xyz/near.w,1.0);let b=u.inverse*vec4f(mid.xyz/mid.w,1.0);
 let origin=a.xyz/a.w;let direction=normalize(b.xyz/b.w-origin);let p=primitives[in.index];let hit=intersect(p,origin,direction);
 if(hit.t>=1e30){discard;}let point=origin+direction*hit.t;let world=u.model*vec4f(point,1.0);let clip=frame.clip*world;let depth=clip.z/clip.w;
 if(clip.w<=0.0 || depth<0.0 || depth>1.0){discard;}
 let n=normalize(vec3f(dot(u.inverse[0].xyz,hit.n),dot(u.inverse[1].xyz,hit.n),dot(u.inverse[2].xyz,hit.n)));
 let axis=p.b.xyz-p.a.xyz;let second=p.b.w>0.5 && dot(point-p.a.xyz,axis)>dot(axis,axis)*0.5;
 let srgb=select(p.ca.xyz,p.cb.xyz,second);let albedo=select(pow((srgb+0.055)/1.055,vec3f(2.4)),srgb/12.92,srgb<=vec3f(0.04045));
 var out:Fragment;out.color=vec4f(toOutput(shade(albedo,n,normalize(frame.eye.xyz-world.xyz))),1.0);out.depth=depth;return out;
}`;

/** One six-vertex instanced draw, one analytic intersection per covered pixel. Opaque, with curved depth. */
export class MoleculeLayer implements Drawable {
  visible = true;
  readonly transparent = false;
  readonly bounds: Bounds;
  readonly primitiveCount: number;
  readonly residues: MoleculeSnapshot['residues'];
  #figure: Figure;
  #snapshot: MoleculeSnapshot;
  #model = new Float32Array(16);
  #values = new Float32Array(32);
  #uniform: GPUBuffer | undefined;
  #buffer: GPUBuffer | undefined;
  #layout!: GPUBindGroupLayout;
  #group!: GPUBindGroup;
  #disposed = false;
  /** @internal Use molecule() to attach a validated snapshot. */
  constructor(figure: Figure, snapshot: MoleculeSnapshot) {
    this.#figure = figure;
    this.#snapshot = snapshot;
    this.bounds = snapshot.bounds;
    this.primitiveCount = snapshot.ends.length;
    this.residues = snapshot.residues;
    try {
      this.#build();
    } catch (error) {
      this.#release();
      throw error;
    }
  }
  #build(): void {
    if (!this.primitiveCount) return;
    const d = this.#figure.renderer.device!,
      data = this.#snapshot.data;
    if (data.byteLength > d.limits.maxStorageBufferBindingSize || data.byteLength > d.limits.maxBufferSize)
      moleculeError('molecule exceeds GPU storage limits; select fewer atoms');
    this.#uniform = d.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#buffer = d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.#buffer, 0, data);
    this.#layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });
    this.#group = d.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniform } },
        { binding: 1, resource: { buffer: this.#buffer } },
      ],
    });
  }
  /** Data-to-scene matrix supplied by the figure. */
  setModel(model: Float32Array): void {
    this.#model.set(model);
  }
  /** @internal */
  center(): readonly [number, number, number] {
    const b = this.bounds,
      p = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2],
      m = this.#model;
    return [0, 1, 2].map((k) => m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k]) as [
      number,
      number,
      number,
    ];
  }
  /** @internal */
  prepare(): void {
    if (this.#disposed || !this.#uniform) return;
    this.#values.set(this.#model);
    if (!invertMatrix(this.#model, this.#values.subarray(16)))
      moleculeError('molecule model matrix must be invertible');
    this.#figure.renderer.device!.queue.writeBuffer(this.#uniform, 0, this.#values);
  }
  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (this.#disposed || !this.primitiveCount) return;
    const pipeline = renderer.pipeline('molecule impostors', context, (target) => {
      const module = renderer.device!.createShaderModule({ code: shader, label: 'sciviz molecule impostors' });
      return {
        layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format }] },
        primitive: { topology: 'triangle-list' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#group);
    pass.draw(6, this.primitiveCount);
  }
  /** Pick displayed atoms and bonds with a ray in angstrom coordinates. */
  pickRay(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
  ): MoleculePick | null {
    return this.#disposed || !this.visible ? null : pickMoleculeSnapshot(this.#snapshot, origin, direction);
  }
  /** Pick a residue at CSS coordinates from the figure canvas's top-left. */
  pick(x: number, y: number): MoleculePick | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) moleculeError('pick coordinates must be finite');
    const canvas = (this.#figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas,
      ray = screenRay(
        dataToClip(this.#figure.engine.camera.matrix, this.#model),
        canvas.clientWidth || canvas.width,
        canvas.clientHeight || canvas.height,
        x,
        y,
      );
    return ray ? this.pickRay(ray.origin, ray.direction) : null;
  }
  #release(): void {
    this.#buffer?.destroy();
    this.#uniform?.destroy();
    this.#buffer = undefined;
    this.#uniform = undefined;
  }
  /** @internal Rebuild entirely from the owned snapshot on device replacement. */
  restore(): void {
    if (this.#disposed) return;
    this.#release();
    try {
      this.#build();
    } catch (error) {
      this.#release();
      throw error;
    }
  }
  /** Detach and release all GPU storage. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#figure.renderer.remove(this);
    this.#release();
    this.#figure.remove(this);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Add ball-and-stick, van der Waals space-filling, or licorice spheres/cylinders to a linear 3D figure. */
export function molecule(figure: Figure, structure: PDBMolecule, options: MoleculeOptions = {}): MoleculeLayer {
  requireGPU(figure.renderer);
  const layer = new MoleculeLayer(figure, moleculeSnapshot(structure, options));
  try {
    figure.renderer.add(layer);
    return figure.addLayer(layer);
  } catch (error) {
    layer.dispose();
    throw error;
  }
}
