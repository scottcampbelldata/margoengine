import { Geometry,PbrMaterial } from '@margoengine/core';
import { meshoptDecodeGltfBuffer } from '@margoengine/decoders/meshopt';

const header=12;
export const poseStride=249;
export const boneCount=20;
export const step=.05;
export const routeNames=['red','blue','green'];
export const routeMoves={red:28,blue:20,green:16};
const poseAssets={
  red:new URL('./opening-red.pose',import.meta.url),
  blue:new URL('./opening-blue.pose',import.meta.url),
  green:new URL('./opening-green.pose',import.meta.url),
};
export const originalRobot=new URL('./light-keeper.mesh',import.meta.url);

async function expand(url,signal) {
  const response=await fetch(url,{signal});
  if (!response.ok) throw new Error('The motion lab asset could not be loaded.');
  const stream=response.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream);
}

export async function loadRobot(signal) {
  return (await expand(originalRobot,signal)).arrayBuffer();
}

export async function loadPose(name,signal) {
  const array=await (await expand(poseAssets[name],signal)).arrayBuffer();
  const view=new DataView(array);
  if(view.getUint32(0)!==0x424c4431 || view.getUint16(6,true)!==poseStride || view.getUint16(8,true)!==20)
    throw new Error('The opening pose format is invalid.');
  const count=view.getUint16(4,true);
  const total=poseStride*count;
  if(count<1 || array.byteLength!==header+2*total+2*count) throw new Error('Opening poses are incomplete.');
  const bytes=new Uint8Array(array);
  const values=new Float32Array(total);
  for(let c=0;c<poseStride;c++){
    const scale=c===poseStride-2?1e-5:1/8192;
    let last=0;
    for(let i=0;i<count;i++){
      const index=header+c*count+i;
      const code=bytes[index] | bytes[index+total]<<8;
      last=(last+((code>>>1)^-(code&1)))<<16>>16;
      values[i*poseStride+c]=last*scale;
    }
  }
  return {values,count,contacts:bytes.subarray(header+2*total,header+2*total+count),moving:bytes.subarray(header+2*total+count)};
}

export async function loadCell(signal) {
  return (await expand(new URL('./opening-cell.mesh',import.meta.url),signal)).json();
}

export function buildOpeningCell(engine,own) {
  const geometries=own.geometry.map(({vertices,indices})=>{
    const positions=[],normals=[];
    for(let i=0;i<vertices.length;i+=6){
      positions.push(vertices[i],vertices[i+1],vertices[i+2]);
      normals.push(vertices[i+3],vertices[i+4],vertices[i+5]);
    }
    return new Geometry(positions,normals,indices);
  });
  const materials=own.materials.map(row=>new PbrMaterial({color:row.slice(0,3),roughness:row[4],metalness:row[5],doubleSided:!!row[6]}));
  for(const {geometry,material,position,rotation,scale} of own.instances)
    engine.createMesh().setGeometry(geometries[geometry]).setMaterial(materials[material])
      .setPosition(position).setRotation(rotation).setScale(scale);
}

// This compact reader only accepts the packed layout of the exhibit’s original model.
export function readOpeningRobot(glb) {
  const meta=new DataView(glb);
  if(meta.getUint32(0,true)!==0x46546c67 || meta.getUint32(4,true)!==2 || meta.getUint32(8,true)!==glb.byteLength)
    throw new Error('The Light Keeper model is invalid.');
  const metaSize=meta.getUint32(12,true);
  const doc=JSON.parse(new TextDecoder().decode(new Uint8Array(glb,20,metaSize)));
  const bin=new Uint8Array(glb,28+metaSize,meta.getUint32(20+metaSize,true));
  const decoded=new Map();
  const accessor=(index,type,stride)=>{
    const a=doc.accessors[index];
    const view=doc.bufferViews[a.bufferView];
    const source=view.extensions?.EXT_meshopt_compression;
    const offset=a.byteOffset??0;
    if(a.componentType!==type || offset%stride!==0 || !source || source.buffer!==0 || source.byteStride!==stride
       || offset+a.count*stride>source.count*stride || (source.byteOffset??0)+source.byteLength>bin.byteLength)
      throw new Error('The Light Keeper model does not use its verified packed layout.');
    let data=decoded.get(a.bufferView);
    if(!data) {
      const low=source.byteOffset??0;
      data=meshoptDecodeGltfBuffer(bin.subarray(low,low+source.byteLength),source.count,stride,source.mode,source.filter);
      decoded.set(a.bufferView,data);
    }
    return {data:data.subarray(offset,offset+a.count*stride),count:a.count};
  };
  return doc.meshes.flatMap(mesh=>mesh.primitives.map(shape=>{
    const a=shape.attributes;
    const {data:position,count}=accessor(a.POSITION,5126,12);
    const {data:normal}=accessor(a.NORMAL,5120,4);
    const {data:joints}=accessor(a.JOINTS_0,5121,4);
    const {data:weights}=accessor(a.WEIGHTS_0,5121,4);
    const {data:indices,count:indexCount}=accessor(shape.indices,5123,2);
    const vertices=new Uint8Array(count*24);
    for(let i=0;i<count;i++){
      const at=i*24;
      vertices.set(position.subarray(i*12,i*12+12),at);
      vertices.set(normal.subarray(i*4,i*4+4),at+12);
      vertices.set(joints.subarray(i*4,i*4+4),at+16);
      vertices.set(weights.subarray(i*4,i*4+4),at+20);
    }
    const material=doc.materials[shape.material];
    const pbr=material.pbrMetallicRoughness;
    const gain=material.extensions?.KHR_materials_emissive_strength?.emissiveStrength??1;
    return {vertices,indices,indexCount,
      color:[...pbr.baseColorFactor.slice(0,3),pbr.metallicFactor],
      surface:[...(material.emissiveFactor??[0,0,0]).map(value=>value*gain),pbr.roughnessFactor]};
  }));
}
