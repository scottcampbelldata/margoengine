// Clean room: Mayorga/Gleicher (2013), Heer (2021), W3C WebGPU integer atomics.
export const densityUniform = `struct Density { clip:mat4x4f, viewport:vec4f, scissor:vec4f, colour:vec4f, settings:vec4f }
@group(0) @binding(0) var<uniform> p:Density;`;

export const countShader = `${densityUniform}
@group(0) @binding(1) var<storage,read> xyz:array<f32>;
@group(0) @binding(2) var<storage,read_write> counts:array<atomic<u32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x*3u;if(i+2u>=arrayLength(&xyz)){return;}
 let v=vec4f(xyz[i],xyz[i+1u],xyz[i+2u],1.0);
 if(!all(abs(v.xyz)<=vec3f(3.402823466e+38))){return;}
 let c=p.clip*v;if(!(c.w>0.0)||c.z<0.0||c.z>c.w){return;}
 let n=c.xy/c.w;if(!all(abs(n)<=vec2f(1.0))){return;}
 let pixel=vec2i(floor(p.viewport.xy+(vec2f(n.x,-n.y)*0.5+0.5)*p.viewport.zw));
 let width=u32(p.settings.x);let height=u32(p.settings.y);
 if(any(pixel<vec2i(p.scissor.xy))||any(pixel>=vec2i(p.scissor.xy+p.scissor.zw))||any(pixel<vec2i(0))||pixel.x>=i32(width)||pixel.y>=i32(height)){return;}
 atomicAdd(&counts[u32(pixel.y)*width+u32(pixel.x)],1u);
}`;

// A normalized finite Gaussian, truncated at four sigma, applied to the integer histogram.
// Two separable passes, independent of the number of input points. Zero extension at the plot edge.
export const blurShader = `${densityUniform}
@group(0) @binding(1) var<storage,read> counts:array<u32>;
@group(0) @binding(2) var<storage,read> inputValues:array<f32>;
@group(0) @binding(3) var<storage,read_write> outputValues:array<f32>;
fn blur(i:u32,vertical:bool){
 let w=u32(p.settings.x);let h=u32(p.settings.y);if(i>=w*h){return;}
 let x=i32(i%w);let y=i32(i/w);let sigma=p.settings.z;let radius=i32(ceil(4.0*sigma));
 var total=0.0;var norm=0.0;
 for(var d=-radius;d<=radius;d++){
  let weight=exp(-0.5*f32(d*d)/(sigma*sigma));norm+=weight;
  let a=x+select(d,0,vertical);let b=y+select(0,d,vertical);
  if(a>=i32(p.scissor.x)&&b>=i32(p.scissor.y)&&a<i32(p.scissor.x+p.scissor.z)&&b<i32(p.scissor.y+p.scissor.w)&&a>=0&&b>=0&&a<i32(w)&&b<i32(h)){
   let k=u32(b)*w+u32(a);var value=0.0;
   if(vertical){value=inputValues[k];}else{value=f32(counts[k]);}total+=weight*value;
  }
 }outputValues[i]=total/norm;
}
@compute @workgroup_size(8,8) fn horizontal(@builtin(global_invocation_id) id:vec3u){if(id.x<u32(p.settings.x)&&id.y<u32(p.settings.y)){blur(id.y*u32(p.settings.x)+id.x,false);}}
@compute @workgroup_size(8,8) fn vertical(@builtin(global_invocation_id) id:vec3u){if(id.x<u32(p.settings.x)&&id.y<u32(p.settings.y)){blur(id.y*u32(p.settings.x)+id.x,true);}}`;

export const densityDrawShader = `struct Frame { clip:mat4x4f, inverse:mat4x4f, eye:vec4f, viewport:vec4f }
@group(0) @binding(0) var<uniform> frame:Frame;
struct Density { clip:mat4x4f, viewport:vec4f, scissor:vec4f, colour:vec4f, settings:vec4f }
@group(1) @binding(0) var<uniform> p:Density;
@group(1) @binding(1) var<storage,read> counts:array<u32>;
@group(1) @binding(2) var<storage,read> smoothed:array<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
 return vec4f(select(-1.0,3.0,i==1u),select(-1.0,3.0,i==2u),0.0,1.0);
}
@fragment fn fragment(@builtin(position) pixel:vec4f)->@location(0) vec4f{
 let k=u32(pixel.y)*u32(p.settings.x)+u32(pixel.x);
 var value=f32(counts[k]);if(p.settings.w>0.5){value=smoothed[k];}
 // Beer-Lambert form: opacity of c coincident marks with per-mark opacity a is 1-(1-a)^c.
 let alpha=select(1.0-exp(-p.colour.a*value),select(0.0,1.0,value>0.0),p.colour.a<0.0);
 let colour=p.colour.rgb;
 let encoded=select(1.055*pow(colour,vec3f(1.0/2.4))-0.055,12.92*colour,colour<=vec3f(0.0031308));
 return vec4f(select(colour,encoded,frame.viewport.z>0.5),alpha);
}`;
