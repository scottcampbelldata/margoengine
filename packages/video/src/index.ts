/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine,type EnginePlugin,type FrameGraph} from '@margoengine/core/extension';
import {group,render} from '../../shared/gpu.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
export interface VideoOptions {rect?:readonly [number,number,number,number];audio?:AudioContext;fftSize?:number;onFrequency?:(bins:Uint8Array)=>void}
const sources=new WeakMap<HTMLMediaElement,{context:AudioContext;node:MediaElementAudioSourceNode;users:number}>();
const shader=`
struct Vertex {@builtin(position) position:vec4f,@location(0) uv:vec2f}
@group(0) @binding(0) var video:texture_external;
@group(0) @binding(1) var linear:sampler;
@group(0) @binding(2) var<uniform> rect:vec4f;
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex{
 let p=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[index];
 let screen=rect.xy+p*rect.zw;return Vertex(vec4f(screen.x*2.0-1.0,1.0-screen.y*2.0,0,1),p);
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f{return textureSampleBaseClampToEdge(video,linear,i.uv);}
`;
let serial=0;
/** Caller owns playback, AudioContext and VideoFrame lifetime. No decoded-frame uploads. */
export class Video implements EnginePlugin {
 readonly name='video:'+ ++serial;private engine?:Engine;private pipeline?:GPURenderPipeline;private sampler?:GPUSampler;private uniform?:GPUBuffer;private format='';private disposed=false;
 private analyser?:AnalyserNode;private audioSource?:MediaElementAudioSourceNode;readonly frequencies:Uint8Array<ArrayBuffer>;private readonly rectangle:Float32Array;
 constructor(readonly source:HTMLVideoElement|VideoFrame,private readonly options:VideoOptions={}){
  const isVideo=typeof HTMLVideoElement!=='undefined'&&source instanceof HTMLVideoElement,isFrame=typeof VideoFrame!=='undefined'&&source instanceof VideoFrame;
  const rect=options.rect??[0,0,1,1],fft=options.fftSize??2048;
  if(!isVideo&&!isFrame||rect.length!==4||rect.some(v=>!Number.isFinite(v)||v<0||v>1)||rect[2]<=0||rect[3]<=0||rect[0]+rect[2]>1||rect[1]+rect[3]>1||!Number.isInteger(fft)||fft<32||fft>32768||(fft&(fft-1))||options.onFrequency!==undefined&&typeof options.onFrequency!=='function'||options.audio&&!isVideo)throw new RangeError('Invalid video source, rectangle or FFT size');
  this.rectangle=new Float32Array(rect);this.frequencies=new Uint8Array(options.audio?fft/2:0);
  if(options.audio){
   const element=source as HTMLVideoElement,existing=sources.get(element);
   if(existing&&existing.context!==options.audio)throw new Error('Video is already connected to a different AudioContext');
   const shared=existing??{context:options.audio,node:options.audio.createMediaElementSource(element),users:0};
   sources.set(element,shared);
   try{
    this.analyser=options.audio.createAnalyser();this.analyser.fftSize=fft;
    if(!shared.users)shared.node.connect(options.audio.destination);shared.node.connect(this.analyser);shared.users++;this.audioSource=shared.node;
   }catch(error){
    if(this.analyser){try{shared.node.disconnect(this.analyser);}catch{}this.analyser.disconnect();}
    if(!shared.users)try{shared.node.disconnect(options.audio.destination);}catch{}
    throw error;
   }
  }
 }
 static attach(engine:EngineKernel,source:HTMLVideoElement|VideoFrame,options:VideoOptions={}):Video {const video=new Video(source,options);try{engineRuntime(engine).use(video);return video;}catch(error){video.dispose();throw error;}}
 import(device:GPUDevice):GPUExternalTexture|null {
  if(this.disposed)throw new Error('Video is disposed');
  if('readyState' in this.source&&(!this.source.videoWidth||this.source.readyState<2))return null;
  if('displayWidth' in this.source&&!this.source.displayWidth)return null;
  return device.importExternalTexture({source:this.source,colorSpace:'srgb'});
 }
 sampleFrequency():Uint8Array {if(this.disposed)throw new Error('Video is disposed');this.analyser?.getByteFrequencyData(this.frequencies);this.options.onFrequency?.(this.frequencies);return this.frequencies;}
 setup(engine:Engine):void {if(this.disposed||!engine.gpu)throw new Error('Video requires WebGPU');this.engine=engine;this.uniform=engine.gpu.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});engine.gpu.queue.writeBuffer(this.uniform,0,this.rectangle as Float32Array<ArrayBuffer>);this.sampler=engine.gpu.createSampler({minFilter:'linear',magFilter:'linear'});}
 registerPasses(graph:FrameGraph):void {graph.add({name:this.name+':frame',order:60,execute:c=>{
  if(c.backend!=='webgpu')return;const texture=this.import(c.device);this.sampleFrequency();if(!texture)return;
  const format=c.format+':'+c.descriptor.multisample?.count;
  if(this.format!==format){this.pipeline=render(c.device,shader,c.format,{multisample:c.descriptor.multisample});this.format=format;}
  const bind=group(c.device,this.pipeline!,[texture,this.sampler!,{buffer:this.uniform!}]);
  const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}]});pass.setPipeline(this.pipeline!);pass.setBindGroup(0,bind);pass.draw(6);pass.end();
 }});}
 onDeviceRestored(engine:Engine):void {this.uniform?.destroy();this.uniform=undefined;this.pipeline=undefined;this.format='';this.setup(engine);}
 dispose():void {if(this.disposed)return;this.disposed=true;this.engine?.removePlugin(this.name);this.uniform?.destroy();if(this.analyser){this.audioSource?.disconnect(this.analyser);this.analyser.disconnect();const shared=sources.get(this.source as HTMLVideoElement)!;if(!--shared.users)shared.node.disconnect(shared.context.destination);}this.analyser=this.audioSource=undefined;this.pipeline=undefined;this.engine=undefined;}
 declare [Symbol.dispose]: () => void;
 [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
