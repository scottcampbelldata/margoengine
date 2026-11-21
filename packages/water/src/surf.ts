import { group } from '../../shared/gpu.js';

// Breaking surf on a terrain-coupled coast (KB-WATER-SURF1). Water's swell is deep-water Gerstner trains; over a
// shoaling beach they slow, shorten, steepen and break, which the shallow-water flow alone did not show (a flat sea
// with a white band at the waterline). The surf here is analytic in time, so a seek or a film frame draws it at once.
//
// Travel time. A swell component crossing the shoal arrives later than in deep water: its phase at a point is the deep
// phase at the point its ray left the source, at the time it left (t - tau). Fermat's principle makes the ray the
// fastest path, so tau solves the eikonal |grad tau| = 1 / c(depth) (the ray theory of water waves: C. C. Mei,
// "The Applied Dynamics of Ocean Surface Waves", 1989, ch. 3; Snell's law across straight contours follows from it).
// `surfFieldShader` solves it once per heightmap on the coastal grid by repeated 8-neighbour relaxation (the
// Bellman-Ford form of the fast marching/sweeping methods: J. A. Sethian, "A fast marching level set method for
// monotonically advancing fronts", PNAS 93(4), 1996, https://doi.org/10.1073/pnas.93.4.1591; H. Zhao, "A fast
// sweeping method for Eikonal equations", Mathematics of Computation 74(250), 2005,
// https://doi.org/10.1090/S0025-5718-04-01678-3), carrying with tau the point each ray came from. Rays start in deep
// water (depth over half the longest wavelength) or at the deepest sea cells of the grid's edge. The celerity is
// linear theory's for the longest component, its wavenumber from the explicit approximation of J. D. Fenton and
// W. D. McKee, "On calculating the lengths of water waves", Coastal Engineering 14(6), 1990,
// https://doi.org/10.1016/0378-3839(90)90032-R. A component's local wavevector keeps the deep wavevector's part along
// the depth contour (Snell) and takes the local wavenumber's remainder across it.
//
// Height. Linear shoaling: the amplitude grows by Ks = sqrt(cg0 / cg) (energy flux conserved along the ray: R. G. Dean
// and R. A. Dalrymple, "Water Wave Mechanics for Engineers and Scientists", 1991, ch. 4), to the depth limit
// H = gamma h with gamma = 0.78 (J. McCowan, "On the highest wave of permanent type", Philosophical Magazine 38(233),
// 1894, https://doi.org/10.1080/14786449408620653). Past it the height is saturated at gamma h, as across a surf zone
// of spilling breakers (E. B. Thornton and R. T. Guza, "Transformation of wave height distribution", JGR 88(C10), 1983,
// https://doi.org/10.1029/JC088iC10p05925; J. A. Battjes and J. P. F. M. Janssen, "Energy loss and set-up due to
// breaking of random waves", Coastal Engineering 1978, https://doi.org/10.1061/9780872621909.034). H is the local
// envelope of the swell components (their phasor sum), so sets break further out than the lulls between them.
//
// Shape. Shoaling waves grow peaked crests (skewness), then lean forward into sawtooth bores (asymmetry). The waveform
// is the closed form of I. Abreu, A. Silva, F. Sancho and A. Temperville, "Analytical approximate wave form for
// asymmetric waves", Coastal Engineering 57(7), 2010, https://doi.org/10.1016/j.coastaleng.2010.02.005, with its
// nonlinearity r and phase phi from the Ursell number by the fit of B. G. Ruessink, G. Ramaekers and L. C. van Rijn,
// "On the parameterization of the free-stream non-linear wave orbital motion in nearshore morphodynamic models",
// Coastal Engineering 65, 2012, https://doi.org/10.1016/j.coastaleng.2012.03.006 (B and psi of Ur = 3/8 H k / (k h)^3;
// b = r / (1 + sqrt(1 - r^2)) and B = 3 b / sqrt(2 (1 - b^2)), checked numerically against the waveform's skewness).
//
// Foam. Where the swell breaks, a roller rides the steep front of each crest (the face between the crest and the
// trough found in closed form from the waveform) and a residual foam trail decays behind it, the white water of a
// spilling breaker and the lace it leaves (P. A. Madsen, O. R. Sorensen and H. A. Schaffer, "Surf zone dynamics
// simulated by a Boussinesq type model. Part I", Coastal Engineering 32(4), 1997,
// https://doi.org/10.1016/S0378-3839(97)00028-7, treat the roller as the water above the front's tangent). Short
// wind-sea components keep their deep phase and are trimmed to the depth limit, damped where the swell breaks.
//
// Graphics precedents (read, not copied): A. Fournier and W. T. Reeves, "A simple model of ocean waves", SIGGRAPH 1986,
// https://doi.org/10.1145/15886.15894 (depth-dependent Gerstner orbits that steepen and break on a beach); D. R.
// Peachey, "Modeling waves and surf", SIGGRAPH 1986, https://doi.org/10.1145/15886.15893 (depth-dependent wavelength
// and breaking as wave sharpness).
//
// Spin-up (KB-WATER-SWASH1). The coastal flow takes the surf over in the inner surf zone and starts at rest, and a long
// wave needs t = 2 sqrt(h0 / g) / s to cross a plane beach of slope s from the hand-over depth h0 to the shoreline (the
// shallow-water speed sqrt(g h) integrated over x = h / s): 19 s on 1:50 from 0.35 m. So a still taken in the first
// seconds showed no swash and no wet sand. Coastal models start the forced flow from rest and run it until it reaches
// its periodic state before the time they report (a spin-up; the surf forcing of the swash and its spin-up are reviewed
// by M. Brocchini and T. E. Baldock, "Recent advances in modeling swash zone dynamics: influence of surf-swash
// interaction on nearshore hydrodynamics and morphodynamics", Reviews of Geophysics 46(3), 2008,
// https://doi.org/10.1029/2006RG000215). The coastal flow runs SURF_SPIN seconds of surf before its first frame, in steps
// of 1/45 s (a 15 fps frame's third): the surf's clock runs from SURF_SPIN seconds before the Water's time up to it, so the
// first frame shows the swash the sea would have by then, on beaches down to about 1:100 below the hand-over depth.
// The clock is two words of the `connected` buffer, the shift of the surf's time and the step while it spins (0 after),
// which three one-invocation kernels set, advance and clear between the flow's steps, inside the first frame's pass.
//
// Layout. The field lives in the coastal flow's `connected` storage buffer, after the n + 1 connectivity words:
// field A (x and z of the ray's source, tau, unused) per cell at n + 1, field B (the relaxation's other half) at
// 5n + 1, a ready flag at 9n + 1 (1 once built), the deepest edge depth at 9n + 2 and the spin-up clock (shift and
// step, seconds) at 9n + 3 and 9n + 4.

