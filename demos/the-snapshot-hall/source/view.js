import source from './hall.wgsl?raw';

const norm=v=>v.map(x=>x/Math.hypot(...v));
const cross=([x,y,z],[a,b,c])=>[y*c-z*b,z*a-x*c,x*b-y*a];
const depthFormat='depth24plus';
const buffers=[
  {arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},
    {shaderLocation:1,offset:12,format:'float32x3'}]},
  {arrayStride:48,stepMode:'instance',attributes:[{shaderLocation:2,offset:0,format:'float32x3'},
    {shaderLocation:3,offset:12,format:'float32x3'},{shaderLocation:4,offset:24,format:'float32x3'},
    {shaderLocation:5,offset:36,format:'float32x3'}]},
];
function camera(position,aspect){
  const t=position*.01;
  const eye=[.39+t*.92,1.83+t*.08,6.48-t*12.9];
  const direction=norm([-.24*t-.075,2.96-eye[1],-(23.0+eye[2])]);
  const right=norm([-direction[2],0,direction[0]]);
  const vertical=cross(right,direction);
  const slope=.448*Math.max(1,1.39/aspect);
  return new Float32Array([...eye,1,...direction,1,...right,slope*aspect,...vertical,slope]);
}
export function hallView(archive){
  let device,engine,vertices,indices,instances,uniforms,depth;
  let format,pipeline,bindings,snapshot,draws=0,recordCount=0,w,h;
  let mode='snapshot',position=0,stats={};
  function dataBuffer(label,data,usage){
    const buffer=device.createBuffer({label,size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(buffer,0,data);
    return buffer;
  }
  function setup(owner){
    engine=owner;
    device=engine.gpu;
    vertices=dataBuffer('Archive shapes',archive.vertices,GPUBufferUsage.VERTEX);
    indices=dataBuffer('Archive shape index groups',archive.indices,GPUBufferUsage.INDEX);
    instances=dataBuffer('Archive part transforms',archive.instances,GPUBufferUsage.VERTEX);
    uniforms=device.createBuffer({label:'Archive camera',size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  }
  function release(){
    vertices?.destroy();indices?.destroy();instances?.destroy();uniforms?.destroy();depth?.destroy();
    snapshot=depth=format=pipeline=bindings=w=h=undefined;
  }
  function prepare(value){
    const module=device.createShaderModule({label:'Hall materials',code:source});
    pipeline=device.createRenderPipeline({label:'Static archive',layout:'auto',vertex:{module,entryPoint:'vertex',buffers},
      fragment:{module,entryPoint:'surface',targets:[{format:value}]},
      depthStencil:{format:depthFormat,depthWriteEnabled:true,depthCompare:'greater'}});
    bindings=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniforms}}]});
    snapshot=undefined;
    format=value;
  }
  function bind(encoder){
    encoder.setPipeline(pipeline);
    encoder.setBindGroup(0,bindings);
    encoder.setVertexBuffer(0,vertices);
    encoder.setVertexBuffer(1,instances);
    encoder.setIndexBuffer(indices,'uint32');
  }
  function issue(encoder,batched){
    bind(encoder);
    let calls=0;
    for(const {first,length,start,count} of archive.ranges){
      if(batched){
        encoder.drawIndexed(length,count,first,0,start);
        calls++;
      }else{
        for(let i=0;i<count;i++){
          encoder.drawIndexed(length,1,first,0,start+i);
          calls++;
        }
      }
    }
    return calls;
  }
  function record(){
    const recorder=device.createRenderBundleEncoder({label:'Archive snapshot',colorFormats:[format],depthStencilFormat:depthFormat});
    draws=issue(recorder,false);
    snapshot=recorder.finish();
    recordCount++;
  }
  function draw(c){
    if(format!==c.format)prepare(c.format);
    const width=engine.canvas.width,height=engine.canvas.height;
    if(w!==width||h!==height){
      depth?.destroy();
      depth=device.createTexture({size:[width,height],format:depthFormat,usage:GPUTextureUsage.RENDER_ATTACHMENT});
      w=width;h=height;
    }
    device.queue.writeBuffer(uniforms,0,camera(position,width/height));
    if(mode==='snapshot'&&!snapshot)record();
    const pass=c.encoder.beginRenderPass({colorAttachments:[{
      view:c.color,loadOp:'clear',storeOp:'store',clearValue:[.049,.067,.086,1]}],
      depthStencilAttachment:{view:depth.createView(),depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'discard'}});
    const start=performance.now();
    let calls=1;
    if(mode==='snapshot')pass.executeBundles([snapshot]);
    else calls=issue(pass,mode==='batch');
    const milliseconds=performance.now()-start;
    pass.end();
    stats={calls,milliseconds,recordCount,draws};
  }
  return {name:'static-archive',setup,dispose:release,
    onDeviceRestored(owner){release();setup(owner);},
    configure(modeValue,positionValue){mode=modeValue;position=positionValue;},
    stats:()=>stats,
    registerPasses(graph){graph.add({name:'archive-view',order:1,execute:draw});}};
}
