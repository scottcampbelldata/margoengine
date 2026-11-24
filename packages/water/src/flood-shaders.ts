// The flood solver's WGSL (`@margoengine/water/flood`, disaster water push 3). It is the scheme of
// packages/water/test/flood-reference.js, cell for cell: Chen-Noelle hydrostatic reconstruction with Audusse's
// second-order bed source, HLL with Kurganov-Petrova one-sided speeds and desingularised velocity (eps = DRY^4), fifth-order
// WENO-Z on h, w = h + b, u and v where five cells are wet and minmod elsewhere, SSP Runge-Kutta 2 and semi-implicit
// Manning friction (sources in that file's header). Every
// invocation reads a cross of cells three out along each axis and writes only its own texel of two rgba32float targets
// (state and momentum), so the WebGL2 layer runs it on its Fragment tier (operational playbook 3.3). A face's flux is
// worked out by the same function from both cells beside it, with the same arguments in the same order, so what one cell
// loses the other gains exactly.
//
// state: (h m, bed m, foam, breaker); momentum: (0, hu, 0, hv) m^2/s, which Water's spray and queries read as
// (west, east, south, north) outflows: velocity = (east - west, north - south) / depth.

import { swellAtWave, swellWaves } from './swell-wgsl.js';

/** Wall, inflow, swell train and wave maker limits: one uniform holds them all. */
export const MAX_FLOOD_SOURCES = 16;
export const MAX_FLOOD_WALLS = 16;
export const MAX_FLOOD_SWELLS = 8;
export const MAX_FLOOD_WAVE_MAKERS = 4;
/**
 * Bytes of the `Flood` uniform: 96 B of settings, 16 sources of 16 B, 16 walls of 32 B. The floats before the sources are
 * dt (0), stage (1), cell (2, 3), the four side kinds (4 to 7: 0 wall, 1 open, 2 sea), roughness (8), dry depth (9),
 * source and wall counts (10, 11), origin (12, 13), the mud's yield and viscous terms (14, 15; 0 for water), the sea (16 to 18: the outer surface in world y, the tsunami's part of
 * it in metres, the first level the water starts at) and the wind and rain (20, 21: wind stress over the water's density in
 * m^2/s^2 along x and z, 22: rain in m/s). After the walls: the swell head (the swell clock in seconds, the train count, the
 * wave maker count, 0), 8 swell trains of 32 B as Water holds them (direction x, z, amplitude, wavenumber; steepness,
 * angular frequency, phase, mesh fade) and 4 wave makers of 32 B ((position x, z, direction x, z), (signal in metres at
 * the tick's middle, angular frequency, band width in metres or 0 for the default, half length in metres or 0 for the
 * whole line)).
 */
export const FLOOD_UNIFORM_BYTES =
  96 + MAX_FLOOD_SOURCES * 16 + MAX_FLOOD_WALLS * 32 + 16 + MAX_FLOOD_SWELLS * 32 + MAX_FLOOD_WAVE_MAKERS * 32;
/** The float where the sources start, and the byte distance between the slices of the uniform ring (a uniform offset is a multiple of 256). */
export const FLOOD_SOURCE_FLOAT = 24;
export const FLOOD_SWELL_FLOAT = FLOOD_SOURCE_FLOAT + MAX_FLOOD_SOURCES * 4 + MAX_FLOOD_WALLS * 8;
export const FLOOD_MAKER_FLOAT = FLOOD_SWELL_FLOAT + 4 + MAX_FLOOD_SWELLS * 8;
export const FLOOD_UNIFORM_STRIDE = 1280;

