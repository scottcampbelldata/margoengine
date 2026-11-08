// Contrast-adaptive unsharp mask on the four neighbours, shared by `TAAUpscale` and `Sharpen`: the weight falls as the
// neighbourhood's room to black or white shrinks (min(lo, 1 - hi) / hi), and the result is clamped to the neighbourhood's
// range, so no halo and no clipping. The idea of scaling sharpening by local contrast headroom is described in AMD's
// public FidelityFX CAS documentation (read as documentation; no source); this form is Margo's.
export const sharpenCode = `fn margoSharpen(image:texture_2d<f32>,p:vec2i,amount:f32)->vec3f {
 let top=vec2i(textureDimensions(image))-1;let c=textureLoad(image,p,0).rgb;if(amount<=0){return c;}
 let n=textureLoad(image,clamp(p-vec2i(0,1),vec2i(0),top),0).rgb;let s=textureLoad(image,clamp(p+vec2i(0,1),vec2i(0),top),0).rgb;
 let w=textureLoad(image,clamp(p-vec2i(1,0),vec2i(0),top),0).rgb;let e=textureLoad(image,clamp(p+vec2i(1,0),vec2i(0),top),0).rgb;
 let lo=min(c,min(min(n,s),min(w,e)));let hi=max(c,max(max(n,s),max(w,e)));
 let room=saturate(min(lo,1-hi)/max(hi,vec3f(0.0001)));let k=-0.2*amount*room;
 return clamp((c+k*(n+s+w+e))/(1+4*k),lo,hi);}`;
