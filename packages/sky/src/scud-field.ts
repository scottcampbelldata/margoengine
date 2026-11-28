// The shape of scud (fractus under a rain deck), loaded by import() only when a layer has `type: 'scud'`, so other
// clouds do not carry its WGSL. `volumetric-clouds` takes it through `loadScudField`, as it takes the storm field.
//
// Fractus is "ragged shreds" of low cloud under the base of a rain cloud (WMO International Cloud Atlas, accessory cloud
// pannus: https://cloudatlas.wmo.int/en/clouds-accessory-pannus.html; AMS Glossary of Meteorology, "scud"): it has no
// flat base, its edges are torn at every height, and it streams along the wind. So the shape here takes the field's
// own billows (Schneider and Vos 2015) with three changes: a lens profile, thickest at mid height and thin at both
// faces, in place of the flat base and tapered top; the erosion that eats the edges at every height, never the rounded
// billows of a cumulus top; and the erosion lookup warped by the shape volume's low channels and stretched along the
// wind, so the edges tear into strings that lean downwind (no new texture).

/** What a layer needs to draw scud: its WGSL. */
export interface ScudField {
  /** WGSL functions of the scud shape (replace `//[scud-fns]` of the cloud field). */
  readonly fns: string;
  /** The WGSL line that takes the scud shape when the layer is scud (replaces `//[scud-branch]`). */
  readonly branch: string;
}
/** The field for a noise coverage map of frequency `weather` against the shapes'. */
export function scudField(weather: number): ScudField {
  return {
    fns: /* wgsl */ `
fn cloudScudDensity(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,h:f32,erode:bool)->f32 {
 let lean=vec3f(c.lift.x,0.0,c.lift.y)*h;let drift=vec3f(c.wind.x,c.wind.z,c.wind.y);
 let along=normalize(vec2f(c.lift.x,c.lift.y)+vec2f(1e-6,0.0));let across=vec2f(-along.y,along.x);
 let w=p+drift+lean;let ws=along*(dot(w.xz,along)*0.5)+across*dot(w.xz,across);
 let q=vec3f(ws.x,w.y,ws.y)*c.shape.x;
 let s=textureSampleLevel(shape,smp,q.xzy,0.0);
 let weather=textureSampleLevel(shape,smp,vec3f((p.xz+c.flags.zw+lean.xz)*c.shape.x*${weather},0.37),0.0).g;
 let z=(0.28+0.46*c.layer.z)*min(1.0,c.layer.z/0.15);let cover=clamp(z*(1.0+2.5*(weather-0.48)),0.0,1.0);
 let profile=smoothstep(0.0,0.45,h)*smoothstep(1.0,0.55,h);
 let low=s.g*0.625+s.b*0.25+s.a*0.125;let raw=clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0);
 let cloud=clamp(cloudRemap(raw*profile,1.0-cover,1.0),0.0,1.0);
 if(cloud<=0.0||!erode){return cloud;}
 let e0=p+drift*1.5+lean;let et=along*(dot(e0.xz,along)*0.35)+across*dot(e0.xz,across);
 let warp=(vec3f(s.g,s.b,s.a)-0.5)*(0.7/c.shape.y);
 let e=textureSampleLevel(detail,smp,((vec3f(et.x,e0.y,et.y)+warp)*c.shape.y*2.5).xzy,0.0).rgb;
 let high=e.r*0.625+e.g*0.25+e.b*0.125;
 return clamp(cloudRemap(cloud,high*0.5*c.look.x,1.0),0.0,1.0);
}
`,
    branch: ' if(c.lift.z>0.5){return cloudScudDensity(c,shape,detail,smp,p,h,erode);}',
  };
}
