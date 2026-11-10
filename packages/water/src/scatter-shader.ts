// Light through thin wave crests: the translucency approximation of Colin Barre-Brisebois and Marc Bouchard,
// "Approximating Translucency for a Fast, Cheap and Convincing Subsurface Scattering Look" (GDC 2011). The view
// vector against the light, bent by the normal times `distortion`, raised to `power`, scaled by a thickness proxy:
// how far the point stands above the still level as a share of the configured wave amplitude, or a crest.
// `base` is a WGSL expression of xz giving (still level, wave share) at that point.
export function scatterShader(binding: number, base: string): string {
  return `
struct ScatterFrame {color:vec4f,shape:vec4f}
@group(0) @binding(${binding}) var<uniform> scatterFrame:ScatterFrame;
fn scatterThickness(world:vec3f,xz:vec2f,crest:f32)->f32 {
 var amplitude=0.0;for(var j=0u;j<u32(frame.settings.w);j++){amplitude+=frame.waves[j].wave.z;}
 let b:vec2f=${base};
 return max(crest,clamp((world.y-b.x)/max(0.0001,amplitude*b.y),0.0,1.0));
}
fn scatterLight(l:Light,n:vec3f,v:vec3f)->vec3f {
 if(l.direction.w<=0.0){return vec3f(0);}
 let bent=l.direction.xyz+n*scatterFrame.shape.y;let h=bent/max(0.0001,length(bent));
 return l.radiance.rgb*l.direction.w*pow(clamp(dot(v,-h),0.0,1.0),scatterFrame.shape.x);
}
fn waterScatter(world:vec3f,xz:vec2f,crest:f32,n:vec3f,v:vec3f)->vec3f {
 let s=scatterFrame.color.rgb*scatterFrame.color.w*scatterThickness(world,xz,crest)*(scatterLight(frame.lights[0],n,v)+scatterLight(frame.lights[1],n,v));
 if(max(s.x,max(s.y,s.z))<=0.0){return s;}
 return s*waterShadow(world);
}
`;
}
