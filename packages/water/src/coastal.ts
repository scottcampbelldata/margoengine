import { group, compute } from '../../shared/gpu.js';
import type { RiverKernels } from './query-state.js';
import { swellAtWave, swellWaves } from './swell-wgsl.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_SRC: number; COPY_DST: number };
declare const GPUBufferUsage: { STORAGE: number; COPY_SRC: number; UNIFORM: number; COPY_DST: number };
export const waterFrame = `
struct Wave {wave:vec4f,shape:vec4f}
struct Light {direction:vec4f,radiance:vec4f}
struct Frame {camera:mat4x4f,eye:vec4f,settings:vec4f,color:vec4f,cameraData:vec4f,waves:array<Wave,8>,coast:vec4f,flow:vec4f,sun:vec4f,radiance:vec4f,lights:array<Light,2>,grid:vec4f,foam:vec4f,shallow:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
// Use the unused alpha of each light's RGB radiance for the shared HDR sky transform.
fn hdrSkyTurn()->f32 {return frame.lights[0].radiance.w;}
fn hdrSkyScale()->f32 {return frame.lights[1].radiance.w;}
`;
// Margo's swell (swell-wgsl.ts) on the frame's wave clock.
export const oceanWaves =
  swellWaves +
  `
fn swell(w:Wave,xz:vec2f,index:u32,sampleWidth:f32)->Swell {return swellAt(w,xz,index,sampleWidth,frame.settings.x);}`.slice(
    1,
  ) +
  swellAtWave;
/**
 * The surf (surf.ts) as CoastalFlow takes it from Water, so entries that build no surf (water/rivers) never bundle it:
 * its WGSL, the `connected` buffer words it needs for a map of `cells` cells and its field builder.
 */
export interface CoastSurf {
  readonly waves: string;
  words(cells: number): number;
  build(device: GPUDevice, uniform: GPUBuffer, terrain: GPUTexture, connected: GPUBuffer, frame: string): SurfBuilder;
  /** Frames of three steps the flow spins up for before its first frame (surf.ts `SURF_SPIN`). */
  readonly spinFrames: number;
}
/**
 * The compute pass to record the next dispatch of `groups` workgroups into (all of a grid's when not given). The first
 * step hands out a new command buffer whenever the one it fills would pass {@link SETUP_WORKGROUPS}.
 */
export type NextPass = (groups?: number) => GPUComputePassEncoder;
/** The surf field's builder and the spin-up clock it keeps in the `connected` buffer (surf.ts). */
interface SurfBuilder {
  build(next: NextPass, width: number, height: number): void;
  clock(pass: GPUComputePassEncoder, phase: 0 | 1 | 2): void;
}
/**
 * The most workgroups one command buffer of the first step's set-up holds: 64 dispatches over a 512 x 512 grid. The
 * set-up (topology, surf field, spin-up) is about 4,600 dispatches there; recorded into the frame's one command buffer
 * it held the GPU 4.4 s on an Intel xe-2lpg laptop GPU, past the 2 s Windows lets one submission run before it resets
 * the device (KB-SCENES-DUNE-ARCHANG1). The same commands in order, in submissions of under 90 ms there.
 */
