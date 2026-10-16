import {parseJSON} from '../../shared/json.js';
import {checkCount,countLimit} from '../../shared/limits.js';
import type {EngineKernel} from '@margoengine/core';
import {parsePreparedPBR,validatePreparedGeometry,type GLTFDocument,type PBRModel,type PreparedGeometry} from '@margoengine/gltf-pro';
import {readResponse} from '../../shared/loading.js';

const maxBytes=256*1024*1024;
const littleEndian=new Uint8Array(new Uint32Array([1]).buffer)[0]===1;
// The prepared glTF subset inspected below; scene and material fields remain
// unknown here because parsePreparedPBR owns their validation.
interface MargoPrimitive {
  vertices?:unknown;
  indices?:unknown;
  attributes?:unknown;
  targets?:unknown;
  extensions?:unknown;
}
interface MargoMesh {primitives?:MargoPrimitive[]}
interface MargoImage {mimeType?:unknown;uri?:unknown;section?:unknown}
interface MargoDocument extends Record<string,unknown> {
  asset?:{version?:unknown};
  meshes?:MargoMesh[];
  nodes?:unknown[];
  images?:MargoImage[];
}
export interface MargoAsset {
  readonly document:GLTFDocument;
  readonly geometry:readonly (readonly PreparedGeometry[])[];
  readonly images:readonly Uint8Array<ArrayBuffer>[];
}
/** Resource limits shared by the .margo decoding and loading entrypoints. */
export interface MargoOptions {
  /** Maximum scene nodes (default 100,000). */
  maxNodes?:number;
}

