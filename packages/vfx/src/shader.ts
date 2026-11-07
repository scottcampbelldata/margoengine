import { MargoError } from '@margoengine/math/errors';
import { fogWgsl } from '../../shared/fog.js';
import { frame } from './frame.js';
import { surfaceEntry } from '../../shared/pass.js';
/**
 * Particle i's position/life and velocity/size are vec4s 2i and 2i+1 of the buffer; its colour and rotation (birth angle,
 * angular velocity, initial life) are 2n+2i and 2n+2i+1 (n = capacity), written once at birth. The per-frame update so
 * reads and writes only the first half; the drawn angle is the birth angle plus angular velocity times age.
 * indirect counts every live particle; the draw lists in alive those whose triangle can reach the screen. That test
 * bounds the triangle by a sphere of radius size (its circumradius) and checks it
 * against the four side planes in clip space, with row-norm margins that bound any offset of that length (1% and a
 * w-relative slack cover rounding); the side planes together also reject everything behind the eye. (The test uses the
 * true size, so a far particle the billboard grows to its 1.5 px minimum can be culled up to a pixel early at an edge.)
 * A respawn's seed is its slot and the simulated frame number (control.z).
 *
 * Slot order, never atomic tickets, so the same frames give the same particles and the same blend order whatever order
 * the GPU runs the threads in (visual checks were load-dependent before). One dispatch each, per frame:
 * - deaths: each workgroup's dying slots (dies, the update's own test) counted into groups (the births buffer);
 * - scan (one workgroup): groups become exclusive offsets, their sum goes to total[1];
 * - main: a slot's ticket is the dying slots before it (births = those offsets, plus prefix in the workgroup), so births
 *   take the lowest dead slots; update returns 1 when the slot is alive and on screen, and each workgroup lists those
 *   in slot order in its own 256 entries of listed, its count in groups (the drawn buffer);
 * - scan of the drawn counts (total = the draw's arguments, instanceCount);
 * - compact: each workgroup's run of listed copied to alive at its offset.
 * deaths and the births scan are skipped in a frame without births: every ticket is then at or above the budget, 0.
 * prefix(l, v) sums v over invocations 0..l of the workgroup and must be called from uniform control flow.
 */
