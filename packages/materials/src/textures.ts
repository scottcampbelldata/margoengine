import type {PBRModel} from '@margoengine/gltf-pro';
import type {ClearcoatTexture} from './index.js';

declare const GPUTextureUsage:{TEXTURE_BINDING:number;COPY_DST:number;RENDER_ATTACHMENT:number};

export interface TextureInfo {index:number;texCoord?:0|1;scale?:number}

const mipShader=/* wgsl */`
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;
}
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var imageSampler:sampler;
@fragment fn fragment(i:Out)->@location(0) vec4f {return textureSample(image,imageSampler,i.uv);}
`;

function integer(value:unknown,label:string):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new TypeError('Invalid clearcoat '+label);
  return value;
}
function record(value:any,label:string):Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid clearcoat '+label);
  return value;
}
function entry(values:any,index:unknown,label:string):Record<string,any> {
  const id=integer(index,label);
  if(!Array.isArray(values))throw new TypeError('Missing clearcoat '+label);
  return record(values[id],label);
}
function samplerDefinition(model:PBRModel,texture:Record<string,any>):Record<string,any> {
  const sampler=texture.sampler===undefined?{}:entry(model.asset.doc.samplers,texture.sampler,'sampler');
  if(sampler.magFilter!==undefined&&![9728,9729].includes(sampler.magFilter)||
    sampler.minFilter!==undefined&&![9728,9729,9984,9985,9986,9987].includes(sampler.minFilter))throw new TypeError('Invalid clearcoat texture filter');
  for(const value of [sampler.wrapS,sampler.wrapT])if(value!==undefined&&![10497,33071,33648].includes(value))throw new TypeError('Invalid clearcoat texture wrapping');
  return sampler;
}

/** Validate glTF texture metadata without allocating any GPU resources. */
export function validateTextureInfo(value:any,model:PBRModel):TextureInfo {
  const info=record(value,'texture info'),index=integer(info.index,'texture index');
  if(info.extensions?.KHR_texture_transform!==undefined)throw new Error('Clearcoat KHR_texture_transform is unsupported');
  if(info.texCoord!==undefined&&info.texCoord!==0&&info.texCoord!==1)throw new TypeError('Invalid clearcoat texture coordinate');
  if(info.scale!==undefined&&(typeof info.scale!=='number'||!Number.isFinite(Math.fround(info.scale))))throw new TypeError('Invalid clearcoat normal scale');
  const texture=entry(model.asset.doc.textures,index,'texture');
  model.image(integer(texture.source,'image source'));
  samplerDefinition(model,texture);
  return {index,texCoord:info.texCoord??0,scale:info.scale??1};
}

interface ImageTexture {texture:GPUTexture;view:GPUTextureView;levels:number;mipsReady:boolean}

/** Owns extension GPU resources while borrowing the model's retained decoded images. */
export class MaterialTextures {
  private readonly images=new Map<number,ImageTexture>();
  private readonly samplers=new Map<number,GPUSampler>();
  private readonly owned=new Set<GPUTexture>();
  private mipPipeline?:GPURenderPipeline;
  private mipSampler?:GPUSampler;
  private disposed=false;
  constructor(private readonly model:PBRModel,private readonly device:GPUDevice) {}

  resolve(value:TextureInfo):ClearcoatTexture {
    if(this.disposed)throw new Error('Material textures are disposed');
    const info=validateTextureInfo(value,this.model),definition=entry(this.model.asset.doc.textures,info.index,'texture');
    const source=integer(definition.source,'image source'),samplerDefinitionValue=samplerDefinition(this.model,definition);
    const usesMips=![9728,9729].includes(samplerDefinitionValue.minFilter);
    let imageTexture=this.images.get(source);
    if(!imageTexture){
      const image=this.model.image(source),size=[image.width,image.height];
      if(size.some(n=>!Number.isSafeInteger(n)||n<1||n>this.device.limits.maxTextureDimension2D))throw new RangeError('Clearcoat image exceeds device limit');
      // Reserve all levels so different samplers can share one image without replacing its view.
      const levels=Math.floor(Math.log2(Math.max(...size)))+1;
      const texture=this.device.createTexture({size,format:'rgba8unorm',mipLevelCount:levels,
        usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
      this.owned.add(texture);
      this.device.queue.copyExternalImageToTexture({source:image},{texture},size);
      imageTexture={texture,view:texture.createView(),levels,mipsReady:levels===1};
      this.images.set(source,imageTexture);
    }
    if(usesMips&&!imageTexture.mipsReady)this.generateMips(imageTexture);
    const samplerId=definition.sampler??-1;
    let sampler=this.samplers.get(samplerId);
    if(!sampler){
      const wrap=(value:any):GPUAddressMode=>value===33071?'clamp-to-edge':value===33648?'mirror-repeat':'repeat';
      const s=samplerDefinitionValue;
      sampler=this.device.createSampler({addressModeU:wrap(s.wrapS),addressModeV:wrap(s.wrapT),
        magFilter:s.magFilter===9728?'nearest':'linear',minFilter:[9728,9984,9986].includes(s.minFilter)?'nearest':'linear',
        mipmapFilter:[9984,9985].includes(s.minFilter)?'nearest':'linear',lodMaxClamp:usesMips?32:0});
      this.samplers.set(samplerId,sampler);
    }
    return {view:imageTexture.view,sampler,texCoord:info.texCoord,scale:info.scale};
  }

  private generateMips(image:ImageTexture):void {
    if(!this.mipPipeline){
      const module=this.device.createShaderModule({code:mipShader});
      this.mipPipeline=this.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},
        fragment:{module,entryPoint:'fragment',targets:[{format:'rgba8unorm'}]}});
    }
    this.mipSampler??=this.device.createSampler({minFilter:'linear',magFilter:'linear'});
    const encoder=this.device.createCommandEncoder();
    for(let level=1;level<image.levels;level++){
      const group=this.device.createBindGroup({layout:this.mipPipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:image.texture.createView({baseMipLevel:level-1,mipLevelCount:1})},{binding:1,resource:this.mipSampler}]});
      const pass=encoder.beginRenderPass({colorAttachments:[{view:image.texture.createView({baseMipLevel:level,mipLevelCount:1}),
        loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}]});
      pass.setPipeline(this.mipPipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
    }
    this.device.queue.submit([encoder.finish()]);image.mipsReady=true;
  }

  dispose():void {
    if(this.disposed)return;this.disposed=true;
    let failure:unknown;
    for(const texture of this.owned)try{texture.destroy();}catch(error){failure??=error;}
    this.owned.clear();this.images.clear();this.samplers.clear();this.mipPipeline=undefined;this.mipSampler=undefined;
    if(failure!==undefined)throw failure;
  }
}
