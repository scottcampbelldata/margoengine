import type { AggregateGlyph } from './aggregate-types.js';

/**
 * Binary32 arithmetic in u32 integer operations, rounding to nearest even. WGSL leaves f32 rounding direction,
 * fused multiply-add, reassociation, subnormal flushing and a 2.5 ULP division to the GPU, so coverage decided in
 * hardware f32 can differ from the CPU reference by one ULP at a pixel centre that lies on an edge. These match
 * IEEE 754 binary32 (and JavaScript's Math.fround of a float64 result) for every input, NaN and infinity included.
 */
const binary32WGSL = `
fn fnan(a:u32)->bool{return (a&0x7fffffffu)>0x7f800000u;}
fn finf(a:u32)->bool{return (a&0x7fffffffu)==0x7f800000u;}
fn fzero(a:u32)->bool{return (a&0x7fffffffu)==0u;}
fn fsig(a:u32)->u32{return (a&0x7fffffu)|select(0u,0x800000u,((a>>23u)&255u)>0u);}
fn fexp(a:u32)->i32{return i32(max((a>>23u)&255u,1u))-150;}
fn fpack(s:u32,m:u32,e:i32,sticky:bool)->u32{
 let top=31-i32(countLeadingZeros(m));let lsb=max(e+top-23,-149);let shift=lsb-e;var q=0u;
 if(shift<=0){q=m<<u32(-shift);}else if(shift<=32){
  let sh=u32(shift);q=select(m>>sh,0u,sh==32u);let rem=select(m&((1u<<sh)-1u),m,sh==32u);let half=1u<<(sh-1u);
  if(rem>half||(rem==half&&(sticky||(q&1u)==1u))){q+=1u;}
 }
 var biased=lsb+150;if(q==0x1000000u){q=0x800000u;biased+=1;}
 if(q<0x800000u){return s|q;}
 if(biased>=255){return s|0x7f800000u;}
 return s|(u32(biased)<<23u)|(q&0x7fffffu);
}
fn fadd(a:u32,b:u32)->u32{
 if(fnan(a)||fnan(b)){return 0x7fc00000u;}
 if(finf(a)){if(finf(b)&&((a^b)>>31u)==1u){return 0x7fc00000u;}return a;}
 if(finf(b)){return b;}
 if(fzero(a)){if(fzero(b)){return a&b;}return b;}
 if(fzero(b)){return a;}
 var ea=fexp(a);var eb=fexp(b);var ma=fsig(a);var mb=fsig(b);var sa=a&0x80000000u;var sb=b&0x80000000u;
 if(ea<eb){let e=ea;ea=eb;eb=e;let m=ma;ma=mb;mb=m;let s=sa;sa=sb;sb=s;}
 let d=u32(ea-eb);
 if(d<=6u){
  let big=ma<<d;
  if(sa==sb){return fpack(sa,big+mb,eb,false);}
  if(big==mb){return 0u;}
  if(big>mb){return fpack(sa,big-mb,eb,false);}
  return fpack(sb,mb-big,eb,false);
 }
 let big=ma<<6u;let k=d-6u;var small=0u;var sticky=mb!=0u;
 if(k<32u){small=mb>>k;sticky=(mb&((1u<<k)-1u))!=0u;}
 if(sa==sb){return fpack(sa,big+small,ea-6,sticky);}
 return fpack(sa,big-small-select(0u,1u,sticky),ea-6,sticky);
}
fn fsub(a:u32,b:u32)->u32{return fadd(a,b^0x80000000u);}
fn fmul(a:u32,b:u32)->u32{
 let s=(a^b)&0x80000000u;
 if(fnan(a)||fnan(b)){return 0x7fc00000u;}
 if(finf(a)||finf(b)){if(fzero(a)||fzero(b)){return 0x7fc00000u;}return s|0x7f800000u;}
 if(fzero(a)||fzero(b)){return s;}
 let x=fsig(a);let y=fsig(b);let e=fexp(a)+fexp(b);
 let ll=(x&65535u)*(y&65535u);let mid=(x&65535u)*(y>>16u)+(x>>16u)*(y&65535u);
 let lo=ll+(mid<<16u);let hi=(x>>16u)*(y>>16u)+(mid>>16u)+select(0u,1u,lo<ll);
 if(hi==0u){return fpack(s,lo,e,false);}
 let k=32u-countLeadingZeros(hi);
 return fpack(s,(hi<<(32u-k))|(lo>>k),e+i32(k),(lo&((1u<<k)-1u))!=0u);
}
fn fdiv(a:u32,b:u32)->u32{
 let s=(a^b)&0x80000000u;
 if(fnan(a)||fnan(b)||(finf(a)&&finf(b))||(fzero(a)&&fzero(b))){return 0x7fc00000u;}
 if(finf(a)||fzero(b)){return s|0x7f800000u;}
 if(finf(b)||fzero(a)){return s;}
 let na=countLeadingZeros(fsig(a))-8u;let nb=countLeadingZeros(fsig(b))-8u;
 let mb=fsig(b)<<nb;var r=fsig(a)<<na;var q=0u;
 if(r>=mb){q=1u;r-=mb;}
 for(var i=0u;i<31u;i++){r=r<<1u;q=q<<1u;if(r>=mb){q|=1u;r-=mb;}}
 return fpack(s,q,fexp(a)-i32(na)-fexp(b)+i32(nb)-31,r!=0u);
}
fn fkey(a:u32)->u32{if(fzero(a)){return 0x80000000u;}return select(a|0x80000000u,~a,(a>>31u)==1u);}
fn flt(a:u32,b:u32)->bool{return !fnan(a)&&!fnan(b)&&fkey(a)<fkey(b);}
fn fmin(a:u32,b:u32)->u32{return select(a,b,flt(b,a));}
fn fmax(a:u32,b:u32)->u32{return select(a,b,flt(a,b));}`;