export const SETUP_WORKGROUPS = 1 << 18;
// The sea a coastal cell is driven toward with the surf: (surface height, relaxation weight, flux); see surfSea.
const surfOcean = (waves: string) =>
  oceanWaves +
  waves +
  `
fn oceanHeight(p:vec2i,size:vec2i,ground:f32)->vec4f{
 surfShift=surfClock(u32(size.x*size.y)).x;
 return surfSea(frame.coast.xy+(vec2f(p)+0.5)/vec2f(size)*frame.coast.zw,ground,size,length(frame.flow.yz));
}
// The flow's step: the frame's, or the spin-up's while the surf spins the flow up (surf.ts).
fn coastStep(size:vec2i)->f32 {let s=surfClock(u32(size.x*size.y)).y;return select(frame.flow.x,s,s>0.0);}
`;
// The same without the surf (still water, water/rivers): the swell, faded in from 2.4 to 0.65 m of depth.
const deepSea =
  oceanWaves +
  `
fn oceanHeight(p:vec2i,size:vec2i,ground:f32)->vec4f{
 let xz=frame.coast.xy+(vec2f(p)+0.5)/vec2f(size)*frame.coast.zw;
 var h=frame.settings.y;
 for(var j=0u;j<u32(frame.settings.w);j++){
  for(var c=0u;c<3u;c++){let s=swell(frame.waves[j],xz,c,length(frame.flow.yz));h+=s.amplitude*sin(s.phase);}
 }return vec4f(h,smoothstep(0.65,2.4,frame.settings.y-ground),0.0,0.0);
}
`;
const initialize =
  waterFrame +
  `
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var state:texture_storage_2d<rgba32float,write>;
@group(0) @binding(3) var flux:texture_storage_2d<rgba32float,write>;
@group(0) @binding(4) var<storage,read_write> connected:array<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(state);if(any(id.xy>=size)){return;}
 let p=vec2i(id.xy);let ground=textureLoad(terrain,p,0).r;
 let index=id.y*size.x+id.x+1u;let edge=id.x==0u||id.y==0u||id.x==size.x-1u||id.y==size.y-1u;
 connected[index]=select(select(index,0u,edge),0xffffffffu,ground>=frame.settings.y);
 textureStore(state,p,vec4f(max(0.0,frame.settings.y-ground),ground,0,0));textureStore(flux,p,vec4f(0));
}`;
// Standing water from `WaterOptions.fill`, written over the initial state: depth up to the fill's surface. A cell keeps
// that surface in w even when its ground stands above it; a still surface reads it there (`STILL` in the water shader).
const prefill =
  waterFrame +
  `
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var fill:texture_2d<f32>;
@group(0) @binding(3) var state:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(state);if(any(id.xy>=size)){return;}
 let p=vec2i(id.xy);let ground=textureLoad(terrain,p,0).r;let level=textureLoad(fill,p,0).r;
 textureStore(state,p,vec4f(max(max(0.0,frame.settings.y-ground),level-ground),ground,0,level));
}`;
const topology = `
@group(0) @binding(0) var terrain:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> connected:array<atomic<u32>>;
fn root(index:u32)->u32 {
 var p=index;
 loop {let next=atomicLoad(&connected[p]);if(next==p){break;}atomicMin(&connected[p],atomicLoad(&connected[next]));p=next;}
 return p;
}
fn join(a:u32,b:u32){
 var x=a;var y=b;
 loop {x=root(x);y=root(y);if(x==y){return;}let high=max(x,y);let low=min(x,y);let previous=atomicMin(&connected[high],low);if(previous==high){return;}
  // Retry the displaced parent too, preserving its component when another thread links the root first.
  x=previous;y=low;
 }
}
@compute @workgroup_size(8,8) fn connect(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(terrain);if(any(id.xy>=size)){return;}let index=id.y*size.x+id.x+1u;if(atomicLoad(&connected[index])==0xffffffffu){return;}
 if(id.x>0u&&atomicLoad(&connected[index-1u])!=0xffffffffu){join(index,index-1u);}
 if(id.y>0u&&atomicLoad(&connected[index-size.x])!=0xffffffffu){join(index,index-size.x);}
}
@compute @workgroup_size(8,8) fn compress(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(terrain);if(any(id.xy>=size)){return;}let index=id.y*size.x+id.x+1u;if(atomicLoad(&connected[index])!=0xffffffffu){atomicStore(&connected[index],root(index));}
}`;
// Water's coast flow: the shallow-water momentum equation on the staggered grid of the heightmap, depth at the cells
// and the discharge q (m^2/s) at the faces, in the momentum-conservative form of G. S. Stelling and S. P. A. Duinmeijer,
// "A staggered conservative scheme for every Froude number in rapidly varied shallow water flows", International Journal
// for Numerical Methods in Fluids 43(12), 2003, https://doi.org/10.1002/fld.537 (its q-form, the advection of momentum
// q u through the cells beside a face and through its corners, u* upwind of each cell's mean discharge). Each face
// takes the local inertial step of P. D. Bates, M. S. Horritt and T. J. Fewtrell, "A simple inertial formulation of the
// shallow water equations for efficient two-dimensional flood inundation modelling", Journal of Hydrology 387(1-2),
// 2010, https://doi.org/10.1016/j.jhydrol.2010.03.027: its flow depth, the higher surface over the higher bed, gives a
// face its velocity q / h and stops a dry face, and its pressure is the mean depth of the two cells over the face's bed,
// which on a flat bed differences g h^2 / 2 and so conserves momentum through a bore. Along the face u* has Koren's limited
// second-order slope (B. Koren, "A robust upwind discretization method for advection, diffusion and source terms", in
// Numerical Methods for Advection-Diffusion Problems, Vieweg 1993); across it, first order. Manning friction, n = 0.02 for
// a sand bed (V. T. Chow, "Open-Channel Hydraulics", 1959, table 5-6), is semi-implicit in the form of Chertock, Cui,
// Kurganov and Wu 2015 (https://doi.org/10.1002/fld.4023): at 5 cm of swash it is a drag coefficient of 0.011, within the
// 0.007 uprush and up to three times that backwash coefficients measured on a sandy beach (J. A. Puleo and K. T. Holland,
// "Estimating swash zone friction coefficients on a sandy beach", Coastal Engineering 43(1), 2001,
// https://doi.org/10.1016/S0378-3839(01)00004-7). A face's speed stays within the Courant-Friedrichs-Lewy bound of half
// a cell per step (Courant, Friedrichs & Lewy 1928), so a fall of any height stays bounded (KB5736a).
//
// It replaced a virtual pipe (O'Brien & Hodgins 1995) that drove each cell's outflow by its own depth alone, carried no
// momentum and decayed every flow by 0.12 a second (KB-WATER-SWASH1): on the NOAA solitary-wave case (Synolakis 1987,
// R / d = 0.0861) it ran up 0.0129, 85% short, and a 1 m swell on a 1:50 beach ran its swash 0.014 to 0.042 m up the sand
// where Stockdon et al. 2006 give 0.24 m. This scheme runs the NOAA case up 0.0874 and carries a dam-break bore at
// Stoker's speed within 0.3% (test/coast-runup.test.js), and the swell 0.126 m up the sand (test/surf.browser.mjs).
//
// The faces are stored as Water reads them: each cell's (west, east, south, north) outflows, >= 0, so a face's discharge
// is the east (north) outflow of the cell below it less the west (south) outflow of the cell above. Every cell works out
// its four faces from the same function and arguments its neighbours use, then keeps its outflows and limits them
// together so it cannot spend more water than it holds.
// The coast flow kernel; with \`sea\` (surfOcean) the surf's relaxation zone also drives the flux and the surf's
// spin-up sets the step.
const coastFlow = (sea = '') =>
  waterFrame +
  sea +
  `
@group(0) @binding(1) var state:texture_2d<f32>;
@group(0) @binding(2) var previous:texture_2d<f32>;
@group(0) @binding(3) var next:texture_storage_2d<rgba32float,write>;
${sea ? '@group(0) @binding(4) var<storage,read> connected:array<u32>;' : ''}
// Depth (m) under which a face carries nothing, and Manning's n (s m^-1/3).
const COAST_DRY=1e-4;
const COAST_MANNING=0.02;
var<private> coastGrid:vec2i;
fn axisStep(axis:i32)->vec2i {return select(vec2i(0,1),vec2i(1,0),axis==0);}
fn axisLength(axis:i32)->f32 {return select(frame.flow.z,frame.flow.y,axis==0);}
fn inside(p:vec2i,n:vec2i)->bool {return all(p>=vec2i(0))&&all(n<coastGrid);}
// The discharge (m^2/s) across the face on the +axis side of cell p; 0 at the grid's edge.
fn faceQ(p:vec2i,axis:i32)->f32 {
 let n=p+axisStep(axis);if(!inside(p,n)){return 0.0;}
 let a=textureLoad(previous,p,0);let b=textureLoad(previous,n,0);return select(a.w-b.z,a.y-b.x,axis==0);
}
// The flow depth there (Bates et al. 2010): the higher surface over the higher bed.
fn faceDepth(p:vec2i,axis:i32)->f32 {
 let n=p+axisStep(axis);if(!inside(p,n)){return 0.0;}
 let a=textureLoad(state,p,0);let b=textureLoad(state,n,0);return max(a.x+a.y,b.x+b.y)-max(a.y,b.y);
}
fn faceU(p:vec2i,axis:i32)->f32 {let h=faceDepth(p,axis);return select(0.0,faceQ(p,axis)/h,h>COAST_DRY);}
// Koren's limited half slope from the upwind difference d1 and the downwind d2.
fn koren(d1:f32,d2:f32)->f32 {if(abs(d1)<1e-12){return 0.0;}let r=d2/d1;return 0.5*d1*max(0.0,min(min(2.0*r,(1.0+2.0*r)/3.0),2.0));}
// The new discharge across the face on the +axis side of cell p over a step of dt. Its neighbours' velocities come
// from one loop and the two cells' u* from another, so a compiler that inlines every call (HLSL under the WebGL2
// layer's ANGLE) makes one copy of faceU, not 17 (KB-WATER-SURFCOMPILE1).
fn faceStep(p:vec2i,axis:i32,dt:f32)->f32 {
 let e=axisStep(axis);let t=axisStep(1-axis);let n=p+e;if(!inside(p,n)){return 0.0;}
 let a=textureLoad(state,p,0);let b=textureLoad(state,n,0);let za=a.x+a.y;let zb=b.x+b.y;
 let bed=max(a.y,b.y);let h=max(za,zb)-bed;if(h<=COAST_DRY){return 0.0;}
 // Velocities of the faces along this one, 2 back to 2 on (0 to 4, this face 2), and of the faces beside it across (5, 6).
 var u:array<f32,7>;
 for(var k=0;k<7;k++){u[k]=faceU(select(p+(k-2)*e,p+select(-t,t,k==6),k>4),axis);}
 let q=faceQ(p,axis);let along=axisLength(axis);let across=axisLength(1-axis);
 // Momentum carried along, through the two cells beside the face, by their mean discharges: each cell's u* is the
 // velocity of its face upwind of its mean discharge, with Koren's slope.
 var mean=array<f32,2>(0.5*(faceQ(p-e,axis)+q),0.5*(q+faceQ(n,axis)));var star:array<f32,2>;
 for(var c=0;c<2;c++){
  let w=c+1;
  if(mean[c]>0.0){star[c]=u[w]+koren(u[w]-u[w-1],u[w+1]-u[w]);}else{star[c]=u[w+1]+koren(u[w+1]-u[w+2],u[w]-u[w+1]);}
 }
 var flux=(mean[1]*star[1]-mean[0]*star[0])/along;
 // And across, through the corners, by the cross discharges of the two cells there, first-order upwind.
 let qn=0.5*(faceQ(p,1-axis)+faceQ(n,1-axis));let qs=0.5*(faceQ(p-t,1-axis)+faceQ(n-t,1-axis));
 flux+=(qn*select(u[6],u[2],qn>0.0)-qs*select(u[2],u[5],qs>0.0))/across;
 // The pressure of the mean depth over the face's bed: on a flat bed g h (zb - za) is then the difference of g h^2 / 2,
 // so a bore keeps its Rankine-Hugoniot speed (Stoker 1957); the flow depth h alone ran it 6% fast.
 let pressure=0.5*(max(0.0,za-bed)+max(0.0,zb-bed));
 var moved=q-dt*flux-dt*9.81*pressure*(zb-za)/along;
 moved/=1.0+dt*9.81*COAST_MANNING*COAST_MANNING*abs(moved)/pow(h,2.3333333);
 let cap=h*0.5*min(frame.flow.y,frame.flow.z)/dt;return clamp(moved,-cap,cap);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 coastGrid=vec2i(textureDimensions(state));let size=coastGrid;let p=vec2i(id.xy);if(any(p>=size)){return;}
 let v=textureLoad(state,p,0);let dt=${sea ? 'coastStep(size)' : 'frame.flow.x'};
 // The cell's outflows (west, east, south, north) from its four faces, in one loop (one copy of faceStep).
 var out:array<f32,4>;
 for(var k=0;k<4;k++){let axis=k/2;let back=k%2==0;let f=faceStep(select(p,p-axisStep(axis),back),axis,dt);out[k]=max(0.0,select(f,-f,back));}
 var q=vec4f(out[0],out[1],out[2],out[3]);
${
  sea
    ? ` // The surf's relaxation zone drives the flux toward the swell's (surfSea; none until the surf field is built).
 if(connected[u32(p.y*size.x+p.x)+1u]==0u&&surfReady(u32(size.x*size.y))){
  let sea=oceanHeight(p,size,v.y);
  q=mix(q,vec4f(max(0.0,-sea.z),max(0.0,sea.z),max(0.0,-sea.w),max(0.0,sea.w)),(1.0-exp(-dt*4.0))*sea.y);
  // The drive moves water only across a wet face, as faceStep does: a face whose higher surface is below its higher bed
  // carries nothing, so the swell cannot push the sea up onto ground above it (it flooded an enclosed basin over a 2 m
  // bank while the sea beside it stood at 0.74 m, test/flow.browser.mjs).
  for(var k=0;k<4;k++){let axis=k/2;if(faceDepth(select(p,p-axisStep(axis),k%2==0),axis)<=COAST_DRY){q[k]=0.0;}}
 }
