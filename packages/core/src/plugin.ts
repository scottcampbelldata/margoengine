import type { Engine } from './engine.js';
import type { Camera } from './camera.js';

export interface DrawOptions {pipeline?:GPURenderPipeline;bindings?:GPUBindGroupEntry[];clear?:boolean;stencilClear?:number;indirect?:boolean}
export type PassContext={delta:number;width:number;height:number;camera:Camera;draw(options?:DrawOptions):void}&(
  {backend:'webgpu';device:GPUDevice;encoder:GPUCommandEncoder;color:GPUTextureView;depth:GPUTextureView;format:GPUTextureFormat;shader:string;bindings:GPUBindGroupEntry[];indirect:boolean;descriptor:GPURenderPipelineDescriptor}|
  {backend:'webgl2';gl:WebGL2RenderingContext}
);
export interface FramePass {name:string;order:number;execute(context:PassContext):void;prepare?(context:PassContext):void}
export interface EnginePlugin {name:string;setup(engine:Engine):void;onPreUpdate?(delta:number):void;registerPasses?(graph:FrameGraph):void;onDeviceRestored?(engine:Engine):void;dispose?():void}

export class FrameGraph {
  private passes:Array<FramePass&{owner?:string}>=[{name:'main',order:0,execute:context=>context.draw()}];
  private owner?:string;
  private executing=false;
  add(pass:FramePass):()=>void {
    if(this.executing)throw new Error('Cannot edit frame graph while executing');
    if(!pass.name||!Number.isFinite(pass.order)||typeof pass.execute!=='function'||this.passes.some(p=>p.name===pass.name))throw new TypeError('Invalid or duplicate frame pass');
    const record={...pass,owner:this.owner};this.passes.push(record);this.passes.sort((a,b)=>a.order-b.order);
    return()=>{if(this.executing)throw new Error('Cannot edit frame graph while executing');this.passes=this.passes.filter(p=>p!==record);};
  }
  withOwner(owner:string,register:()=>void):void {const previous=this.owner;this.owner=owner;try{register();}finally{this.owner=previous;}}
  removeOwner(owner:string):void {if(this.executing)throw new Error('Cannot edit frame graph while executing');this.passes=this.passes.filter(p=>p.owner!==owner);}
  execute(context:PassContext):void {if(this.executing)throw new Error('Recursive frame graph');this.executing=true;try{for(const pass of this.passes)pass.execute(context);}finally{this.executing=false;}}
  prepare(context:PassContext):void {if(this.executing)throw new Error('Recursive frame graph');this.executing=true;try{for(const pass of this.passes)pass.prepare?.(context);}finally{this.executing=false;}}
}