/** Shared coverage convention: point ownership, segment/pixel intersection, polygon pixel centres. */
export const rasterWGSL = `${binary32WGSL}
fn pointBin(v:f32, size:u32)->i32 { return min(i32(size)-1,i32(floor(v))); }
fn covers(row:u32, x:u32,y:u32)->bool {
 let o=row*16u;let a=vec2f(bitcast<f32>(src[o]),bitcast<f32>(src[o+1u]));
 if((src[o+10u]&1u)==0u){return false;}
 if(p.glyph==0u){return a.x>=0.0&&a.y>=0.0&&a.x<=f32(p.width)&&a.y<=f32(p.height)&&pointBin(a.x,p.width)==i32(x)&&pointBin(a.y,p.height)==i32(y);}
 if(p.glyph==1u){
  var enter=0u;var leave=0x3f800000u;
  for(var k=0u;k<2u;k++){
   let start=src[o+k];let delta=fsub(src[o+2u+k],start);let cell=select(x,y,k==1u);
   let low=bitcast<u32>(f32(cell));let high=bitcast<u32>(f32(cell+1u));
   if(fzero(delta)){if(flt(start,low)||!flt(start,high)){return false;}}
   else{let u=fdiv(fsub(low,start),delta);let v=fdiv(fsub(high,start),delta);enter=fmax(enter,fmin(u,v));leave=fmin(leave,fmax(u,v));}
  }
  return !flt(leave,enter)&&!flt(0x3f800000u,enter)&&!flt(leave,0u);
 }
 let cx=bitcast<u32>(f32(x)+0.5);let cy=bitcast<u32>(f32(y)+0.5);var inside=false;
 let vertices=select(4u,3u,p.glyph==3u);var j=vertices-1u;
 for(var i=0u;i<vertices;i++){
  let vx=src[o+i*2u];let vy=src[o+i*2u+1u];let wx=src[o+j*2u];let wy=src[o+j*2u+1u];
  if(flt(cy,vy)!=flt(cy,wy)){if(flt(cx,fadd(vx,fmul(fdiv(fsub(cy,vy),fsub(wy,vy)),fsub(wx,vx))))){inside=!inside;}}
  j=i;
 }
 return inside;
}`;

/** CPU reference: IEEE 754 binary32 operations (Math.fround of each float64 step) and the shader's half-open edge rules. */
export function covers(
  src: Uint32Array,
  floats: Float32Array,
  row: number,
  x: number,
  y: number,
  width: number,
  height: number,
  glyph: AggregateGlyph,
): boolean {
  const o = row * 16,
    ax = floats[o],
    ay = floats[o + 1],
    f = Math.fround;
  if (!(src[o + 10] & 1)) return false;
  if (glyph === 'points')
    return (
      ax >= 0 &&
      ay >= 0 &&
      ax <= width &&
      ay <= height &&
      Math.min(width - 1, Math.floor(ax)) === x &&
      Math.min(height - 1, Math.floor(ay)) === y
    );
  if (glyph === 'lines') {
    let enter = 0,
      leave = 1;
    for (let k = 0; k < 2; k++) {
      const a = floats[o + k],
        delta = f(floats[o + 2 + k] - a),
        low = k ? y : x,
        high = low + 1;
      if (delta === 0) {
        if (a < low || a >= high) return false;
      } else {
        const u = f(f(low - a) / delta),
          v = f(f(high - a) / delta);
        enter = Math.max(enter, Math.min(u, v));
        leave = Math.min(leave, Math.max(u, v));
      }
    }
    return enter <= leave && enter <= 1 && leave >= 0;
  }
  const n = glyph === 'triangles' ? 3 : 4;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vx = floats[o + i * 2],
      vy = floats[o + i * 2 + 1],
      wx = floats[o + j * 2],
      wy = floats[o + j * 2 + 1];
    if (vy > y + 0.5 !== wy > y + 0.5) {
      const cross = f(vx + f(f(f(y + 0.5 - vy) / f(wy - vy)) * f(wx - vx)));
      if (x + 0.5 < cross) inside = !inside;
    }
  }
  return inside;
}
