import {geometryData, type GeometryData, type GeometryGroup} from './data.js';

/** Alternating tile UV treatments. Tile alternates both columns and rows; row alternates entire rows. */
export type TilePattern='none'|'flip-tile'|'rotate-tile'|'flip-row'|'rotate-row'|'flip-rotate-tile'|'flip-rotate-row';
/** Tiled plane controls. Partial edge tiles preserve texture scale instead of stretching. */
export interface TiledPlaneOptions {
  width?: number;
  height?: number;
  tileSize?: number;
  tileWidth?: number;
  tileHeight?: number;
  /** Default center. Full tiles align to the specified edge, or partials split between both edges. */
  alignHorizontal?: 'left'|'center'|'right';
  /** Default center. */
  alignVertical?: 'bottom'|'center'|'top';
  /** Default none. */
  pattern?: TilePattern;
  /** Default front; back reverses winding/normals, double duplicates vertices for the other side. */
  side?: 'front'|'back'|'double';
  /** UV rectangle [u0,v0,u1,v1], default [0,0,1,1]. */
  frontUVs?: readonly [number,number,number,number];
  backUVs?: readonly [number,number,number,number];
}
/** A tiled box shares plane options on all faces; faceOptions overrides each face (+x,-x,+y,-y,+z,-z). */
export interface TiledBoxOptions extends TiledPlaneOptions {
  depth?: number;
  faceOptions?: readonly TiledPlaneOptions[];
}
function positive(x:number):void {if(!(x>0&&Number.isFinite(x)))throw new RangeError('Invalid tile or face size; pass finite positive dimensions');}
function intervals(size:number,tile:number,align:string):number[][] {
  positive(size);positive(tile);
  const full=Math.floor(size/tile),rest=size-full*tile,endAligned=align==='right'||align==='top',out:number[][]=[];
  if(!full){const a=align==='center'?(1-size/tile)/2:endAligned?1-size/tile:0;return [[-size/2,size/2,a,a+size/tile,0]];}
  const origin=rest===0||align==='left'||align==='bottom'?0:align==='center'?rest/2-tile:rest-tile;
  for(let k=0;k<=Math.ceil(size/tile)+1;k++) {
    const start=origin+k*tile,end=start+tile,a=Math.max(0,start),b=Math.min(size,end);
    if(b>a)out.push([a-size/2,b-size/2,(a-start)/tile,(b-start)/tile,k]);
  }
  return out;
}
/** Plane in XY facing +z with independent UVs per tile, seven patterns, three alignments and separately mapped sides. */
export function tiledPlaneGeometry(options:TiledPlaneOptions={}):GeometryData {
  const {width=1,height=1,tileSize=1,tileWidth=tileSize,tileHeight=tileSize,alignHorizontal='center',alignVertical='center',pattern='none',side='front',frontUVs=[0,0,1,1],backUVs=[0,0,1,1]}=options;
  if(!['left','center','right'].includes(alignHorizontal)||!['bottom','center','top'].includes(alignVertical)||!['front','back','double'].includes(side)||!['none','flip-tile','rotate-tile','flip-row','rotate-row','flip-rotate-tile','flip-rotate-row'].includes(pattern))
    throw new RangeError('Invalid tile layout; use a documented alignment, side and pattern');
  for(const rect of [frontUVs,backUVs])if(rect.length!==4||!rect.every(Number.isFinite))throw new RangeError('Invalid UV rectangle; pass four finite coordinates');
  const columns=intervals(width,tileWidth,alignHorizontal),rows=intervals(height,tileHeight,alignVertical),p:number[]=[],n:number[]=[],uv:number[]=[],ix:number[]=[];
  for(const back of side==='double'?[false,true]:[side==='back'])for(const [y0,y1,v0,v1,row] of rows)for(const [x0,x1,u0,u1,column]of columns) {
    const base=p.length/3,rect=back?backUVs:frontUVs,odd=(pattern.endsWith('row')?row:row+column)%2===1;
    p.push(x0,y0,0,x1,y0,0,x1,y1,0,x0,y1,0);
    for(let i=0;i<4;i++)n.push(0,0,back?-1:1);
    for(let [u,v] of [[u0,v0],[u1,v0],[u1,v1],[u0,v1]]) {
      if(odd){if(pattern.startsWith('flip'))u=1-u;if(pattern.startsWith('rotate')||pattern.startsWith('flip-rotate')){u=1-u;v=1-v;}}
      uv.push(rect[0]+u*(rect[2]-rect[0]),rect[1]+v*(rect[3]-rect[1]));
    }
    ix.push(...(back?[base,base+2,base+1,base,base+3,base+2]:[base,base+1,base+2,base,base+2,base+3]));
  }
  return geometryData(p,n,uv,ix);
}

/** Six independent tiled faces with face material groups and per-face layout/UV overrides. */
export function tiledBoxGeometry(options:TiledBoxOptions={}):GeometryData {
  const {width=1,height=1,depth=1}=options,size=[width,height,depth];size.forEach(positive);
  const p:number[]=[],n:number[]=[],uv:number[]=[],ix:number[]=[],groups:GeometryGroup[]=[];
  const frames=[[0,1,2,-1,1,1],[0,-1,2,1,1,1],[1,1,0,1,2,-1],[1,-1,0,1,2,1],[2,1,0,1,1,1],[2,-1,0,-1,1,1]];
  frames.forEach(([axis,sign,ua,us,va,vs],face)=>{
    const data=tiledPlaneGeometry({...options,...options.faceOptions?.[face],width:size[ua],height:size[va]}),base=p.length/3,start=ix.length;
    for(let i=0;i<data.positions.length;i+=3){const a=[0,0,0],b=[0,0,0];a[axis]=sign*size[axis]/2;a[ua]=data.positions[i]*us;a[va]=data.positions[i+1]*vs;b[axis]=data.normals[i+2]*sign;p.push(...a);n.push(...b);}
    uv.push(...data.uvs);ix.push(...Array.from(data.indices,k=>base+k));groups.push({start,count:ix.length-start,materialIndex:face});
  });
  return geometryData(p,n,uv,ix,groups);
}
