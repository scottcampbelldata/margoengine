// One scalar lookup contract for surfaces, meshes, LIC, graph nodes, volumes and slices.
import { SRGBToLinear } from '@margoengine/math/color';
import type { Colormap } from './colormaps.js';

/** @internal Extended float table: source ramp, scale metadata, bin edges, bin colours. */
export function colorTextureData(map: Colormap, opacity?: Uint8Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(256 * 4 * 4),
    e = map.encoding!;
  const base = map.unscaled().table(256, { linear: true });
  out.set(base);
  if (opacity) for (let i = 0; i < 256; i++) out[i * 4 + 3] = opacity[i * 4 + 3] / 255;
  const row = 256 * 4;
  [e.under, e.over, e.nan].forEach((c, i) => out.set([...c.map(SRGBToLinear), 1], row + i * 4));
  out.set([['linear', 'log', 'symlog'].indexOf(e.scale), ...e.domain, e.constant], row + 12);
  out.set([e.colors.length, map.kind === 'cyclic' ? 1 : 0, 0, 0], row + 16);
  e.edges.slice(1, -1).forEach((v, i) => {
    out[row * 2 + i * 4] = v;
  });
  e.colors.forEach((c, i) =>
    out.set(
      [
        ...c.map(SRGBToLinear),
        opacity ? opacity[Math.round((e.edges[i] + e.edges[i + 1]) * 0.5 * 255) * 4 + 3] / 255 : 1,
      ],
      row * 3 + i * 4,
    ),
  );
  return out;
}

/** @internal Manual filtering also accepts baseline sRGB8 tables without needing float32-filterable. */
export const colorLookupWGSL = /* wgsl */ `
fn colourTransform(v:f32, kind:f32, c:f32)->f32 {
  if(kind>1.5){return sign(v)*log(1.0+abs(v)/c);}
  if(kind>0.5){return log(v);}
  return v;
}
fn colourLookup(table:texture_2d<f32>, value:f32)->vec4f {
  let dims=textureDimensions(table);
  var t=value;
  if(dims.y==4u) {
    if((bitcast<u32>(t)&0x7fffffffu)>0x7f800000u){return textureLoad(table,vec2i(2,1),0);}
    if(t<0.0){return textureLoad(table,vec2i(0,1),0);}
    if(t>1.0){return textureLoad(table,vec2i(1,1),0);}
    let p=textureLoad(table,vec2i(3,1),0);
    let low=colourTransform(p.y,p.x,p.w); let high=colourTransform(p.z,p.x,p.w);
    t=(colourTransform(p.y+t*(p.z-p.y),p.x,p.w)-low)/(high-low);
    let options=textureLoad(table,vec2i(4,1),0);
    let count=i32(options.x);
    if(count>0){
      var i=0;
      for(var j=0;j<255;j++){
        if(j>=count-1){break;}
        if(t<textureLoad(table,vec2i(j,2),0).r){break;}
        i++;
      }
      return textureLoad(table,vec2i(i,3),0);
    }
    if(options.y>0.5){t=fract(t);}
  }
  if((bitcast<u32>(t)&0x7fffffffu)>0x7f800000u){t=0.0;}
  var x=clamp(t*f32(dims.x)-0.5,0.0,f32(dims.x-1u));
  if(dims.y==4u){x=clamp(t,0.0,1.0)*f32(dims.x-1u);}
  let i=i32(floor(x)); let f=fract(x);
  return mix(textureLoad(table,vec2i(i,0),0),textureLoad(table,vec2i(min(i+1,i32(dims.x)-1),0),0),f);
}
`;
