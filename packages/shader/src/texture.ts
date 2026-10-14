import {Node,cast,uv,unique,type Input,type Resource} from './node.js';
declare const GPUTextureUsage:{TEXTURE_BINDING:number;COPY_DST:number};
/** Anything with `@margoengine/materials` Texture's `bind`; `srgb` is the default colour space (a texture's own `colorSpace` wins). */
export interface TextureSource {bind(device:GPUDevice,srgb:boolean):[GPUTextureView,GPUSampler]|undefined}
const resources=new WeakMap<TextureSource,Resource&{id:number}>(),fallbacks=new WeakMap<GPUDevice,[GPUTextureView,GPUSampler]>();
/** Opaque white until the source has pixels (an unloaded image or video). */
function white(device:GPUDevice):[GPUTextureView,GPUSampler] {
  let f=fallbacks.get(device);
  if(!f){const texture=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});device.queue.writeTexture({texture},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]);f=[texture.createView(),device.createSampler()];fallbacks.set(device,f);}
  return f;
}
/** Samples a texture (sRGB by default; `new Texture(source, {colorSpace: 'linear'})` for data). Vertex and compute stages, or an explicit
 * `level`, use textureSampleLevel. */
export function texture(source:TextureSource,coord:Input<'vec2f'>=uv(),level?:Input<'f32'>):Node<'vec4f'> {
  if(typeof source?.bind!=='function')throw new TypeError('texture() needs a Texture from @margoengine/materials');
  let r=resources.get(source);
  if(!r){r={id:unique(),prefix:'ndt',bindings:2,declare:(name,group,binding)=>`@group(${group}) @binding(${binding}) var ${name}:texture_2d<f32>;\n@group(${group}) @binding(${binding+1}) var ${name}s:sampler;`,entries:device=>source.bind(device,true)??white(device)};resources.set(source,r);}
  const resource=r,args:Node[]=[cast(coord,'vec2f','texture uv')];if(level!==undefined)args.push(cast(level,'f32','texture level'));
  return new Node('vec4f','t'+r.id,args,(b,n)=>{
    const name=b.resource(resource),[c,l]=n.args.map(a=>b.expr(a)),implicit=l===undefined&&(b.stage.kind==='fragment'||b.stage.kind==='post');
    return implicit?`textureSample(${name}, ${name}s, ${c})`:`textureSampleLevel(${name}, ${name}s, ${c}, ${l??'0.0'})`;
  });
}
