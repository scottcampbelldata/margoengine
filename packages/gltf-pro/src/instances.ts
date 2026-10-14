import type {TextureTransform} from './index.js';
declare const GPUBufferUsage:{VERTEX:number;COPY_DST:number};
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,1,1,1,1,1,1,0,0];
/**
 * Per-instance data for gltf-pro primitives, the counterpart of three.js InstancedMesh's `instanceMatrix`/`instanceColor`:
 * assign one to `primitive.instances` and that primitive draws `count` instances in one instanced draw. Matrices are in the
 * primitive's node space (world = node matrix x instance matrix, as glTF EXT_mesh_gpu_instancing). Each instance also has
 * an RGBA tint (multiplies base colour, like vertex colour) and a UV scale + offset applied to both UV sets before the
 * material's own texture transforms (an atlas region per instance). Setters mark the rows for upload; after writing `data`
 * directly set `needsUpdate = true`. Primitives (also of other models) may share one PBRInstances.
 */
export class PBRInstances {
  /** 24 floats per instance: matrix (column-major), tint, UV scale x/y and offset x/y. */
  readonly data:Float32Array;private drawn:number;private low=0;private high:number;private stale=true;
  private gpu?:GPUBuffer;private device?:GPUDevice;private flipped=false;
  readonly capacity:number;
  constructor(capacity:number) {
    this.capacity=capacity;
    if(!Number.isInteger(capacity)||capacity<1||capacity>1_000_000)throw new RangeError('Invalid instance capacity');
    this.data=new Float32Array(capacity*24);for(let i=0;i<capacity;i++)this.data.set(identity,i*24);this.drawn=this.high=capacity;
  }
  /** Instances drawn, the first `count` rows (default and maximum: `capacity`). */
  get count():number {return this.drawn;}
  set count(n:number) {if(!Number.isInteger(n)||n<0||n>this.capacity)throw new RangeError('Invalid instance count');this.drawn=n;this.stale=true;}
  /** Set true after writing `data` directly: every row is uploaded before the next draw. */
  get needsUpdate():boolean {return this.high>this.low;}
  set needsUpdate(v:boolean) {if(v){this.low=0;this.high=this.capacity;this.stale=true;}}
  private index(i:number):number {if(!Number.isInteger(i)||i<0||i>=this.capacity)throw new RangeError('Instance index out of range');return i*24;}
  private row(i:number,at:number,values:ArrayLike<number>,n:number,min=-Infinity):this {
    const o=this.index(i)+at;for(let k=0;k<n;k++)if(!Number.isFinite(Math.fround(values[k]))||values[k]<min)throw new RangeError('Invalid instance value');
    for(let k=0;k<n;k++)this.data[o+k]=values[k];this.low=Math.min(this.low,i);this.high=Math.max(this.high,i+1);this.stale=true;return this;
  }
  /** Column-major 4x4 (`Matrix4.elements` from @margoengine/math, `camera.matrix` layout); the last row must be 0, 0, 0, 1. */
  setMatrixAt(i:number,m:ArrayLike<number>):this {if(m?.length!==16||m[3]||m[7]||m[11]||m[15]!==1)throw new TypeError('Invalid instance matrix');return this.row(i,0,m,16);}
  getMatrixAt<T extends {[k:number]:number}=Float32Array>(i:number,out:T=new Float32Array(16) as unknown as T):T {const o=this.index(i);for(let k=0;k<16;k++)out[k]=this.data[o+k];return out;}
  /** Linear RGB or RGBA (0 or more; 1 = unchanged), multiplied into the base colour like a vertex colour. */
  setColorAt(i:number,color:ArrayLike<number>):this {if(color?.length!==3&&color?.length!==4)throw new TypeError('Invalid instance color');return this.row(i,16,color.length===3?[color[0],color[1],color[2],1]:color,4,0);}
  /** UV offset and scale (an `packAtlas` region); rotation is not supported per instance. `null` restores the identity. */
  setUVTransformAt(i:number,t:TextureTransform|null):this {
    const offset=t?.offset??[0,0],scale=t?.scale??[1,1];if(t?.rotation||offset.length!==2||scale.length!==2)throw new TypeError('Invalid instance UV transform');
    return this.row(i,20,[scale[0],scale[1],offset[0],offset[1]],4);
  }
  /** True when some drawn instance has a negative determinant (mirrored); such primitives draw without face culling. */
  get mirrored():boolean {this.scan();return this.flipped;}
  /** @internal The vertex buffer for `device` with pending rows uploaded (gltf-pro, shadows and staging call it before drawing). */
  upload(device:GPUDevice):GPUBuffer {
    if(this.device!==device||!this.gpu){this.gpu?.destroy();this.gpu=device.createBuffer({size:this.data.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});this.device=device;this.low=0;this.high=this.capacity;}
    if(this.high>this.low){device.queue.writeBuffer(this.gpu,this.low*96,this.data as Float32Array<ArrayBuffer>,this.low*24,(this.high-this.low)*24);this.low=this.capacity;this.high=0;}
    this.scan();return this.gpu;
  }
  private scan():void {
    if(!this.stale)return;const d=this.data;this.stale=this.flipped=false;
    for(let o=0;o<this.drawn*24&&!this.flipped;o+=24)this.flipped=d[o]*(d[o+5]*d[o+10]-d[o+6]*d[o+9])-d[o+4]*(d[o+1]*d[o+10]-d[o+2]*d[o+9])+d[o+8]*(d[o+1]*d[o+6]-d[o+2]*d[o+5])<0;
  }
  /** Frees the GPU buffer; the next draw uploads everything again. */
  dispose():void {this.gpu?.destroy();this.gpu=this.device=undefined;}
}
// Instanced vertex stage, patched after lighting and material effects (shader NodeMaterial's vertex nodes keep their anchor):
// the node matrix times the instance matrix, normals by its cofactor matrix (the inverse-transpose up to a positive scale,
// normalized per fragment), per-instance handedness for facing and tangents, tint and UV scale/offset.
const instancedCode=new Map<string,string>();
export function instancedShader(code:string):string {
  let out=instancedCode.get(code);if(out!==undefined)return out;
  const edit=(from:string|RegExp,to:string)=>{const next=out!.replace(from,to);if(next===out)throw new Error('PBR instancing patch target missing: '+from);out=next;};out=code;
  edit(/(struct Out \{[^}]*?)\n\}/,'$1, @location(5) @interpolate(flat) mirror:f32\n}');
  edit('@vertex fn vertex(i:Input)->Out {',`struct Instance {@location(5) m0:vec4f, @location(6) m1:vec4f, @location(7) m2:vec4f, @location(8) m3:vec4f, @location(9) tint:vec4f, @location(10) uvt:vec4f}
@vertex fn vertex(i:Input,k:Instance)->Out {
  let margoI=f.model*mat4x4f(k.m0,k.m1,k.m2,k.m3); let margoS=select(-1.0,1.0,dot(margoI[0].xyz,cross(margoI[1].xyz,margoI[2].xyz))>0);`);
  edit('let p=f.model*vec4f(','let p=margoI*vec4f(');
  edit('o.normal=(f.normalMatrix*vec4f(i.normal.xyz,0)).xyz;','o.normal=mat3x3f(cross(margoI[1].xyz,margoI[2].xyz),cross(margoI[2].xyz,margoI[0].xyz),cross(margoI[0].xyz,margoI[1].xyz))*i.normal.xyz*margoS;');
  edit('(f.model*vec4f(i.tangent.xyz,0)).xyz,i.tangent.w*f.coordsB.y)','(margoI*vec4f(i.tangent.xyz,0)).xyz,i.tangent.w*margoS)');
  edit('o.uv=i.uv; o.color=i.color;','o.uv=i.uv*k.uvt.xyxy+k.uvt.zwzw; o.color=i.color*k.tint; o.mirror=margoS;');
  edit('let facing=front==(f.coordsB.y>0);','let facing=front==(i.mirror>0);');
  if(instancedCode.size>=64)instancedCode.clear();instancedCode.set(code,out);return out;
}