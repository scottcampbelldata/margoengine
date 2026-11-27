import {ConstrainedWFC} from '@margoengine/wfc/constraints';
import {createDungeonGenerator} from '@margoengine/procedural/dungeon';
import {width,depth,entrance,sanctuary,cardinal} from './grid.js';
const layers=[[0,1,2,3,4,5],[6,7,8,9]];
const lowerToUpper=[[9],[6,7],[7,8],[7,8],[8],[8]];
const weights=[3.2,5.5,1.8,1.2,.24,.24,2.0,1.9,1.4,2.0];
const tiles=weights.map((weight,id)=>{
  const upper=id>=6,onLayer=layers[Number(upper)];
  const up=upper?[]:lowerToUpper[id],down=upper?layers[0].filter(k=>lowerToUpper[k].includes(id)):[];
  return {weight,neighbors:[onLayer,onLayer,up,down,onLayer,onLayer]};
});
const accessible=[1,2,3,4,5];
const engine=new ConstrainedWFC([width,2,depth],tiles,{
  connected:accessible,
  paths:[{from:[entrance[0],0,entrance[1]],to:[sanctuary[0],0,sanctuary[1]],tiles:accessible}],
  counts:[{tiles:accessible,min:49,max:76},{tiles:[4],min:1,max:1},{tiles:[5],min:1,max:1}]
});
const edge=[];
for(let z=0;z<depth;z++)for(let x=0;x<width;x++)if(!x||!z||x===width-1||z===depth-1)edge.push({position:[x,0,z],tile:0});
const fixed=new Map();
const key=(x,z)=>z*width+x;
function pickPlan(bsp,seed){
  const proposal=bsp.generate({width,height:depth,seed,minRoomSize:3,maxRooms:6});
  fixed.clear();
  const put=(x,z,t)=>fixed.set(key(x,z),{position:[x,0,z],tile:t});
  for(const p of edge)put(p.position[0],p.position[2],p.tile);
  for(const [n,r] of proposal.rooms.entries()){
    const x=r.x+Math.floor(r.width/2),z=r.y+Math.floor(r.height/2);
    put(x,z,n%2?2:3);
  }
  for(const [x,z] of [[1,2],[2,1],[3,2],[1,3],[2,3],[3,3],[2,4]] )put(x,z,1);
  const [sx,sz]=sanctuary;
  for(const [dx,dz] of cardinal)put(sx+dx,sz+dz,2);
  put(...entrance,4);put(...sanctuary,5);
  return [...fixed.values()];
}
export function solveGallery(bsp,seed){
  const pins=pickPlan(bsp,seed);
  const solved=engine.solve({seed,pins,backtracks:2300,attempts:4});
  return {seed,solved,pins:pins.length,decisions:engine.stats.decisions,backtracks:engine.stats.backtracks};
}
export const createBase=(signal)=>createDungeonGenerator({signal});
