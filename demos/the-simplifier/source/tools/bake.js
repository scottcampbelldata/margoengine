import { Engine, Geometry } from '@margoengine/core';
import { LODSystem } from '@margoengine/lod';
import { autoLOD } from '@margoengine/lod/auto';
import { simplifyMesh } from '@margoengine/mesh-edit/modeling';
import { remeshMesh } from '@margoengine/mesh-edit/remesh';
import { carve } from './sculpture.js';

function originalMesh() {
  const scan=carve();
  const faces=[];
  for(let i=0;i<scan.triangles.length;i+=3) {
    const vertices=scan.triangles.slice(i,i+3);
    faces.push({id:`stone-${i/3}`,vertices,uv:vertices.map(id=>[
      (scan.vertices[id][0]+.75)/1.5,(scan.vertices[id][1]+.10)/2,
    ])});
  }
  const prepared=remeshMesh({vertices:scan.vertices,faces}, {
    targetLength:.030,iterations:1,preserveSeams:false,
  });
  const mesh=simplifyMesh(prepared.mesh,{targetTriangles:12500,mergeCoplanar:false}).mesh;
  const positions=mesh.vertices.flat(), indices=mesh.faces.flatMap(face=>face.vertices);
  const normals=new Float32Array(positions.length);
  for(let offset=0;offset<indices.length;offset+=3) {
    const [a,b,c]=indices.slice(offset,offset+3).map(index=>mesh.vertices[index]);
    const u=b.map((part,index)=>part-a[index]);
    const v=c.map((part,index)=>part-a[index]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    for(let corner=0;corner<3;corner++)for(let axis=0;axis<3;axis++) normals[3*indices[offset+corner]+axis]+=n[axis];
  }
  for(let i=0;i<normals.length;i+=3) {
    const size=Math.hypot(normals[i],normals[i+1],normals[i+2])||1;
    for(let axis=0;axis<3;axis++)normals[i+axis]/=size;
  }
  return {geometry:new Geometry(positions,normals,indices),carved:faces.length};
}

function weld(geometry) {
  const positions=[], indices=[], unique=new Map();
  for(const index of geometry.indices) {
    const start=index*6;
    const point=geometry.vertices.subarray(start,start+3);
    const key=point.join('/');
    if(!unique.has(key)) {
      unique.set(key,positions.length/3);
      positions.push(...point);
    }
    indices.push(unique.get(key));
  }
  return {positions,indices};
}

let engine;
try {
  engine=await Engine.create(document.querySelector('canvas'),{backend:'webgpu',exactSize:true});
  const {geometry,carved}=originalMesh();
  const statue=engine.createMesh().setGeometry(geometry);
  const system=LODSystem.attach(engine);
  const lod=await autoLOD(system,statue,{
    ratios:[.55,.24,.10,.035],screens:[.61,.44,.32,.23],crease:72,
  });
  globalThis.result={carved,levels:lod.levels.map(level=>weld(level.object))};
}catch(error) {
  globalThis.result={error:error.stack??String(error)};
}finally {engine?.dispose();}