`
    : ''
} if(p.x==0){q.x=0;}if(p.x==size.x-1){q.y=0;}if(p.y==0){q.z=0;}if(p.y==size.y-1){q.w=0;}
 // Limit the complete outflow together so a cell cannot spend more water than it owns.
 let outgoing=(q.x+q.y)/frame.flow.y+(q.z+q.w)/frame.flow.z;
 q*=min(1.0,v.x/max(0.000001,dt*outgoing));textureStore(next,p,q);
}`;
// \`dt\` and \`inflow\` (a binding-5 source term, water/rivers) let an optional solver reuse this step unchanged; \`sea\`
// is the coast's surf (the default, deepSea, keeps the surf out of solvers that build no surf field).
export const integrateShader = (dt = 'frame.flow.x', inflow = '', sea = deepSea) =>
  waterFrame +
  sea +
  inflow +
  `
@group(0) @binding(1) var state:texture_2d<f32>;
@group(0) @binding(2) var flux:texture_2d<f32>;
@group(0) @binding(3) var next:texture_storage_2d<rgba32float,write>;
@group(0) @binding(4) var<storage,read> connected:array<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(state));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let v=textureLoad(state,p,0);let q=textureLoad(flux,p,0);let dt=${dt};
 var incoming=vec4f(0);
 if(p.x>0){incoming.x=textureLoad(flux,p-vec2i(1,0),0).y;}
 if(p.x<size.x-1){incoming.y=textureLoad(flux,p+vec2i(1,0),0).x;}
 if(p.y>0){incoming.z=textureLoad(flux,p-vec2i(0,1),0).w;}
 if(p.y<size.y-1){incoming.w=textureLoad(flux,p+vec2i(0,1),0).z;}
 var h=max(0.0,v.x+dt*((incoming.x+incoming.y-q.x-q.y)/frame.flow.y+(incoming.z+incoming.w-q.z-q.w)/frame.flow.z)${inflow ? '+dt*inflow(p,size)' : ''});
 // Drive open sea near every beach; isolated basins retain conservative flow.
 let seaCell=connected[id.y*u32(size.x)+id.x+1u]==0u;let boundary=p.x==0||p.y==0||p.x==size.x-1||p.y==size.y-1;
 if(seaCell||boundary){
  let sea=oceanHeight(p,size,v.y);
  if(seaCell){h=mix(h,max(0.0,sea.x-v.y),(1.0-exp(-dt*4.0))*sea.y);}
  if(boundary){h=max(0.0,sea.x-v.y);}
 }
 var carried=v.x*v.z;
 if(p.x>0){carried+=dt*incoming.x*textureLoad(state,p-vec2i(1,0),0).z/frame.flow.y;}
 if(p.x<size.x-1){carried+=dt*incoming.y*textureLoad(state,p+vec2i(1,0),0).z/frame.flow.y;}
 if(p.y>0){carried+=dt*incoming.z*textureLoad(state,p-vec2i(0,1),0).z/frame.flow.z;}
 if(p.y<size.y-1){carried+=dt*incoming.w*textureLoad(state,p+vec2i(0,1),0).z/frame.flow.z;}
 carried-=dt*v.z*((q.x+q.y)/frame.flow.y+(q.z+q.w)/frame.flow.z);
 let velocity=vec2f(q.y-q.x+incoming.x-incoming.y,q.w-q.z+incoming.z-incoming.w)/max(0.04,2.0*h);
 let froude=length(velocity)/sqrt(9.81*max(0.03,h));
 let breaker=smoothstep(0.45,1.0,froude)*smoothstep(0.01,0.08,h)*(1.0-smoothstep(0.8,1.8,h));
 let foam=max(clamp(carried/max(0.003,h),0.0,1.0)*exp(-dt*0.8),breaker);
 textureStore(next,p,vec4f(h,v.y,foam,breaker));
}`;
/** Water's own coast flow kernel (water/rivers swaps in its reconstructed pipe). */
export const coastFlowShader = coastFlow();
const integrate = integrateShader();