/** CAD vertices and uint16 indices expand once; other geometry retains the input buffer. */
export function decodeMargo(input:ArrayBuffer|ArrayBufferView,{maxNodes=100_000}:MargoOptions={}):MargoAsset {
  countLimit('maxNodes',maxNodes);
  if(!(input instanceof ArrayBuffer)&&!ArrayBuffer.isView(input))throw new TypeError('Expected .margo bytes');
  const buffer=input instanceof ArrayBuffer?input:input.buffer,base=input instanceof ArrayBuffer?0:input.byteOffset,length=input.byteLength;
  if(!(buffer instanceof ArrayBuffer)||base%4||!littleEndian)throw new TypeError('.margo requires aligned, little-endian ArrayBuffer storage');
  if(length<64||length>maxBytes||length%4)throw new RangeError('Invalid .margo size');
  const view=new DataView(buffer,base,length);
  if(view.getUint32(0,true)!==0x4f47524d||view.getUint32(4,true)!==1||view.getUint32(8,true)!==length||view.getUint32(16,true)!==64||view.getUint32(24,true)!==80)throw new TypeError('Invalid .margo header/version/stride');
  for(let at=20;at<64;at+=4)if(at!==24&&view.getUint32(at,true)!==0)throw new TypeError('Unsupported .margo flags');
  const count=view.getUint32(12,true);
  if(count<3||count>4096||64+count*16>length)throw new RangeError('Invalid .margo section count');
  const sections:{type:number;stride:number;bytes:Uint8Array<ArrayBuffer>}[]=[];let end=64+count*16;
  for(let i=0;i<count;i++){
    const at=64+i*16,type=view.getUint32(at,true),offset=view.getUint32(at+4,true),size=view.getUint32(at+8,true),flags=view.getUint32(at+12,true),stride=type===2?(flags===1?24:80):(flags===1?2:4);
    if(![1,2,3,4].includes(type)||flags>(type===2?1:type===3?2:0)||!size||offset!==end||offset+size>length)throw new RangeError('Invalid .margo section bounds/type/alignment');
    if((i===0)!==(type===1)||type===1&&size>1024*1024||type===2&&size%stride||type===3&&size%(stride*3))throw new RangeError('Invalid .margo section layout');
    sections.push({type,stride,bytes:new Uint8Array(buffer,base+offset,size)});end=(offset+size+3)&~3;
  }
  if(end!==length)throw new RangeError('Trailing/truncated .margo data');
  const doc:MargoDocument|null=parseJSON(new TextDecoder('utf-8',{fatal:true}).decode(sections[0].bytes));
  if(!doc||doc.asset?.version!=='2.0'||!Array.isArray(doc.meshes)||!doc.meshes.length||!Array.isArray(doc.nodes)||!doc.nodes.length)throw new TypeError('Invalid .margo scene');
  checkCount('Too many .margo nodes',doc.nodes.length,maxNodes,'maxNodes');
  for(const key of ['buffers','bufferViews','accessors','skins','animations','extensionsRequired'])if(doc[key]!==undefined)throw new TypeError('Unsupported .margo '+key);
  for(const key of ['materials','images','textures','samplers','scenes'])if(doc[key]!==undefined&&!Array.isArray(doc[key]))throw new TypeError('Invalid .margo '+key);
  const section=(id:unknown,type:number)=>{
    if(typeof id!=='number'||!Number.isSafeInteger(id)||id<1||sections[id]?.type!==type)throw new TypeError('Invalid .margo section reference');
    return sections[id];
  };
  const shared=new Map<string,PreparedGeometry>();let geometryBytes=0;
  const geometry=doc.meshes.map(mesh=>{
    if(!mesh||!Array.isArray(mesh.primitives)||!mesh.primitives.length)throw new TypeError('Invalid .margo primitives');
    return mesh.primitives.map(p=>{
      if(!p||p.attributes||p.targets||p.extensions)throw new TypeError('Unsupported .margo primitive');
      const {bytes:vertices,stride}=section(p.vertices,2),{bytes:indices,stride:indexStride}=section(p.indices,3);
      const key=`${p.vertices}:${p.indices}`;
      let geometry=shared.get(key);
      if(!geometry){
        const count=vertices.byteLength/stride;geometryBytes+=count*80+indices.byteLength/indexStride*4;
        if(count<3||count>1_000_000||geometryBytes>maxBytes)throw new RangeError('.margo geometry exceeds decoded size limit');
        let packed=new Float32Array(buffer,vertices.byteOffset,vertices.byteLength/4);
        if(stride===24){
          const expanded=new Float32Array(count*20);
          for(let i=0;i<count;i++){
            for(let axis=0;axis<3;axis++){expanded[i*20+axis]=packed[i*6+axis];expanded[i*20+4+axis]=packed[i*6+3+axis];}
            expanded[i*20+3]=1;expanded.fill(1,i*20+16,i*20+20);
          }
          packed=expanded;
        }
        const packedIndices=indexStride===2?Uint32Array.from(new Uint16Array(buffer,indices.byteOffset,indices.byteLength/2)):new Uint32Array(buffer,indices.byteOffset,indices.byteLength/4);
        geometry={vertices:packed,indices:packedIndices};validatePreparedGeometry(geometry);shared.set(key,geometry);
      }
      return geometry;
    });
  });
  let decoded=0;
  const images=(doc.images??[]).map(image=>{
    if(!image||image.mimeType!=='image/png'||image.uri!==undefined)throw new TypeError('.margo images must be embedded PNG');
    const {bytes}=section(image.section,4),png=new DataView(buffer,bytes.byteOffset,bytes.byteLength);
    if(bytes.length<33||png.getUint32(0)!==0x89504e47||png.getUint32(4)!==0x0d0a1a0a||png.getUint32(8)!==13||png.getUint32(12)!==0x49484452||bytes[24]!==8||bytes[25]!==6||bytes[26]||bytes[27]||bytes[28])throw new TypeError('Invalid .margo RGBA8 PNG');
    const width=png.getUint32(16),height=png.getUint32(20);decoded+=width*height*4;
    if(!width||!height||width>4096||height>4096||decoded>maxBytes)throw new RangeError('.margo images exceed decoded size limit');
    return bytes;
  });
  return {document:doc,geometry,images};
}

export async function parseMargo(engine:EngineKernel,input:ArrayBuffer|ArrayBufferView,{signal,maxNodes}:MargoOptions&{signal?:AbortSignal}={}):Promise<PBRModel> {
  signal?.throwIfAborted();const asset=decodeMargo(input,{maxNodes}),images:ImageBitmap[]=[];
  try{
    for(const bytes of asset.images){
      signal?.throwIfAborted();
      const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});images.push(image);
      const png=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      if(image.width!==png.getUint32(16)||image.height!==png.getUint32(20))throw new RangeError('Decoded .margo image size mismatch');
    }
    signal?.throwIfAborted();return parsePreparedPBR(engine,asset.document,asset.geometry,images,{maxNodes});
  }catch(error){for(const image of images)image.close();throw error;}
}

export async function loadMargo(engine:EngineKernel,url:string|URL,{signal,maxNodes}:MargoOptions&{signal?:AbortSignal}={}):Promise<PBRModel> {
  signal?.throwIfAborted();const target=new URL(url,globalThis.location?.href);
  if(!['http:','https:'].includes(target.protocol))throw new TypeError('.margo URL must use HTTP(S)');
  const bytes=await readResponse(await fetch(target,{signal}),{maxBytes,signal,label:'.margo download'});
  return parseMargo(engine,bytes,{signal,maxNodes});
}
