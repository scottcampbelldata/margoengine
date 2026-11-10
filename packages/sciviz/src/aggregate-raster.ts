import type { AggregateGlyph } from './aggregate-types.js';

/** Shared coverage convention: point ownership, segment/pixel intersection, polygon pixel centres. */
export const rasterWGSL = `
fn pointBin(v:f32, size:u32)->i32 { return min(i32(size)-1,i32(floor(v))); }
fn covers(row:u32, x:u32,y:u32)->bool {
 let o=row*16u;let a=vec2f(bitcast<f32>(src[o]),bitcast<f32>(src[o+1u]));
 if((src[o+10u]&1u)==0u){return false;}
 if(p.glyph==0u){return a.x>=0.0&&a.y>=0.0&&a.x<=f32(p.width)&&a.y<=f32(p.height)&&pointBin(a.x,p.width)==i32(x)&&pointBin(a.y,p.height)==i32(y);}
 let b=vec2f(bitcast<f32>(src[o+2u]),bitcast<f32>(src[o+3u]));
 if(p.glyph==1u){
  let low=vec2f(f32(x),f32(y));let high=low+vec2f(1.0);let delta=b-a;var enter=0.0;var leave=1.0;
  for(var k=0u;k<2u;k++){if(delta[k]==0.0){if(a[k]<low[k]||a[k]>=high[k]){return false;}}
   else{let u=(low[k]-a[k])/delta[k];let v=(high[k]-a[k])/delta[k];enter=max(enter,min(u,v));leave=min(leave,max(u,v));}}
  return enter<=leave&&enter<=1.0&&leave>=0.0;
 }
 let centre=vec2f(f32(x)+0.5,f32(y)+0.5);var inside=false;
 let vertices=select(4u,3u,p.glyph==3u);var j=vertices-1u;
 for(var i=0u;i<vertices;i++){
  let v=vec2f(bitcast<f32>(src[o+i*2u]),bitcast<f32>(src[o+i*2u+1u]));
  let w=vec2f(bitcast<f32>(src[o+j*2u]),bitcast<f32>(src[o+j*2u+1u]));
  if((v.y>centre.y)!=(w.y>centre.y)) {let cross=v.x+(centre.y-v.y)/(w.y-v.y)*(w.x-v.x);if(centre.x<cross){inside=!inside;}}j=i;
 }
 return inside;
}`;

/** CPU reference uses the shader's f32 operations and the same half-open edge rules. */
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
