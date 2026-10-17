// Margo's display transform. Khronos PBR Neutral tone mapping, written from the Khronos Group's published specification
// (2024): a colour passes through below 0.76 (less a small offset that keeps blacks black), its peak rolls off towards
// white above that, and saturation falls only as the peak does, so base colours under neutral light show as authored.
// Then the exact sRGB encoding (IEC 61966-2-1). Core keeps its own copy of the curve; every package that writes a lit
// colour to the screen ends with these, so a colour looks the same on a core mesh, a glTF model, terrain, sky, water,
// foliage and after any post effect.
export const neutralShader = `fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
`;
export const displayShader = `${neutralShader}fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`;
