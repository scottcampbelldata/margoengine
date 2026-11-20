import { LIMBS, STATS } from './aggregate-exact.js';
import { rasterWGSL } from './aggregate-raster.js';

/** Most rows one invocation tests. A longer single invocation can be dropped (see the chunk plan in aggregate.ts). */
export const SLICE_ROWS = 512;

const less = `fn less(a:vec2u,b:vec2u)->bool{
 let ah=select(a.y^0x80000000u,~a.y,(a.y&0x80000000u)>0u);let bh=select(b.y^0x80000000u,~b.y,(b.y&0x80000000u)>0u);
 let al=select(a.x,~a.x,(a.y&0x80000000u)>0u);let bl=select(b.x,~b.x,(b.y&0x80000000u)>0u);
 return ah<bh||(ah==bh&&al<bl);
}`;

const head = (params: string, categories: number) => `struct Params{${params}};
@group(0) @binding(0) var<storage,read> src:array<u32>;
@group(0) @binding(1) var<storage,read_write> dst:array<u32>;
@group(0) @binding(2) var<uniform> p:Params;
${less}
const stride=${STATS + LIMBS * 2 + categories}u;`;

const state = (categories: number) =>
  `var positive:array<u32,${LIMBS}>;var negative:array<u32,${LIMBS}>;var cats:array<u32,${Math.max(1, categories)}>;
 var count=0u;var valid=0u;var low=vec2u(0u);var high=vec2u(0u);var first=vec2u(0u);var last=vec2u(0u);var firstRow=0xffffffffu;var lastRow=0xffffffffu;`;

const store = (categories: number) => `let out=id.x*stride;
 dst[out]=count;dst[out+1u]=valid;dst[out+2u]=low.x;dst[out+3u]=low.y;dst[out+4u]=high.x;dst[out+5u]=high.y;
 dst[out+6u]=first.x;dst[out+7u]=first.y;dst[out+8u]=last.x;dst[out+9u]=last.y;dst[out+10u]=firstRow;dst[out+11u]=lastRow;
 for(var j=0u;j<${LIMBS}u;j++){dst[out+${STATS}u+j]=positive[j];dst[out+${STATS + LIMBS}u+j]=negative[j];}
 ${categories ? `for(var j=0u;j<${categories}u;j++){dst[out+${STATS + LIMBS * 2}u+j]=cats[j];}` : ''}`;

/**
 * One owner per bin and row slice, integer superaccumulators, no float atomics or order races. Invocation
 * `slice * bins + bin` tests the slice's rows (at most `p.rows`) in row order and writes its record at that index.
 */
export function aggregateShader(categories: number): string {
  return `${head('count:u32,width:u32,height:u32,glyph:u32,rows:u32,slices:u32', categories)}
${rasterWGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let bins=p.width*p.height;let slice=id.x/bins;if(slice>=p.slices){return;}let bin=id.x%bins;let x=bin%p.width;let y=bin/p.width;
 ${state(categories)}
 let start=slice*p.rows;let end=min(p.count,start+p.rows);
 for(var row=start;row<end;row++){
  if(!covers(row,x,y)){continue;}let o=row*16u;count++;
  ${categories ? `let category=src[o+11u];if(category<${categories}u){cats[category]++;}` : ''}
  if((src[o+10u]&2u)==0u){continue;}let value=vec2u(src[o+8u],src[o+9u]);
  if(valid==0u){low=value;high=value;first=value;firstRow=src[o+12u];}else{if(less(value,low)){low=value;}if(less(high,value)){high=value;}}
  last=value;lastRow=src[o+12u];valid++;
  let exponent=(value.y>>20u)&2047u;let shift=select(0u,exponent-1u,exponent>0u);let base=shift/16u;let bits=shift%16u;
  let hi=(value.y&0xfffffu)|select(0u,0x100000u,exponent>0u);var carry=0u;
  for(var d=0u;d<4u;d++){
   var mantissa=0u;if(d==0u){mantissa=value.x&65535u;}if(d==1u){mantissa=value.x>>16u;}if(d==2u){mantissa=hi&65535u;}if(d==3u){mantissa=hi>>16u;}
   let digit=(mantissa<<bits)|carry;carry=digit>>16u;
   if((value.y&0x80000000u)==0u){positive[base+d]+=digit&65535u;}else{negative[base+d]+=digit&65535u;}
  }
  if((value.y&0x80000000u)==0u){positive[base+4u]+=carry;}else{negative[base+4u]+=carry;}
 }
 ${store(categories)}
}`;
}

/**
 * Folds each bin's slice records, in slice (so row) order, into one record: the same sums, counts, extremes and
 * first and last rows as one invocation testing every row of the chunk. Integer sums do not depend on the order.
 */
export function mergeShader(categories: number): string {
  return `${head('bins:u32,slices:u32', categories)}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=p.bins){return;}
 ${state(categories)}
 for(var s=0u;s<p.slices;s++){
  let o=(s*p.bins+id.x)*stride;count+=src[o];
  for(var j=0u;j<${LIMBS}u;j++){positive[j]+=src[o+${STATS}u+j];negative[j]+=src[o+${STATS + LIMBS}u+j];}
  ${categories ? `for(var j=0u;j<${categories}u;j++){cats[j]+=src[o+${STATS + LIMBS * 2}u+j];}` : ''}
  let v=src[o+1u];if(v==0u){continue;}
  let lo=vec2u(src[o+2u],src[o+3u]);let hi=vec2u(src[o+4u],src[o+5u]);
  if(valid==0u){low=lo;high=hi;first=vec2u(src[o+6u],src[o+7u]);firstRow=src[o+10u];}else{if(less(lo,low)){low=lo;}if(less(high,hi)){high=hi;}}
  last=vec2u(src[o+8u],src[o+9u]);lastRow=src[o+11u];valid+=v;
 }
 ${store(categories)}
}`;
}
