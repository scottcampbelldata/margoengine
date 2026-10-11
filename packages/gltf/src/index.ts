import {engineRuntime} from '@vexel/core/extension';
import type {EngineKernel,Mesh as MeshHandle} from '@vexel/core';
import { Engine, Geometry, PbrMaterial, type Mesh } from '@vexel/core/extension';
import { readResponse } from '../../shared/loading.js';

const limit=64*1024*1024;
type Document=Record<string,any>;
const integer=(value:unknown,label:string,min=0):number=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min)throw new TypeError(`Invalid glTF ${label}`);return value;};
const entry=(array:any[],id:unknown,label:string):any=>{const value=array?.[integer(id,label)];if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(`Missing glTF ${label}`);return value;};
function bytes(input:ArrayBuffer|ArrayBufferView):Uint8Array {return input instanceof ArrayBuffer?new Uint8Array(input):new Uint8Array(input.buffer,input.byteOffset,input.byteLength);}
function container(input:string|object|ArrayBuffer|ArrayBufferView):{doc:Document;binary?:Uint8Array} {
  if(typeof input==='string'){if(input.length>limit||new TextEncoder().encode(input).length>limit)throw new RangeError('glTF JSON exceeds 64 MiB');return {doc:JSON.parse(input)};}
  if(!(input instanceof ArrayBuffer)&&!ArrayBuffer.isView(input))return {doc:input as Document};
  const data=bytes(input),view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  if(data.length<20||data.length>limit||view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==data.length)throw new TypeError('Invalid GLB header');
  let doc:Document|undefined,binary:Uint8Array|undefined,offset=12;
  while(offset<data.length){if(offset+8>data.length)throw new RangeError('Truncated GLB chunk');const length=view.getUint32(offset,true),type=view.getUint32(offset+4,true);offset+=8;
    if(length%4||offset+length>data.length)throw new RangeError('Invalid GLB chunk size');const chunk=data.subarray(offset,offset+length);
    if(offset===20&&type!==0x4e4f534a)throw new TypeError('GLB JSON must be first');
    if(type===0x4e4f534a){if(doc)throw new TypeError('Duplicate GLB JSON');doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(chunk));}
    else if(type===0x004e4942){if(binary)throw new TypeError('Duplicate GLB binary');binary=chunk;}offset+=length;
  }
  if(!doc)throw new TypeError('Missing GLB JSON');return {doc,binary};
}
function embedded(uri:string):Uint8Array {
  const match=/^data:application\/(?:octet-stream|gltf-buffer);base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if(!match||match[1].length>limit*4/3+4)throw new TypeError('Invalid glTF data URI');return Uint8Array.from(atob(match[1]),c=>c.charCodeAt(0));
}
function validate(doc:Document):void {
  if(!doc||doc.asset?.version!=='2.0')throw new TypeError('Expected glTF 2.0');
  for(const field of ['buffers','bufferViews','accessors','meshes','nodes','scenes','materials','skins','animations','extensionsRequired'])if(doc[field]!==undefined&&!Array.isArray(doc[field]))throw new TypeError(`glTF ${field} must be an array`);
  if(doc.extensionsRequired?.length||doc.skins?.length||doc.animations?.length)throw new Error('Minimal glTF supports static uncompressed models; required extensions, skins and animations are unsupported');
  if((doc.nodes?.length??0)>100_000)throw new RangeError('Too many glTF nodes');
}
function transform(mesh:Mesh,node:any):void {
  if(node.matrix!==undefined){
    if(node.translation!==undefined||node.rotation!==undefined||node.scale!==undefined||!Array.isArray(node.matrix)||node.matrix.length!==16||node.matrix.some((v:unknown)=>typeof v!=='number'||!Number.isFinite(Math.fround(v))))throw new TypeError('Invalid glTF matrix');
    const m=node.matrix;if(m[3]!==0||m[7]!==0||m[11]!==0||m[15]!==1)throw new TypeError('glTF matrix must be affine');
    const sx=Math.hypot(m[0],m[1],m[2]),sy=Math.hypot(m[4],m[5],m[6]),sz=Math.hypot(m[8],m[9],m[10]);if(Math.min(sx,sy,sz)===0)throw new RangeError('Singular glTF matrix');
    const det=m[0]*(m[5]*m[10]-m[6]*m[9])-m[4]*(m[1]*m[10]-m[2]*m[9])+m[8]*(m[1]*m[6]-m[2]*m[5]),scale=[sx*Math.sign(det),sy,sz] as const;
    const r=Array.from({length:9},(_,i)=>m[Math.floor(i/3)*4+i%3]/scale[Math.floor(i/3)]);
    for(const [a,b]of [[0,3],[0,6],[3,6]])if(Math.abs(r[a]*r[b]+r[a+1]*r[b+1]+r[a+2]*r[b+2])>1e-5)throw new Error('Sheared glTF matrices are unsupported');
    const trace=r[0]+r[4]+r[8];let q:number[];
    if(trace>0){const s=2*Math.sqrt(trace+1);q=[(r[5]-r[7])/s,(r[6]-r[2])/s,(r[1]-r[3])/s,s/4];}
    else if(r[0]>r[4]&&r[0]>r[8]){const s=2*Math.sqrt(1+r[0]-r[4]-r[8]);q=[s/4,(r[3]+r[1])/s,(r[6]+r[2])/s,(r[5]-r[7])/s];}
    else if(r[4]>r[8]){const s=2*Math.sqrt(1+r[4]-r[0]-r[8]);q=[(r[3]+r[1])/s,s/4,(r[7]+r[5])/s,(r[6]-r[2])/s];}
    else{const s=2*Math.sqrt(1+r[8]-r[0]-r[4]);q=[(r[6]+r[2])/s,(r[7]+r[5])/s,s/4,(r[1]-r[3])/s];}
    mesh.setPosition([m[12],m[13],m[14]]).setScale(scale).setQuaternion(q);
  }else{mesh.setPosition(node.translation??[0,0,0]).setScale(node.scale??[1,1,1]).setQuaternion(node.rotation??[0,0,0,1]);}
}

