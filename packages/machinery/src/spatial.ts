import {meshRuntime} from '@margoengine/core/extension';
import type {Mesh,Vec3} from '@margoengine/core';
import {machineryMemory} from './runtime.js';
import {vertexAnchor,holeAnchor,edgeAnchor} from './metrology.js';
import {worldAnchor,type Anchor} from './anchors.js';
import {meshTriangles} from '../../shared/mesh-source.js';
export interface RayHit {node:Mesh;triangle:number;distance:number;point:Vec3}
interface TriangleRecord {vertices:Float32Array;indices:Uint32Array;stride:6|20}
function records(node:Mesh):TriangleRecord[] {
  const triangles=meshTriangles(node);if(!triangles)return [];
  if(triangles.kind==='core')return [{vertices:triangles.geometry.vertices,indices:triangles.geometry.indices,stride:6}];
  if(triangles.source.primitives.some(primitive=>primitive.deformed))throw new Error('Deformed PBR mesh requires async Raycaster.intersectModel(model); AssemblyBVH accepts static triangles only');
  return triangles.source.primitives.map(primitive=>({vertices:primitive.vertices,indices:primitive.indices,stride:20}));
}
export class AssemblyBVH {
  private disposed=false;private valid=false;private readonly triangles:Float32Array;private readonly result:Float64Array;
  private readonly owners:Uint32Array;private readonly faces:Uint32Array;
  private constructor(readonly nodes:readonly Mesh[],private readonly sources:readonly TriangleRecord[][],private readonly count:number,private readonly memory:Awaited<ReturnType<typeof machineryMemory>>) {this.triangles=new Float32Array(memory.buffer,memory.ptr,count*9);this.result=new Float64Array(memory.buffer,memory.ptr+count*104,2);this.owners=new Uint32Array(count);this.faces=new Uint32Array(count);}
  static async create(nodes:Iterable<Mesh>):Promise<AssemblyBVH> {const list=[...nodes],sources=list.map(node=>{node.check();return records(node);});let count=0;for(const values of sources)for(const source of values)count+=source.indices.length/3;if(!count||count>1_000_000)throw new RangeError('BVH requires 1..1000000 triangles');const index=new AssemblyBVH(list,sources,count,await machineryMemory(count*104+16));index.rebuild();return index;}
  private checkSource(index:number):void {const node=this.nodes[index];node.check();const current=records(node),previous=this.sources[index];if(current.length!==previous.length||current.some((value,at)=>value.vertices!==previous[at].vertices||value.indices!==previous[at].indices||value.stride!==previous[at].stride))throw new Error('Geometry changed; recreate assembly BVH');}
  rebuild():void {
    if(this.disposed)throw new Error('BVH is disposed');this.valid=false;let at=0;
    for(let n=0;n<this.nodes.length;n++){const node=this.nodes[n],runtime=meshRuntime(node);this.checkSource(n);const m=runtime.matrix;let visible=true;
      for(let id=runtime.id,depth=0;id!==-1;id=runtime.engine.store.parents[id],depth++){if(depth>=64||!Number.isSafeInteger(id)||id<0||id>=runtime.engine.store.capacity)throw new Error('Invalid BVH hierarchy');if(runtime.engine.store.hidden[id]){visible=false;break;}}
      let face=0;for(const geometry of this.sources[n])for(let f=0;f<geometry.indices.length;f+=3){this.owners[at]=n;this.faces[at]=face++;for(let v=0;v<3;v++){const id=geometry.indices[f+v]*geometry.stride,x=geometry.vertices[id],y=geometry.vertices[id+1],z=geometry.vertices[id+2];for(let a=0;a<3;a++)this.triangles[at*9+v*3+a]=visible?m[a]*x+m[4+a]*y+m[8+a]*z+m[12+a]:0;}at++;}
    }
    if(!this.memory.api.bvh_build(this.memory.ptr,this.count))throw new RangeError('Invalid BVH coordinates');this.valid=true;
  }
  raycast(origin:Vec3,direction:Vec3,maxDistance=Infinity):RayHit|null {
    if(this.disposed)throw new Error('BVH is disposed');if(!this.valid)throw new Error('Rebuild the BVH before raycasting');if(origin.length!==3||direction.length!==3||!origin.every(Number.isFinite)||!direction.every(Number.isFinite)||!(maxDistance>=0))throw new RangeError('Invalid ray');const length=Math.hypot(...direction);if(!length||!Number.isFinite(length))throw new RangeError('Ray direction must be finite and nonzero');
    for(let index=0;index<this.nodes.length;index++)this.checkSource(index);
    this.memory.api.bvh_ray(this.memory.ptr,this.count,origin[0],origin[1],origin[2],direction[0]/length,direction[1]/length,direction[2]/length,maxDistance,this.memory.ptr+this.count*104);const id=this.result[0];if(id<0)return null;const node=this.nodes[this.owners[id]],distance=this.result[1];return {node,triangle:this.faces[id],distance,point:[origin[0]+direction[0]/length*distance,origin[1]+direction[1]/length*distance,origin[2]+direction[2]/length*distance]};
  }
  snap(hit:RayHit,{kind='vertex',rings=[],maxDistance=Infinity}:{kind?:'vertex'|'edge'|'centerline';rings?:readonly (readonly number[])[];maxDistance?:number}={}):Anchor|null {
    if(this.disposed||!this.nodes.includes(hit.node)||!['vertex','edge','centerline'].includes(kind)||!(maxDistance>=0)||!Number.isSafeInteger(hit.triangle)||hit.triangle<0)throw new RangeError('Invalid BVH snap');const nodeIndex=this.nodes.indexOf(hit.node);this.checkSource(nodeIndex);let face=hit.triangle,geometry:TriangleRecord|undefined;for(const part of this.sources[nodeIndex]){if(face<part.indices.length/3){geometry=part;break;}face-=part.indices.length/3;}if(!geometry)throw new RangeError('Invalid hit triangle');worldAnchor({point:hit.point});let best:Anchor|null=null,distance=maxDistance;
    const ids=geometry.indices.subarray(face*3,face*3+3),count=kind==='centerline'?rings.length:3;
    if(geometry.stride===20&&kind==='centerline')throw new Error('PBR centerline snapping requires an explicit local anchor');
    const local=(id:number):Vec3=>Array.from(geometry!.vertices.subarray(id*geometry!.stride,id*geometry!.stride+3)) as unknown as Vec3;
    for(let i=0;i<count;i++){const point=local(ids[i]),next=local(ids[(i+1)%3]),anchor:Anchor=geometry.stride===6?(kind==='vertex'?vertexAnchor(hit.node,ids[i]):kind==='edge'?edgeAnchor(hit.node,ids[i],ids[(i+1)%3]):holeAnchor(hit.node,rings[i])):{node:hit.node,point:kind==='vertex'?point:[(point[0]+next[0])/2,(point[1]+next[1])/2,(point[2]+next[2])/2]},p=worldAnchor(anchor),d=Math.hypot(p[0]-hit.point[0],p[1]-hit.point[1],p[2]-hit.point[2]);if(d<=distance){best=anchor;distance=d;}}
    return best;
  }
  dispose():void {this.disposed=true;}
}
