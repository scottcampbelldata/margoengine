// The point and spot light PCSS kernel, one WGSL text shared by LocalShadows (@margoengine/clustered shadows.ts) and the
// integrated maps (`ClusteredOptions.shadows`). Each emits it under its own names, and only while one of its lights has
// a shadow radius, so a scene without one compiles none of it.
//
// PCSS (Fernando 2005): the blocker search covers the light's footprint at the receiver (x3, blockers down to a
// quarter of the receiver's depth), the penumbra is the light's extent at the receiver times (receiver - blocker) /
// blocker depth, and the receiver's tangent plane is the reference depth at every tap (Isidoro 2006). Taps on a Vogel
// 1979 spiral, turned per pixel and moved within their rings by interleaved gradient noise (Jimenez 2014); see
// shadows.ts for the full account.

/** The per-pixel spiral turn and its golden-angle rotation, under the given names. */
export const pcssTurn = (golden, turn) =>
  /* wgsl */ `const ${golden}=mat2x2f(-0.737368878,0.675490294,-0.675490294,-0.737368878);
fn ${turn}(position:vec3f)->vec3f {
  let eye=clusterFrame.view*vec4f(position,1);let ortho=clusterFrame.intensity.w>0.5;
  let pixel=floor(eye.xy/select(max(-eye.z,0.000001),1.0,ortho)*(0.5*clusterFrame.screen.y/clusterFrame.screen.z));
  let magic=vec2f(0.06711056,0.00583715);let noise=fract(52.9829189*fract(vec2f(dot(pixel,magic),dot(pixel.yx,magic))));
  let a=6.2831853*noise.x;return vec3f(cos(a),sin(a),noise.y);
}
`;
/**
 * The kernel: 16 blocker reads, then 24 comparisons over the penumbra's disc. A blocker is nearer the light than the
 * receiver plane at its tap; its depth is made linear from the map's (reversed or standard) perspective depth.
 */
export const pointPcss = ({ head, data, map, sampler, turn, golden, reversed, reference = 'z' }) =>
  /* wgsl */ `${head} {
  ${data}
  let t1=normalize(cross(n,select(vec3f(1,0,0),vec3f(0,1,0),abs(n.x)>0.9)))*(distance*0.01);let t2=cross(n,t1);
  let c1=m*vec4f(p+t1,1);let c2=m*vec4f(p+t2,1);
  let d1=vec3f(c1.xy/c1.w*vec2f(0.5,-0.5)+0.5-uv,c1.z/c1.w-z);let d2=vec3f(c2.xy/c2.w*vec2f(0.5,-0.5)+0.5-uv,c2.z/c2.w-z);
  let det=d1.x*d2.y-d1.y*d2.x;
  let slope=select(vec2f(0),vec2f(d1.z*d2.y-d2.z*d1.y,d1.x*d2.z-d2.x*d1.z)/det,abs(det)>1e-12);
  let extent=s.xy/w;let size=vec2f(textureDimensions(${map}));let reach=min(extent*3.0,vec2f(s.z));
  let turn=${turn}(p);var direction=turn.xy;var blockers=0.0;var depth=0.0;
  for(var i=0u;i<16u;i++){
    let o=direction*select(sqrt((f32(i)+turn.z)/16.0),0.0,i==0u)*reach;direction=${golden}*direction;let stored=textureLoad(${map},vec2i(clamp((uv+o)*size,vec2f(0),size-1)),layer,0);
    if(${reversed ? `stored>${reference}+dot(slope,o)` : `stored<${reference}+dot(slope,o)`}){blockers+=1.0;depth+=${reversed ? 'd.x*d.y/(stored*(d.y-d.x)+d.x)' : 'd.x*d.y/(d.y-stored*(d.y-d.x))'};}
  }
  if(blockers<0.5){return 1.0;}
  let blocker=depth/blockers;let radius=clamp(extent*max(w-blocker,0.0)/blocker,vec2f(smallest),vec2f(max(s.z,smallest)));
  var lit=0.0;direction=turn.xy;
  for(var i=0u;i<24u;i++){let o=direction*sqrt((f32(i)+turn.z)/24.0)*radius;direction=${golden}*direction;lit+=textureSampleCompareLevel(${map},${sampler},uv+o,layer,${reference}+dot(slope,o));}
  return lit/24.0;
}
`;
