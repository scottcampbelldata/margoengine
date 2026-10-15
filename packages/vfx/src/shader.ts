export const frame = /* wgsl */ `
struct Particle {positionLife:vec4f,velocitySize:vec4f,color:vec4f,rotation:vec4f}
struct Frame {camera:mat4x4f,right:vec4f,up:vec4f,gravityDelta:vec4f,emitterTime:vec4f,velocitySpread:vec4f,color:vec4f,shape:vec4f,physics:vec4f,emissionExtent:vec4f,control:vec4u}
@group(0) @binding(0) var<uniform> f:Frame;
`;
/**
 * Particle i's position/life and velocity/size are vec4s 2i and 2i+1 of the buffer; its colour and rotation (birth angle,
 * angular velocity, initial life) are 2n+2i and 2n+2i+1 (n = capacity), written once at birth. The per-frame update so
 * reads and writes only the first half; the drawn angle is the birth angle plus angular velocity times age.
 * indirect counts every live particle; drawn (the draw's arguments) counts those listed in live: the ones whose
 * triangle can reach the screen. That test bounds the triangle by a sphere of radius size (its circumradius) and checks it
 * against the four side planes in clip space, with row-norm margins that bound any offset of that length (1% and a
 * w-relative slack cover rounding); the side planes together also reject everything behind the eye.
 */
export const simulationShader =
  frame +
  /* wgsl */ `
@group(0) @binding(1) var<storage,read_write> particles:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> alive:array<u32>;
struct Indirect {vertexCount:u32,instanceCount:atomic<u32>,rest:array<u32,3>}
@group(0) @binding(4) var<storage,read_write> indirect:Indirect;
@group(0) @binding(2) var<storage,read_write> drawn:Indirect;
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
  if(id.x>=f.control.x){return;}let dt=f.gravityDelta.w;
  let at=id.x*2;let cold=f.control.x*2+at;var p=Particle(particles[at],particles[at+1],vec4f(0),vec4f(0));
  p.positionLife.w-=dt;
  if(p.positionLife.w<=0){
    let ticket=atomicAdd(&respawn.count,1u);
    if(ticket>=f.control.y){particles[at].w=0;return;}
    let seed=hash(atomicAdd(&respawn.sequence,1u)+id.x);
    let life=mix(f.shape.y,f.shape.z,random(seed));
    let origin=f.emitterTime.xyz+(vec3f(random(seed+5u),random(seed+6u),random(seed+7u))*2-1)*f.emissionExtent.xyz;
    p.positionLife=vec4f(origin,max(0.0,life-dt));
    p.velocitySize=vec4f(f.velocitySpread.xyz+(vec3f(random(seed+1u),random(seed+2u),random(seed+3u))*2-1)*f.velocitySpread.w,f.shape.x);
    p.color=vec4f(f.color.rgb*f.emissionExtent.w,f.color.a);p.rotation=vec4f(random(seed+4u)*6.2831853,f.physics.w,life,0);
    particles[cold]=p.color;particles[cold+1]=p.rotation;
  }
  p.velocitySize=vec4f(p.velocitySize.xyz+(f.gravityDelta.xyz+curlNoise(p.positionLife.xyz))*dt,p.velocitySize.w);
  p.positionLife=vec4f(p.positionLife.xyz+p.velocitySize.xyz*dt,p.positionLife.w);
  if(p.positionLife.y-p.velocitySize.w*0.5<f.shape.w){p.positionLife.y=f.shape.w+p.velocitySize.w*0.5;if(p.velocitySize.y<0){p.velocitySize.y=-p.velocitySize.y*f.physics.z;}}
  particles[at]=p.positionLife;particles[at+1]=p.velocitySize;
  if(p.positionLife.w<=0){return;}
  atomicAdd(&indirect.instanceCount,1u);
  let c=f.camera*vec4f(p.positionLife.xyz,1);let m=transpose(f.camera);let r=p.velocitySize.w*1.01;
  if(any(vec4f(c.x-c.w,-c.x-c.w,c.y-c.w,-c.y-c.w)>vec4f(length(m[0].xyz-m[3].xyz),length(m[0].xyz+m[3].xyz),length(m[1].xyz-m[3].xyz),length(m[1].xyz+m[3].xyz))*r+abs(c.w)*1e-5)){return;}
  alive[atomicAdd(&drawn.instanceCount,1u)]=id.x;
}`;
/** One triangle around the unit disc (inradius 1) per particle: half the primitives and 3/4 of the vertices of a quad. */
export const billboardShader =
  frame +
  /* wgsl */ `
@group(0) @binding(1) var<storage,read> particles:array<vec4f>;
@group(0) @binding(2) var<storage,read> alive:array<u32>;
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f}
@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out {
  let corners=array<vec2f,3>(vec2f(-1.7320509,-1),vec2f(1.7320509,-1),vec2f(0,2));let corner=corners[vertex];let at=alive[instance]*2;let cold=f.control.x*2+at;let p=Particle(particles[at],particles[at+1],particles[cold],particles[cold+1]);
  let angle=p.rotation.x+p.rotation.y*(p.rotation.z-p.positionLife.w);let cs=cos(angle);let sn=sin(angle);let rotated=vec2f(corner.x*cs-corner.y*sn,corner.x*sn+corner.y*cs);
  let position=p.positionLife.xyz+(f.right.xyz*rotated.x+f.up.xyz*rotated.y)*p.velocitySize.w*0.5;
  var o:Out;o.clip=f.camera*vec4f(position,1);o.uv=corner;o.color=vec4f(p.color.rgb,p.color.a*clamp(p.positionLife.w/p.rotation.z,0.0,1.0));return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let radius=dot(i.uv,i.uv);if(radius>1){discard;}return vec4f(i.color.rgb,i.color.a*(1-radius)*(1-radius));
}`;
/**
 * With 4x MSAA the fragment shader runs once per pixel but writes every sample the triangle covers, and the triangle
 * covers more samples than the quad it replaced. Keep exactly the quad's samples: those whose uv (from the pixel centre's
 * uv, its screen derivatives and WebGPU's standard 4x sample offsets) lies in the unit square.
 */
export const multisampled = (billboard: string) =>
  billboard.replace(
    '@fragment fn fragment(i:Out)->@location(0) vec4f {',
    /* wgsl */ `struct Samples {@location(0) color:vec4f,@builtin(sample_mask) mask:u32}
@fragment fn fragment(i:Out,@builtin(sample_mask) covered:u32)->Samples {
  let dx=dpdx(i.uv);let dy=dpdy(i.uv);let offsets=array<vec2f,4>(vec2f(-0.125,-0.375),vec2f(0.375,-0.125),vec2f(-0.375,0.125),vec2f(0.125,0.375));var mask=0u;
  for(var s=0u;s<4u;s++){let q=abs(i.uv+dx*offsets[s].x+dy*offsets[s].y);if(max(q.x,q.y)<=1){mask|=1u<<s;}}
  return Samples(shade(i),covered&mask);
}
fn shade(i:Out)->vec4f {`,
  );
/** Statement the obstacle and wrap features insert their per-particle work before. */
export const settle = 'particles[at]=p.positionLife;';
