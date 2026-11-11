// Whitewater for ParticleLiquid: spray, foam and air bubbles generated from the fluid particles' velocities, after
// M. Ihmsen, N. Akinci, G. Akinci and M. Teschner, Unified spray, foam and air bubbles for particle-based fluids, The
// Visual Computer 28(6-8) 2012, https://doi.org/10.1007/s00371-012-0697-9 (equations 1 to 8: trapped-air, wave-crest
// and kinetic-energy potentials, the clamping function, cylinder sampling, classification by fluid neighbour count,
// ballistic spray, foam advected with the averaged fluid velocity, buoyant bubbles with drag, foam-only dissolution).
// GPU structure, all render passes (no compute, so the WebGL2 layer runs every pass as an ordinary draw):
// - neighbour grid: T. Harada, S. Koshizuka, Y. Kawaguchi, Smoothed Particle Hydrodynamics on GPUs, CGI 2007 (a bucket
//   texture filled by one point draw per slot, the depth test keeping the smallest index above the previous slot), over
//   a uniform grid that wraps every G cells, so it needs no bounds (cells that share a bucket are told apart by position);
// - emission without scatter or atomics: G. Ziegler, A. Tevs, C. Theobalt, H.-P. Seidel, On-the-fly Point Clouds
//   through Histogram Pyramids, VMV 2006 (a sum pyramid of emission counts, walked top-down by each new particle);
// - random numbers: M. Jarzynski, M. Olano, Hash Functions for GPU Rendering, JCGT 9(3) 2020 (PCG hash).
// Citations and the choices the paper leaves open: docs/water-liquid.md and docs/clean-room.md.
import { applyView } from '../../shared/view-rect.js';
import { liquidBlock as block } from './liquid-shaders.js';
import type { ParticleSource, WhitewaterOptions } from './liquid.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number; MAP_READ: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
declare const GPUMapMode: { READ: number };

/** Slots per hash bucket (Harada et al. use 4 per texel; two textures of 4 give 8). */
const SLOTS = 8;

/** Whitewater uniform block; integers first. */
const params = `
struct W {
 a:vec4u,b:vec4u,e:vec4u,
 grid:vec4f,crest:vec4f,rates:vec4f,motion:vec4f,gravity:vec4f,life:vec4f,look:vec4f,
}
`;

/** Helpers shared by the passes that read particles and the bucket grid. `@binding` numbers are fixed per pass. */
const helpers = `
fn pos(j:u32)->vec3f {let b=u32(u.particles.y)+j*u32(u.particles.x);return vec3f(points[b],points[b+1u],points[b+2u]);}
fn cellOf(p:vec3f)->vec3i {return vec3i(floor(p/w.grid.x));}
// The cell's texel in a wrapped grid of G x G x Z cells (powers of two, so the wrap is a mask of the two's-complement
// bits): z slices tiled Sx across, so the cells around a particle are neighbouring texels and stay in cache.
fn hashOf(c:vec3i)->vec2u {
 let q=vec3u(c)&vec3u(w.a.x-1u,w.a.x-1u,w.e.w-1u);
 return vec2u(q.x+w.a.x*(q.z%w.a.y),q.y+w.a.x*(q.z/w.a.y));
}
`;
const reader = `
fn slotAt(h:vec2u,s:u32)->u32 {
 let t=vec2i(i32(h.x*4u+s/2u),i32(h.y));
 if((s&1u)==0u){return textureLoad(evenSlots,t,0).x;}return textureLoad(oddSlots,t,0).x;
}
fn vel(j:u32)->vec3f {let b=w.b.w+j*w.b.z;return vec3f(speeds[b],speeds[b+1u],speeds[b+2u]);}
`;
// PCG hash (Jarzynski and Olano 2020), chained over the particle, a sample number, the step and the seed.
const random = `
fn pcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let t=((s>>((s>>28u)+4u))^s)*277803737u;return (t>>22u)^t;}
fn rand(a:u32,b:u32)->f32 {return f32(pcg(a^pcg(b^pcg(w.e.x^pcg(w.e.y))))>>8u)/16777216.0;}
`;

/**
 * Every fluid particle j with |x - x_j| < h, from the 125 cells of size h / 2 around x; BODY sees j, xj, rij = x - xj and
 * dist. A particle found through a colliding bucket is skipped unless it lies in the cell being visited, so each
 * neighbour counts once.
 */
