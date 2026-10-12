import type {Engine,EnginePlugin,FrameGraph} from '@margoengine/core/extension';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
export interface ToonOptions {bands?:number;rim?:number}
export class ToonShading implements EnginePlugin {
  readonly name='toon-shading';private buffer?:GPUBuffer;private entry?:GPUBindGroupEntry;private readonly values:Float32Array;
  constructor({bands=4,rim=0.15}:ToonOptions={}){if(!Number.isSafeInteger(bands)||bands<2||bands>16||!Number.isFinite(rim)||rim<0||rim>1)throw new RangeError('Invalid toon options');this.values=new Float32Array([bands,rim,0,0]);}
  setup(engine:Engine):void {if(!engine.gpu)throw new Error('ToonShading requires WebGPU');this.buffer=engine.gpu.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.entry={binding:1,resource:{buffer:this.buffer}};engine.gpu.queue.writeBuffer(this.buffer,0,this.values as Float32Array<ArrayBuffer>);}
  registerPasses(graph:FrameGraph):void {graph.add({name:'toon:shade',order:-25,execute:context=>{if(context.backend!=='webgpu')return;const binding=context.bindings.length+1;
    context.shader=`@group(0) @binding(${binding}) var<uniform> toon:vec4f;\n`+context.shader.replace(/let v=normalize\(frame.eye.xyz-i.position\);[\s\S]*?let linear=[^;]+;/,`let v=normalize(frame.eye.xyz-i.position);let l=normalize(frame.light.xyz);let band=min(toon.x-1.0,floor(max(dot(n,l),0.0)*toon.x))/(toon.x-1.0);let rim=pow(1.0-clamp(dot(n,v),0.0,1.0),3.0)*toon.y;let linear=i.color*(band*frame.radiance.xyz*frame.light.w+frame.radiance.w)+vec3f(rim);`);
    this.entry!.binding=binding;context.bindings.push(this.entry!);
  }});}
  onDeviceRestored(engine:Engine):void {this.dispose();this.setup(engine);}
  dispose():void{this.buffer?.destroy();this.buffer=undefined;this.entry=undefined;}
}