/** Words the coastal `connected` buffer needs for `cells` heightmap cells with the surf field. */
export const surfWords = (cells: number): number => cells * 9 + 5;
/** Seconds of surf the coastal flow runs before its first frame (see the top of this file). */
export const SURF_SPIN = 40;
/** The spin-up's step, s: a third of a 15 fps frame, as Water's flow steps then. */
const SPIN_STEP = 1 / 45;
/** Frames of three steps in the spin-up. */
export const SURF_SPIN_FRAMES = Math.round(SURF_SPIN / (3 * SPIN_STEP));

// Bounded tanh (KB-WATER-SURGEVOL1). Every tanh in the surf's WGSL takes its argument through min(x, 10). Native
// WebGPU on an Intel xe-2lpg laptop GPU returns NaN for tanh(x) once sinh and cosh overflow f32 (x over about 88.7;
// measured 1 at x = 50, NaN at 100), and the Ruessink et al. phase's 0.815 / Ur^0.672 passes that in calm deep water
// (Ur under about 1e-3): the surf drove the open sea toward NaN, the relaxation's max(0, NaN) read 0, and the sea near
// the map's deep edge drained (a beach at rest held 1,431 of its 2,880 m^3). Fenton and McKee's tanh((k0 d)^0.75)
// passes it at k0 d over 397 (a 20 m swell over 1.26 km of water). For x over 9.01, 1 - tanh x = 2 / (e^2x + 1) is
// under 2^-25, half an f32 ulp below 1, so tanh x rounds to 1 (IEEE 754-2019, round to nearest) and the clamp changes
// no correctly rounded value; Ruessink's phase psi then reads 0, the symmetric wave of its Ur -> 0 limit.
/** WGSL shared by the water surface, its probes and the coastal flow; needs `frame`, `swell` and `connected`. */
export const surfWaves = `
// The shift of the surf's clock from the Water's (s): 0, except in the coastal flow's spin-up (surfClock).
var<private> surfShift:f32;
// The spin-up clock (shift s, step s); both 0 once the flow has spun up, and without the words.
fn surfClock(n:u32)->vec2f {let at=n*9u+3u;if(arrayLength(&connected)<=at+1u){return vec2f(0);}return vec2f(bitcast<f32>(connected[at]),bitcast<f32>(connected[at+1u]));}
// Depth-limited breaking (McCowan 1894).
const SURF_GAMMA=0.78;
// Depths (m) over which the coastal flow takes the surf over: the inner surf zone and the swash are the flow's.
const SURF_SWASH=vec2f(0.35,0.9);
// Local wavenumber at depth d of a component of deep wavenumber k0 (Fenton and McKee 1990).
fn surfK(k0:f32,d:f32)->f32 {return k0/pow(tanh(min(pow(k0*max(d,0.01),0.75),10.0)),0.6666667);}
// Linear shoaling coefficient sqrt(cg0 / cg).
fn surfShoal(k0:f32,d:f32)->f32 {let k=surfK(k0,d);let kh=min(k*max(d,0.01),10.0);return sqrt(0.5*k/((0.5+kh/sinh(2.0*kh))*k0));}
// The field's wavenumber: the lowest component of the train with the most height, the peak of the sea (KB-WATER-SURFFIELD1:
// the longest train with any height let a wind sea's empty long trains, 1e-31 m high, set it, so its real waves counted
// as short chop and never broke).
fn surfFieldK()->f32 {var k=1e9;var top=0.0;for(var j=0u;j<u32(frame.settings.w);j++){if(frame.waves[j].wave.z>top){top=frame.waves[j].wave.z;k=frame.waves[j].wave.w*0.84;}}return k;}
fn surfReady(n:u32)->bool {let flag=n*9u+1u;return frame.flow.w>0.5&&arrayLength(&connected)>flag+1u&&connected[flag]==1u;}
struct SurfField {source:vec2f,tau:f32,weight:f32}
// The field at world xz, bilinear over the cells a ray reached; weight is the share of them.
fn surfField(xz:vec2f,size:vec2i)->SurfField {
 let n=u32(size.x*size.y);if(!surfReady(n)){return SurfField(xz,0.0,0.0);}
 let uv=(xz-frame.coast.xy)/frame.coast.zw;
 let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let weights=vec4f((1.0-t.x)*(1.0-t.y),t.x*(1.0-t.y),(1.0-t.x)*t.y,t.x*t.y);
 let cells=array<vec2i,4>(lo,vec2i(hi.x,lo.y),vec2i(lo.x,hi.y),hi);
 var source=vec2f(0);var tau=0.0;var total=0.0;
 for(var c=0;c<4;c++){
  let i=n+1u+u32(cells[c].y*size.x+cells[c].x)*4u;let time=bitcast<f32>(connected[i+2u]);
  if(time<1e29){source+=weights[c]*vec2f(bitcast<f32>(connected[i]),bitcast<f32>(connected[i+1u]));tau+=weights[c]*time;total+=weights[c];}
 }
 if(total<1e-4){return SurfField(xz,0.0,0.0);}
 return SurfField(source/total,tau/total,total);
}
struct SurfProfile {value:f32,slope:f32}
// Abreu et al. (2010) at time-angle pi - phase, so the steep face leads: value and d value / d phase. r = 0 is sin.
fn surfProfile(phase:f32,r:f32,phi:f32)->SurfProfile {
 let t=3.14159265-phase;let s=sqrt(1.0-r*r);let lift=r*sin(phi)/(1.0+s);let d=1.0-r*cos(t+phi);
 return SurfProfile(s*(sin(t)+lift)/d,-s*(cos(t)*d-(sin(t)+lift)*r*sin(t+phi))/(d*d));
}
// Roller on the front face (x) and the foam trail behind the crest (y) at this phase of a breaking component.
fn surfFoamAt(phase:f32,r:f32,phi:f32)->vec2f {
 let s=sqrt(1.0-r*r);let lift=r*sin(phi)/(1.0+s);
 // Extremes of the waveform: cos t (1 - lift r sin phi) - sin t (lift r cos phi) = r cos phi.
 let p=1.0-lift*r*sin(phi);let q=lift*r*cos(phi);let base=atan2(q,p);let a=acos(clamp(r*cos(phi)/max(length(vec2f(p,q)),1e-6),-1.0,1.0));
 let t1=a-base;let t2=-a-base;let v1=(sin(t1)+lift)/(1.0-r*cos(t1+phi));let v2=(sin(t2)+lift)/(1.0-r*cos(t2+phi));
 let crest=3.14159265-select(t2,t1,v1>=v2);let trough=3.14159265-select(t1,t2,v1>=v2);
 let behind=phase-crest-6.2831853*floor((phase-crest+3.14159265)/6.2831853);
 let front=max(0.3,(trough-crest)-6.2831853*floor((trough-crest)/6.2831853));
 let roller=smoothstep(-0.6,-0.1,behind)*(1.0-smoothstep(0.35*front,0.9*front,behind));
 return vec2f(roller,select(0.0,exp(behind*0.7),behind<0.0));
}
struct SurfPart {gradient:vec2f,phase:f32,amplitude:f32,steepness:f32,swell:f32}
struct Surf {offset:vec3f,dx:vec3f,dz:vec3f,crest:f32,breaking:f32,foam:vec2f,stir:f32,heading:vec2f}
// The surf at xz over still-water depth d with its field: displacement, its x and z derivatives, the crest share,
// how hard the swell breaks there (0..1), with \`foam\` the roller and trail foam (0..1 each), and how much sand the
// swell's orbital flow at the bed lifts (0..1). The swell components break as one sea: their phasor sum
// E = sum a exp(i phase) gives the local height 2|E| and the phase of the combined crest, which carries the nonlinear
// shape and the foam; each component keeps its own horizontal orbit.
fn surfSample(xz:vec2f,sampleWidth:f32,depth:f32,field:SurfField,foam:bool)->Surf {
 let kField=surfFieldK();let d=max(depth,0.02);
 var parts:array<SurfPart,24>;var count=0u;
 // E, and G = sum a grad(phase) exp(i phase) (its cosine and sine parts), so grad E = i G; k is the mean wavenumber.
 var envelope=vec2f(0);var gCos=vec2f(0);var gSin=vec2f(0);var weight=0.0;var k=0.0;var omega=0.0;
 for(var j=0u;j<u32(frame.settings.w);j++){
  let w=frame.waves[j];
  for(var c=0u;c<3u;c++){
   let component=swellComponent(c);let k0=w.wave.w*component.y;let kl=surfK(k0,d);let ks=surfShoal(k0,d);
   let deep=swellAt(w,xz,c,sampleWidth,frame.settings.x+surfShift);let a=w.wave.z*component.z*min(w.shape.w,swellFilter(kl,sampleWidth));
   if(k0<=kField*2.5){
    // A swell component: the deep wave at the ray's source, when it left; Snell's wavevector at the local wavenumber.
    let s=swellAt(w,field.source,c,sampleWidth,frame.settings.x+surfShift-field.tau);let travel=xz-field.source;
    let u=select(deep.direction,travel*inverseSqrt(max(dot(travel,travel),1e-12)),dot(travel,travel)>1e-6);
    let along=deep.gradient-u*dot(deep.gradient,u);let g=along+u*sqrt(max(kl*kl-dot(along,along),0.0));
    parts[count]=SurfPart(g,s.phase,a*ks,w.shape.x,1.0);
    envelope+=a*ks*vec2f(cos(s.phase),sin(s.phase));gCos+=a*ks*g*cos(s.phase);gSin+=a*ks*g*sin(s.phase);
    weight+=a*ks;k+=a*ks*kl;omega+=a*ks*sqrt(9.81*k0);
   } else {parts[count]=SurfPart(deep.gradient,deep.phase,a*min(ks,1.0),w.shape.x,0.0);}
   count++;
  }
 }
 let size=length(envelope);let high=2.0*size;let saturate=min(1.0,SURF_GAMMA*d/max(high,1e-4));
 let breaking=smoothstep(0.8,1.05,high/(SURF_GAMMA*d));
 var result=Surf(vec3f(0),vec3f(0),vec3f(0),0.0,breaking,vec2f(0),0.0,vec2f(0));
 if(size>1e-5){
  // The combined swell: height S |E| F(phase of E), F the Abreu waveform at the Ursell number of the saturated sea.
  let phase=atan2(envelope.y,envelope.x);let turn=(gCos*envelope.x+gSin*envelope.y)/(size*size);
  let grow=-(envelope.x*gSin-envelope.y*gCos)/size;
  k/=weight;let kd=k*d;let ursell=max(0.375*high*saturate*k/(kd*kd*kd),1e-6);
  let big=0.857/(1.0+exp((-0.471-log(ursell)*0.4342945)/0.297));let psi=-1.5707963+1.5707963*tanh(min(0.815/pow(ursell,0.672),10.0));
  let b=big*sqrt(2.0/(9.0+2.0*big*big));let r=2.0*b/(1.0+b*b);let phi=-1.5707963-psi;
  let profile=surfProfile(phase,r,phi);let slope=saturate*(grow*profile.value+size*profile.slope*turn);
  result.offset.y=saturate*size*profile.value;result.dx.y=slope.x;result.dz.y=slope.y;
  result.crest=smoothstep(0.75,0.98,sin(phase))*smoothstep(0.14,0.32,size*saturate*k);result.heading=turn/max(length(turn),1e-6);
  if(foam&&breaking>0.0){result.foam=surfFoamAt(phase,r,phi)*breaking;}
  // Linear theory's orbital speed at the bed, a omega / sinh(k h), against the 0.1 to 0.6 m/s over which fine sand
  // starts moving and goes into suspension under waves (P. D. Komar and M. C. Miller, "The threshold of sediment
  // movement under oscillatory water waves", Journal of Sedimentary Petrology 43(4), 1973,
  // https://archives.datapages.com/data/sepm/journals/v42-46/data/043/043004/1101.htm).
  result.stir=smoothstep(0.1,0.6,size*saturate*(omega/weight)/sinh(min(kd,10.0)));
 }
 for(var i=0u;i<count;i++){
  let part=parts[i];var a=part.amplitude;
  if(part.swell>0.5){a*=saturate;} else {a*=min(1.0,SURF_GAMMA*d/max(2.0*a,1e-4))*(1.0-0.8*breaking);}
  let kc=length(part.gradient);let dir=part.gradient/max(kc,1e-6);
  // Shorter, higher waves would fold under the deep crest sharpness: hold the summed sharpness under 0.9.
  let q=min(part.steepness*0.9,0.9/(f32(count)*max(a*kc,1e-6)));let s=sin(part.phase);let c=cos(part.phase);
  result.offset+=vec3f(q*a*dir.x*c,0.0,q*a*dir.y*c);
  var derivative=vec3f(-q*a*dir.x*s,0.0,-q*a*dir.y*s);
  if(part.swell<0.5){
   result.offset.y+=a*s;derivative.y=a*c;
   result.crest=max(result.crest,smoothstep(0.75,0.98,s)*smoothstep(0.14,0.32,a*kc));
  }
  result.dx+=derivative*part.gradient.x;result.dz+=derivative*part.gradient.y;
 }
 return result;
}
// The sea the coastal flow is driven toward at xz over ground: (surface height, relaxation weight, and the flux per
// unit width, m^2/s, along x and z). With the surf field the swell shoals and breaks into the swash, and the flow takes
// over across SURF_SWASH, the inner surf zone, and runs its bores up the beach. The relaxation zone drives both the
// surface and its flux, as a numerical wave maker must to send waves on rather than reflect them (J. Larsen and
// H. Dancy, "Open boundaries in short wave
// simulations: a new approach", Coastal Engineering 7(3), 1983, https://doi.org/10.1016/0378-3839(83)90022-4;
// N. G. Jacobsen, D. R. Fuhrman and J. Fredsoe, "A wave generation toolbox for the open-source CFD library: OpenFoam",
// International Journal for Numerical Methods in Fluids 70(9), 2012, https://doi.org/10.1002/fld.2726): the long-wave
// flux eta sqrt(g D) along the swell's heading. Without the field, the surface alone, as before.
fn surfSea(xz:vec2f,ground:f32,size:vec2i,sampleWidth:f32)->vec4f {
 var h=frame.settings.y;
 for(var j=0u;j<u32(frame.settings.w);j++){for(var c=0u;c<3u;c++){let s=swellAt(frame.waves[j],xz,c,sampleWidth,frame.settings.x+surfShift);h+=s.amplitude*sin(s.phase);}}
 let depth=frame.settings.y-ground;
 if(surfReady(u32(size.x*size.y))){
  let field=surfField(xz,size);var flux=vec2f(0);
  if(field.weight>0.0){
   let s=surfSample(xz,sampleWidth,depth,field,false);h=mix(h,frame.settings.y+s.offset.y,field.weight);
   flux=s.heading*s.offset.y*sqrt(9.81*max(h-ground,0.01))*field.weight;
  }
  return vec4f(h,smoothstep(SURF_SWASH.x,SURF_SWASH.y,depth),flux);
 }
 return vec4f(h,smoothstep(0.65,2.4,depth),0.0,0.0);
}
`;