const neighbours = (body: string) => `
 {let home=cellOf(x);
 for(var dz=-2;dz<=2;dz++){for(var dy=-2;dy<=2;dy++){for(var dx=-2;dx<=2;dx++){
  let cc=home+vec3i(dx,dy,dz);
  // Skip a cell whose nearest point is out of reach.
  let low=vec3f(cc)*w.grid.x;let gap=max(max(low-x,x-low-vec3f(w.grid.x)),vec3f(0));
  if(dot(gap,gap)>=w.grid.y*w.grid.y){continue;}
  let hh=hashOf(cc);
  for(var s=0u;s<${SLOTS}u;s++){
   let id=slotAt(hh,s);if(id==0u){break;}
   let j=id-1u;let xj=pos(j);
   if(any(cellOf(xj)!=cc)){continue;}
   let rij=x-xj;let dist=length(rij);if(dist>=w.grid.y){continue;}
   ${body}
  }
 }}}}
`;

const fluidBindings = `
@group(0) @binding(1) var<storage,read> points:array<f32>;
@group(0) @binding(2) var<storage,read> speeds:array<f32>;
@group(0) @binding(3) var<uniform> w:W;
@group(0) @binding(4) var evenSlots:texture_2d<u32>;
@group(0) @binding(5) var oddSlots:texture_2d<u32>;
`;
const fullscreen = `
struct Screen {@builtin(position) position:vec4f}
@vertex fn vertex(@builtin(vertex_index) index:u32)->Screen {
 return Screen(vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index],0,1));
}
`;

/** Bucket fill (Harada et al. 2007): pass k writes particle index + 1 into slot k of its cell's bucket. */
export const bucketShader = `${block}${params}
@group(0) @binding(1) var<storage,read> points:array<f32>;
@group(0) @binding(2) var<uniform> w:W;
@group(0) @binding(3) var<uniform> slot:vec4u;
@group(0) @binding(4) var previous:texture_2d<u32>;
${helpers}
struct Point {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) id:u32}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Point {
 var o:Point;o.id=i+1u;o.clip=vec4f(2,2,2,1);
 let x=pos(i);if(!(abs(x.x)+abs(x.y)+abs(x.z)<3.0e38)){return o;}
 let h=hashOf(cellOf(x));let width=f32(w.a.x*w.a.y*4u);let height=f32(w.a.x*(w.e.w/w.a.y));
 let t=vec2f(f32(h.x*4u+slot.x/2u)+0.5,f32(h.y)+0.5);
 // Depth i / 2^22 is exact for every index, so the depth test keeps the smallest one.
 o.clip=vec4f(t.x/width*2.0-1.0,1.0-t.y/height*2.0,f32(i)/4194304.0,1);return o;
}
@fragment fn fragment(i:Point)->@location(0) vec4u {
 if(slot.x>0u){
  // Slot k - 1 sits in the other texture, one texel left for an even k.
  let back=vec2i(i.clip.xy)-vec2i(i32(1u-(slot.x&1u)),0);
  if(i.id<=textureLoad(previous,back,0).x){discard;}
 }
 return vec4u(i.id,0,0,0);
}
`;

/** Surface normals: n_i is the weighted mean of the unit vectors from the neighbours; defined only at the surface. */
export const normalShader = `${block}${params}${fluidBindings}${helpers}${reader}${fullscreen}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let t=vec2u(at.xy);let i=t.y*w.a.z+t.x;if(i>=w.a.w){return vec4f(0);}
 let x=pos(i);var sum=vec3f(0);var total=0.0;
 ${neighbours('if(j==i||dist<=0.0){continue;}let k=1.0-dist/w.grid.y;sum+=rij/dist*k;total+=k;')}
 let length_=length(sum);
 if(!(length_>0.0)||length_<w.grid.w*total){return vec4f(0);}
 return vec4f(sum/length_,1);
}
`;

/**
 * Potentials and emission count (Ihmsen et al. 2012, equations 1 to 8). Output: count (low 8 bits, at most 255 per
 * step) and the lifetime factor in 16 bits above, into level 0 of the count pyramid.
 */
