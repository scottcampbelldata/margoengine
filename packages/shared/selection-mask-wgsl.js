// The WGSL side of shared/selection-mask.js, in its own module so code that only packs masks (a PointCloud or Line
// without its plugin) does not carry the shader text.

/**
 * WGSL: the packed mask at `@group(group) @binding(binding)`, `margoMaskPresent()` (false for a zeroed stand-in),
 * `margoMaskOn(i)`, `margoMaskHidden(on)` and `margoMaskColor(linear colour, on)`, the same maths as `maskColor`.
 */
export const maskWgsl = (group, binding) => `
@group(${group}) @binding(${binding}) var<storage,read> margoMask:array<u32>;
fn margoMaskPresent()->bool{return margoMask[3]==1u;}
fn margoMaskOn(i:u32)->bool{return ((margoMask[4u+(i>>5u)]>>(i&31u))&1u)!=0u;}
fn margoMaskHidden(on:bool)->bool{return !on&&margoMask[0]==2u;}
fn margoMaskColor(c:vec4f,on:bool)->vec4f{
  let l=max(c.rgb,vec3f(0.0));
  var s=select(1.055*pow(l,vec3f(1.0/2.4))-0.055,l*12.92,l<=vec3f(0.0031308));
  if(on){if(margoMask[0]!=1u){return c;}let h=unpack4x8unorm(margoMask[2]);s=mix(s,h.rgb,h.a);}
  else{s*=bitcast<f32>(margoMask[1]);}
  return vec4f(select(pow((s+0.055)/1.055,vec3f(2.4)),s/12.92,s<=vec3f(0.04045)),c.a);
}
`;
