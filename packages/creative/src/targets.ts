import {SceneTarget,sceneSamples} from '../../shared/msaa.js';
import type {PassContext} from '@margoengine/core/extension';
declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;STORAGE_BINDING:number;COPY_SRC:number};
export class HDRRenderTarget {
  scene!:{readonly color:GPUTextureView;readonly depth:GPUTextureView;begin(context:Extract<PassContext,{backend:'webgpu'}>):void;resolve(encoder:GPUCommandEncoder,final?:boolean):void;restore(context:Extract<PassContext,{backend:'webgpu'}>):void;dispose():void};
  color!:GPUTexture;depth!:GPUTexture;width=0;height=0;
  constructor(readonly device:GPUDevice,width:number,height:number,readonly samples=sceneSamples()){this.resize(width,height);}
  resize(width:number,height:number):void {
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||Math.min(width,height)<1||Math.max(width,height)>Math.min(4096,this.device.limits.maxTextureDimension2D))throw new RangeError('HDR target size exceeds limits');
    if(width===this.width&&height===this.height)return;
    const color=this.device.createTexture({size:[width,height],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});
    let depth:GPUTexture;try{depth=this.device.createTexture({size:[width,height],format:(this.device.features.has('depth32float-stencil8')?'depth32float-stencil8':'depth32float'),usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});}catch(error){color.destroy();throw error;}
    let scene:SceneTarget;try{scene=new SceneTarget(this.device,color,depth,this.samples);}catch(error){color.destroy();depth.destroy();throw error;}
    this.scene?.dispose();this.color?.destroy();this.depth?.destroy();this.scene=scene;this.color=color;this.depth=depth;this.width=width;this.height=height;
  }
  dispose():void{this.scene?.dispose();this.color?.destroy();this.depth?.destroy();this.width=this.height=0;}
}
