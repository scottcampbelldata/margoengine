// Rain shafts under a deck (`VolumetricClouds` `rain`), loaded by import() only when a layer has rain cells, so other
// clouds do not carry their WGSL. `volumetric-clouds` takes it through `loadRainShafts`, as it takes the storm field.
//
// The rain is a medium in the air under the base, marched along each view ray in the layer's air band. Its rate at a
// point is each cell's footprint at cloud base (an exponential mound, as `PrecipitationField`'s `RainCell`) read where
// the water now passing that point left the base: tau = (base - h) / v seconds ago, at xz - (wind - cell velocity) tau
// (the fall streak trails downwind: the drift law of `@margoengine/weather` `PrecipitationField.sample`), with v the
// fall speed of the median drop of the strongest cell (Marshall and Palmer 1948 sizes, the Atlas, Srivastava and
// Sekhon 1973 fall-speed fit, as `rainFall` in `@margoengine/sky/weather`), and nothing under a cell's `reach` (virga
// that stops above the ground). A streak noise
// carried down the fall line breaks the shaft into curtains (`streaks`, 0 for an even shaft). Extinction is that of
// Marshall and Palmer's drops, N(D) = N0 exp(-L D) with N0 = 8000 per m^3 per mm and L = 4.1 R^-0.21 per mm, at the
// geometric-optics extinction efficiency 2: sigma = 2 (pi / 4) N0 2 / L^3 = pi N0 / L^3 (D in mm, 1e-6 m^2 per mm^2) =
// 3.647e-4 R^0.63 per metre (R in mm/h). The
// drops scatter the light round them isotropically, as the layer's mist does: the ground's (the sky light's lower half
// and the ground lights at the drop's own place and height) and the deck's, plus the sun and moon through the deck.

/** What a layer needs to draw rain shafts: its WGSL. */
export interface RainShafts {
  /** WGSL of the rain march (replaces `//[rain-fns]` of the picture shader). */
  readonly fns: string;
  /** The WGSL lines that put the rain in front of the cloud (replace `//[rain-call]`). */
  readonly call: string;
}
/** The rain shafts' shader code. */
export function rainShafts(): RainShafts {
  return {
    fns: /* wgsl */ `
fn cloudRainAt(p:vec2f,h:f32)->f32 {
 let base=clouds.rain[0].z;if(h>=base){return 0.0;}
 let tau=(base-max(h,0.0))/clouds.rain[0].w;var rate=0.0;
 for(var i=0u;i<8u;i++){
  let c=clouds.rainCells[2u*i];if(c.z<=0.0){break;}let m=clouds.rainCells[2u*i+1u];
  if(h<m.z){continue;}
  let o=p-c.xy-(clouds.rain[1].xy-m.xy)*tau;
  rate+=c.w*exp(-length(o)/c.z);
 }
 return rate;
}
fn cloudRain(d:vec3f,far:f32,jitter:f32)->vec4f {
 let e=clouds.eye.xyz;let low=clouds.rain[1].z;let high=clouds.rain[1].w;let altitude=cloudAltitude(clouds,e);
 let up=dot(d,normalize(vec3f(e.x,e.y+clouds.eye.w,e.z)))>0.0;var a=0.0;var b=0.0;
 if(altitude>=high){
  let hi=cloudShell(d,high);if(hi.x<=0.0){return vec4f(0,0,0,1);}a=hi.x;
  let lo=cloudShell(d,low);b=select(hi.y,lo.x,lo.x>0.0);
 } else if(altitude>=low){
  let lo=cloudShell(d,low);b=select(cloudShell(d,high).y,lo.x,lo.x>0.0);
 } else {
  if(!up){return vec4f(0,0,0,1);}a=cloudShell(d,low).y;b=cloudShell(d,high).y;
 }
 b=min(b,min(far,a+clouds.shape.z));if(b<=a){return vec4f(0,0,0,1);}
 let n=u32(clouds.rain[0].y);let dt=(b-a)/f32(n);let streaks=clouds.rain[2].x;let r=clouds.rain[2].y;
 let above=textureLoad(skyLight,vec2i(0,0),0).rgb*clouds.link.z;let sky=textureLoad(skyLight,vec2i(1,0),0).rgb+clouds.look.w*above;
 let lit=clouds.sunColor.rgb*clouds.sun.w*clouds.link.x*clouds.rain[2].z+clouds.moonColor.rgb*clouds.moon.w*clouds.link.y*clouds.rain[2].w*0.15;
 var transmittance=1.0;var light=vec3f(0);
 for(var k=0u;k<n;k++){
  let t=a+(f32(k)+jitter)*dt;let p=e+d*t;let h=cloudAltitude(clouds,p);
  var rate=cloudRainAt(p.xz,h);if(rate<=0.0){continue;}
  if(streaks>0.0){
   let tau=(clouds.rain[0].z-max(h,0.0))/clouds.rain[0].w;let s=(p.xz-clouds.rain[1].xy*tau)/3000.0;
   let fibre=smoothstep(0.35,0.65,textureSampleLevel(erosionNoise,noiseSampler,vec3f(s.x,s.y,0.5),0.0).r);
   rate*=mix(1.0,2.0*fibre,streaks);
  }
  let sigma=3.647e-4*pow(rate,0.63);let step=exp(-sigma*dt);
  let source=0.5*((1.0+r)*(sky+cloudGround(p.xz,max(h,0.0)))+(1.0-r)*above)+lit;
  light+=transmittance*(1.0-step)*source;transmittance*=step;
 }
 return vec4f(light,transmittance);
}
`,
    call: /* wgsl */ ` if(clouds.rain[0].x>0.0){let rain=cloudRain(d,sceneFar,fract(cloudHash3(vec3u(vec2u(i.position.xy),11u)).x+clouds.flags.y));light=rain.rgb+rain.a*light;opacity=1.0-rain.a*(1.0-opacity);}`,
  };
}
