import {TiledNavMesh} from '@margoengine/navmesh/tiles';
import {limits,cell,tileCells,origin,floor,triangles,fixed,gates,obstacle} from './layout.js';

export const tileKey=(x,z)=>x+','+z;
export function tileState(world){
  return new Map(Array.from(world.tileList(),({x,z,mesh})=>[tileKey(x,z),{x,z,mesh}]));
}
export function build(){
  const world=new TiledNavMesh(floor,triangles,{
    origin,cs:cell,ch:.025,tileSize:tileCells,walkableRadius:2,walkableHeight:6,walkableClimb:0,
    maxSimplificationError:.6,maxEdgeLen:18,obstacles:fixed.map(obstacle),deferred:true,
  });
  const moving=gates.map(gate=>({
    gate,id:world.addObstacle(obstacle({...gate,z:gate.stops[gate.initial]})),
    z:gate.stops[gate.initial],index:gate.initial,
  }));
  const constructed=world.update();
  return {world,moving,constructed};
}
export function tileRect(x,z,span){
  const x0=origin[0]+x*span,z0=origin[2]+z*span;
  return [x0,z0,Math.min(x0+span,limits.right),Math.min(z0+span,limits.front)];
}
export function routeLength(points){
  let total=0;
  for(let i=1;i<points.length;i++)total+=Math.hypot(points[i][0]-points[i-1][0],points[i][2]-points[i-1][2]);
  return total;
}
export function move(world,entry,z){
  if(!world.moveObstacle(entry.id,obstacle({...entry.gate,z})))throw new Error('The moving wall has no navigation obstacle.');
  entry.z=z;
}
