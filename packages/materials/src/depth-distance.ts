/** Private data-output specialization; beauty data bypasses lighting and colour transfer. */
export function depthDistanceShader(source: string, group: number, shading: 'depth' | 'distance'): string {
  const declarations = /* wgsl */ `
struct MargoDepthDistance {reference:vec4f,range:vec4f}
@group(${group}) @binding(196) var<uniform> margoDepthDistance:MargoDepthDistance;
// Base-256 packing, R most significant. The endpoint branches preserve exact zero and one.
fn margoPackDepth(value:f32)->vec4f {
  if(value<=0){return vec4f(0);}
  if(value>=1){return vec4f(1);}
  let scaled=value*16777216.0;
  let whole=floor(scaled);
  let b=whole/256.0;
  let g=floor(b)/256.0;
  return vec4f(floor(g)/255.0,fract(g)*(256.0/255.0),fract(b)*(256.0/255.0),fract(scaled));
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
