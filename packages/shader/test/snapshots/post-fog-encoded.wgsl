
struct Vertex { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index];
 return Vertex(vec4f(p,0,1),vec2f(p.x*0.5+0.5,0.5-p.y*0.5));
}
@group(0) @binding(0) var ndi0:texture_2d<f32>;
@group(0) @binding(1) var ndd1:texture_depth_2d;
fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
  let c = vec4f(mix(textureLoad(ndi0, vec2i(v.position.xy), 0).xyz, vec3f(0.6, 0.7, 0.8), vec3f(clamp(1.0 - (textureLoad(ndd1, vec2i(v.position.xy), 0) * 50.0), 0.0, 1.0))), 1.0);
  let x = pbrNeutral(max(c.rgb, vec3f(0.0)));
  return vec4f(select(x * 12.92, 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x >= vec3f(0.0031308)), c.a);
}