export interface Model {root:MeshHandle;meshes:readonly MeshHandle[];nodes:readonly MeshHandle[];dispose():void}
export function parseGLTF(instance:EngineKernel,input:string|object|ArrayBuffer|ArrayBufferView,suppliedBuffers:Array<ArrayBuffer|ArrayBufferView>=[]):Model {
  const engine=engineRuntime(instance);
  const {doc,binary}=container(input);validate(doc);let total=0,vertices=0;
  const buffers=(doc.buffers??[]).map((def:any,i:number)=>{const length=integer(def.byteLength,'buffer length',1);const data=suppliedBuffers[i]?bytes(suppliedBuffers[i]):def.uri?embedded(def.uri):i===0?binary:undefined;if(!data||length>data.length)throw new RangeError('Truncated glTF buffer');total+=data.length;if(total>limit)throw new RangeError('glTF buffers exceed 64 MiB');return data.subarray(0,length);});
  const accessor=(id:unknown,index=false):Float32Array|Uint32Array=>{
    const a=entry(doc.accessors,id,'accessor'),v=entry(doc.bufferViews,a.bufferView,'bufferView'),buffer=buffers[integer(v.buffer,'buffer reference')];
    if(!buffer||a.sparse||a.normalized||a.type!==(index?'SCALAR':'VEC3')||!(index?[5121,5123,5125]:[5126]).includes(a.componentType))throw new Error('Unsupported glTF accessor');
    const size=a.componentType===5121?1:a.componentType===5123?2:4,components=index?1:3,count=integer(a.count,'accessor count',1),offset=integer(a.byteOffset??0,'accessor offset'),start=integer(v.byteOffset??0,'view offset'),length=integer(v.byteLength,'view length',1),stride=integer(v.byteStride??size*components,'stride',size*components);
    if(count>1_000_000||start+length>buffer.length||offset+(count-1)*stride+components*size>length||start%size||offset%size||stride%size||stride>252||index&&v.byteStride!==undefined)throw new RangeError('Invalid glTF accessor bounds/stride');
    const view=new DataView(buffer.buffer,buffer.byteOffset+start,length),out=index?new Uint32Array(count):new Float32Array(count*3);
    for(let i=0;i<count;i++)for(let c=0;c<components;c++){const at=offset+i*stride+c*size;out[i*components+c]=index?size===1?view.getUint8(at):size===2?view.getUint16(at,true):view.getUint32(at,true):view.getFloat32(at,true);}return out;
  };
  const materials=(doc.materials??[]).map((m:any)=>{
    const p=m.pbrMetallicRoughness??{},color=p.baseColorFactor??[1,1,1,1];
    if((m.alphaMode??'OPAQUE')!=='OPAQUE'||!Array.isArray(color)||color.length!==4||color[3]!==1||m.emissiveFactor?.some((v:number)=>v!==0)||m.extensions||[p.baseColorTexture,p.metallicRoughnessTexture,m.normalTexture,m.occlusionTexture,m.emissiveTexture].some(Boolean))throw new Error('Minimal PBR supports opaque constant colors; textures, emission and transparency require an extension');
    return new PbrMaterial({color:color.slice(0,3),roughness:p.roughnessFactor??1,metalness:p.metallicFactor??1,doubleSided:m.doubleSided??false});
  });
  const definitions=(doc.meshes??[]).map((mesh:any)=>{
    if(!Array.isArray(mesh.primitives)||!mesh.primitives.length)throw new TypeError('Missing glTF primitives');
    return mesh.primitives.map((p:any)=>{
      if((p.mode??4)!==4||p.targets||p.extensions||Object.keys(p.attributes??{}).some(key=>/^(COLOR|JOINTS|WEIGHTS)_/.test(key)))throw new Error('Minimal glTF requires rigid triangles without vertex colors');
      let positions=accessor(p.attributes?.POSITION) as Float32Array,normals=p.attributes?.NORMAL===undefined?null:accessor(p.attributes.NORMAL) as Float32Array;
      let indices=p.indices===undefined?Uint32Array.from({length:positions.length/3},(_,i)=>i):accessor(p.indices,true) as Uint32Array;
      if(indices.length%3)throw new RangeError('Indices must contain complete triangles');
      vertices+=normals?positions.length/3:indices.length;if(vertices>1_000_000)throw new RangeError('glTF exceeds one million vertices');
      if(!normals){const expanded=new Float32Array(indices.length*3);normals=new Float32Array(expanded.length);
        for(let i=0;i<indices.length;i++){if(indices[i]>=positions.length/3)throw new RangeError('Index exceeds vertices');expanded.set(positions.subarray(indices[i]*3,indices[i]*3+3),i*3);}
        for(let i=0;i<expanded.length;i+=9){const a=expanded.subarray(i,i+9),ux=a[3]-a[0],uy=a[4]-a[1],uz=a[5]-a[2],vx=a[6]-a[0],vy=a[7]-a[1],vz=a[8]-a[2],normal=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];for(let j=0;j<3;j++)normals.set(normal,i+j*3);}positions=expanded;indices=Uint32Array.from({length:expanded.length/3},(_,i)=>i);
      }
      const material=p.material===undefined?new PbrMaterial({color:[1,1,1],roughness:1,metalness:1,doubleSided:false}):materials[integer(p.material,'material reference')];if(!material)throw new Error('Missing material');
      return {geometry:new Geometry(positions,normals,indices),material};
    });
  });
  const nodes=doc.nodes??[],parents=new Int32Array(nodes.length).fill(-1);
  nodes.forEach((node:any,id:number)=>{if(!node||node.skin!==undefined||node.camera!==undefined||node.extensions)throw new Error('Unsupported glTF node');if(node.children!==undefined&&!Array.isArray(node.children))throw new TypeError('Invalid glTF children');for(const child of node.children??[]){const index=integer(child,'child reference');if(index>=nodes.length||parents[index]!==-1||index===id)throw new Error('Invalid glTF hierarchy');parents[index]=id;}});
  for(let id=0;id<nodes.length;id++){let depth=0;for(let current=id;current!==-1;current=parents[current])if(++depth>62)throw new Error('glTF hierarchy cycle or depth limit');}
  const roots=doc.scenes?entry(doc.scenes,doc.scene??0,'scene').nodes??[]:nodes.map((_:unknown,i:number)=>i).filter((i:number)=>parents[i]===-1);
  if(!Array.isArray(roots)||new Set(roots).size!==roots.length)throw new TypeError('Invalid glTF scene roots');
  const created:Mesh[]=[],renderable:Mesh[]=[],imported:Mesh[]=[];
  try{const root=engine.createMesh();created.push(root);const stack=roots.map((id:unknown)=>({id:integer(id,'root'),parent:root}));
    while(stack.length){const {id,parent}=stack.pop()!,node=entry(nodes,id,'node');if(parent===root&&parents[id]!==-1)throw new Error('Scene root has a parent');const mesh=engine.createMesh(parent);created.push(mesh);imported.push(mesh);mesh.name=typeof node.name==='string'?node.name:'';transform(mesh,node);
      if(node.mesh!==undefined){const primitives=definitions[integer(node.mesh,'mesh reference')];if(!primitives)throw new Error('Missing glTF mesh');for(const p of primitives){const child=engine.createMesh(mesh);created.push(child);child.setGeometry(p.geometry).setMaterial(p.material);renderable.push(child);}}
      for(const child of node.children??[])stack.push({id:child,parent:mesh});
    }
    if(!renderable.length)throw new Error('glTF contains no renderable meshes');return {root,meshes:renderable,nodes:imported,dispose(){for(let i=created.length-1;i>=0;i--)created[i].dispose();}};
  }catch(error){for(let i=created.length-1;i>=0;i--)created[i].dispose();throw error;}
}

