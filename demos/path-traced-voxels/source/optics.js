export const camera={position:[84,58,104],target:[30.3,10,22.6],near:.25,far:440};
export const imageSize=[960,840];
export const referenceSamples=160;

export const tracing={
  resolutionScale:1,samplesPerFrame:1,maxSamples:64,maxBounces:7,
  denoise:'auto',toneMapping:'agx',exposure:.58,clamp:28,
};

export function projection(out,aspect,webgpu){
  const {near,far}=camera,range=far-near,span=Math.max(55,76/aspect);
  out[0]=2/(span*aspect);out[5]=2/span;
  out[10]=webgpu?1/range:-2/range;
  out[14]=webgpu?far/range:-(far+near)/range;
  out[15]=1;
}