// The uniform, the ground (terrain plus obstacles) and the bed with walls. Wall i is wall[2i] = (from x, z, to x, z) and
// wall[2i + 1] = (crest y, half width, open 0..1, 0); a wall raises every cell whose square, grown by the half width,
// the segment from-to touches (the slab test of Kay and Kajiya 1986), so even a wall thinner than a cell is a 4-connected
// line of cells with no gap at a diagonal. Open lowers the crest to the ground (a breach).
const common =
  swellWaves +
  swellAtWave +
  `
struct Wave {wave:vec4f,shape:vec4f}
struct Flood {dt:f32,stage:f32,cell:vec2f,boundary:vec4f,roughness:f32,dry:f32,sources:f32,walls:f32,origin:vec2f,mud:vec2f,sea:vec4f,wind:vec4f,
 source:array<vec4f,${MAX_FLOOD_SOURCES}>,wall:array<vec4f,${MAX_FLOOD_WALLS * 2}>,swell:vec4f,waves:array<Wave,${MAX_FLOOD_SWELLS}>,
 maker:array<vec4f,${MAX_FLOOD_WAVE_MAKERS * 2}>}
@group(0) @binding(0) var<uniform> flood:Flood;
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var obstacles:texture_2d<f32>;
const G=9.81;
fn crosses(a:vec2f,z:vec2f,c:vec2f,half:vec2f)->bool{
 let d=z-a;var lo=0.0;var hi=1.0;
 for(var k=0;k<2;k++){
  if(abs(d[k])<1e-9){if(abs(a[k]-c[k])>half[k]){return false;}}
  else{let t1=(c[k]-half[k]-a[k])/d[k];let t2=(c[k]+half[k]-a[k])/d[k];lo=max(lo,min(t1,t2));hi=min(hi,max(t1,t2));}
 }
 return lo<=hi;
}
fn bedAt(p:vec2i)->f32{
 let ground=textureLoad(terrain,p,0).r+textureLoad(obstacles,p,0).r;var b=ground;
 let c=flood.origin+(vec2f(p)+0.5)*flood.cell;
 for(var i=0u;i<u32(flood.walls);i++){
  let s=flood.wall[i*2u+1u];
  if(crosses(flood.wall[i*2u].xy,flood.wall[i*2u].zw,c,flood.cell*0.5+s.y)){b=max(b,mix(s.x,ground,s.z));}
 }
 return b;
}
`;

/**
 * The first state: water up to the higher of the flood's first sea level (`sea.z`, the Water's level when the flood began)
 * and the Water's `fill` surface over the bed (terrain, obstacles and walls), at rest. Binding 3 is the fill (r32float,
 * -1e30 where none), 4 and 5 the state and momentum written.
 */
export const floodInitialize =
  common +
  `
@group(0) @binding(3) var fill:texture_2d<f32>;
@group(0) @binding(4) var outState:texture_storage_2d<rgba32float,write>;
@group(0) @binding(5) var outMomentum:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(terrain));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let b=bedAt(p);let level=max(flood.sea.z,textureLoad(fill,p,0).r);
 textureStore(outState,p,vec4f(max(0.0,level-b),b,0,0));textureStore(outMomentum,p,vec4f(0));
}`;

/**
 * One SSP Runge-Kutta stage (stage 0: U1 = U + dt L(U); stage 1: U' = (U + U1 + dt L(U1)) / 2). Bindings 3 and 4 are
 * the step's start U (state, momentum), 5 and 6 the state the rates are taken of, 7 and 8 the targets. Boundary kinds
 * per side (west, east, south, north): 0 wall, 1 open (zero gradient), 2 sea (Flather 1976, below).
 *
 * The Water's swell trains arrive the same way (push 7): each component's linear elevation a sin(phase) at the face, on
 * the swell clock and filtered to the cell as Water filters it to its mesh, adds to the outer surface and to the
 * incoming wave, weighted by how squarely it travels inward (1 from 14 degrees off the inward normal, 0 along the side
 * and for waves leaving, which the inside already carries and Flather lets out).
 *
 * The wave makers (push 7): the source function of Wei, Kirby and Sinha (1999, Coastal Eng. 36, 271-299,
 * https://doi.org/10.1016/S0378-3839(99)00009-5), a Gaussian band exp(-beta r^2) across the line (r along the travel
 * direction) adding D s(t) of depth a second, here with its twin c D s(t) on the momentum along the travel direction. In the
 * linear shallow-water equations the Riemann invariants q -/+ c eta (Stoker 1957) then get sources 0 and 2 c f, so every
 * wave the band makes runs one way and nothing runs out the back; the band only adds, so waves crossing it pass through
 * as through open water (unlike a wave paddle at the edge, Larsen and Dancy 1983). The far-field amplitude of a band of
 * strength D is D I / c with I = sqrt(pi / beta) exp(-k^2 / (4 beta)) and k = omega / c (Wei 1999's I for the
 * non-dispersive limit), so D = a c / I gives the signal's amplitude a; c = sqrt(g h) is the cell's own. The default band
 * is Wei's beta = 80 / (delta^2 L^2) at delta 0.5, never narrower than 1.5 cells.
 */