// The eikonal of the swell's travel time over the coastal grid (see the top of this file). Only the deepest edge needs
// an atomic (atomicMax across cells); the sources and the sweeps read and write plain words, each invocation its own
// cell, from one field to the other, so they are their own module over the same buffer. Until 2026-11-18 one atomic
// module ran every sweep, so the WebGL2 layer ran the whole build, width + height sweeps of every cell, one invocation
// at a time in JavaScript (its CPU tier takes any atomic): about 7 minutes for a 512 x 82 grid on the first frame.
const surfFieldShader = (waterFrame: string, atomic: boolean) =>
  waterFrame +
  `
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var<storage,read_write> cells:array<${atomic ? 'atomic<u32>' : 'u32'}>;
fn word(i:u32)->u32 {return ${atomic ? 'atomicLoad(&cells[i])' : 'cells[i]'};}
fn put(i:u32,v:u32){${atomic ? 'atomicStore(&cells[i],v);' : 'cells[i]=v;'}}
fn cellCount()->u32 {let s=textureDimensions(terrain);return s.x*s.y;}
fn fieldK()->f32 {var k=1e9;var top=0.0;for(var j=0u;j<u32(frame.settings.w);j++){if(frame.waves[j].wave.z>top){top=frame.waves[j].wave.z;k=frame.waves[j].wave.w*0.84;}}return k;}
fn waveK(k0:f32,d:f32)->f32 {return k0/pow(tanh(min(pow(k0*max(d,0.01),0.75),10.0)),0.6666667);}
fn depthAt(p:vec2i)->f32 {return frame.settings.y-textureLoad(terrain,p,0).r;}
fn root(p:vec2i)->u32 {return word(u32(p.y)*textureDimensions(terrain).x+u32(p.x)+1u);}
// Open sea, or ground up to 1.5 m above the sea next to it (the swash); never an enclosed basin.
fn passable(p:vec2i)->bool {let r=root(p);return r==0u||(r==0xffffffffu&&depthAt(p)>-1.5);}
// Seconds per metre: 1 / celerity of the longest component, at least 5 cm deep.
fn slowness(p:vec2i)->f32 {let k=fieldK();return waveK(k,max(depthAt(p),0.05))/sqrt(9.81*k);}
fn centre(p:vec2i)->vec2f {return frame.coast.xy+(vec2f(p)+0.5)*frame.flow.yz;}
fn store(base:u32,source:vec2f,tau:f32){put(base,bitcast<u32>(source.x));put(base+1u,bitcast<u32>(source.y));put(base+2u,bitcast<u32>(tau));}
fn load(base:u32)->vec3f {return vec3f(bitcast<f32>(word(base)),bitcast<f32>(word(base+1u)),bitcast<f32>(word(base+2u)));}
fn edge(p:vec2i)->bool {let s=vec2i(textureDimensions(terrain));return p.x==0||p.y==0||p.x==s.x-1||p.y==s.y-1;}
${
  atomic
    ? `@compute @workgroup_size(8,8) fn deepest(@builtin(global_invocation_id) id:vec3u){
 let s=textureDimensions(terrain);if(any(id.xy>=s)){return;}let p=vec2i(id.xy);
 if(edge(p)&&root(p)==0u&&depthAt(p)>0.0){atomicMax(&cells[cellCount()*9u+2u],bitcast<u32>(depthAt(p)));}
}`
    : `@compute @workgroup_size(8,8) fn seed(@builtin(global_invocation_id) id:vec3u){
 let s=textureDimensions(terrain);if(any(id.xy>=s)){return;}let p=vec2i(id.xy);let n=cellCount();
 let d=depthAt(p);let deepest=bitcast<f32>(word(n*9u+2u));
 let source=root(p)==0u&&(d>=3.14159265/fieldK()||(edge(p)&&d>=0.7*deepest));
 store(n+1u+(id.y*s.x+id.x)*4u,centre(p),select(1e30,0.0,source));
 if(all(id.xy==vec2u(0))){put(n*9u+1u,1u);}
}
fn relax(id:vec3u,fromField:u32,toField:u32){
 let s=textureDimensions(terrain);if(any(id.xy>=s)){return;}let p=vec2i(id.xy);let i=id.y*s.x+id.x;
 var best=load(fromField+i*4u);
 if(passable(p)&&best.z>0.0){
  let own=slowness(p);
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
   let q=p+vec2i(x,y);if((x==0&&y==0)||any(q<vec2i(0))||any(q>=vec2i(s))||!passable(q)){continue;}
   let other=load(fromField+(u32(q.y)*s.x+u32(q.x))*4u);if(other.z>=1e29){continue;}
   let time=other.z+length(vec2f(f32(x),f32(y))*frame.flow.yz)*0.5*(own+slowness(q));
   if(time<best.z){best=vec3f(other.xy,time);}
  }}
 }
 store(toField+i*4u,best.xy,best.z);
}
// The spin-up clock (see the top of this file): start it SURF_SPIN seconds back, advance it by a frame of three steps,
// stop it. One invocation each; the coastal flow reads the two words.
@compute @workgroup_size(1) fn spinStart(){let at=cellCount()*9u+3u;put(at,bitcast<u32>(f32(-${SURF_SPIN.toFixed(1)})));put(at+1u,bitcast<u32>(f32(${SPIN_STEP})));}
@compute @workgroup_size(1) fn spinTick(){let at=cellCount()*9u+3u;put(at,bitcast<u32>(bitcast<f32>(word(at))+3.0*bitcast<f32>(word(at+1u))));}
@compute @workgroup_size(1) fn spinEnd(){let at=cellCount()*9u+3u;put(at,0u);put(at+1u,0u);}
@compute @workgroup_size(8,8) fn forward(@builtin(global_invocation_id) id:vec3u){let n=cellCount();relax(id,n+1u,n*5u+1u);}
@compute @workgroup_size(8,8) fn backward(@builtin(global_invocation_id) id:vec3u){let n=cellCount();relax(id,n*5u+1u,n+1u);}`
}
`;

