import type {Engine, EnginePlugin, FrameGraph} from '@margoengine/core/extension';
import {SkyMoonPass, type SkyMoonConfig} from './sky-moon.js';
import {invert} from '../../shared/math.js';

declare const GPUBufferUsage: {UNIFORM: number; COPY_DST: number};
const fogShader = `
@group(0) @binding(0) var<uniform> frame:array<vec4f,6>;
@group(0) @binding(1) var depth:texture_depth_2d;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let d=textureLoad(depth,vec2i(p.xy),0);if(d<=0){discard;}
 let uv=p.xy/vec2f(textureDimensions(depth));
 let world=mat4x4f(frame[0],frame[1],frame[2],frame[3])*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),d,1);
 let w=world.xyz/world.w;
 let density=frame[5].w*(1.0+max(-w.y,0.0)*0.065);
 return vec4f(frame[5].rgb,1.0-exp(-length(frame[4].xyz-w)*density));
}`;

/** Keeps the study's lunar controls while composing with the optional HDR effects. */
export class NightAtmosphere implements EnginePlugin {
  readonly name = 'citadel:atmosphere';
  sky!: SkyMoonPass;
  readonly fog = new Float32Array(24);
  private readonly scratch = new Float64Array(52);
  private readonly inverse = this.fog.subarray(0,16);
  private uniform?: GPUBuffer;
  private pipeline?: GPURenderPipeline;
  private group?: GPUBindGroup;
  private sampled?: GPUTexture;
  private time = 0;
  private readonly color: GPURenderPassColorAttachment = {view: undefined!, loadOp: 'load', storeOp: 'store'};
  private readonly depth: GPURenderPassDepthStencilAttachment = {view: undefined!, depthReadOnly: true, stencilReadOnly: true};
  private readonly skyPass: GPURenderPassDescriptor = {colorAttachments: [this.color], depthStencilAttachment: this.depth};
  private readonly fogPass: GPURenderPassDescriptor = {colorAttachments: [this.color]};
  constructor(readonly config: SkyMoonConfig, private readonly depthTexture: () => GPUTexture | undefined) {}
  setup(engine: Engine): void {
    const device = engine.gpu!;
    this.sky = new SkyMoonPass(device, 'rgba16float', device.features.has('depth32float-stencil8')?'depth32float-stencil8':'depth32float');
    this.sky.setConfig(this.config);
    this.uniform = device.createBuffer({size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({name:'citadel:framing',order:-100,execute:c=>{
      // Keep the fortress between the title and controls on wide screens.
      if (c.width/c.height>1.1) for(let i=0;i<4;i++) c.camera.matrix[i*4]-=0.12*c.camera.matrix[i*4+3];
    }});
    graph.add({name:'citadel:moon',order:2,execute:c=>{
      if(c.backend!=='webgpu')return;
      if(!invert(this.inverse,c.camera.matrix,0,this.scratch))throw new Error('Invalid sky camera');
      this.time+=c.delta;this.sky.updateFrame(this.inverse,c.camera.position,this.time);
      this.color.view=c.color;this.depth.view=c.depth;
      const pass=c.encoder.beginRenderPass(this.skyPass);this.sky.record(pass,c.descriptor.multisample?.count);pass.end();
    }});
    graph.add({name:'citadel:haze',order:5,execute:c=>{
      if(c.backend!=='webgpu')return;
      const depth=this.depthTexture();if(!depth)return;
      if(!this.pipeline){
        // shortcut: covered samples share nearest-depth fog, use per-sample fog if subpixel depth layers need distinct haze.
        const code=depth.sampleCount===4?fogShader.replace('texture_depth_2d','texture_depth_multisampled_2d')
          .replace('@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {','struct FogOutput { @location(0) color:vec4f,@builtin(sample_mask) mask:u32 }\n@fragment fn fragment(@builtin(position) p:vec4f)->FogOutput {')
          .replace('let d=textureLoad(depth,vec2i(p.xy),0);if(d<=0){discard;}',`let q=vec2i(p.xy);
 let samples=vec4f(textureLoad(depth,q,0),textureLoad(depth,q,1),textureLoad(depth,q,2),textureLoad(depth,q,3));
 let d=max(max(samples.x,samples.y),max(samples.z,samples.w));if(d<=0){discard;}
 let mask=select(0u,1u,samples.x>0)|select(0u,2u,samples.y>0)|select(0u,4u,samples.z>0)|select(0u,8u,samples.w>0);`)
          .replace('return vec4f(frame[5].rgb,1.0-exp(-length(frame[4].xyz-w)*density));','return FogOutput(vec4f(frame[5].rgb,1.0-exp(-length(frame[4].xyz-w)*density)),mask);'):fogShader;
        const module=c.device.createShaderModule({code});this.pipeline=c.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},multisample:c.descriptor.multisample});
      }
      if(this.sampled!==depth){this.sampled=depth;this.group=c.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform!}},{binding:1,resource:depth.createView({aspect:'depth-only'})}]});}
      this.fog.set(c.camera.position,16);c.device.queue.writeBuffer(this.uniform!,0,this.fog);
      this.color.view=c.color;const pass=c.encoder.beginRenderPass(this.fogPass);pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group!);pass.draw(3);pass.end();
    }});
  }
  onDeviceRestored(engine:Engine):void {this.dispose();this.setup(engine);}
  dispose():void {this.sky?.dispose();this.uniform?.destroy();this.pipeline=this.group=this.sampled=undefined;}
}