export async function loadGLTF(engine:EngineKernel,url:string|URL,{signal}: {signal?:AbortSignal}={}):Promise<Model> {
  signal?.throwIfAborted();let base=new URL(url,globalThis.location?.href),total=0;
  async function fetchBytes(target:URL,root=false){if(!['http:','https:'].includes(target.protocol))throw new TypeError('glTF URL must use HTTP(S)');const response=await fetch(target,{signal});if(root&&response.url)base=new URL(response.url);const data=await readResponse(response,{maxBytes:limit-total,signal,label:'glTF download'});total+=data.byteLength;return data;}
  const data=await fetchBytes(base,true),glb=data.length>=4&&new DataView(data.buffer).getUint32(0,true)===0x46546c67,{doc,binary}=container(glb?data:new TextDecoder('utf-8',{fatal:true}).decode(data));validate(doc);
  const buffers=[];
  for(const def of doc.buffers??[]){if(!def.uri)buffers.push(binary??new Uint8Array());else if(def.uri.startsWith('data:')){const data=embedded(def.uri);total+=data.length;if(total>limit)throw new RangeError('glTF exceeds download limit');buffers.push(data);}else buffers.push(await fetchBytes(new URL(def.uri,base)));}
  signal?.throwIfAborted();return parseGLTF(engine,doc,buffers);
}
