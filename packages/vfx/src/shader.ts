const frame=/* wgsl */`
struct Particle {positionLife:vec4f,velocitySize:vec4f,color:vec4f,rotation:vec4f}
struct Frame {camera:mat4x4f,right:vec4f,up:vec4f,gravityDelta:vec4f,emitterTime:vec4f,velocitySpread:vec4f,color:vec4f,shape:vec4f,physics:vec4f,emissionExtent:vec4f,control:vec4u}
@group(0) @binding(0) var<uniform> f:Frame;
`;
export const simulationShader=frame+/* wgsl */`
@group(0) @binding(1) var<storage,read_write> particles:array<Particle>;
@group(0) @binding(3) var<storage,read_write> alive:array<u32>;
struct Indirect {indexCount:u32,instanceCount:atomic<u32>,firstIndex:u32,baseVertex:i32,firstInstance:u32}
@group(0) @binding(4) var<storage,read_write> indirect:Indirect;
struct Respawn {count:atomic<u32>,sequence:atomic<u32>}
@group(0) @binding(5) var<storage,read_write> respawn:Respawn;
fn hash(v:u32)->u32 {var x=v;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return x^(x>>16u);}
fn random(seed:u32)->f32{return f32(hash(seed)>>8u)/16777216.0;}
fn curlNoise(p:vec3f)->vec3f {
  var curl=vec3f(0);var frequency=f.physics.y;var amplitude=1.0;
  for(var octave=0u;octave<3u;octave++){
    let q=p*frequency+f.emitterTime.w*0.3;
    // Analytic curl of a smooth vector potential; its divergence is zero.
    curl+=vec3f(-sin(q.y)-cos(q.z),-sin(q.z)-cos(q.x),-sin(q.x)-cos(q.y))*amplitude;
    frequency*=2.03;amplitude*=0.5;
  }
  return curl*f.physics.x;
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=f.control.x){return;}var p=particles[id.x];let dt=f.gravityDelta.w;
  p.positionLife.w-=dt;
  if(p.positionLife.w<=0){
    let ticket=atomicAdd(&respawn.count,1u);
    if(ticket>=f.control.y){p.positionLife.w=0;particles[id.x]=p;return;}
    let seed=hash(atomicAdd(&respawn.sequence,1u)+id.x);
    let life=mix(f.shape.y,f.shape.z,random(seed));
    let origin=f.emitterTime.xyz+(vec3f(random(seed+5u),random(seed+6u),random(seed+7u))*2-1)*f.emissionExtent.xyz;
    p.positionLife=vec4f(origin,max(0.0,life-dt));
    p.velocitySize=vec4f(f.velocitySpread.xyz+(vec3f(random(seed+1u),random(seed+2u),random(seed+3u))*2-1)*f.velocitySpread.w,f.shape.x);
    p.color=vec4f(f.color.rgb*f.emissionExtent.w,f.color.a);p.rotation=vec4f(random(seed+4u)*6.2831853,f.physics.w,life,0);
  }
  p.velocitySize=vec4f(p.velocitySize.xyz+(f.gravityDelta.xyz+curlNoise(p.positionLife.xyz))*dt,p.velocitySize.w);
  p.positionLife=vec4f(p.positionLife.xyz+p.velocitySize.xyz*dt,p.positionLife.w);
  if(p.positionLife.y-p.velocitySize.w*0.5<f.shape.w){p.positionLife.y=f.shape.w+p.velocitySize.w*0.5;if(p.velocitySize.y<0){p.velocitySize.y=-p.velocitySize.y*f.physics.z;}}
  p.rotation.x+=p.rotation.y*dt;particles[id.x]=p;
  if(p.positionLife.w<=0){return;}
  let instance=atomicAdd(&indirect.instanceCount,1u);alive[instance]=id.x;
}`;
export const billboardShader=frame+/* wgsl */`
@group(0) @binding(1) var<storage,read> particles:array<Particle>;
@group(0) @binding(2) var<storage,read> alive:array<u32>;
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f}
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out {
  let corners=array<vec2f,4>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(1,1));let corner=corners[vertex];let p=particles[alive[instance]];
  let cs=cos(p.rotation.x);let sn=sin(p.rotation.x);let rotated=vec2f(corner.x*cs-corner.y*sn,corner.x*sn+corner.y*cs);
  let position=p.positionLife.xyz+(f.right.xyz*rotated.x+f.up.xyz*rotated.y)*p.velocitySize.w*0.5;
  var o:Out;o.clip=f.camera*vec4f(position,1);o.uv=corner;o.color=vec4f(p.color.rgb,p.color.a*clamp(p.positionLife.w/p.rotation.z,0.0,1.0));return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let radius=dot(i.uv,i.uv);if(radius>1){discard;}return vec4f(i.color.rgb,i.color.a*(1-radius)*(1-radius));
}`;
