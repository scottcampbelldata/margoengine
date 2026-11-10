export const DENOISE_ML = /* wgsl */ `
struct Params {size:vec2u,samples:f32,pad:f32}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> weights:array<f32>;
@group(0) @binding(2) var<storage,read> color:array<f32>;
@group(0) @binding(3) var<storage,read> albedo:array<f32>;
@group(0) @binding(4) var<storage,read> normal:array<f32>;
@group(0) @binding(5) var<storage,read> alpha:array<f32>;
@group(0) @binding(6) var<storage,read_write> output:array<f32>;
fn mlColor(i:u32)->vec4f {let at=i*3u;return vec4f(color[at],color[at+1u],color[at+2u],alpha[i]);}
fn mlAlbedo(i:u32)->vec3f {let at=i*3u;return vec3f(albedo[at],albedo[at+1u],albedo[at+2u]);}
fn mlGuideNormal(i:u32)->vec3f {let at=i*3u;return vec3f(normal[at],normal[at+1u],normal[at+2u]);}
fn mlMean(v:vec3f)->f32 {return (v.x+v.y+v.z)/3.0;}
fn mlNeighbour(p:vec2u,k:u32)->u32 {
 let delta=vec2i(i32(k%3u)-1,i32(k/3u)-1);
 let q=vec2u(clamp(vec2i(p)+delta,vec2i(0),vec2i(params.size)-1));return q.y*params.size.x+q.x;
}
fn mlNormal(v:vec3f)->vec3f {let n=dot(v,v);return v*inverseSqrt(max(n,1e-20));}
fn mlScore(input:array<f32,10>)->f32 {
 var h:array<f32,16>;var j:array<f32,8>;
 for(var a=0u;a<16u;a++){
  var value=weights[160u+a];for(var b=0u;b<10u;b++){value+=input[b]*weights[b*16u+a];}h[a]=max(0.0,value);
 }
 for(var a=0u;a<8u;a++){
  var value=weights[304u+a];for(var b=0u;b<16u;b++){value+=h[b]*weights[176u+b*8u+a];}j[a]=max(0.0,value);
 }
 var result=weights[320u];for(var a=0u;a<8u;a++){result+=j[a]*weights[312u+a];}return result;
}
@compute @workgroup_size(8,8) fn denoiseML(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=params.size)){return;}
 let index=id.y*params.size.x+id.x;let center=mlColor(index);
 let scale=max(mlMean(center.rgb),0.01);let c=center.rgb/scale;let cl=mlMean(c);let denom=1.0+cl*cl;
 let cn=mlNormal(mlGuideNormal(index));let ca=mlAlbedo(index);
 var variance=0.0;
 for(var k=0u;k<9u;k++){let delta=mlColor(mlNeighbour(id.xy,k)).rgb/scale-c;variance+=dot(delta,delta)/27.0;}
 var score:array<f32,9>;var largest=-3.402823466e38;
 for(var k=0u;k<9u;k++){
  let neighbour=mlNeighbour(id.xy,k);let radiance=mlColor(neighbour).rgb/scale;
  let delta=radiance-c;let da=mlAlbedo(neighbour)-ca;let nl=mlMean(radiance);
  let offset=vec2f(f32(i32(k%3u)-1),f32(i32(k/3u)-1));
  let features=array<f32,10>(dot(offset,offset)*0.5,log(1.0+dot(delta,delta)/(3.0*denom)),
   dot(da,da)/3.0,clamp(1.0-dot(cn,mlNormal(mlGuideNormal(neighbour))),0.0,2.0),
   log(1.0+variance/denom),cl/(1.0+cl),nl/(1.0+nl),abs(mlColor(neighbour).a-center.a),
   inverseSqrt(params.samples),0.25);
  score[k]=mlScore(features);largest=max(largest,score[k]);
 }
 var result=vec3f(0.0);var total=0.0;
 for(var k=0u;k<9u;k++){let weight=exp(score[k]-largest);result+=weight*mlColor(mlNeighbour(id.xy,k)).rgb;total+=weight;}
 let value=result/total;output[index*3u]=value.x;output[index*3u+1u]=value.y;output[index*3u+2u]=value.z;
}
`;
