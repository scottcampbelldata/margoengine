import type {PassContext} from '@margoengine/core/extension';
type Context=Extract<PassContext,{backend:'webgpu'}>;
export interface PBRDeviceRenderer {
  /** Encode deformation on this renderer's device before opening the eye pass. */
  prepare(context:Pick<Context,'backend'|'device'|'encoder'>):void;
  /** Append the ordinary PBR shader to a caller-owned forward-Z eye pass. */
  draw(context:Context,pass:GPURenderPassEncoder,view:ArrayLike<number>):void;
  dispose():void;
}
export interface PBRDeformationRenderer {
  prepare(context:Pick<Context,'backend'|'device'|'encoder'>):void;
  dispose():void;
}

/** Own only replica resources. The source retains its nodes, decoded images and device. */
export function deviceRenderer(device:GPUDevice,prepare:PBRDeviceRenderer['prepare'],draw:PBRDeviceRenderer['draw'],release:()=>void,onDispose:(cleanup:()=>void)=>()=>void):PBRDeviceRenderer {
  let disposed=false,unsubscribe:(()=>void)|undefined;
  const renderer:PBRDeviceRenderer={
    prepare(context){if(disposed)throw new Error('PBR device renderer is disposed');if(context.device!==device)throw new Error('PBR renderer belongs to another GPU device');prepare(context);},
    draw(context,pass,view){if(disposed)throw new Error('PBR device renderer is disposed');if(context.device!==device)throw new Error('PBR renderer belongs to another GPU device');draw(context,pass,view);},
    dispose(){if(disposed)return;disposed=true;unsubscribe?.();unsubscribe=undefined;release();},
  };
  unsubscribe=onDispose(()=>renderer.dispose());
  return renderer;
}