export const potentialShader = `${block}${params}${fluidBindings}
@group(0) @binding(6) var normals:texture_2d<f32>;
${helpers}${reader}${random}${fullscreen}
fn phi(i:f32,lo:f32,hi:f32)->f32 {return (min(i,hi)-min(i,lo))/(hi-lo);}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4u {
 let t=vec2u(at.xy);let i=t.y*w.a.z+t.x;if(i>=w.a.w){return vec4u(0);}
 let x=pos(i);let v=vel(i);let ni=textureLoad(normals,vec2i(t),0);
 var trapped=0.0;var curvature=0.0;
 ${neighbours(`if(j==i||dist<=0.0){continue;}
   let k=1.0-dist/w.grid.y;let xh=rij/dist;let vij=v-vel(j);let vl=length(vij);
   // Equation 2: |v_ij| (1 - v^_ij . x^_ij) W.
   if(vl>0.0){trapped+=vl*(1.0-dot(vij/vl,xh))*k;}
   // Equations 4 to 6: (1 - n^_i . n^_j) W over surface neighbours on the convex side (x^_ji . n^_i < 0).
   if(ni.w>0.5){let nj=textureLoad(normals,vec2i(i32(j%w.a.z),i32(j/w.a.z)),0);
    if(nj.w>0.5&&dot(-xh,ni.xyz)<0.0){curvature+=(1.0-dot(ni.xyz,nj.xyz))*k;}}`)}
 let speed=length(v);
 // Equation 7: only where the particle moves along its normal (v^ . n^ >= 0.6).
 let moving=ni.w>0.5&&speed>0.0&&dot(v/speed,ni.xyz)>=0.6;
 let ita=phi(trapped,w.crest.x,w.crest.y);let iwc=phi(select(0.0,curvature,moving),w.crest.z,w.crest.w);
 let ik=phi(0.5*w.motion.x*speed*speed,w.rates.x,w.rates.y);
 let rate=ik*(w.rates.z*ita+w.rates.w*iwc);
 // Equation 8 per step, rounded stochastically so the expected count is exact.
 let n=min(255.0,floor(rate*w.grid.z+rand(i,0xffffffffu)));
 let scale=w.rates.z+w.rates.w;let p=select(0.0,clamp(rate/scale,0.0,1.0),scale>0.0);
 return vec4u(u32(max(n,0.0))|(u32(p*65535.0+0.5)<<8u),0,0,0);
}
`;

/**
 * The count pyramid (Ziegler et al. 2006) lives in two atlases: level l in atlas l % 2, at (0, 0) for level 0 and at
 * (P, P - 2 (P >> l)) for the others, so a pass never reads the texture it draws into.
 */
const pyramid = `
@group(0) @binding(7) var evenLevels:texture_2d<u32>;
@group(0) @binding(8) var oddLevels:texture_2d<u32>;
fn origin(l:u32)->vec2u {if(l==0u){return vec2u(0);}let p=w.a.z;return vec2u(p,p-2u*(p>>l));}
fn level(l:u32,t:vec2u)->u32 {
 let q=vec2i(origin(l)+t);
 if((l&1u)==0u){let v=textureLoad(evenLevels,q,0).x;return select(v,v&255u,l==0u);}
 return textureLoad(oddLevels,q,0).x;
}
`;
export const reduceShader = `${block}${params}
@group(0) @binding(3) var<uniform> w:W;
@group(0) @binding(4) var<uniform> step_:vec4u;
@group(0) @binding(5) var source:texture_2d<u32>;
${fullscreen}
fn origin(l:u32)->vec2u {if(l==0u){return vec2u(0);}let p=w.a.z;return vec2u(p,p-2u*(p>>l));}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4u {
 let l=step_.x;let t=(vec2u(at.xy)-origin(l))*2u;let o=origin(l-1u);var sum=0u;
 for(var n=0u;n<4u;n++){let v=textureLoad(source,vec2i(o+t+vec2u(n&1u,n>>1u)),0).x;sum+=select(v,v&255u,l==1u);}
 return vec4u(sum,0,0,0);
}
`;

/** The ring's next free slot: head + min(emitted, pool) mod pool. */
export const headShader = `${block}${params}
@group(0) @binding(3) var<uniform> w:W;
@group(0) @binding(6) var heads:texture_2d<u32>;
${pyramid}${fullscreen}
@fragment fn fragment()->@location(0) vec4u {
 let pool=w.b.x;let total=level(w.e.z,vec2u(0));
 return vec4u((textureLoad(heads,vec2i(0),0).x+min(total,pool))%pool,0,0,0);
}
`;

/**
 * One step of every diffuse slot: a slot the ring reaches takes the next emitted particle (found by walking the
 * pyramid), the others are classified by fluid neighbour count and advected as spray, foam or a bubble.
 */
