import studio from './studio.wgsl?raw';
import {display} from './plinth.js';

const norm=v=>v.map(x=>x/Math.hypot(...v));
const cross=([x,y,z],[a,b,c])=>[y*c-z*b,z*a-x*c,x*b-y*a];
const light=norm([-.72,1,.55]),lightRight=norm([light[2],0,-light[0]]);
const lightUp=cross(light,lightRight);
const stand=display();
const stride=36,mapSize=512,depthFormat='depth24plus';
const layout=[{arrayStride:stride,attributes:[
  {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
  {shaderLocation:2,offset:24,format:'float32'},{shaderLocation:3,offset:28,format:'float32x2'},
]}];
const meshLayout=[{arrayStride:stride,attributes:[layout[0].attributes[0]]}];

export function modelView(){
  let device,engine,backDepth,map,params,stage,part,partSize,model;
  let color,shadow,colorGroup,shadowGroup,format;
  let angle=34,meshLines=0,w,h,world;
  function setup(owner){
    engine=owner;device=owner.gpu;
    params=device.createBuffer({label:'lightwell settings',size:128,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.UNIFORM});
    stage=device.createBuffer({label:'display plinth',size:stand.vertices.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.VERTEX});
    device.queue.writeBuffer(stage,0,stand.vertices);
    map=device.createTexture({label:'lightwell shadow map',size:[mapSize,mapSize],format:depthFormat,
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});
    if(model)upload(model);
  }
  function release(){
    backDepth?.destroy();map?.destroy();params?.destroy();stage?.destroy();part?.destroy();
    backDepth=map=params=stage=part=color=shadow=colorGroup=shadowGroup=undefined;
    format=w=h=partSize=undefined;
  }
  function upload(geometry){
    model=geometry;
    const byteLength=geometry.byteLength;
    if(!part||byteLength>partSize){
      part?.destroy();
      partSize=Math.max(65536,2**Math.ceil(Math.log2(byteLength)));
      part=device.createBuffer({label:'dual contour triangles',size:partSize,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.VERTEX});
    }
    device.queue.writeBuffer(part,0,geometry);
  }
  function prepare(target){
    const module=device.createShaderModule({label:'Lightwell studio',code:studio});
    color=device.createRenderPipeline({label:'Lightwell main pass',layout:'auto',
      vertex:{module,entryPoint:'vertex',buffers:layout},
      fragment:{module,entryPoint:'fragment',targets:[{format:target}]},
      primitive:{cullMode:'back'},depthStencil:{format:depthFormat,depthWriteEnabled:true,depthCompare:'greater'}});
    shadow=device.createRenderPipeline({label:'Lightwell depth pass',layout:'auto',
      vertex:{module,entryPoint:'depthVertex',buffers:meshLayout},
      primitive:{cullMode:'back'},depthStencil:{format:depthFormat,depthWriteEnabled:true,depthCompare:'less'}});
    const paramsBinding={binding:0,resource:{buffer:params}};
    colorGroup=device.createBindGroup({layout:color.getBindGroupLayout(0),entries:[
      paramsBinding,{binding:1,resource:map.createView()},
    ]});
    shadowGroup=device.createBindGroup({layout:shadow.getBindGroupLayout(0),entries:[paramsBinding]});
    format=target;
  }
  function camera(width,height){
    const aspect=width/height;
    const radians=angle*Math.PI/180;
    const eye=[Math.sin(radians)*1.67,1.09,Math.cos(radians)*1.67];
    const targetY=.169-.057*Math.min(1,Math.max(0,(aspect-1.32)/.63));
    const forward=norm([-eye[0],targetY-eye[1],-eye[2]]);
    const side=norm([-forward[2],0,forward[0]]);
    const up=cross(side,forward);
    const tan=.353*Math.max(1,1.355/aspect);
    return new Float32Array([...eye,1,...forward,1,...side,tan*aspect,...up,tan,
      ...light,1,...lightRight,1,...lightUp,1,meshLines,width,height,0]);
  }
  function draw(c){
    if(!model)return;
    if(format!==c.format)prepare(c.format);
    const width=engine.canvas.width,height=engine.canvas.height;
    if(w!==width||h!==height){
      backDepth?.destroy();
      backDepth=device.createTexture({label:'display depth',size:[width,height],format:depthFormat,
        usage:GPUTextureUsage.RENDER_ATTACHMENT});
      w=width;h=height;
    }
    device.queue.writeBuffer(params,0,camera(width,height));
    if(world!==model){
      const shadowDepth=c.encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{
        view:map.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
      shadowDepth.setPipeline(shadow);
      shadowDepth.setBindGroup(0,shadowGroup);
      shadowDepth.setVertexBuffer(0,stage);
      shadowDepth.draw(stand.vertices.length/9-stand.floorEnd,1,stand.floorEnd);
      shadowDepth.setVertexBuffer(0,part);
      shadowDepth.draw(model.length/9);
      shadowDepth.end();
      world=model;
    }

    const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'clear',storeOp:'store',
      clearValue:[.095,.125,.176,1]}],depthStencilAttachment:{view:backDepth.createView(),depthClearValue:0,
      depthLoadOp:'clear',depthStoreOp:'discard'}});
    pass.setPipeline(color);
    pass.setBindGroup(0,colorGroup);
    pass.setVertexBuffer(0,stage);
    pass.draw(stand.vertices.length/9);
    pass.setVertexBuffer(0,part);
    pass.draw(model.length/9);
    pass.end();
  }
  return {name:'lightwell-studio',setup,dispose:release,upload,
    onDeviceRestored(owner){release();world=undefined;setup(owner);},
    camera(value,edges){angle=value;meshLines=edges?1:0;},
    registerPasses(graph){graph.add({name:'render-lightwell',order:1,execute:draw});}};
}