export const simulationShader =
  frame +
  /* wgsl */ `
@group(0) @binding(1) var<storage,read_write> particles:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> groups:array<u32>;
@group(0) @binding(3) var<storage,read_write> alive:array<u32>;
struct Indirect {vertexCount:u32,instanceCount:atomic<u32>,rest:array<u32,3>}
@group(0) @binding(4) var<storage,read_write> indirect:Indirect;
@group(0) @binding(5) var<storage,read> births:array<u32>;
@group(0) @binding(9) var<storage,read_write> listed:array<u32>;
@group(0) @binding(10) var<storage,read_write> total:array<u32,5>;
var<workgroup> scratch:array<u32,256>;
fn prefix(l:u32,v:u32)->u32 {scratch[l]=v;workgroupBarrier();for(var o=1u;o<256u;o=o<<1u){var a=0u;if(l>=o){a=scratch[l-o];}workgroupBarrier();scratch[l]+=a;workgroupBarrier();}return scratch[l];}
fn dies(i:u32)->u32 {return select(0u,1u,i<f.control.x&&particles[i*2].w-f.gravityDelta.w<=0);}
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
fn update(i:u32,ticket:u32)->u32 {
  let dt=f.gravityDelta.w;
  let at=i*2;let cold=f.control.x*2+at;var p=Particle(particles[at],particles[at+1],vec4f(0),vec4f(0));
  p.positionLife.w-=dt;
  if(p.positionLife.w<=0){
    if(ticket>=f.control.y){particles[at].w=0;return 0u;}
    let seed=hash(i+hash(f.control.z));
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
  if(p.positionLife.w<=0){return 0u;}
  atomicAdd(&indirect.instanceCount,1u);
  let c=f.camera*vec4f(p.positionLife.xyz,1);let m=transpose(f.camera);let r=p.velocitySize.w*1.01;
  if(any(vec4f(c.x-c.w,-c.x-c.w,c.y-c.w,-c.y-c.w)>vec4f(length(m[0].xyz-m[3].xyz),length(m[0].xyz+m[3].xyz),length(m[1].xyz-m[3].xyz),length(m[1].xyz+m[3].xyz))*r+abs(c.w)*1e-5)){return 0u;}
  return 1u;
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) l:u32,@builtin(workgroup_id) w:vec3u){
  let d=dies(id.x);let ticket=births[w.x]+prefix(l,d)-d;
  var drawn=0u;if(id.x<f.control.x){drawn=update(id.x,ticket);}
  let rank=prefix(l,drawn);if(drawn==1u){listed[w.x*256u+rank-1u]=id.x;}if(l==255u){groups[w.x]=rank;}
}
@compute @workgroup_size(256) fn deaths(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) l:u32,@builtin(workgroup_id) w:vec3u){
  let d=prefix(l,dies(id.x));if(l==255u){groups[w.x]=d;}
}
@compute @workgroup_size(256) fn scan(@builtin(local_invocation_index) l:u32){
  let n=(f.control.x+255u)/256u;let per=(n+255u)/256u;let a=min(l*per,n);let b=min(a+per,n);
  var sum=0u;for(var k=a;k<b;k++){sum+=groups[k];}
  var run=prefix(l,sum)-sum;for(var k=a;k<b;k++){let v=groups[k];groups[k]=run;run+=v;}
  if(l==255u){total[1]=run;}
}
@compute @workgroup_size(256) fn compact(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32){
  let start=groups[w.x];var end=total[1];if(w.x+1u<(f.control.x+255u)/256u){end=groups[w.x+1u];}
  if(l<end-start){alive[start+l]=listed[w.x*256u+l];}
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
  // At least 1.5 px across: a smaller (far) particle is drawn at that size with its alpha scaled by the area it gained,
  // so it keeps its average light instead of popping in and out as it crosses pixel centres or MSAA samples.
  let pixels=p.velocitySize.w*f.up.w/max(abs((f.camera*vec4f(p.positionLife.xyz,1)).w),1e-6);let grow=select(1.0,max(1.0,1.5/pixels),pixels>0);
  let position=p.positionLife.xyz+(f.right.xyz*rotated.x+f.up.xyz*rotated.y)*p.velocitySize.w*0.5*grow;
  var o:Out;o.clip=f.camera*vec4f(position,1);o.uv=corner;o.color=vec4f(p.color.rgb,p.color.a*clamp(p.positionLife.w/p.rotation.z,0.0,1.0)/(grow*grow));return o;
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
const transparentEdits: Array<[string, string]> = [
  ['@location(0) uv:vec2f,', '@location(0) uv:vec2f,@location(3) margoDepth:f32,'],
  [
    'o.clip=f.camera*vec4f(position,1);',
    'o.clip=f.camera*vec4f(position,1);o.margoDepth=-dot(cross(f.right.xyz,f.up.xyz),position)-f.right.w;',
  ],
  ['@fragment fn fragment(i:Out)->@location(0) vec4f {', 'fn margoShade(i:Out)->vec4f {'],
];
/** A finished billboard shader (fog, softness and texture in place) with its fragment feeding a transparency hook. */
export const transparentBillboard = (billboard: string, declarations: string): string => {
  let code = billboard;
  for (const [from, to] of transparentEdits) {
    if (code.split(from).length !== 2)
      throw new MargoError(
        'unsupported',
        'VFX transparency needs the billboard shader it was written for; update its edits',
      );
    code = code.replace(from, to);
  }
  return declarations + code + surfaceEntry(declarations, 'i:Out', 'margoShade(i)', 'i.clip', 'i.margoDepth');
};
const fogEdits: Array<[string, string]> = [
  ['@location(0) uv:vec2f,', '@location(0) uv:vec2f,@location(7) fogWorld:vec3f,'],
  ['o.clip=f.camera*vec4f(position,1);', 'o.clip=f.camera*vec4f(position,1);o.fogWorld=position;'],
  [
    '@fragment fn fragment(i:Out)->@location(0) vec4f {',
    '@fragment fn fragment(i:Out)->@location(0) vec4f {return fogged(i,unfogged(i));}\nfn unfogged(i:Out)->vec4f {',
  ],
];
/**
 * Scene fog (`setFog`) on a billboard shader, plain or textured, before `multisampled`: each fragment fades toward the
 * fog colour by the fog at its world position. Particles blend alpha over the scene and write their colour as it is, so
 * the fog colour in the uniform is in the target's terms (sRGB-encoded for an 8-bit canvas). Fog uniform at binding 5.
 */
export const foggedBillboard = (billboard: string): string => {
  let code = billboard;
  for (const [from, to] of fogEdits) {
    if (code.split(from).length !== 2)
      throw new MargoError(
        'unsupported',
        'VFX fog needs the billboard shader it was written for; update the fog edits',
      );
    code = code.replace(from, to);
  }
  return (
    code +
    fogWgsl(0, 5) +
    'fn fogged(i:Out,c:vec4f)->vec4f {return vec4f(mix(c.rgb,margoFog.color.rgb,fogAmount(i.fogWorld)),c.a);}\n'
  );
};
