import {meshRuntime} from '@margoengine/core/extension';
import type {Mesh,Vec3} from '@margoengine/core';
import type {Geometry} from '@margoengine/core/extension';
import {machineryMemory} from './runtime.js';
import {vertexAnchor,holeAnchor,edgeAnchor} from './metrology.js';
import {worldAnchor,type Anchor} from './anchors.js';
export interface RayHit {node:Mesh;triangle:number;distance:number;point:Vec3}
/**
 * Two-level picking: one local-space Wasm triangle BVH per distinct geometry, shared by all its instances, under a per-part bounding-sphere
 * pass over world transforms. rebuild() is O(parts) and memory follows distinct triangles, so assemblies with millions of instanced triangles fit.
 */
export class AssemblyBVH {
  private disposed=false;private valid=false;private readonly triangles:Float32Array;private readonly result:Float64Array;private readonly geometries:(Geometry|null)[];
  private readonly shape:Int32Array;private readonly inverses:Float64Array;private readonly spheres:Float64Array;
  private readonly order:Int32Array;private readonly entry:Float64Array;
  private constructor(readonly nodes:readonly Mesh[],private readonly shapes:{ptr:number;count:number}[],private readonly memory:Awaited<ReturnType<typeof machineryMemory>>,shape:Int32Array,total:number) {
    const n=nodes.length;this.triangles=new Float32Array(memory.buffer,memory.ptr,total*26);this.result=new Float64Array(memory.buffer,memory.ptr+total*104,2);this.geometries=nodes.map(node=>node.geometry);
    this.shape=shape;this.inverses=new Float64Array(n*12);this.spheres=new Float64Array(n*4);this.order=new Int32Array(n);this.entry=new Float64Array(n);
  }
  static async create(nodes:Iterable<Mesh>):Promise<AssemblyBVH> {
    const list=[...nodes],ids=new Map<Geometry,number>(),unique:Geometry[]=[],shape=new Int32Array(list.length);let total=0;
    for(let i=0;i<list.length;i++){const node=list[i];node.check();const geometry=meshRuntime(node).geometry;let id=-1;if(geometry){id=ids.get(geometry)??-1;if(id<0){id=unique.length;ids.set(geometry,id);unique.push(geometry);total+=geometry.indices.length/3;}}shape[i]=id;}
    if(!total||total>1_000_000)throw new RangeError('BVH requires 1..1000000 triangles');
    const memory=await machineryMemory(total*104+16),shapes:{ptr:number;count:number}[]=[];let at=memory.ptr;
    for(const geometry of unique){const count=geometry.indices.length/3,triangles=new Float32Array(memory.buffer,at,count*9),v=geometry.vertices,f=geometry.indices;
      for(let i=0;i<f.length;i++){const p=f[i]*6;triangles[i*3]=v[p];triangles[i*3+1]=v[p+1];triangles[i*3+2]=v[p+2];}
      if(!memory.api.bvh_build(at,count))throw new RangeError('Invalid BVH coordinates');shapes.push({ptr:at,count});at+=count*104;}
    const index=new AssemblyBVH(list,shapes,memory,shape,total);index.rebuild();return index;
  }
  rebuild():void {
    if(this.disposed)throw new Error('BVH is disposed');this.valid=false;const s=this.spheres;
    for(let n=0;n<this.nodes.length;n++){const node=this.nodes[n],runtime=meshRuntime(node);node.check();if(node.geometry!==this.geometries[n])throw new Error('Geometry changed; recreate assembly BVH');const geometry=runtime.geometry;s[n*4+3]=-1;if(!geometry)continue;let visible=true;
      for(let id=runtime.id,depth=0;id!==-1;id=runtime.engine.store.parents[id],depth++){if(depth>=64||!Number.isSafeInteger(id)||id<0||id>=runtime.engine.store.capacity)throw new Error('Invalid BVH hierarchy');if(runtime.engine.store.hidden[id]){visible=false;break;}}
      if(!visible)continue;const m=runtime.matrix,b=geometry.bounds;if(!m.every(Number.isFinite))throw new RangeError('Invalid BVH coordinates');// Affine inverse: rows of the 3x3 inverse are the cross products of the columns over the determinant.
      const k=n*12,v=this.inverses,x0=m[0],x1=m[1],x2=m[2],y0=m[4],y1=m[5],y2=m[6],z0=m[8],z1=m[9],z2=m[10],r0=y1*z2-y2*z1,r1=y2*z0-y0*z2,r2=y0*z1-y1*z0,det=x0*r0+x1*r1+x2*r2;if(!det||!Number.isFinite(1/det))continue;
      const rows=[r0,r1,r2,z1*x2-z2*x1,z2*x0-z0*x2,z0*x1-z1*x0,x1*y2-x2*y1,x2*y0-x0*y2,x0*y1-x1*y0];for(let a=0;a<3;a++){for(let c=0;c<3;c++)v[k+c*3+a]=rows[a*3+c]/det;v[k+9+a]=-(v[k+a]*m[12]+v[k+3+a]*m[13]+v[k+6+a]*m[14]);}
      // Frobenius norm bounds the largest singular value, so the sphere also covers sheared and mirrored parts.
      let norm=0;for(let c=0;c<3;c++)for(let r=0;r<3;r++)norm+=m[c*4+r]*m[c*4+r];for(let a=0;a<3;a++)s[n*4+a]=m[a]*b[0]+m[4+a]*b[1]+m[8+a]*b[2]+m[12+a];s[n*4+3]=b[3]*Math.sqrt(norm)*(1+1e-6)+1e-9;}
    this.valid=true;
  }
  raycast(origin:Vec3,direction:Vec3,maxDistance=Infinity):RayHit|null {
    if(this.disposed)throw new Error('BVH is disposed');if(!this.valid)throw new Error('Rebuild the BVH before raycasting');if(origin.length!==3||direction.length!==3||!origin.every(Number.isFinite)||!direction.every(Number.isFinite)||!(maxDistance>=0))throw new RangeError('Invalid ray');const length=Math.hypot(...direction);if(!length||!Number.isFinite(length))throw new RangeError('Ray direction must be finite and nonzero');
    const [ox,oy,oz]=origin,ux=direction[0]/length,uy=direction[1]/length,uz=direction[2]/length,s=this.spheres,order=this.order,entry=this.entry;let candidates=0;
    // ponytail: linear sphere pass, about 0.5 ms per ray at 100k parts; add a top-level BVH over spheres if hover picking needs more.
    for(let n=0;n<this.nodes.length;n++){const r=s[n*4+3];if(r<0)continue;const cx=s[n*4]-ox,cy=s[n*4+1]-oy,cz=s[n*4+2]-oz,along=cx*ux+cy*uy+cz*uz,d2=cx*cx+cy*cy+cz*cz-along*along;if(d2>r*r)continue;const half=Math.sqrt(r*r-d2);if(along+half<0)continue;const t=Math.max(0,along-half);if(t>maxDistance)continue;entry[n]=t;order[candidates++]=n;}
    const sorted=order.subarray(0,candidates).sort((a,b)=>entry[a]-entry[b]);let best=maxDistance,node=-1,triangle=-1;
    for(let i=0;i<sorted.length;i++){const n=sorted[i];if(entry[n]>best)break;const m=this.inverses,k=n*12,shape=this.shapes[this.shape[n]];
      this.memory.api.bvh_ray(shape.ptr,shape.count,m[k]*ox+m[k+3]*oy+m[k+6]*oz+m[k+9],m[k+1]*ox+m[k+4]*oy+m[k+7]*oz+m[k+10],m[k+2]*ox+m[k+5]*oy+m[k+8]*oz+m[k+11],m[k]*ux+m[k+3]*uy+m[k+6]*uz,m[k+1]*ux+m[k+4]*uy+m[k+7]*uz,m[k+2]*ux+m[k+5]*uy+m[k+8]*uz,best,this.result.byteOffset);
      if(this.result[0]>=0&&this.result[1]<=best){best=this.result[1];node=n;triangle=this.result[0];}}
    if(node<0)return null;const hit=this.nodes[node];hit.check();if(hit.geometry!==this.geometries[node])throw new Error('Geometry changed; recreate assembly BVH');
    return {node:hit,triangle,distance:best,point:[ox+ux*best,oy+uy*best,oz+uz*best]};
  }
  snap(hit:RayHit,{kind='vertex',rings=[],maxDistance=Infinity}:{kind?:'vertex'|'edge'|'centerline';rings?:readonly (readonly number[])[];maxDistance?:number}={}):Anchor|null {
    if(this.disposed||!this.nodes.includes(hit.node)||!['vertex','edge','centerline'].includes(kind)||!(maxDistance>=0)||!Number.isSafeInteger(hit.triangle)||hit.triangle<0)throw new RangeError('Invalid BVH snap');hit.node.check();const indices=hit.node.geometry?.indices;if(!indices||hit.triangle>=indices.length/3)throw new RangeError('Invalid hit triangle');worldAnchor({point:hit.point});let best:Anchor|null=null,distance=maxDistance;
    const ids=indices.subarray(hit.triangle*3,hit.triangle*3+3),count=kind==='centerline'?rings.length:3;
    for(let i=0;i<count;i++){const anchor=kind==='vertex'?vertexAnchor(hit.node,ids[i]):kind==='edge'?edgeAnchor(hit.node,ids[i],ids[(i+1)%3]):holeAnchor(hit.node,rings[i]),p=worldAnchor(anchor),d=Math.hypot(p[0]-hit.point[0],p[1]-hit.point[1],p[2]-hit.point[2]);if(d<=distance){best=anchor;distance=d;}}
    return best;
  }
  dispose():void {this.disposed=true;}
}