export const updateShader = `${block}${params}${fluidBindings}
@group(0) @binding(6) var heads:texture_2d<u32>;
${pyramid}
@group(0) @binding(9) var positionsIn:texture_2d<f32>;
@group(0) @binding(10) var velocitiesIn:texture_2d<f32>;
${helpers}${reader}${random}${fullscreen}
struct Slots {@location(0) place:vec4f,@location(1) motion:vec4f}
struct Fluid {count:f32,flow:vec3f,weight:f32}
// Fluid neighbours of a diffuse particle: their number and the cubic-spline averaged velocity (section 3.2).
fn around(x:vec3f)->Fluid {
 var f=Fluid(0.0,vec3f(0),0.0);
 ${neighbours(`f.count+=1.0;let q=dist/w.grid.y;
   let k=select(2.0*(1.0-q)*(1.0-q)*(1.0-q),6.0*(q*q*q-q*q)+1.0,q<0.5);f.flow+=vel(j)*k;f.weight+=k;`)}
 return f;
}
fn kind(n:f32)->f32 {return select(select(1.0,2.0,n>w.life.w),0.0,n<w.life.z);}
@fragment fn fragment(@builtin(position) at:vec4f)->Slots {
 let t=vec2u(at.xy);let slot=t.y*w.b.y+t.x;let pool=w.b.x;let dt=w.grid.z;
 if(slot>=pool){return Slots(vec4f(0),vec4f(0));}
 let total=level(w.e.z,vec2u(0));let spawn=min(total,pool);
 let k=(slot+pool-textureLoad(heads,vec2i(0),0).x)%pool;
 if(k<spawn){
  // Emitted particle e (spread evenly over all emitted ones when the pool is smaller), walked down the pyramid.
  var e=min(u32(f32(k)*(f32(total)/f32(spawn))),total-1u);var c=vec2u(0);
  for(var l=i32(w.e.z);l>0;l--){
   c*=2u;
   for(var n=0u;n<4u;n++){let q=c+vec2u(n&1u,n>>1u);let m=level(u32(l-1),q);if(e<m){c=q;break;}e-=m;}
  }
  let i=c.y*w.a.z+c.x;let packed=textureLoad(evenLevels,vec2i(c),0).x;
  let xf=pos(i);let vf=vel(i);let speed=length(vf);let vh=select(vec3f(0,1,0),vf/speed,speed>0.0);
  let a=select(vec3f(1,0,0),vec3f(0,0,1),abs(vh.x)>0.9);let e1=normalize(cross(vh,a));let e2=cross(vh,e1);
  // Uniform in the cylinder of radius r_V spanned by x_f and x_f + dt v_f (sqrt for a uniform disc).
  let r=u.eye.w*sqrt(rand(i,e*3u));let theta=6.283185307*rand(i,e*3u+1u);let h=rand(i,e*3u+2u);
  let side=r*cos(theta)*e1+r*sin(theta)*e2;let x=xf+side+h*dt*vf;
  let life=mix(w.life.x,w.life.y,f32(packed>>8u)/65535.0);
  return Slots(vec4f(x,life),vec4f(side+vf,kind(around(x).count)));
 }
 let p=textureLoad(positionsIn,vec2i(t),0);if(p.w<=0.0){return Slots(vec4f(0),vec4f(0));}
 var x=p.xyz;var v=textureLoad(velocitiesIn,vec2i(t),0).xyz;var life=p.w;
 let f=around(x);let type_=kind(f.count);let flow=select(v,f.flow/max(f.weight,1e-30),f.weight>0.0);
 if(type_<0.5){v+=dt*w.gravity.xyz;x+=dt*v;}
 else if(type_<1.5){if(f.weight>0.0){x+=dt*flow;}life-=dt;}
 else{v+=dt*(-w.motion.y*w.gravity.xyz)+select(vec3f(0),w.motion.z*(flow-v),f.weight>0.0);x+=dt*v;}
 if(life<=0.0||!(abs(x.x)+abs(x.y)+abs(x.z)<3.0e38)){return Slots(vec4f(0),vec4f(0));}
 return Slots(vec4f(x,life),vec4f(v,type_));
}
`;

/**
 * Diffuse sprites into a premultiplied rgba16float layer the composite lays over the liquid: hidden behind the scene,
 * dimmed by Beer-Lambert absorption for the path below the liquid surface.
 */
