import {Engine} from '@margoengine/core';
import {ComputePass,ivec2,uniform,vec4,smoothstep} from '@margoengine/shader';
import {pingPong} from '@margoengine/shader/compute-texture';
import {size,recipes,starter} from './model.js';
import {displayWGSL} from './optics.js';

function reaction(texture,recipe,ink){
  return new ComputePass(texture.pixels,i=>{
    const at=texture.coord(i),x=at.x.toInt(),y=at.y.toInt();
    const sample=(a,b)=>texture.load(ivec2(x.add(a+size).mod(size),y.add(b+size).mod(size))).xy;
    const current=sample(0,0),cardinal=sample(-1,0).add(sample(1,0)).add(sample(0,-1)).add(sample(0,1)).mul(.20);
    const diagonal=sample(-1,-1).add(sample(1,-1)).add(sample(-1,1)).add(sample(1,1)).mul(.05);
    const laplacian=cardinal.add(diagonal).sub(current);
    const react=current.x.mul(current.y).mul(current.y);
    const u=current.x.add(laplacian.x.mul(.99)).sub(react).add(current.x.oneMinus().mul(recipe.feed));
    const v=current.y.add(laplacian.y.mul(.495)).add(react).sub(current.y.mul(recipe.feed+recipe.kill));
    const uv=texture.uv(at),brush=smoothstep(.014,.049,uv.sub(ink.xy).length()).oneMinus().mul(ink.z);
    return texture.store(at,vec4(u.mix(.52,brush).clamp(0,1),v.mix(.43,brush).clamp(0,1),0,1));
  },{workgroupSize:128});
}
export async function attachNative(canvas,signal){
  const engine=await Engine.create(canvas,{backend:'webgpu',exactSize:true,antialias:false,capacity:1,signal});
  const ink=uniform([0,0,0],{name:'ink'});
  let texture,step,pipeline,shape,binding,view,pending=0,retired=[];
  const handle=engine.scene.frameGraph.add({name:'display chemical plate',order:4,execute(context){
    if(context.backend!=='webgpu')return;
    const {device,encoder,width,height}=context;
    if(!pipeline){
      const module=device.createShaderModule({code:displayWGSL});
      pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:context.format}]}});
      shape=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    }
    const run=pending;
    pending=0;
    for(let j=0;j<run;j++)step.encode(device,encoder,{width:size,height:size,delta:1});
    const [surface,sampler]=texture.bind(device);
    if(view!==surface){
      view=surface;
      binding=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:surface},{binding:1,resource:sampler},{binding:2,resource:{buffer:shape}}
      ]});
    }
    device.queue.writeBuffer(shape,0,new Float32Array([width/height,size,0,0]));
    const pass=encoder.beginRenderPass({colorAttachments:[{view:context.color,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]});
    pass.setPipeline(pipeline);pass.setBindGroup(0,binding);pass.draw(3);pass.end();
  }});
  return {
    backend:'webgpu',
    install(name){
      if(texture)retired.push(texture);
      texture=pingPong(size,size,{format:'rgba16float',data:starter(name),filter:'linear',wrap:'repeat'});
      step?.dispose();step=reaction(texture,recipes[name],ink);
    },
    brush(u,v,on){ink.value=[u,v,on?1:0];},
    async draw(steps){
      pending=steps;engine.render({delta:0});await engine.gpu.queue.onSubmittedWorkDone();
      for(const old of retired.splice(0))old.dispose();
    },
    dispose(){
      handle();step?.dispose();texture?.dispose();shape?.destroy();
      for(const old of retired)old.dispose();
      engine.dispose();
    }
  };
}