export const floodStage =
  common +
  `
@group(0) @binding(3) var baseState:texture_2d<f32>;
@group(0) @binding(4) var baseMomentum:texture_2d<f32>;
@group(0) @binding(5) var evalState:texture_2d<f32>;
@group(0) @binding(6) var evalMomentum:texture_2d<f32>;
@group(0) @binding(7) var outState:texture_storage_2d<rgba32float,write>;
@group(0) @binding(8) var outMomentum:texture_storage_2d<rgba32float,write>;
fn minmod(a:f32,b:f32)->f32{if(a>0.0&&b>0.0){return min(a,b);}if(a<0.0&&b<0.0){return max(a,b);}return 0.0;}
fn velocity(h:f32,m:f32)->f32{
 if(h<=flood.dry){return 0.0;}let h4=h*h*h*h;let d4=flood.dry*flood.dry*flood.dry*flood.dry;
 return 1.41421356*h*m/sqrt(h4+max(h4,d4));
}
// A cell along a line as (h, b, normal velocity, tangential velocity); t is the cell's index on the line, n the line's
// length, axis 0 along x. Off the grid it is a ghost: beyond a wall the mirror of the cells inside (t = -1 of cell 0,
// t = -2 of cell 1, normal velocity negated), beyond an open or sea side the edge cell.
struct Cell {h:f32,b:f32,u:f32,v:f32}
fn load(p:vec2i,axis:u32)->Cell{
 let s=textureLoad(evalState,p,0);let m=textureLoad(evalMomentum,p,0);
 let mn=select(m.w,m.y,axis==0u);let mt=select(m.y,m.w,axis==0u);
 return Cell(s.x,s.y,velocity(s.x,mn),velocity(s.x,mt));
}
fn cellOn(origin:vec2i,axis:u32,t:i32,n:i32)->Cell{
 let step=select(vec2i(0,1),vec2i(1,0),axis==0u);
 if(t<0){let wall=flood.boundary[axis*2u]<0.5;var c=load(origin+step*select(0,min(-t-1,n-1),wall),axis);if(wall){c.u=-c.u;}return c;}
 if(t>=n){let wall=flood.boundary[axis*2u+1u]<0.5;var c=load(origin+step*select(n-1,max(2*n-1-t,0),wall),axis);if(wall){c.u=-c.u;}return c;}
 return load(origin+step*t,axis);
}
// WENO-Z (Borges, Carmona, Costa, Don 2008) at the face between c and d from the left: the reference's weno5z.
fn weno(a:f32,b:f32,c:f32,d:f32,e:f32)->f32{
 let q=vec3f(2.0*a-7.0*b+11.0*c,-b+5.0*c+2.0*d,2.0*c+5.0*d-e)/6.0;
 let s=vec3f(13.0/12.0*(a-2.0*b+c)*(a-2.0*b+c)+0.25*(a-4.0*b+3.0*c)*(a-4.0*b+3.0*c),
  13.0/12.0*(b-2.0*c+d)*(b-2.0*c+d)+0.25*(b-d)*(b-d),13.0/12.0*(c-2.0*d+e)*(c-2.0*d+e)+0.25*(3.0*c-4.0*d+e)*(3.0*c-4.0*d+e));
 let r=abs(s.x-s.z)/(s+1e-12);let w=vec3f(0.1,0.6,0.3)*(1.0+r*r);
 return dot(w,q)/(w.x+w.y+w.z);
}
// Reconstructed (h, b, u, v) at the face of slot t on side sg (1: towards +, -1: towards -); ghosts are constant. Where
// all five cells around it hold more than 0.01 m (the reference's WENO_WET, epsilon its WENO_EPS), fifth-order WENO-Z on h, w = h + b, u and v, kept while both its depth faces
// stay at or above 0; elsewhere (shores, fronts, edges of a wet patch) minmod, which keeps the depth positive there.
fn face(origin:vec2i,axis:u32,t:i32,n:i32,sg:f32)->Cell{
 let c=cellOn(origin,axis,t,n);
 if(t<0||t>=n){return c;}
 let a=cellOn(origin,axis,t-1,n);let z=cellOn(origin,axis,t+1,n);
 let aa=cellOn(origin,axis,t-2,n);let zz=cellOn(origin,axis,t+2,n);
 if(min(min(min(aa.h,a.h),min(c.h,z.h)),zz.h)>0.01){
  let he=weno(aa.h,a.h,c.h,z.h,zz.h);let hw=weno(zz.h,z.h,c.h,a.h,aa.h);
  if(he>=0.0&&hw>=0.0){
   if(sg>0.0){return Cell(he,weno(aa.h+aa.b,a.h+a.b,c.h+c.b,z.h+z.b,zz.h+zz.b)-he,weno(aa.u,a.u,c.u,z.u,zz.u),weno(aa.v,a.v,c.v,z.v,zz.v));}
   return Cell(hw,weno(zz.h+zz.b,z.h+z.b,c.h+c.b,a.h+a.b,aa.h+aa.b)-hw,weno(zz.u,z.u,c.u,a.u,aa.u),weno(zz.v,z.v,c.v,a.v,aa.v));
  }
 }
 let sh=minmod(c.h-a.h,z.h-c.h)*0.5;let sw=minmod((c.h+c.b)-(a.h+a.b),(z.h+z.b)-(c.h+c.b))*0.5;
 let su=minmod(c.u-a.u,z.u-c.u)*0.5;let sv=minmod(c.v-a.v,z.v-c.v)*0.5;
 let hs=max(0.0,c.h+sg*sh);let ws=c.h+c.b+sg*sw;
 return Cell(hs,ws-hs,c.u+sg*su,c.v+sg*sv);
}
fn hll(hL:f32,uL:f32,vL:f32,hR:f32,uR:f32,vR:f32)->vec3f{
 if(hL<=flood.dry&&hR<=flood.dry){return vec3f(0);}
 let cL=sqrt(G*hL);let cR=sqrt(G*hR);let ap=max(max(uL+cL,uR+cR),0.0);let am=min(min(uL-cL,uR-cR),0.0);
 if(ap-am<1e-12){return vec3f(0);}
 let qL=hL*uL;let qR=hR*uR;
 let fL=vec3f(qL,qL*uL+0.5*G*hL*hL,qL*vL);let fR=vec3f(qR,qR*uR+0.5*G*hR*hR,qR*vR);
 let UL=vec3f(hL,qL,hL*vL);let UR=vec3f(hR,qR,hR*vR);
 return (ap*fL-am*fR+ap*am*(UR-UL))/(ap-am);
}
// The sea side: Flather's condition (1976, Mem. Soc. Roy. Sci. Liege 10, 141-164, no open link) in its nonlinear form,
// the Riemann invariants of the shallow-water equations (Stoker 1957, Water Waves, ch. 10; Blayo and Debreu 2005, Ocean
// Modelling 9(3) 231-252, https://doi.org/10.1016/j.ocemod.2004.07.001, who show Flather's condition is the incoming
// characteristic linearised; Toro 2001, Shock-Capturing Methods for Free-Surface Shallow Flows, Wiley, ch. 4 on boundary
// conditions from them). Along the inward normal the invariant coming in, R+ = u + 2 sqrt(g h), is the outer sea's, and
// the one going out, R- = u - 2 sqrt(g h), the edge cell's; the face then has u = (R+ + R-) / 2 and sqrt(g h) =
// (R+ - R-) / 4. The outer sea stands at sea.x (plus the swell) over the edge cell's bed, and its current is that of the
// incoming wave (sea.y plus the swell) running into still water, R- of the still sea: u = 2 (sqrt(g h) - sqrt(g h0)) with
// h0 its depth without the wave (Stoker's simple wave; a sqrt(g / h0) for a small wave a, Flather's current). So a wave
// leaving passes out with no reflection, a wave entering arrives as given, and an inside equal to the outside stays at
// rest. When both invariants come in (the face's flow supercritical inwards, as over a dry or bared edge) the ghost is
// the outer sea itself and the Riemann solver makes the flood front, at most 2 sqrt(g h) (Ritter 1892); when both go
// out it is the edge cell (zero gradient). Every speed is bounded by the outer sea's depth and the edge cell's speed.
// KB-FLATHER-DRY1: the linear form, with sqrt(g / h) taken at the edge cell's own depth (KB-FLATHER-GHOST1), grew without
// bound as that depth went to 0 (a 6 m crest sent 40 m/s into a 0.4 m sheet on a land edge, and 100+ m/s into an edge
// the trough had bared), and a dry edge was a wall the sea could not come back over.
// The swell at a sea face: the incoming components of the Water's trains (comment on floodStage).
fn swellIn(at:vec2f,inward:vec2f)->f32{
 var eta=0.0;let width=min(flood.cell.x,flood.cell.y);
 for(var j=0u;j<u32(flood.swell.y);j++){
  for(var c=0u;c<3u;c++){let s=swellAt(flood.waves[j],at,c,width,flood.swell.x);eta+=clamp(4.0*dot(s.direction,inward),0.0,1.0)*s.amplitude*sin(s.phase);}
 }
 return eta;
}
// sign is -1 on the low side (inward +axis) and 1 on the high side (inward -axis); speeds below are along the inward normal.
fn seaGhost(inner:Cell,sign:f32,at:vec2f,axis:u32)->Cell{
 let zeta=swellIn(at,-sign*select(vec2f(0,1),vec2f(1,0),axis==0u));
 let he=max(0.0,flood.sea.x+zeta-inner.b);let h0=max(0.0,he-flood.sea.y-zeta);
 let ce=sqrt(G*he);let ue=2.0*(ce-sqrt(G*h0));
 let ui=-sign*inner.u;let ci=sqrt(G*max(inner.h,0.0));
 if(inner.h>flood.dry&&ui+ci<=0.0){return inner;}
 let rp=ue+2.0*ce;let rm=ui-2.0*ci;
 let cb=max(0.0,0.25*(rp-rm));let ub=0.5*(rp+rm);
 if(ub>=cb){return Cell(he,inner.b,-sign*ue,inner.v);}
 return Cell(cb*cb/G,inner.b,-sign*ub,inner.v);
}
// The face between slots f - 1 and f: what the left cell loses (out) and the right cell gains (in), each (h, normal, tangential).
struct Face {out:vec3f,into:vec3f}
fn faceFlux(origin:vec2i,axis:u32,f:i32,n:i32)->Face{
 var L=face(origin,axis,f-1,n,1.0);var R=face(origin,axis,f,n,-1.0);
 if(f==0&&flood.boundary[axis*2u]<0.5){L=Cell(R.h,R.b,-R.u,R.v);}
 if(f==n&&flood.boundary[axis*2u+1u]<0.5){R=Cell(L.h,L.b,-L.u,L.v);}
 // The face's middle in world xz, where the sea side reads the swell.
 let across=select(f32(origin.x),f32(origin.y),axis==0u)+0.5;
 let at=flood.origin+select(vec2f(across,f32(f)),vec2f(f32(f),across),axis==0u)*flood.cell;
 if(f==0&&flood.boundary[axis*2u]>1.5){L=seaGhost(R,-1.0,at,axis);}
 if(f==n&&flood.boundary[axis*2u+1u]>1.5){R=seaGhost(L,1.0,at,axis);}
 let top=min(max(L.b,R.b),min(L.h+L.b,R.h+R.b));
 let hLs=max(0.0,min(L.h+L.b-top,L.h));let hRs=max(0.0,min(R.h+R.b-top,R.h));
 let flux=hll(hLs,L.u,L.v,hRs,R.u,R.v);
 return Face(vec3f(flux.x,flux.y+0.5*G*(L.h+hLs)*(top-L.b),flux.z),vec3f(flux.x,flux.y-0.5*G*(hRs+R.h)*(R.b-top),flux.z));
}
// The foam on slot t of a line (0 off the grid: water from the sea or through a wall side comes in clean).
fn foamOn(origin:vec2i,axis:u32,t:i32,n:i32)->f32{
 if(t<0||t>=n){return 0.0;}return textureLoad(evalState,origin+select(vec2i(0,1),vec2i(1,0),axis==0u)*t,0).z;
}
// dU/dt of the cell from one axis: (h, normal momentum, tangential momentum, foam x h). The foam rides on the mass flux
// of each face, taken from the cell upwind of it, so it is carried with the water exactly and never made by transport.
fn rates(p:vec2i,axis:u32,size:vec2i)->vec4f{
 let t=select(p.y,p.x,axis==0u);let n=select(size.y,size.x,axis==0u);
 let origin=select(vec2i(p.x,0),vec2i(0,p.y),axis==0u);let d=select(flood.cell.y,flood.cell.x,axis==0u);
 let west=faceFlux(origin,axis,t,n);let east=faceFlux(origin,axis,t+1,n);
 var r=(west.into-east.out)/d;
 let e=face(origin,axis,t,n,1.0);let w=face(origin,axis,t,n,-1.0);
 r.y+=G*0.5*(w.h+e.h)*(w.b-e.b)/d;
 let here=foamOn(origin,axis,t,n);
 let fw=west.into.x*select(here,foamOn(origin,axis,t-1,n),west.into.x>0.0);
 let fe=east.out.x*select(foamOn(origin,axis,t+1,n),here,east.out.x>0.0);
 return vec4f(r,(fw-fe)/d);
}
// Ihmsen et al. 2012's clamped ramp: 0 below lo, 1 above hi.
fn ramp(i:f32,lo:f32,hi:f32)->f32{return (min(i,hi)-min(i,lo))/(hi-lo);}
// White water where the flow breaks, after Ihmsen et al. 2012's potentials: water is aerated where it is pushed together
// (their trapped-air potential, the velocity of neighbours running into each other: a bore, a hydraulic jump, a jet
// hitting slower water), where the surface stands up against the flow (their wave-crest potential; fronts after
// Chentanez and Muller 2010) or where a surge runs into shallower water, each scaled by the kinetic-energy potential, which alone makes no white water. Fast flow
// that is not compressed or steepened (the long run of current behind a bore, a uniform chute) stays clear, so the
// channel marks the breaking front, not every fast cell (FG-07). 0 in still water.
fn cellVelocity(p:vec2i)->vec2f{
 let s=textureLoad(evalState,p,0);if(s.x<=flood.dry){return vec2f(0);}
 let m=textureLoad(evalMomentum,p,0);return vec2f(velocity(s.x,m.y),velocity(s.x,m.w));
}
fn breaking(p:vec2i,size:vec2i)->f32{
 let s=textureLoad(evalState,p,0);
 if(s.x<=flood.dry){return 0.0;}
 let u=cellVelocity(p);let speed=length(u);
 let pe=min(p+vec2i(1,0),size-1);let pw=max(p-vec2i(1,0),vec2i(0));let pn=min(p+vec2i(0,1),size-1);let ps=max(p-vec2i(0,1),vec2i(0));
 let east=textureLoad(evalState,pe,0);let west=textureLoad(evalState,pw,0);
 let north=textureLoad(evalState,pn,0);let south=textureLoad(evalState,ps,0);
 let slope=vec2f((east.x+east.y)-(west.x+west.y),(north.x+north.y)-(south.x+south.y))/(2.0*flood.cell);
 let front=ramp(max(0.0,-dot(slope,u)/max(speed,1e-6)),0.05,0.3);
 // Neighbours closing on each other across one cell (m/s): the compressive half of the velocity differences.
 let ue=cellVelocity(pe);let uw=cellVelocity(pw);let un=cellVelocity(pn);let us=cellVelocity(ps);
 let closing=0.5*(max(uw.x-ue.x,0.0)+max(us.y-un.y,0.0));
 let trapped=ramp(closing,FOAM_CLOSING_LO,FOAM_CLOSING_HI);
 // A surge front: water running into water a good part shallower than itself (the tip of a surge over dry ground, the
 // face of a bore over standing water), each axis's drop weighted by the share of the current along it. The aerated
 // roller of a surge or bore front (Chanson 2009) is white; the even depth behind it is not.
 let downX=select(west.x,east.x,u.x>0.0);let downZ=select(south.x,north.x,u.y>0.0);
 let surge=ramp((abs(u.x)*max(s.x-downX,0.0)+abs(u.y)*max(s.x-downZ,0.0))/(max(abs(u.x)+abs(u.y),1e-6)*s.x),0.2,0.6);
 return ramp(speed,0.5,2.0)*max(max(front,trapped),surge)*ramp(s.x,0.01,0.08);
}
// The closing speed (m/s across one cell) where the trapped-air potential starts and saturates: a hydraulic jump closes
// at metres a second over a cell or two at any cell size, while the slow deceleration of a long current closes at
// centimetres a second a cell.
const FOAM_CLOSING_LO=0.25;
const FOAM_CLOSING_HI=1.0;
// Inflow depth rate (m/s): each source's discharge spread over the cells whose centres lie within its radius of its
// position (per axis), and always the cell under it, as water/rivers spreads its sources.
fn inflow(p:vec2i,size:vec2i)->f32{
 var rate=0.0;
 for(var i=0u;i<u32(flood.sources);i++){let s=flood.source[i];
  let c=floor((s.xy-flood.origin)/flood.cell);
  let lo=max(min(ceil((s.xy-s.w-flood.origin)/flood.cell-0.5),c),vec2f(0));let hi=min(max(floor((s.xy+s.w-flood.origin)/flood.cell-0.5),c),vec2f(size-1));
  let at=vec2f(p);if(all(at>=lo)&&all(at<=hi)){rate+=s.z/((hi.x-lo.x+1.0)*(hi.y-lo.y+1.0)*flood.cell.x*flood.cell.y);}
 }return rate;
}
// The wave makers: one-way source bands (derivation in the comment on floodStage).
fn makers(p:vec2i,h:f32)->vec3f{
 var rate=vec3f(0);if(h<=flood.dry){return rate;}
 let c=flood.origin+(vec2f(p)+0.5)*flood.cell;let cw=sqrt(G*h);let narrow=1.0/(2.25*min(flood.cell.x,flood.cell.y)*min(flood.cell.x,flood.cell.y));
 for(var i=0u;i<u32(flood.swell.z);i++){
  let a=flood.maker[i*2u];let b=flood.maker[i*2u+1u];let d=a.zw;let off=c-a.xy;
  if(b.w>0.0&&abs(dot(off,vec2f(-d.y,d.x)))>b.w){continue;}
  let k=b.y/cw;let r=dot(off,d);
  let beta=min(select(80.0*k*k/(0.25*39.4784176),1.0/(b.z*b.z),b.z>0.0),narrow);
  let f=b.x*cw/(sqrt(3.14159265/beta)*exp(-k*k/(4.0*beta)))*exp(-beta*r*r);
  rate+=vec3f(f,cw*f*d.x,cw*f*d.y);
 }
 return rate;
}
// Foam lasts FOAM_LIFE seconds (e-folding): oceanic whitecap foam decays in 1.4 to 4.8 s on the area-weighted mean
// (Callaghan, Deane, Stokes and Ward 2012, JGR Oceans 117, C09015, https://doi.org/10.1029/2012JC008147).
const FOAM_LIFE=3.0;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(evalState));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let rx=rates(p,0u,size);let rz=rates(p,1u,size);
 let evalFoam=textureLoad(evalState,p,0);
 let foamRate=rx.w+rz.w-evalFoam.z*evalFoam.x/FOAM_LIFE;
 let wet=select(0.0,1.0,textureLoad(evalState,p,0).x>flood.dry);
 let rate=vec3f(rx.x+rz.x+inflow(p,size)+flood.wind.z,rx.y+rz.z+wet*flood.wind.x,rx.z+rz.y+wet*flood.wind.y)+makers(p,evalFoam.x);
 let base=textureLoad(baseState,p,0);let bm=textureLoad(baseMomentum,p,0);
 let now=textureLoad(evalState,p,0);let nm=textureLoad(evalMomentum,p,0);
 var U=vec3f(now.x,nm.y,nm.w)+flood.dt*rate;var frictionDt=flood.dt;var carried=now.z*now.x+flood.dt*foamRate;
 if(flood.stage>0.5){U=0.5*(vec3f(base.x,bm.y,bm.w)+U);frictionDt=flood.dt*0.5;carried=0.5*(base.z*base.x+carried);}
 var depth=U.x;var mu=U.y;var mv=U.z;
 if(depth<=flood.dry){depth=max(0.0,depth);mu=0.0;mv=0.0;}
 else if(flood.roughness>0.0||flood.mud.x>0.0||flood.mud.y>0.0){
  // The quadratic rheology (O'Brien, Julien and Fullerton 1993): g h S_f of the Manning term g n^2 |q| q / h^(7/3) and
  // the viscous K eta q / (8 rho_m h^2), semi-implicit; then the yield stress takes tau_y / rho_m off |q| and holds the
  // flow at rest where it would reverse it. Water has mud = 0 and keeps Manning alone.
  let q=length(vec2f(mu,mv));
  let damp=1.0+frictionDt*(G*flood.roughness*flood.roughness*q/depth/pow(depth,4.0/3.0)+flood.mud.y/(depth*depth));mu/=damp;mv/=damp;
  let held=length(vec2f(mu,mv));let keep=select(0.0,max(held-frictionDt*flood.mud.x,0.0)/held,held>0.0);mu*=keep;mv*=keep;
 }
 // The foam: what the water carried in, and never less than the white water breaking here now (the breaker channel).
 let breaker=breaking(p,size);
 let foam=select(0.0,clamp(max(carried/max(depth,1e-6),breaker),0.0,1.0),depth>flood.dry);
 textureStore(outState,p,vec4f(depth,bedAt(p),foam,breaker));textureStore(outMomentum,p,vec4f(0,mu,0,mv));
}`;

