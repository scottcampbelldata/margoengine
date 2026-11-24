/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type RenderView } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Picking, type PickHit } from './picking.js';
import type { ScreenRect } from './tools.js';
declare const GPUTextureUsage: {RENDER_ATTACHMENT:number;COPY_SRC:number};
declare const GPUBufferUsage: {MAP_READ:number;COPY_DST:number};
declare const GPUMapMode: {READ:number};
/** Area readback limits. maxPixels defaults to 16777216 drawing-buffer pixels per query. */
export interface AreaPickingOptions { maxPixels?: number; /** Capture ordinary point IDs in the beauty pass. Default false. */ capture?: boolean; }
/** Visible triangle selection at exact raster pixel centres. This picker also supports ordinary point queries. */
export class AreaPicking extends Picking {
  constructor(readonly areaOptions: AreaPickingOptions = {}) {
    super({capture:areaOptions.capture ?? false});
    const max=areaOptions.maxPixels ?? 16777216;
    if (!Number.isSafeInteger(max) || max<1) throw new RangeError('Area maxPixels must be a positive safe integer; choose a readback budget.');
  }
  /** Attach instead of Picking to share its scene, source and point-query protocol. */
  static override attach(engine: EngineKernel, options: AreaPickingOptions = {}): AreaPicking {
    const picker=new AreaPicking(options);engineRuntime(engine).use(picker);return picker;
  }
  /** Marquee in canvas CSS pixels. Negative widths/heights are normalized. Only pixel centres inside the shape count. */
  rect(rect: ScreenRect, view?: RenderView, signal?: AbortSignal): Promise<PickHit[]> {
    const {x,y,width:w,height:h}=rect;
    if (![x,y,w,h,x+w,y+h].every(Number.isFinite)) throw new RangeError('Area rectangle must be finite; pass CSS pixel bounds.');
    return this.polygon([[x,y],[x+w,y],[x+w,y+h],[x,y+h]],view,signal);
  }
  /** Closed, even-odd lasso in CSS pixels, up to 4096 finite vertices. Results follow first visible raster occurrence. */
  async polygon(points: readonly (readonly [number,number])[], view?: RenderView, signal?: AbortSignal): Promise<PickHit[]> {
    signal?.throwIfAborted();
    if (points.length<3 || points.length>4096 || points.some(p=>p.length!==2 || !p.every(Number.isFinite)))
      throw new RangeError('Lasso needs 3-4096 finite xy points; pass canvas CSS pixels.');
    const polygon=points.map(p=>[p[0],p[1]]),e=this.queryEngine;
    if (!e.gpu) throw new MargoError('unsupported','Area picking needs GPU ID targets; use WebGPU or the full compatibility layer.');
    const canvas=e.canvas,cw=canvas.clientWidth||canvas.width,ch=canvas.clientHeight||canvas.height;
    const viewport=view?.viewport ?? (view?.pixels ? [0,0,canvas.width,canvas.height] : [0,0,1,1]),scale=view?.pixels ? [cw/canvas.width,ch/canvas.height]:[cw,ch];
    const clips=[viewport,...(view?.scissor?[view.scissor]:[])];
    let left=Math.max(0,Math.min(...polygon.map(p=>p[0]))),top=Math.max(0,Math.min(...polygon.map(p=>p[1])));
    let right=Math.min(cw,Math.max(...polygon.map(p=>p[0]))),bottom=Math.min(ch,Math.max(...polygon.map(p=>p[1])));
    for(const r of clips){left=Math.max(left,r[0]*scale[0]);top=Math.max(top,r[1]*scale[1]);right=Math.min(right,(r[0]+r[2])*scale[0]);bottom=Math.min(bottom,(r[1]+r[3])*scale[1]);}
    if (right<=left || bottom<=top)return [];
    const out:PickHit[]=[];
    await this.queryContext((left+right)/2,(top+bottom)/2,view,async chosen=>{
      signal?.throwIfAborted();
      const w=canvas.width,h=canvas.height,v=chosen.viewport!,clip=chosen.scissor??v;
      const x0=Math.max(0,v[0],clip[0],Math.floor(left*w/cw)),y0=Math.max(0,v[1],clip[1],Math.floor(top*h/ch));
      const x1=Math.min(w,v[0]+v[2],clip[0]+clip[2],Math.ceil(right*w/cw)),y1=Math.min(h,v[1]+v[3],clip[1]+clip[3],Math.ceil(bottom*h/ch));
      const width=x1-x0,height=y1-y0,pitch=Math.ceil(width*4/256)*256,device=e.gpu!;
      if(width<=0||height<=0)return;
      if(width*height>(this.areaOptions.maxPixels??16777216)||pitch*height>device.limits.maxBufferSize||width>device.limits.maxTextureDimension2D||height>device.limits.maxTextureDimension2D)
        throw new RangeError('Area exceeds the pixel or GPU allocation budget; select a smaller region or raise maxPixels within device limits.');
      const scene=this.scene(),encoder=device.createCommandEncoder();
      const ids=device.createTexture({size:[width,height],format:'r32uint',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      const depth=device.createTexture({size:[width,height],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT});
      const read=device.createBuffer({size:pitch*height,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
      try{
        this.primitives.discover(scene.meshes.values());
        const candidates=this.renderMicro(encoder,x0+(width-1)/2,y0+(height-1)/2,scene.list,v,chosen,{width,height,color:ids.createView(),depth:depth.createView()});
        const instances=this.instanceHits;
        encoder.copyTextureToBuffer({texture:ids},{buffer:read,bytesPerRow:pitch},[width,height]);device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);signal?.throwIfAborted();
        const data=new Uint32Array(read.getMappedRange()),seen=new Set<number>();
        for(let row=0;row<height;row++){
          const y=(y0+row+0.5)*ch/h,edges:number[]=[];
          for(let a=polygon.length-1,b=0;b<polygon.length;a=b++){
            const p=polygon[a],q=polygon[b];
            if((p[1]>y)!==(q[1]>y))edges.push(p[0]+(y-p[1])*(q[0]-p[0])/(q[1]-p[1]));
          }
          edges.sort((a,b)=>a-b);
          for(let k=0;k+1<edges.length;k+=2){
            const start=Math.max(0,Math.ceil(edges[k]*w/cw-x0-0.5)),end=Math.min(width,Math.ceil(edges[k+1]*w/cw-x0-0.5));
            for(let col=start;col<end;col++){
              const at=row*pitch/4+col,id=data[at];if(!id||seen.has(id))continue;seen.add(id);
              const hit=this.decode(scene,data,{at,cx:0,cy:0,width:1,height:1,candidates,instances},chosen);
              if(hit&&!hit.approximate&&!hit.line&&!hit.cloud&&!hit.splats)out.push(hit);
            }
          }
        }
      }finally{if(read.mapState==='mapped')read.unmap();read.destroy();ids.destroy();depth.destroy();}
    });
    signal?.throwIfAborted();return out;
  }
}
