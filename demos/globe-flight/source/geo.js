import {cartographicToEcef, ecefToCartographic, ecefToEnu, degToRad, WGS84_A, WGS84_B} from '@margoengine/math/geo';

import georef from './tools/georeference.json';
export const frames=Object.fromEntries(Object.entries(georef).map(([name,grid])=>[name,{
  ...grid,west:degToRad(grid.west),north:degToRad(grid.north),width:degToRad(grid.width),height:degToRad(grid.height)
}]));
export const globeRadii=[WGS84_A,WGS84_B,WGS84_A];
const view=(longitude,latitude,height,heading,pitch,range)=>({
  longitude:degToRad(longitude),latitude:degToRad(latitude),height,heading:degToRad(heading),pitch:degToRad(pitch),range
});
export const views={
  orbit:view(-137,28,0,2,89,15.75e6),
  island:view(-155.58,19.51,1800,16,77,215000),
  summit:view(-155.46815,19.82061,4205,28,45,4050),
};
export const earthToWorld=([x,y,z])=>[x,z,-y];
export const worldToEarth=([x,y,z])=>[x,-z,y];
export const at=(lon,lat,height=0)=>earthToWorld(cartographicToEcef(lon,lat,height));
export const fromWorld=p=>ecefToCartographic(...worldToEarth(p));
export const anchors=Object.fromEntries(Object.entries(frames).map(([name,frame])=>[name,at(frame.west+frame.width*.5,frame.north-frame.height*.5)]));

export function uvOnFrame(frame,lon,lat){
  const u=(lon-frame.west)/frame.width,v=(frame.north-lat)/frame.height;
  const size=frame.pixels;
  return [(u*(size-1)+.5)/size,(v*(size-1)+.5)/size];
}
const sub=frames.summit;
const margin=.00043;
export const detailMask=[...uvOnFrame(frames.island,sub.west,sub.north).map(value=>value+margin),
  ...uvOnFrame(frames.island,sub.west+sub.width,sub.north-sub.height).map(value=>value-margin)];

export function eyeAsView(point,eye){
  const target=fromWorld(point);
  const offset=ecefToEnu(target,...worldToEarth(eye));
  const groundRange=Math.hypot(offset[0],offset[1]);
  return {...target,heading:Math.atan2(-offset[0],-offset[1]),pitch:Math.atan2(offset[2],groundRange),range:Math.hypot(...offset)};
}

export function terrainHeight(heights,frame,lon,lat){
  if(!heights)return undefined;
  const rows=frame.samples;
  const x=(lon-frame.west)/frame.width*(rows-1);
  const y=(frame.north-lat)/frame.height*(rows-1);
  if(x<0||x>rows-1||y<0||y>rows-1)return undefined;
  const left=Math.min(rows-2,Math.floor(x));
  const top=Math.min(rows-2,Math.floor(y));
  const fx=x-left,fy=y-top,i=top*rows+left;
  return (heights[i]*(1-fx)+heights[i+1]*fx)*(1-fy)+
    (heights[i+rows]*(1-fx)+heights[i+rows+1]*fx)*fy;
}

function surface(columns,height,sample,terrain){
  const positions=new Float32Array(columns*height*3);
  const normals=new Float32Array(positions.length);
  const uvs=new Float32Array(columns*height*2);
  const indices=new Uint32Array((columns-1)*(height-1)*6);
  const center=terrain?.anchor??[0,0,0];
  const pixels=terrain?.pixelSize??1;
  let t=0;
  for(let y=0;y<height;y++){
    for(let x=0;x<columns;x++){
      const u=x/(columns-1),v=y/(height-1);
      const [lon,lat,z]=sample(u,v,x,y);
      const p=at(lon,lat,z);
      const i=y*columns+x;
      positions.set(p.map((value,axis)=>value-center[axis]),i*3);
      normals.set([Math.cos(lat)*Math.cos(lon),Math.sin(lat),-Math.cos(lat)*Math.sin(lon)],i*3);
      uvs.set(terrain?[(u*(pixels-1)+.5)/pixels,(v*(pixels-1)+.5)/pixels]:[u,v],i*2);
      if(x+1===columns||y+1===height)continue;
      indices.set([i,i+columns+1,i+1,i,i+columns,i+columns+1],t);
      t+=6;
    }
  }
  if(terrain){
    for(let y=0;y<height;y++)for(let x=0;x<columns;x++){
      const a=(y*columns+Math.max(0,x-1))*3,b=(y*columns+Math.min(columns-1,x+1))*3;
      const c=(Math.max(0,y-1)*columns+x)*3,d=(Math.min(height-1,y+1)*columns+x)*3;
      const ex=positions[b]-positions[a],ey=positions[b+1]-positions[a+1],ez=positions[b+2]-positions[a+2];
      const sx=positions[d]-positions[c],sy=positions[d+1]-positions[c+1],sz=positions[d+2]-positions[c+2];
      const nx=sy*ez-sz*ey,ny=sz*ex-sx*ez,nz=sx*ey-sy*ex;
      const size=Math.hypot(nx,ny,nz);
      normals.set([nx/size,ny/size,nz/size],(y*columns+x)*3);
    }
  }
  return {positions,normals,uvs,indices};
}

export const makeEarth=()=>surface(145,73,(u,v)=>[(u-.5)*Math.PI*2,(.5-v)*Math.PI,0]);
export function makeTerrain(name,heights){
  const frame=frames[name],samples=frame.samples;
  return surface(samples,samples,(u,v,x,y)=>[
    frame.west+u*frame.width,frame.north-v*frame.height,heights[y*samples+x]+1.85
  ],{anchor:anchors[name],pixelSize:frame.pixels});
}
