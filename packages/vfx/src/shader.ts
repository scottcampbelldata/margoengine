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
// Optional features patch the default shaders, so effects without them compile byte-identical WGSL.
const extra=/* wgsl */`
struct Extra {eye:vec4f,forward:vec4f,count:vec4u,obstacles:array<vec4f,128>}
@group(0) @binding(6) var<uniform> extra:Extra;
`;
/** Outward normal (xyz) and signed distance (w) from obstacle i, a sphere or a box. */
const obstacle=/* wgsl */`
fn obstacle(i:u32,position:vec3f)->vec4f {
  let center=extra.obstacles[i*2u];let extent=extra.obstacles[i*2u+1u].xyz;let r=position-center.xyz;
  if(center.w<0.5){let d=length(r);return vec4f(select(vec3f(0,1,0),r/max(d,0.0001),d>0.003),d-extent.x);}
  let q=abs(r)-extent;let outside=max(q,vec3f(0));let nearest=length(outside);let d=nearest+min(max(q.x,max(q.y,q.z)),0.0);
  if(nearest>0.0001){return vec4f(outside*sign(r)/nearest,d);}
  let s=select(vec3f(-1),vec3f(1),r>=vec3f(0));
  if(q.x>=q.y&&q.x>=q.z){return vec4f(s.x,0,0,d);}if(q.y>=q.z){return vec4f(0,s.y,0,d);}return vec4f(0,0,s.z,d);
}`;
const force='p.velocitySize=vec4f(p.velocitySize.xyz+(f.gravityDelta.xyz+curlNoise(p.positionLife.xyz))*dt,p.velocitySize.w);';
const settle='p.rotation.x+=p.rotation.y*dt;';
export function featureShaders(obstacles:boolean,wrap:boolean,sort:boolean,texture:boolean):{simulation:string;billboard:string;sort?:string} {
  let simulation=simulationShader;
  if(obstacles)simulation=simulation.replace('@group(0) @binding(1)',extra+'@group(0) @binding(1)').replace('@compute',obstacle+'\n@compute').replace(force,/* wgsl */`var force=f.gravityDelta.xyz+curlNoise(p.positionLife.xyz);
  // Flow bends around obstacles within one unit; particles inside are pushed out and reflected.
  for(var i=0u;i<extra.count.x;i++){let o=obstacle(i,p.positionLife.xyz);if(o.w<1){force-=o.xyz*min(dot(force,o.xyz),0.0)*(1-clamp(o.w,0.0,1.0));}}
  p.velocitySize=vec4f(p.velocitySize.xyz+force*dt,p.velocitySize.w);`).replace(settle,/* wgsl */`
  for(var i=0u;i<extra.count.x;i++){let o=obstacle(i,p.positionLife.xyz);let r=p.velocitySize.w*0.5;if(o.w<r){p.positionLife=vec4f(p.positionLife.xyz+o.xyz*(r-o.w),p.positionLife.w);p.velocitySize=vec4f(p.velocitySize.xyz-o.xyz*min(dot(p.velocitySize.xyz,o.xyz),0.0)*(1+f.physics.z),p.velocitySize.w);}}
  `+settle);
  // Wrap keeps a field inside the emission box; re-entering particles restart at the emitter velocity.
  if(wrap)simulation=simulation.replace(settle,/* wgsl */`
  let low=f.emitterTime.xyz-f.emissionExtent.xyz;let span=2*f.emissionExtent.xyz;let q=p.positionLife.xyz-low;
  if(any(q<vec3f(0))||any(q>span)){p.positionLife=vec4f(low+q-floor(q/span)*span,p.positionLife.w);p.velocitySize=vec4f(f.velocitySpread.xyz,p.velocitySize.w);}
  `+settle);
  const billboard=texture?billboardShader.replace('struct Out','@group(0) @binding(3) var sprite:texture_2d<f32>;\n@group(0) @binding(4) var spriteSampler:sampler;\nstruct Out')
    .replace('let radius=dot(i.uv,i.uv);if(radius>1){discard;}return vec4f(i.color.rgb,i.color.a*(1-radius)*(1-radius));','let t=textureSample(sprite,spriteSampler,i.uv*vec2f(0.5,-0.5)+0.5);if(t.a<0.02){discard;}return vec4f(i.color.rgb*t.rgb,i.color.a*t.a);'):billboardShader;
  return {simulation,billboard,sort:sort?frame+extra+/* wgsl */`
@group(0) @binding(1) var<storage,read> particles:array<Particle>;
@group(0) @binding(3) var<storage,read_write> alive:array<u32>;
@group(0) @binding(4) var<storage,read> indirect:array<u32,5>;
@group(0) @binding(7) var<uniform> stage:vec4u;
fn key(id:u32)->f32 {if(id==0xffffffffu){return -1e30;}return dot(particles[id].positionLife.xyz-extra.eye.xyz,extra.forward.xyz);}
// Slots past the live count hold stale ids; mark them so they sort last.
@compute @workgroup_size(256) fn clear(@builtin(global_invocation_id) id:vec3u){if(id.x>=indirect[1]&&id.x<stage.z){alive[id.x]=0xffffffffu;}}
// One bitonic compare-exchange step, far particles first.
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  let a=id.x;let b=a^stage.x;if(b<=a||b>=stage.z){return;}let ia=alive[a];let ib=alive[b];let ka=key(ia);let kb=key(ib);let descending=(a&stage.y)==0;
  if((descending&&ka<kb)||(!descending&&ka>kb)){alive[a]=ib;alive[b]=ia;}
}`:undefined};
}
