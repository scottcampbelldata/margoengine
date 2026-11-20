// The hurricane's part of the cloud layer, loaded by import() only when a layer draws a storm (`hurricane` option or
// `type: 'hurricane'`), so clouds without one do not carry its WGSL or its maths. `volumetric-clouds` takes it through
// `loadStormField`; the shadows and shafts read the same one.
import { Hurricane, hurricaneCover, resolveHurricane, type HurricaneOptions, type ResolvedHurricane } from './hurricane.js';
import type { VolumetricCloudOptions } from './volumetric-clouds.js';
const TAU = 2 * Math.PI;
const cover = { eye: 0, eyewall: 0, outerEyewall: 0, moat: 0, band: 0, shield: 0, canopy: 0, cover: 0 };
/** What a layer needs to draw a storm: its WGSL and the CPU side of the same field. */
export interface StormField {
  /** WGSL functions of the storm field (replace `//[storm-fns]` of the cloud field). */
  readonly fns: string;
  /** The WGSL line that takes the storm's density when one is set (replaces `//[storm-branch]`). */
  readonly branch: string;
  /** The storm a layer draws: its `hurricane`, the default storm under `type: 'hurricane'`, else none. */
  of(options: VolumetricCloudOptions): ResolvedHurricane | undefined;
  /** Writes the storm's floats (64 to 95) of the cloud uniform at `seconds`; zeros without a storm. */
  write(v: Float32Array, options: VolumetricCloudOptions, seconds: number, scale: number): void;
  /** The share of the storm's cloud over a point at `seconds`, largest over five heights of the layer. */
  coverOver(storm: ResolvedHurricane, x: number, z: number, seconds: number, depth: number): number;
}
/** The field for a noise coverage map of frequency `weather` against the shapes'. */
export function stormField(weather: number): StormField {
  return {
    fns: /* wgsl */ `
fn cloudStormTop(h:f32,t:f32)->f32 {return 1.0-smoothstep(t-0.1,t,h);}
fn cloudStormSpin(c:Clouds,r:f32)->f32 {
 let s5=c.storm[5];let x=min(pow(s5.z/max(r,1.0),s5.y),80.0);let half=r*s5.w*0.5;
 return (sqrt(s5.x*x*exp(-x)+half*half)-half)/max(r,1.0)*c.storm[6].z*c.storm[3].y;
}
fn cloudStormCover(c:Clouds,d:vec2f,height:f32,h:f32)->vec2f {
 let s0=c.storm[0];let s1=c.storm[1];let s2=c.storm[2];let s3=c.storm[3];let s4=c.storm[4];let s6=c.storm[6];
 let r=length(d);let w=s1.x;let edge=s0.z+s0.w*height;let bandStart=s1.y;let extent=s1.z;
 let eye=s3.x*(1.0-smoothstep(edge-0.1*w,edge,r))*(1.0-smoothstep(800.0,2000.0,height));
 let wall=smoothstep(edge-0.1*w,edge+0.1*w,r)*(1.0-smoothstep(edge+0.5*w,edge+1.1*w,r));
 var outer=0.0;if(s4.x>0.0){let q=(r-s4.x-s0.w*height)/(0.45*w);outer=s4.y*exp(-q*q)*cloudStormTop(h,0.85);}
 let moat=s2.w*smoothstep(edge,edge+0.5*w,r)*(1.0-smoothstep(0.9*bandStart,bandStart,r))*cloudStormTop(h,0.25);
 var band=0.0;let n=s2.x;
 if(n>0.0&&r>0.0){
  let k=s1.w;let phase=n*(s3.y*atan2(-d.y,d.x)+log(r/bandStart)/k+s4.w)/6.2831853;
  let idx=floor(phase+0.5);let index=idx-n*floor(idx/n);let u=abs(phase-idx);
  let across=r*(exp(6.2831853*k/n)-1.0)/sqrt(1.0+k*k);
  let principal=select(0.0,s6.y,index<0.5);let width=s2.y*(1.0+principal);
  let inner=select(bandStart,bandStart+(edge+w*0.8-bandStart)*principal,principal>0.0);let a=u*across/(0.5*width);
  band=exp(-a*a)*smoothstep(0.85*inner,inner,r)*(1.0-smoothstep(0.75*extent,extent,r))*(1.0-0.4*smoothstep(bandStart,extent,r))*cloudStormTop(h,s4.z);
 }
 let shield=s2.z*smoothstep(0.9*bandStart,bandStart,r)*(1.0-smoothstep(0.7*extent,extent,r))*cloudStormTop(h,0.35);
 let canopy=s6.x*smoothstep(edge,edge+0.3*w,r)*(1.0-smoothstep(0.55*extent,0.85*extent,r))*smoothstep(0.78,0.86,h);
 return vec2f(max(max(max(eye,wall),max(outer,moat)),max(max(band,shield),canopy)),max(wall,max(outer,band)));
}
fn cloudStormDensity(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,h:f32,erode:bool)->f32 {
 let centre=c.storm[0].xy;let d=p.xz-centre;
 let parts=cloudStormCover(c,d,cloudAltitude(c,p)-c.layer.x,h);var cover=parts.x*c.layer.z;
 if(cover<=0.0){return 0.0;}
 let phase=c.storm[3].z;let period=c.storm[3].w;let spin=cloudStormSpin(c,length(d));
 let a1=-spin*phase*period;let a2=-spin*fract(phase+0.5)*period;let w1=1.0-abs(1.0-2.0*phase);
 let home=centre-c.storm[7].xy;
 let q1=vec3f(home.x+d.x*cos(a1)+d.y*sin(a1),p.y,home.y-d.x*sin(a1)+d.y*cos(a1));
 let q2=vec3f(home.x+d.x*cos(a2)+d.y*sin(a2),p.y,home.y-d.x*sin(a2)+d.y*cos(a2));
 let drift=vec3f(c.wind.x,c.wind.z,c.wind.y);
 let base=mix(cloudBase(textureSampleLevel(shape,smp,((q2+drift)*c.shape.x).xzy,0.0)),cloudBase(textureSampleLevel(shape,smp,((q1+drift)*c.shape.x).xzy,0.0)),w1);
 let weather=textureSampleLevel(shape,smp,vec3f((q1.xz+c.storm[7].xy-c.storm[7].zw+c.flags.zw)*c.shape.x*${weather},0.37),0.0).g;
 cover=clamp(cover*(1.0+1.2*(weather-0.48)),0.0,1.0);
 let profile=smoothstep(0.0,0.04,h)*smoothstep(1.0,0.9,h);
 let cloud=max(clamp(cloudRemap(base*profile,1.0-cover,1.0),0.0,1.0)*cover,smoothstep(0.75,1.0,parts.y)*profile*(0.45+0.55*base)*cover);
 if(cloud<=0.0||!erode){return cloud;}
 let lift=vec3f(c.wind.x,c.wind.z*2.0,c.wind.y)*1.5;
 let e=mix(textureSampleLevel(detail,smp,((q2+lift)*c.shape.y).xzy,0.0).rgb,textureSampleLevel(detail,smp,((q1+lift)*c.shape.y).xzy,0.0).rgb,w1);
 let high=e.r*0.625+e.g*0.25+e.b*0.125;
 return clamp(cloudRemap(cloud,mix(high,1.0-high,clamp(h*4.0,0.0,1.0))*0.35*c.look.x,1.0),0.0,1.0);
}
`,
    branch: ' if(c.storm[3].y!=0.0){return cloudStormDensity(c,shape,detail,smp,p,h,erode);}',
    of(options) {
      const h = options.hurricane;
      if (h === undefined) return options.type === 'hurricane' ? resolveHurricane() : undefined;
      // A Hurricane (duck-typed, so a second copy of the package works): its options; else the options themselves.
      return resolveHurricane(h instanceof Hurricane || 'weatherAt' in h ? (h as Hurricane).options : (h as HurricaneOptions));
    },
    write(v, options, seconds, scale) {
      const s = this.of(options);
      if (!s) {
        v.fill(0, 64, 96);
        return;
      }
      const mx = s.vx * seconds,
        mz = s.vz * seconds;
      v[64] = s.cx + mx;
      v[65] = s.cz + mz;
      v[66] = s.eye;
      v[67] = s.slope;
      v[68] = s.wall;
      v[69] = s.bandStart;
      v[70] = s.extent;
      v[71] = Math.tan(s.pitch);
      v[72] = s.bands;
      v[73] = s.bandWidth;
      v[74] = s.shield;
      v[75] = s.moat;
      v[76] = s.eyeCloud;
      v[77] = s.spin;
      v[78] = (seconds / s.flowPeriod) % 1;
      v[79] = s.flowPeriod;
      v[80] = s.outer;
      v[81] = s.outerStrength;
      v[82] = s.bandTop;
      v[83] = (s.bandRotation + s.bandDrift * seconds) % TAU;
      v[84] = (s.b * s.dp) / s.rho;
      v[85] = s.b;
      v[86] = s.rmax;
      v[87] = s.f;
      v[88] = s.canopy;
      v[89] = s.principal;
      v[90] = s.swirl;
      v[91] = 0;
      // The storm's travel, wrapped at the shapes' repeat and at the coverage map's: the cloud's noise rides with the storm.
      v[92] = mx % scale;
      v[93] = mz % scale;
      v[94] = mx % (scale / weather);
      v[95] = mz % (scale / weather);
    },
    coverOver(storm, x, z, seconds, depth) {
      const dx = x - (storm.cx + storm.vx * seconds),
        dz = z - (storm.cz + storm.vz * seconds),
        r = Math.hypot(dx, dz),
        theta = Math.atan2(-dz, dx);
      let most = 0;
      for (const h of [0.05, 0.3, 0.55, 0.8, 0.95])
        most = Math.max(most, hurricaneCover(storm, r, theta, h * depth, h, seconds, cover).cover);
      return most;
    },
  };
}
