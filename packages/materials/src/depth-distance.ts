/** Private data-output specialization; beauty data bypasses lighting and colour transfer. */
export function depthDistanceShader(source: string, group: number, shading: 'depth' | 'distance'): string {
  const declarations = /* wgsl */ `
struct MargoDepthDistance {reference:vec4f,range:vec4f}
@group(${group}) @binding(196) var<uniform> margoDepthDistance:MargoDepthDistance;
// RGBA8 fixed point (README "RGBA packing"): q = floor(v*2^24) is split into bytes R (bits 23-16), G (15-8) and
// B (7-0); A holds the leftover fraction v*2^24 - q, rounded by the unorm write. Every step is exact in f32: scaling by
// a power of two, and floor and division by 256 or 65536 of integers below 2^24. v <= 0 and v >= 1 write all-0 / all-255.
fn margoPackDepth(value:f32)->vec4f {
  let scaled=clamp(value,0.0,1.0)*16777216.0;
  let q=floor(scaled);
  let high=floor(q/65536.0);
  let upper=floor(q/256.0);
  let bytes=vec3f(high,upper-high*256.0,q-upper*256.0);
  let packed=vec4f(bytes/255.0,scaled-q);
  return select(select(packed,vec4f(1.0),value>=1.0),vec4f(0.0),value<=0.0);
}
`;
  const value =
    shading === 'depth'
      ? 'clamp(1.0-i.clip.z,0.0,1.0)'
      : 'clamp((length(i.position-margoDepthDistance.reference.xyz)-margoDepthDistance.range.x)/(margoDepthDistance.range.y-margoDepthDistance.range.x),0.0,1.0)';
  let hooks = 0;
  const code = source
    .replace(/@fragment fn fragment\([^{]*\{\s*let s=surface\(i,front\);/, (head) => {
      hooks++;
      return `${head}
  if(f.coordsB.w<0.5){
  let matDepthValue=${value};
  if(margoDepthDistance.range.z>0.5){return margoPackDepth(matDepthValue);}
  let matDepthAlpha=select(1.0,s.base.a,f.settings.x>1.5);
  return vec4f(vec3f(${shading === 'depth' ? '1.0-matDepthValue' : 'matDepthValue'}),matDepthAlpha);
  }
`;
    })
    .replace('fn surface(i:Out,front:bool)->Surface {', (head) => {
      hooks++;
      // G-buffer and ambient entries retain the same local bind-group layout.
      return head + '\n  _=&margoDepthDistance;';
    });
  if (hooks !== 2) throw new Error('Depth and distance materials require the gltf-pro PBR shader');
  return declarations + code;
}
