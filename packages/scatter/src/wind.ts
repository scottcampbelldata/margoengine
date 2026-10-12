/** Horizontal direction (x,z) and maximum bend strength, in [0,1]. */
export type ScatterWind = readonly [number, number, number];
export function validateWind(wind: ScatterWind): number {
  if (wind.length !== 3 || [0,1,2].some(i => !Number.isFinite(Math.fround(wind[i]))) || wind[2] < 0 || wind[2] > 1 || !Math.hypot(Math.fround(wind[0]),Math.fround(wind[1]))) throw new RangeError('Invalid scatter wind');
  return Math.hypot(wind[0],wind[1]);
}
export const windShader = /* wgsl */`
fn windBend(height:f32,root:vec2f,wind:vec4f)->vec3f {
 let h=max(0.0,height);let phase=dot(root,vec2f(0.17,0.11));
 let gust=(0.65*sin(wind.w*1.7+phase)+0.35*sin(wind.w*0.73+phase*1.9))*wind.z;
 let direction=wind.xy/max(length(wind.xy),0.0001);
 return vec3f(direction*gust*h*h/(1.0+h),gust*h*(2.0+h)/((1.0+h)*(1.0+h)));
}
fn windNormal(normal:vec3f,bend:vec3f,wind:vec4f)->vec3f {
 let direction=wind.xy/max(length(wind.xy),0.0001);
 return vec3f(normal.x,normal.y-dot(normal.xz,direction)*bend.z,normal.z);
}
`;