export const spriteShader = `${block}${params}
@group(0) @binding(3) var<uniform> w:W;
@group(0) @binding(4) var positionsIn:texture_2d<f32>;
@group(0) @binding(5) var velocitiesIn:texture_2d<f32>;
@group(0) @binding(6) var scene:texture_depth_2d;
@group(0) @binding(7) var surfaceDepth:texture_2d<f32>;
struct Sprite {@builtin(position) clip:vec4f,@location(0) corner:vec2f,@location(1) @interpolate(flat) center:vec4f}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Sprite {
 var o:Sprite;o.clip=vec4f(2,2,2,1);o.corner=vec2f(0);
 let t=vec2i(i32(i%w.b.y),i32(i/w.b.y));let p=textureLoad(positionsIn,t,0);
 let type_=textureLoad(velocitiesIn,t,0).w;o.center=vec4f(p.xyz,type_);
 let depth=dot(p.xyz-u.eye.xyz,u.forward.xyz);if(p.w<=0.0||depth<=0.0){return o;}
 let k=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[v];
 let up=select(vec3f(0,1,0),vec3f(1,0,0),abs(u.forward.y)>0.99);
 let right=normalize(cross(u.forward.xyz,up));let top=cross(right,u.forward.xyz);
 // At least one pixel across, so distant spray does not flicker out.
 let size=max(w.motion.w,depth*u.forward.w/u.viewport.w);
 o.corner=k;o.clip=u.viewProj*vec4f(p.xyz+(right*k.x+top*k.y)*size,1);return o;
}
@fragment fn fragment(i:Sprite)->@location(0) vec4f {
 let d=dot(i.corner,i.corner);if(d>1.0){discard;}
 let px=i.clip.xy;let c=i.center.xyz;let z=textureLoad(scene,vec2i(px),0);
 let toward=dot(c-u.eye.xyz,u.forward.xyz);
 if(z>0.0&&toward>dot(unproject(ndc(px),z)-u.eye.xyz,u.forward.xyz)){discard;}
 let s=textureLoad(surfaceDepth,vec2i(px),0).x;
 let ray=normalize(c-u.eye.xyz);let below=select(0.0,(toward-s)/max(dot(ray,u.forward.xyz),1e-3),s>0.0&&toward>s);
 let through=exp(-u.absorption.rgb*below);
 let alpha=w.look.a*(1.0-d*d);
 let light=w.look.rgb*(u.ambient.rgb+u.radiance.rgb*0.25)*through*alpha;
 return vec4f(light,alpha*(through.r+through.g+through.b)/3.0);
}
`;

/** The whitewater a ParticleLiquid owns: pool state, bucket grid and count pyramid, all GPU-resident. */
export class Whitewater {
  private uniform: GPUBuffer;
  private slotSteps: GPUBuffer[];
  private levelSteps: GPUBuffer[] = [];
  private readonly ints = new Uint32Array(40);
  private readonly floats = new Float32Array(this.ints.buffer);
  private pipelines: Record<string, GPURenderPipeline> = {};
  /** even slots, odd slots, bucket depth, normals, even levels, odd levels, head 0, head 1, place 0, motion 0, place 1, motion 1, layer. */
  private textures: GPUTexture[] = [];
  private groups: Record<string, GPUBindGroup | GPUBindGroup[]> = {};
  private bound: unknown[] = [];
  private storage?: GPUBuffer;
  private current = 0;
  private stepIndex = 0;
  private table = [0, 0, 0];
  private side = 1;
  private levels = 0;
  /** Pool slots and the side of the square texture holding them. */
  pool = 0;
  poolSide = 16;
  /** Passes, draws and groups of the last call, read by ParticleLiquid's frame stats. */
  passes = 0;
  draws = 0;
  groupsMade = 0;
  bytes = 0;