/** Builds the surf field of a coastal grid in the flow's `connected` buffer, once, on the flow's first step. */
export class SurfFieldBuilder {
  private readonly pipelines: GPUComputePipeline[];
  private readonly groups: GPUBindGroup[];
  constructor(device: GPUDevice, uniform: GPUBuffer, terrain: GPUTexture, connected: GPUBuffer, waterFrame: string) {
    const atomic = device.createShaderModule({ code: surfFieldShader(waterFrame, true) }),
      plain = device.createShaderModule({ code: surfFieldShader(waterFrame, false) });
    this.pipelines = ['deepest', 'seed', 'forward', 'backward', 'spinStart', 'spinTick', 'spinEnd'].map((entryPoint) =>
      device.createComputePipeline({
        layout: 'auto',
        compute: { module: entryPoint === 'deepest' ? atomic : plain, entryPoint },
      }),
    );
    // The clock's kernels read no frame: their groups hold only the heightmap and the buffer.
    this.groups = this.pipelines.map((pipeline, i) =>
      i < 4
        ? group(device, pipeline, [{ buffer: uniform }, terrain.createView(), { buffer: connected }])
        : device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 1, resource: terrain.createView() },
              { binding: 2, resource: { buffer: connected } },
            ],
          }),
    );
  }
  /** Records the spin-up clock's start (0), one frame's advance (1) or its end (2) into `pass`. */
  clock(pass: GPUComputePassEncoder, phase: 0 | 1 | 2): void {
    pass.setPipeline(this.pipelines[4 + phase]);
    pass.setBindGroup(0, this.groups[4 + phase]);
    pass.dispatchWorkgroups(1);
  }
  /**
   * Records the build, each dispatch into the pass `next` gives (coastal.ts `NextPass`): the deepest edge, the
   * sources, then relaxation sweeps, as many as the grid has cells along both sides (no ray is longer), in an even
   * count so the result ends in field A.
   */
  build(next: (groups?: number) => GPUComputePassEncoder, width: number, height: number): void {
    const x = Math.ceil(width / 8),
      y = Math.ceil(height / 8),
      sweeps = (width + height + 1) & ~1;
    for (let i = 0; i < 2 + sweeps; i++) {
      const pass = next(x * y),
        k = i < 2 ? i : 2 + (i & 1);
      pass.setPipeline(this.pipelines[k]);
      pass.setBindGroup(0, this.groups[k]);
      pass.dispatchWorkgroups(x, y);
    }
  }
}

/** The surf as CoastalFlow takes it (coastal.ts `CoastSurf`); Water passes it, so only entries that use it bundle it. */
export const coastSurf = {
  waves: surfWaves,
  words: surfWords,
  spinFrames: SURF_SPIN_FRAMES,
  build: (device: GPUDevice, uniform: GPUBuffer, terrain: GPUTexture, connected: GPUBuffer, frame: string) =>
    new SurfFieldBuilder(device, uniform, terrain, connected, frame),
};