/** The fill texel value of a cell with no fill: below any water surface. */
export const NO_FILL = -1e30;

/** Conservative shore flow; connected offshore cells supply waves while inland basins retain volume. */
export class CoastalFlow {
  readonly states: GPUTexture[] = [];
  readonly views: GPUTextureView[] = [];
  readonly fluxes: GPUTexture[] = [];
  readonly connected: GPUBuffer;
  private readonly flowGroups: GPUBindGroup[] = [];
  private readonly integrateGroups: GPUBindGroup[] = [];
  private readonly initializer: GPUComputePipeline;
  private readonly flowing: GPUComputePipeline;
  private readonly integrating: GPUComputePipeline;
  private readonly initialGroup: GPUBindGroup;
  private readonly connector: GPUComputePipeline;
  private readonly compressor: GPUComputePipeline;
  private readonly connectGroup: GPUBindGroup;
  private readonly compressGroup: GPUBindGroup;
  private readonly descriptor: GPUComputePassDescriptor = {};
  private initialized = false;
  private readonly fillTexture?: GPUTexture;
  private readonly filling?: GPUComputePipeline;
  private readonly fillGroup?: GPUBindGroup;
  // The surf field (surf.ts), built with the topology; open-sea flow only, not still water or rivers.
  private readonly surf?: SurfBuilder;
  // Frames of three steps it spins up for before its first frame (KB-WATER-SWASH1).
  private readonly spinFrames: number = 0;
  current = 0;
  private readonly device: GPUDevice;
  private sources?: GPUBuffer;
  constructor(
    device: GPUDevice,
    uniform: GPUBuffer,
    readonly terrain: GPUTexture,
    // Fill surface per texel (`NO_FILL` for none), rows of increasing z; without it the terrain's sea level alone.
    fill?: Float32Array,
    // No flow: the first step's state stands.
    private readonly still = false,
    // water/rivers: steep-bed flow, sources and substeps in place of the coastal ones.
    readonly river?: RiverKernels,
    // Breaking surf on open-sea shores (Water passes surf.ts); unused for still water and rivers.
    coastSurf?: CoastSurf,
  ) {
    this.device = device;
    try {
      const cells = terrain.width * terrain.height,
        surf = still || river ? undefined : coastSurf;
      this.connected = device.createBuffer({
        size: (surf ? surf.words(cells) : cells + 1) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      for (let i = 0; i < 2; i++) {
        this.states.push(
          device.createTexture({
            size: [terrain.width, terrain.height],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
          }),
        );
        this.fluxes.push(
          device.createTexture({
            size: [terrain.width, terrain.height],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
          }),
        );
      }
      this.views = this.states.map((t) => t.createView());
      const fluxViews = this.fluxes.map((t) => t.createView());
      this.initializer = compute(device, initialize);
      const sea = surf && surfOcean(surf.waves);
      this.flowing = compute(device, river?.flow ?? (sea ? coastFlow(sea) : coastFlowShader));
      this.integrating = compute(
        device,
        river?.integrate ?? (sea ? integrateShader('coastStep(size)', '', sea) : integrate),
      );
      if (river) {
        this.sources = device.createBuffer({
          size: river.sources.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      const topologyModule = device.createShaderModule({ code: topology });
      this.connector = device.createComputePipeline({
        layout: 'auto',
        compute: { module: topologyModule, entryPoint: 'connect' },
      });
      this.compressor = device.createComputePipeline({
        layout: 'auto',
        compute: { module: topologyModule, entryPoint: 'compress' },
      });
      this.connectGroup = group(device, this.connector, [terrain.createView(), { buffer: this.connected }]);
      this.surf = surf?.build(device, uniform, terrain, this.connected, waterFrame);
      this.spinFrames = surf?.spinFrames ?? 0;
      this.compressGroup = group(device, this.compressor, [terrain.createView(), { buffer: this.connected }]);
      this.initialGroup = group(device, this.initializer, [
        { buffer: uniform },
        terrain.createView(),
        this.views[0],
        fluxViews[0],
        { buffer: this.connected },
      ]);
      if (fill) {
        this.fillTexture = device.createTexture({
          size: [terrain.width, terrain.height],
          format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture: this.fillTexture },
          fill as Float32Array<ArrayBuffer>,
          { bytesPerRow: terrain.width * 4, rowsPerImage: terrain.height },
          [terrain.width, terrain.height],
        );
        this.filling = compute(device, prefill);
        this.fillGroup = group(device, this.filling, [
          { buffer: uniform },
          terrain.createView(),
          this.fillTexture.createView(),
          this.views[0],
        ]);
      }
      for (let i = 0; i < 2; i++) {
        this.flowGroups.push(
          group(device, this.flowing, [
            { buffer: uniform },
            this.views[i],
            fluxViews[i],
            fluxViews[1 - i],
            ...(sea ? [{ buffer: this.connected }] : []),
          ]),
        );
        this.integrateGroups.push(
          group(device, this.integrating, [
            { buffer: uniform },
            this.views[i],
            fluxViews[1 - i],
            this.views[1 - i],
            { buffer: this.connected },
            ...(this.sources ? [{ buffer: this.sources }] : []),
          ]),
        );
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  step(encoder: GPUCommandEncoder): void {
    if (this.still && this.initialized) return;
    const x = Math.ceil(this.terrain.width / 8),
      y = Math.ceil(this.terrain.height / 8);
    if (!this.initialized) this.setUp(x, y);
    if (this.still) return;
    const pass = encoder.beginComputePass(this.descriptor),
      next = () => pass;
    if (this.river) this.device.queue.writeBuffer(this.sources!, 0, this.river.sources as Float32Array<ArrayBuffer>);
    // shortcut: three substeps suit coastal cells >= 0.5m, increase substeps for finer maps.
    for (let i = 0; i < (this.river?.substeps ?? 3); i++) this.substep(next, x, y);
    pass.end();
  }
  /**
   * The first step's set-up: the initial state, the sea's connectivity, the surf field, the fill and the spin-up. It is
   * submitted ahead of the frame's own commands in command buffers of at most {@link SETUP_WORKGROUPS} workgroups, so it
   * reads the heightmap and the uniform as the queue holds them now: the heightmap's upload, and the uniform written
   * just before `step`, but not a heightmap the same frame's command encoder writes earlier on the GPU.
   */
  private setUp(x: number, y: number): void {
    let encoder: GPUCommandEncoder | undefined,
      pass: GPUComputePassEncoder | undefined,
      held = 0;
    const flush = () => {
        if (!encoder) return;
        pass!.end();
        // One submit per command buffer: Dawn records the buffers of one submit into one D3D12 command list.
        this.device.queue.submit([encoder.finish()]);
        encoder = pass = undefined;
        held = 0;
      },
      next: NextPass = (groups = x * y) => {
        if (held + groups > SETUP_WORKGROUPS) flush();
        held += groups;
        if (!pass) pass = (encoder = this.device.createCommandEncoder()).beginComputePass(this.descriptor);
        return pass;
      },
      grid = (pipeline: GPUComputePipeline, bindGroup: GPUBindGroup) => {
        const pass = next();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(x, y);
      };
    grid(this.initializer, this.initialGroup);
    grid(this.connector, this.connectGroup);
    grid(this.compressor, this.compressGroup);
    this.surf?.build(next, this.terrain.width, this.terrain.height);
    if (this.filling) grid(this.filling, this.fillGroup!);
    // The surf's spin-up: the flow runs the sea of the seconds before its first frame (surf.ts, KB-WATER-SWASH1).
    if (this.surf && !this.still && this.spinFrames > 0) {
      this.surf.clock(next(1), 0);
      for (let f = 0; f < this.spinFrames; f++) {
        for (let i = 0; i < 3; i++) this.substep(next, x, y);
        this.surf.clock(next(1), 1);
      }
      this.surf.clock(next(1), 2);
    }
    flush();
    this.initialized = true;
  }
  private substep(next: NextPass, x: number, y: number): void {
    let pass = next();
    pass.setPipeline(this.flowing);
    pass.setBindGroup(0, this.flowGroups[this.current]);
    pass.dispatchWorkgroups(x, y);
    pass = next();
    pass.setPipeline(this.integrating);
    pass.setBindGroup(0, this.integrateGroups[this.current]);
    pass.dispatchWorkgroups(x, y);
    this.current = 1 - this.current;
  }
  dispose(): void {
    this.connected?.destroy();
    this.fillTexture?.destroy();
    this.sources?.destroy();
    for (let i = 0; i < this.states.length; i++) this.states[i].destroy();
    for (let i = 0; i < this.fluxes.length; i++) this.fluxes[i].destroy();
  }
}