  constructor(private readonly device: GPUDevice) {
    this.uniform = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.slotSteps = Array.from({ length: SLOTS }, (_, k) => {
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Uint32Array([k, 0, 0, 0]));
      return b;
    });
    const make = (code: string, format: GPUTextureFormat, extra: Partial<GPURenderPipelineDescriptor> = {}) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
        ...extra,
      });
    };
    this.pipelines = {
      bucket: make(bucketShader, 'r32uint', {
        primitive: { topology: 'point-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      }),
      normals: make(normalShader, 'rgba32float'),
      potentials: make(potentialShader, 'r32uint'),
      reduce: make(reduceShader, 'r32uint'),
      head: make(headShader, 'r32uint'),
    };
    const update = device.createShaderModule({ code: updateShader });
    this.pipelines.update = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: update, entryPoint: 'vertex' },
      fragment: {
        module: update,
        entryPoint: 'fragment',
        targets: [{ format: 'rgba32float' }, { format: 'rgba32float' }],
      },
    });
    const over = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } as const;
    const sprite = device.createShaderModule({ code: spriteShader });
    this.pipelines.sprite = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: sprite, entryPoint: 'vertex' },
      fragment: {
        module: sprite,
        entryPoint: 'fragment',
        targets: [{ format: 'rgba16float', blend: { color: over, alpha: over } }],
      },
    });
  }

  /** Sizes the grid, pyramid and pool for `count` fluid particles and `pool` diffuse slots; true when reallocated. */
  private allocate(count: number, pool: number, width: number, height: number): boolean {
    const side = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))))));
    const e = Math.min(22, Math.max(10, Math.ceil(Math.log2(Math.max(1, 2 * count)))));
    const g = Math.ceil(e / 3),
      z = e - 2 * g;
    // Cells per axis G, slices Z = Sx * Sy, tiled Sx across: a G Sx by G Sy cell texture.
    const grid = [2 ** g, 2 ** Math.ceil(z / 2), 2 ** z];
    const tw = grid[0]! * grid[1]!,
      th = (grid[0]! * grid[2]!) / grid[1]!;
    const poolSide = Math.max(16, Math.ceil(Math.ceil(Math.sqrt(pool)) / 16) * 16);
    const layer = this.textures[12];
    if (
      this.side === side &&
      this.table.join() === grid.join() &&
      this.pool === pool &&
      layer?.width === width &&
      layer.height === height
    )
      return false;
    for (const t of this.textures) t.destroy();
    for (const b of this.levelSteps) b.destroy();
    const d = this.device,
      usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const make = (format: GPUTextureFormat, w: number, h: number) => d.createTexture({ size: [w, h], format, usage });
    const levels = Math.log2(side);
    const atlas = side + Math.max(1, side / 2);
    this.textures = [
      make('r32uint', tw * 4, th),
      make('r32uint', tw * 4, th),
      make('depth32float', tw * 4, th),
      make('rgba32float', side, side),
      make('r32uint', atlas, side),
      make('r32uint', atlas, side),
      make('r32uint', 1, 1),
      make('r32uint', 1, 1),
      make('rgba32float', poolSide, poolSide),
      make('rgba32float', poolSide, poolSide),
      make('rgba32float', poolSide, poolSide),
      make('rgba32float', poolSide, poolSide),
      make('rgba16float', width, height),
    ];
    this.levelSteps = Array.from({ length: levels }, (_, l) => {
      const b = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(b, 0, new Uint32Array([l + 1, 0, 0, 0]));
      return b;
    });
    Object.assign(this, { side, table: grid, pool, poolSide, levels, current: 0, stepIndex: 0 });
    this.fresh = true;
    return true;
  }
  /** The pool and head start empty: cleared on their first use after an allocation. */
  private fresh = true;

  /** The premultiplied whitewater layer of the last draw, for the composite. */
  get layer(): GPUTexture | undefined {
    return this.textures[12];
  }

  private velocityBuffer(c: { device: GPUDevice }, source: ParticleSource, count: number, upload: boolean): GPUBuffer {
    const p = source.velocities!;
    if (p instanceof Float32Array) {
      const stride = source.stride ?? 3,
        offset = source.velocityOffset ?? 0;
      const floats = count ? offset + (count - 1) * stride + 3 : 4;
      const bytes = Math.max(16, Math.ceil((floats * 4) / 16) * 16);
      if (!this.storage || this.storage.size < bytes) {
        this.storage?.destroy();
        this.storage = c.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        upload = true;
      }
      if (upload && count) {
        const length = Math.min(p.length, floats);
        c.device.queue.writeBuffer(this.storage, 0, p, 0, length);
        this.bytes += length * 4;
      }
      return this.storage;
    }
    return typeof (p as GPUBuffer).getMappedRange === 'function'
      ? (p as GPUBuffer)
      : (p as { buffer: GPUBuffer }).buffer;
  }

  /**
   * Records one whitewater step (when `step`) and the sprite layer. `main` is ParticleLiquid's uniform, `positions`
   * its particle buffer and `surface` its filtered depth.
   */
  record(
    c: {
      device: GPUDevice;
      encoder: GPUCommandEncoder;
      width: number;
      height: number;
      view?: { viewport?: readonly number[] };
    },
    o: WhitewaterOptions,
    radius: number,
    source: ParticleSource,
    count: number,
    main: GPUBuffer,
    positions: GPUBuffer,
    sceneDepth: GPUTexture,
    surface: GPUTexture,
    step: boolean,
  ): void {
    this.passes = this.draws = this.groupsMade = this.bytes = 0;
    const pool = o.maxParticles ?? 65536;
    this.allocate(count, pool, c.width, c.height);
    const velocities = this.velocityBuffer(c, source, count, step);
    const t = this.textures as GPUTexture[];
    const [even, odd, bucketDepth, normals, evenLevels, oddLevels] = t as [
      GPUTexture,
      GPUTexture,
      GPUTexture,
      GPUTexture,
      GPUTexture,
      GPUTexture,
    ];
    const key = [positions, velocities, sceneDepth, surface, main, t[0]];
    if (key.length !== this.bound.length || key.some((k, i) => k !== this.bound[i])) {
      this.bound = key;
      this.build(main, positions, velocities, sceneDepth, surface);
    }
    const g = this.groups as Record<string, GPUBindGroup[]>;
    const run = (
      pipeline: GPURenderPipeline,
      bind: GPUBindGroup,
      targets: GPURenderPassColorAttachment[],
      vertices: number,
      instances = 1,
      depth?: GPURenderPassDepthStencilAttachment,
      viewport?: readonly [number, number, number, number],
    ) => {
      const pass = c.encoder.beginRenderPass({ colorAttachments: targets, depthStencilAttachment: depth });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      if (viewport) {
        pass.setViewport(viewport[0], viewport[1], viewport[2], viewport[3], 0, 1);
        pass.setScissorRect(viewport[0], viewport[1], viewport[2], viewport[3]);
      }
      pass.draw(vertices, instances);
      pass.end();
      this.passes++;
      this.draws++;
    };
    const target = (texture: GPUTexture, clear: boolean): GPURenderPassColorAttachment => ({
      view: texture.createView(),
      loadOp: clear ? 'clear' : 'load',
      storeOp: 'store',
      clearValue: [0, 0, 0, 0],
    });
    if (this.fresh) {
      // Empty pool and head 0 (one clear pass each, once per allocation).
      for (const i of [6, 7, 8, 9, 10, 11]) {
        c.encoder.beginRenderPass({ colorAttachments: [target(t[i]!, true)] }).end();
        this.passes++;
      }
      this.fresh = false;
    }
    this.write(o, radius, count, pool, source.stride ?? 3, source.velocityOffset ?? 0);
    if (step && count > 0) {
      // 1. Bucket grid: one point draw per slot.
      for (let k = 0; k < SLOTS; k++)
        run(this.pipelines.bucket!, g.bucket![k]!, [target(k & 1 ? odd : even, k < 2)], count, 1, {
          view: bucketDepth.createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
          depthClearValue: 1,
        });
      // 2. Normals, 3. potentials into pyramid level 0, 4. the pyramid.
      const s = this.side;
      run(this.pipelines.normals!, g.normals![0]!, [target(normals, true)], 3);
      run(this.pipelines.potentials!, g.potentials![0]!, [target(evenLevels, true)], 3, 1, undefined, [0, 0, s, s]);
      for (let l = 1; l <= this.levels; l++) {
        const size = s >> l;
        run(
          this.pipelines.reduce!,
          g.reduce![l - 1]!,
          [target(l & 1 ? oddLevels : evenLevels, l === 1)],
          3,
          1,
          undefined,
          [s, s - 2 * size, size, size],
        );
      }
      // 5. Every slot steps or spawns, 6. the ring head moves on.
      const cur = this.current;
      run(this.pipelines.update!, g.update![cur]!, [target(t[10 - 2 * cur]!, true), target(t[11 - 2 * cur]!, true)], 3);
      run(this.pipelines.head!, g.head![this.stepIndex & 1]!, [target(t[7 - (this.stepIndex & 1)]!, true)], 3);
      this.current = 1 - cur;
      this.stepIndex++;
    }
    // 7. Sprites into the layer the composite reads.
    const pass = c.encoder.beginRenderPass({ colorAttachments: [target(t[12]!, true)] });
    pass.setPipeline(this.pipelines.sprite!);
    pass.setBindGroup(0, g.sprite![this.current]!);
    applyView(pass, c as never);
    pass.draw(6, pool);
    pass.end();
    this.passes++;
    this.draws++;
  }

  private build(
    main: GPUBuffer,
    positions: GPUBuffer,
    velocities: GPUBuffer,
    sceneDepth: GPUTexture,
    surface: GPUTexture,
  ) {
    const d = this.device,
      p = this.pipelines,
      t = this.textures,
      view = (i: number) => t[i]!.createView();
    // Bindings by number; a pass lists only those its shader reads (auto layouts drop the others).
    const bind = (pipeline: GPURenderPipeline, entries: Record<number, GPUBindingResource>) => {
      this.groupsMade++;
      return d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: Object.entries(entries).map(([binding, resource]) => ({ binding: +binding, resource })),
      });
    };
    const m = { buffer: main },
      u = { buffer: this.uniform },
      points = { buffer: positions },
      speeds = { buffer: velocities };
    const grid = { 0: m, 1: points, 3: u, 4: view(0), 5: view(1) };
    this.groups = {
      bucket: this.slotSteps.map((s, k) =>
        bind(p.bucket!, { 0: m, 1: points, 2: u, 3: { buffer: s }, 4: view(k & 1 ? 0 : 1) }),
      ),
      normals: [bind(p.normals!, grid)],
      potentials: [bind(p.potentials!, { ...grid, 2: speeds, 6: view(3) })],
      reduce: this.levelSteps.map((s, l) => bind(p.reduce!, { 3: u, 4: { buffer: s }, 5: view(l & 1 ? 5 : 4) })),
      head: [0, 1].map((h) => bind(p.head!, { 3: u, 6: view(6 + h), 7: view(4), 8: view(5) })),
      update: [0, 1].map((cur) =>
        bind(p.update!, {
          ...grid,
          2: speeds,
          6: view(6 + cur),
          7: view(4),
          8: view(5),
          9: view(8 + 2 * cur),
          10: view(9 + 2 * cur),
        }),
      ),
      sprite: [0, 1].map((cur) =>
        bind(p.sprite!, {
          0: m,
          3: u,
          4: view(8 + 2 * cur),
          5: view(9 + 2 * cur),
          6: sceneDepth.createView({ aspect: 'depth-only' }),
          7: surface.createView(),
        }),
      ),
    };
  }

  private write(
    o: WhitewaterOptions,
    radius: number,
    count: number,
    pool: number,
    stride: number,
    velocityOffset: number,
  ): void {
    const i = this.ints,
      f = this.floats,
      h = o.support ?? 4 * radius;
    i.fill(0);
    i.set([this.table[0]!, this.table[1]!, this.side, count], 0);
    i.set([pool, this.poolSide, stride, velocityOffset], 4);
    i.set([this.stepIndex, o.seed ?? 0, this.levels, this.table[2]!], 8);
    f.set([h / 2, h, o.timeStep ?? 1 / 60, o.surfaceThreshold ?? 0.25], 12);
    f.set([...(o.trappedAir ?? [5, 20]), ...(o.waveCrest ?? [2, 8])], 16);
    f.set([...(o.kineticEnergy ?? [5, 50]), o.trappedAirRate ?? 100, o.waveCrestRate ?? 100], 20);
    const mass = o.particleMass ?? 1000 * (2 * radius) ** 3;
    f.set([mass, o.buoyancy ?? 2, o.drag ?? 0.8, o.radius ?? 0.25 * radius], 24);
    f.set([...(o.gravity ?? [0, -9.81, 0]), 0], 28);
    f.set([...(o.lifetime ?? [2, 6]), o.sprayNeighbours ?? 6, o.bubbleNeighbours ?? 20], 32);
    f.set([...(o.color ?? [1, 1, 1]), o.opacity ?? 0.7], 36);
    this.device.queue.writeBuffer(this.uniform, 0, i);
    this.bytes += i.byteLength;
  }

  /** Live diffuse particles by type, read back from the pool. */
  async read(signal?: AbortSignal): Promise<{ spray: number; foam: number; bubbles: number }> {
    if (!this.textures.length) return { spray: 0, foam: 0, bubbles: 0 };
    const d = this.device,
      side = this.poolSide,
      bytes = side * side * 16;
    const copies = [8 + 2 * this.current, 9 + 2 * this.current].map((index) => {
      const buffer = d.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      return { index, buffer };
    });
    const encoder = d.createCommandEncoder();
    for (const { index, buffer } of copies)
      encoder.copyTextureToBuffer({ texture: this.textures[index]! }, { buffer, bytesPerRow: side * 16 }, [side, side]);
    d.queue.submit([encoder.finish()]);
    try {
      await Promise.all(copies.map((c) => c.buffer.mapAsync(GPUMapMode.READ)));
      signal?.throwIfAborted();
      const place = new Float32Array(copies[0]!.buffer.getMappedRange());
      const motion = new Float32Array(copies[1]!.buffer.getMappedRange());
      const out = { spray: 0, foam: 0, bubbles: 0 };
      for (let s = 0; s < this.pool; s++) {
        if (!(place[s * 4 + 3]! > 0)) continue;
        const type = motion[s * 4 + 3]!;
        if (type < 0.5) out.spray++;
        else if (type < 1.5) out.foam++;
        else out.bubbles++;
      }
      return out;
    } finally {
      for (const c of copies) c.buffer.destroy();
    }
  }

  destroy(): void {
    for (const x of this.textures) x.destroy();
    for (const b of [...this.slotSteps, ...this.levelSteps, this.uniform]) b.destroy();
    this.storage?.destroy();
    this.textures = [];
    this.bound = [];
  }
}
