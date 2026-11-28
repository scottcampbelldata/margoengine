import {cellCenter,hexDistance,hexLine,mapPixelSize} from '@margoengine/tilemap/hex';
import {findPath} from '@margoengine/tilemap/path';

const rows=[
  '..wffmmsgg.',
  '.wwfgmmmfg.',
  'wwwfgmmffgg',
  'wwgfpmfgfgg',
  'wwpppmpfgpg',
  'wppfgmpfppg',
  'wpgwppppgfg',
  'wwwwgffgpgg',
  '.wwwwwgggg.',
];
const dimensions={width:rows[0].length,height:rows.length,tileWidth:1,
  tileHeight:2/Math.sqrt(3),orientation:'hexagonal',staggerAxis:'y',staggerIndex:'odd',
  hexSideLength:1/Math.sqrt(3)};
export const grid=Object.freeze(dimensions);
export const [extentX,extentZ]=mapPixelSize(grid);
export const sites=Object.freeze({
  harbor:{cell:[1,6],name:'Harbor'},
  beacon:{cell:[3,4],name:'West Beacon'},
  summit:{cell:[9,3],name:'Observatory'},
});
export const start=sites.harbor.cell;
export const radius=3;
const elevations={w:.055,p:.145,g:.18,f:.232,m:.36,s:.395};
const traversal={w:Infinity,p:1,g:2,f:3,m:Infinity,s:Infinity};
const covers=new Set(['m','s']);
export const cells=rows.flatMap((row,y)=>Array.from(row,(kind,x)=>{
  if(kind==='.')return undefined;
  const [cx,cz]=cellCenter(grid,x,y);
  return {kind,coord:[x,y],key:x+','+y,x:cx-extentX/2,z:cz-extentZ/2,
    elevation:elevations[kind],cost:traversal[kind],opaque:covers.has(kind)};
}).filter(Boolean));
const address=new Map(cells.map(cell=>[cell.key,cell]));
const routeGrid={width:grid.width,height:grid.height,layout:grid,
  cost:Float64Array.from(rows.join(''),kind=>traversal[kind]??Infinity)};
export function tileAt([x,y]){return address.get(x+','+y);}
export function route(origin,goal){
  if(!tileAt(origin)||!tileAt(goal))return null;
  return findPath(routeGrid,origin,goal);
}
export function inSight(origin,tile,reach=radius){
  if(hexDistance(grid,origin,tile.coord)>reach)return false;
  return hexLine(grid,origin,tile.coord).slice(1,-1).every(coord=>{
    const previous=tileAt(coord);
    return previous&&!previous.opaque;
  });
}
export function reveal(origin,history){
  const visible=new Set();
  for(const tile of cells){
    if(!inSight(origin,tile))continue;
    visible.add(tile.key);
    history.add(tile.key);
  }
  return visible;
}
