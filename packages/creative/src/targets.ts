declare const GPUTextureUsage:{RENDER_ATTACHMENT:number;TEXTURE_BINDING:number;STORAGE_BINDING:number;COPY_SRC:number};
export class HDRRenderTarget {
  color!:GPUTexture;depth!:GPUTexture;width=0;height=0;
  constructor(readonly device:GPUDevice,width:number,height:number){this.resize(width,height);}
  resize(width:number,height:number):void {
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||Math.min(width,height)<1||Math.max(width,height)>Math.min(4096,this.device.limits.maxTextureDimension2D))throw new RangeError('HDR target size exceeds limits');
    if(width===this.width&&height===this.height)return;
    const color=this.device.createTexture({size:[width,height],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});
    let depth:GPUTexture;try{depth=this.device.createTexture({size:[width,height],format:(this.device.features.has('depth32float-stencil8')?'depth32float-stencil8':'depth32float'),usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});}catch(error){color.destroy();throw error;}
    this.color?.destroy();this.depth?.destroy();this.color=color;this.depth=depth;this.width=width;this.height=height;
  }
  dispose():void{this.color?.destroy();this.depth?.destroy();this.width=this.height=0;}
}