/**
 * After each tick: the current in m/s for `Flood.velocityTexture` (u, v, speed, depth) and the wetting record for
 * `Flood.wetTexture` (deepest depth so far in m, seconds since the cell was last wet, 1 once it has been wet, 0). A cell
 * is wet above 1 cm. Bindings: 0 and 1 the state and momentum, 2 the record before the tick, 3 and 4 the targets; a
 * gather that writes only its own texel of two rgba32float targets, as the stage does, so the WebGL2 layer runs it on its
 * Fragment tier. The tick is 1 / 120 s and the dry depth `dry` m, both written into the text.
 */
export function floodRecord(tick: number, dry: number): string {
  return `
@group(0) @binding(0) var state:texture_2d<f32>;
@group(0) @binding(1) var momentum:texture_2d<f32>;
@group(0) @binding(2) var before:texture_2d<f32>;
@group(0) @binding(3) var outVelocity:texture_storage_2d<rgba32float,write>;
@group(0) @binding(4) var outWet:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(state));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let s=textureLoad(state,p,0);let m=textureLoad(momentum,p,0);let w=textureLoad(before,p,0);
 var u=vec2f(0);
 if(s.x>${dry}){let h4=s.x*s.x*s.x*s.x;let d4=${dry * dry * dry * dry};u=1.41421356*s.x*vec2f(m.y,m.w)/sqrt(h4+max(h4,d4));}
 let wet=s.x>0.01;
 textureStore(outVelocity,p,vec4f(u,length(u),s.x));
 textureStore(outWet,p,vec4f(max(w.x,s.x),select(select(0.0,w.y+${tick},w.z>0.5),0.0,wet),select(w.z,1.0,wet),0.0));
}`;
}
