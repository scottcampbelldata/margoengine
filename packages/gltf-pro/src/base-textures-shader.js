export const packedBaseWGSL = `
struct MargoBaseInfo {rows:array<vec4f,10>}
@group(1) @binding(0) var margoBaseMaps:texture_2d_array<f32>;
@group(1) @binding(1) var<uniform> margoBaseInfo:MargoBaseInfo;
fn margoBaseWrap(x:i32,n:i32,mode:f32)->i32 {
  if(mode<0.5){return clamp(x,0,n-1);}
  if(mode<1.5){return ((x%n)+n)%n;}
  let k=((x%(2*n))+2*n)%(2*n); return min(k,2*n-1-k);
}
fn margoBaseTexel(slot:i32,p:vec2i,level:i32)->vec4f {
  let a=margoBaseInfo.rows[slot*2];let b=margoBaseInfo.rows[slot*2+1];
  let size=max(vec2i(a.xy)>>vec2u(u32(level)),vec2i(1));
  return textureLoad(margoBaseMaps,vec2i(margoBaseWrap(p.x,size.x,b.z),margoBaseWrap(p.y,size.y,b.w)),slot,level);
}
fn margoBaseCoord(v:f32,mode:f32)->f32 {
  if(mode<0.5){return clamp(v,0.0,1.0);}
  if(mode<1.5){return fract(v);}
  let x=fract(v*0.5)*2.0; return min(x,2.0-x);
}
fn margoBaseLevel(slot:i32,uv:vec2f,level:i32,linear:bool)->vec4f {
  let wrap=margoBaseInfo.rows[slot*2+1].zw;
  let at=vec2f(margoBaseCoord(uv.x,wrap.x),margoBaseCoord(uv.y,wrap.y));
  let size=max(vec2i(margoBaseInfo.rows[slot*2].xy)>>vec2u(u32(level)),vec2i(1));
  if(!linear){return margoBaseTexel(slot,vec2i(floor(at*vec2f(size))),level);}
  let p=at*vec2f(size)-0.5;let lo=vec2i(floor(p));let f=fract(p);
  return mix(mix(margoBaseTexel(slot,lo,level),margoBaseTexel(slot,lo+vec2i(1,0),level),f.x),
    mix(margoBaseTexel(slot,lo+vec2i(0,1),level),margoBaseTexel(slot,lo+vec2i(1,1),level),f.x),f.y);
}
fn margoBaseSample(slot:i32,at:vec2f)->vec4f {
  let a=margoBaseInfo.rows[slot*2];let b=margoBaseInfo.rows[slot*2+1];
  let dx=dpdx(at)*a.xy;let dy=dpdy(at)*a.xy;let lod=log2(max(max(length(dx),length(dy)),0.000001));
  let linear=select(b.x>0.5,a.w>0.5,lod<=0.0||b.y>1.5);
  let l=select(clamp(lod,0.0,a.z-1.0),0.0,b.y>1.5);
  if(b.y<0.5){return margoBaseLevel(slot,at,i32(floor(l+0.5)),linear);}
  let lo=i32(floor(l));let hi=min(lo+1,i32(a.z)-1);
  return mix(margoBaseLevel(slot,at,lo,linear),margoBaseLevel(slot,at,hi,linear),fract(l));
}
`;

export function packBaseShader(code) {
  const names = ['base', 'mr', 'normal', 'ao', 'emissive'];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    code = code
      .replace(`@group(1) @binding(${i * 2}) var ${name}Map:texture_2d<f32>;`, '')
      .replace(`@group(1) @binding(${i * 2 + 1}) var ${name}Sampler:sampler;`, '')
      .replaceAll(`textureSample(${name}Map,${name}Sampler,`, `margoBaseSample(${i},`);
  }
  return packedBaseWGSL + code;
}
