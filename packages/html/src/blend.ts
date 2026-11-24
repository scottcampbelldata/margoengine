/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import { LabelRenderer, type Label, type CSS3DObject, type CSS3DOptions, type LabelRendererOptions } from '@margoengine/labels';
import { margoError } from '../../shared/errors.js';
import { overlayDepthPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';
import { htmlGLState, htmlProgram } from './gl.js';

declare const GPUBufferUsage: {UNIFORM:number;COPY_DST:number};
const wgsl = `struct Mask {camera:mat4x4f,model:mat4x4f,size:vec4f}
@group(0) @binding(0) var<uniform> mask:Mask;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,6>(vec2f(-.5,.5),vec2f(.5,.5),vec2f(-.5,-.5),vec2f(-.5,-.5),vec2f(.5,.5),vec2f(.5,-.5))[i];
 return mask.camera*mask.model*vec4f(p*mask.size.xy,0,1);
}
@fragment fn fragment()->@location(0) vec4f {return vec4f(0);}`;
const vertex = `#version 300 es
uniform mat4 camera,model;uniform vec2 size;
void main(){vec2 p[6]=vec2[6](vec2(-.5,.5),vec2(.5,.5),vec2(-.5,-.5),vec2(-.5,-.5),vec2(.5,.5),vec2(.5,-.5));
gl_Position=camera*model*vec4(p[gl_VertexID]*size,0,1);}`;
const fragment = `#version 300 es
precision highp float;out vec4 color;void main(){color=vec4(0);}`;
type GPUContext = Extract<PassContext,{backend:'webgpu'}>;
interface Mask {uniform?:GPUBuffer;group?:GPUBindGroup;pipeline?:GPURenderPipeline}
interface CanvasState {owners:number;position:string;zIndex:string;pointerEvents:string;alphaMode:GPUCanvasAlphaMode}
const canvases = new WeakMap<HTMLCanvasElement,CanvasState>();

/** CSS3D panels behind a depth-tested transparent canvas aperture. Rectangular panels retain real DOM content. */
export class HTMLBlend extends LabelRenderer {
  private runtime?: Engine;
  private readonly masks = new Map<CSS3DObject,Mask>();
  private readonly pipelines = new Map<string,GPURenderPipeline>();
  private readonly values = new Float32Array(36);
  private readonly viewport: [number,number,number,number] = [0,0,0,0];
  private readonly descriptor = overlayDepthPass();
  private glState?: {gl:WebGL2RenderingContext;program:WebGLProgram;vao:WebGLVertexArrayObject};
  private disposed = false;
  constructor(options: LabelRendererOptions = {}) {super({...options,name:options.name??'html-blend',zIndex:options.zIndex??0});}
  /** Attaches the DOM layer and the mask pass; preview must be created with an alpha-enabled renderer. */
  static override attach(engine: EngineKernel, options?: LabelRendererOptions): HTMLBlend {
    const blend = new HTMLBlend(options);
    engineRuntime(engine).use(blend);
    return blend;
  }
  override setup(instance:EngineKernel):void {
    if (this.disposed) throw margoError('disposed','HTMLBlend is disposed; create a new HTMLBlend');
    const engine=engineRuntime(instance), canvas=engine.canvas;
    if (!engine.gpu && !canvas.getContext('webgl2')?.getContextAttributes()?.alpha)
      throw margoError('unsupported','HTMLBlend needs canvas alpha; create the preview with webglRenderer(canvas, {transparent: true})');
    this.runtime=engine;
    let state=canvases.get(canvas);
    if (!state) {
      state={owners:0,position:canvas.style.position,zIndex:canvas.style.zIndex,pointerEvents:canvas.style.pointerEvents,
        alphaMode:this.configuration()?.alphaMode??'opaque'};
      canvases.set(canvas,state);
    }
    state.owners++;
    canvas.style.position ||= 'relative';
    canvas.style.zIndex='1';
    canvas.style.pointerEvents='none';
    this.configure('premultiplied');
    super.setup(instance);
  }
  override add3D(element:HTMLElement,options:CSS3DOptions={}):CSS3DObject {
    if (this.disposed) throw margoError('disposed','HTMLBlend is disposed; create a new HTMLBlend');
    const object=super.add3D(element,{pointerEvents:'auto',...options});
    this.masks.set(object,{});
    return object;
  }
  override remove(item:Label|CSS3DObject):void {
    const mask=this.masks.get(item as CSS3DObject);
    mask?.uniform?.destroy();
    this.masks.delete(item as CSS3DObject);
    super.remove(item);
  }
  override registerPasses(graph:FrameGraph):void {
    graph.add({name:this.name,order:0.9,execute:(context)=>{
      for(const object of this.masks.keys()) object.remeasure();
      this.update();
      if(context.backend==='webgpu') this.drawGPU(context);
      else this.drawGL(context);
    }});
  }
  private configuration():GPUCanvasConfiguration|null|undefined {
    if(!this.runtime?.gpu) return undefined;
    return (this.runtime.canvas.getContext('webgpu') as GPUCanvasContext)?.getConfiguration?.();
  }
  private configure(alphaMode:GPUCanvasAlphaMode):void {
    const engine=this.runtime;
    if(!engine?.gpu || engine.disposed) return;
    (engine.canvas.getContext('webgpu') as GPUCanvasContext).configure({
      ...this.configuration(),device:engine.gpu,format:this.configuration()?.format??navigator.gpu.getPreferredCanvasFormat(),alphaMode,
    });
  }
  private pipeline(c:GPUContext):GPURenderPipeline {
    const d=c.descriptor,key=`${c.format} ${d.multisample?.count} ${d.depthStencil?.format} ${d.depthStencil?.depthCompare}`;
    let pipeline=this.pipelines.get(key);
    if(!pipeline) {
      const module=c.device.createShaderModule({code:wgsl});
      pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},
        fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},primitive:{topology:'triangle-list',cullMode:'none'},
        depthStencil:d.depthStencil&&{format:d.depthStencil.format,depthWriteEnabled:true,depthCompare:d.depthStencil.depthCompare??'less'},
        multisample:d.multisample});
      this.pipelines.set(key,pipeline);
    }
    return pipeline;
  }
  private explicitViewport(c:PassContext):readonly number[]|undefined {
    const view=this.view;
    if(!view) return undefined;
    const [x,y,width,height]=view.viewport??[0,0,1,1],canvas=this.runtime!.canvas,
      sx=view.pixels?c.width/canvas.width:c.width,sy=view.pixels?c.height/canvas.height:c.height;
    this.viewport[0]=x*sx;this.viewport[1]=y*sy;
    this.viewport[2]=width*sx;this.viewport[3]=height*sy;
    return this.viewport;
  }
  private drawGPU(c:GPUContext):void {
    if(!this.masks.size) return;
    const pipeline=this.pipeline(c),viewport=this.explicitViewport(c),
      camera=this.view?(this.view.camera??this.runtime!.camera):c.camera;
    let pass:GPURenderPassEncoder|undefined;
    for(const [object,mask] of this.masks) {
      if(!object.onScreen) continue;
      mask.uniform??=c.device.createBuffer({size:144,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      if(mask.pipeline!==pipeline) {mask.group=undefined;mask.pipeline=pipeline;}
      mask.group??=c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:mask.uniform}}]});
      this.values.set(camera.matrix);
      this.values.set(object.matrix,16);
      this.values[32]=object.element.offsetWidth*object.pixelScale;
      this.values[33]=object.element.offsetHeight*object.pixelScale;
      c.device.queue.writeBuffer(mask.uniform,0,this.values as Float32Array<ArrayBuffer>);
      if(!pass) {
        this.descriptor.colorAttachments[0].view=c.color;
        this.descriptor.depthStencilAttachment.view=c.depth;
        pass=c.encoder.beginRenderPass(this.descriptor);
        if(viewport) {
          const [x,y,width,height]=viewport,left=Math.max(0,Math.floor(x)),top=Math.max(0,Math.floor(y)),
            right=Math.min(c.width,Math.ceil(x+width)),bottom=Math.min(c.height,Math.ceil(y+height));
          pass.setViewport(x,y,width,height,0,1);
          pass.setScissorRect(left,top,Math.max(0,right-left),Math.max(0,bottom-top));
        } else applyView(pass,c);
        pass.setPipeline(pipeline);
      }
      pass.setBindGroup(0,mask.group);
      pass.draw(6);
    }
    pass?.end();
  }
  private drawGL(c:Extract<PassContext,{backend:'webgl2'}>):void {
    if(!this.masks.size || c.gl.isContextLost()) return;
    const gl=c.gl;
    if(this.glState?.gl!==gl) this.releaseGL();
    this.glState??={gl,program:htmlProgram(gl,vertex,fragment),vao:gl.createVertexArray()!};
    const {program,vao}=this.glState,restore=htmlGLState(gl);
    try {
      const explicit=this.explicitViewport(c),[x,y,w,h]=explicit??c.view?.viewport??[0,0,c.width,c.height],
        camera=this.view?(this.view.camera??this.runtime!.camera):c.camera;
      gl.viewport(x,c.height-y-h,w,h);
      if(explicit) {
        const left=Math.max(0,Math.floor(x)),top=Math.max(0,Math.floor(y)),
          right=Math.min(c.width,Math.ceil(x+w)),bottom=Math.min(c.height,Math.ceil(y+h));
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(left,c.height-bottom,Math.max(0,right-left),Math.max(0,bottom-top));
      }
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.colorMask(true,true,true,true);
      gl.uniformMatrix4fv(gl.getUniformLocation(program,'camera'),false,camera.matrix);
      for(const object of this.masks.keys()) if(object.onScreen) {
        gl.uniformMatrix4fv(gl.getUniformLocation(program,'model'),false,new Float32Array(object.matrix));
        gl.uniform2f(gl.getUniformLocation(program,'size'),object.element.offsetWidth*object.pixelScale,object.element.offsetHeight*object.pixelScale);
        gl.drawArrays(gl.TRIANGLES,0,6);
      }
    } finally {restore();}
  }
  private releaseGL():void {
    const state=this.glState;
    this.glState=undefined;
    if(!state || state.gl.isContextLost()) return;
    state.gl.deleteProgram(state.program);
    state.gl.deleteVertexArray(state.vao);
  }
  /** Rebuilds lazily after restoration and reapplies alpha compositing to the restored canvas. */
  onDeviceRestored():void {
    this.pipelines.clear();
    for(const mask of this.masks.values()) {mask.uniform=mask.group=mask.pipeline=undefined;}
    this.releaseGL();
    this.configure('premultiplied');
  }
  override dispose():void {
    if(this.disposed) return;
    this.disposed=true;
    this.releaseGL();
    const canvas=this.runtime?.canvas,state=canvas&&canvases.get(canvas);
    if(state && --state.owners===0) {
      this.configure(state.alphaMode);
      canvas!.style.position=state.position;
      canvas!.style.zIndex=state.zIndex;
      canvas!.style.pointerEvents=state.pointerEvents;
      canvases.delete(canvas!);
    }
    super.dispose();
    this.pipelines.clear();
    this.runtime=undefined;
  }
  declare [Symbol.dispose]:()=>void;
  [(Symbol.dispose??Symbol()) as symbol]():void {this.dispose();}
}
