import type {VFXFeatures} from './base.js';
declare const GPUTextureUsage:{COPY_DST:number;TEXTURE_BINDING:number};
/** `texture` option: an RGBA8 sRGB sprite multiplied by the particle colour instead of the soft disc. */
export const texture:NonNullable<VFXFeatures['texture']>={
 copy(t){if(!Number.isSafeInteger(t.width)||!Number.isSafeInteger(t.height)||Math.min(t.width,t.height)<1||Math.max(t.width,t.height)>4096||!(t.data instanceof Uint8Array||t.data instanceof Uint8ClampedArray)||t.data.length!==t.width*t.height*4)throw new RangeError('Invalid RGBA particle texture');return {width:t.width,height:t.height,data:Uint8Array.from(t.data)};},
 patch:billboard=>billboard.replace('struct Out','@group(0) @binding(3) var sprite:texture_2d<f32>;\n@group(0) @binding(4) var spriteSampler:sampler;\nstruct Out')
  .replace('let radius=dot(i.uv,i.uv);if(radius>1){discard;}return vec4f(i.color.rgb,i.color.a*(1-radius)*(1-radius));','let t=textureSample(sprite,spriteSampler,i.uv*vec2f(0.5,-0.5)+0.5);if(t.a<0.02||any(abs(i.uv)>vec2f(1))){discard;}return vec4f(i.color.rgb*t.rgb,i.color.a*t.a);'),
 create(d,s,owned){
  const texture=d.createTexture({size:[s.width,s.height],format:'rgba8unorm-srgb',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});owned.push(texture);d.queue.writeTexture({texture},s.data as Uint8Array<ArrayBuffer>,{bytesPerRow:s.width*4},[s.width,s.height]);
  return [{binding:3,resource:texture.createView()},{binding:4,resource:d.createSampler({minFilter:'linear',magFilter:'linear'})}];
 }};
