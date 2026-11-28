import {backdrop,surface,volume} from './shaders.js';
import {cloudSize,makeVolume} from './field.js';
import {geometry} from './geometry.js';

const eye=[3.78,3.23,5.18],target=[0,.28,0];
const center=target.map((axis,i)=>axis-eye[i]);
const norm=values=>values.map(x=>x/Math.hypot(...values));
const facing=norm(center);
const horizontal=norm([-facing[2],0,facing[0]]);
const vertical=[horizontal[1]*facing[2]-horizontal[2]*facing[1],
  horizontal[2]*facing[0]-horizontal[0]*facing[2],horizontal[0]*facing[1]-horizontal[1]*facing[0]];
const stride=48,formatDepth='depth24plus';
const descriptors=[
  {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
  {shaderLocation:2,offset:24,format:'float32x3'},{shaderLocation:3,offset:36,format:'float32x2'},
  {shaderLocation:4,offset:44,format:'float32'},
];
const depthState={format:formatDepth,depthWriteEnabled:true,depthCompare:'greater'};
const cloudBlend={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},
  alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}};

export function specimenView(signal){
  let engine,device,uniforms,vertices,depth,depthW,depthH,format;
  let floorPipeline,specimenPipeline,cloudPipeline,tilePipeline,floorGroup,specimenGroup,cloudGroup,tileGroup;
  let cloudAtlas,cloudSampler,tile,tileSampler,tileSource,tileImport,lastCloud,shapes,key,mode;
  let frequency=2.4,detail=.65;

  function setup(value){
    engine=value;
    device=engine.gpu;
    uniforms=device.createBuffer({label:'specimen camera',size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    vertices=device.createBuffer({label:'sculpted terrain and chassis',size:stride*20500,
      usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
  }
  function release(){
    tile?.dispose();
    vertices?.destroy();uniforms?.destroy();depth?.destroy();cloudAtlas?.destroy();
    tile=tileSampler=vertices=uniforms=depth=cloudAtlas=cloudSampler=undefined;
    floorPipeline=specimenPipeline=cloudPipeline=tilePipeline=floorGroup=specimenGroup=cloudGroup=tileGroup=undefined;
    format=depthW=depthH=lastCloud=shapes=key=undefined;
  }
  function onDeviceRestored(value){
    release();
    setup(value);
    if(mode==='tile'){
      prepare(mode,frequency,detail).then(()=>{
        if(!signal.aborted)engine.render(0);
      }).catch(error=>{if(!signal.aborted)engine.onError?.(error);});
    }else set(mode,frequency,detail);
  }
  function module(code,label){return device.createShaderModule({code,label});}
  function pipeline(code,point,{mesh=false,blend}={}){
    const shader=module(code,point);
    const options={label:'Noise Lab '+point,layout:'auto',
      vertex:{module:shader,entryPoint:mesh?'project':'fullscreen',buffers:mesh?[{arrayStride:stride,attributes:descriptors}]:[]},
      fragment:{module:shader,entryPoint:point,targets:[{format,blend}]}};
    if(mesh)options.depthStencil=depthState;
    return device.createRenderPipeline(options);
  }
  function group(pipeline,resources=[]){
    const entries=[{binding:0,resource:{buffer:uniforms}}];
    resources.forEach((resource,i)=>entries.push({binding:1+i,resource}));
    return device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
  }

  function set(next,scale,amount){
    mode=next;frequency=scale;detail=amount;
    const geometryKey=next==='terrain'?next+'/'+scale+'/'+amount:next;
    if(key!==geometryKey){
      shapes=geometry(next,scale,amount);
      device.queue.writeBuffer(vertices,0,shapes.data);
      key=geometryKey;
    }
    if(next==='cloud'&&lastCloud?.frequency!==scale){
      const [w,h,d]=cloudSize;
      if(!cloudAtlas){
        cloudAtlas=device.createTexture({size:[w,h*d],format:'r8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
        cloudSampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      }
      const {atlas,total}=makeVolume(scale);
      device.queue.writeTexture({texture:cloudAtlas},atlas,{bytesPerRow:w,rowsPerImage:h*d},[w,h*d]);
      lastCloud={frequency:scale,total};
    }
    return {relief:shapes.range,triangles:shapes.triangles,cloudSum:lastCloud?.total};
  }

  async function prepare(next,scale,amount){
    if(next==='tile'&&!tile){
      tileImport??=import('./tile.js');
      const {bakeTile,tileShader}=await tileImport;
      signal.throwIfAborted();
      const source=tileSource??=tileShader();
      const current=device;
      const output=await bakeTile(current,signal);
      if(signal.aborted||current!==device){
        output.dispose();
        signal.throwIfAborted();
        throw new Error('The Margo device changed during the tile bake.');
      }
      tile=output;
      tileSource=source;
      tileSampler=device.createSampler({addressModeU:'repeat',addressModeV:'repeat',minFilter:'linear',magFilter:'linear'});
    }
    return set(next,scale,amount);
  }

  function draw(c){
    if(!shapes||mode==='tile'&&!tile)return;
    const w=engine.canvas.width,h=engine.canvas.height,aspect=w/h;
    const slope=.276*Math.max(1,1.40/aspect);
    const data=new Float32Array([...eye,1,...facing,1,...horizontal,slope*aspect,...vertical,slope,
      frequency,detail,w,h]);
    device.queue.writeBuffer(uniforms,0,data);
    if(format!==c.format){
      format=c.format;
      floorPipeline=pipeline(backdrop,'floorColor');
      specimenPipeline=pipeline(surface(),'shade',{mesh:true});
      floorGroup=group(floorPipeline);
      specimenGroup=group(specimenPipeline);
      cloudPipeline=tilePipeline=cloudGroup=tileGroup=undefined;
    }
    if(w!==depthW||h!==depthH){
      depth?.destroy();
      depth=device.createTexture({size:[w,h],format:formatDepth,usage:GPUTextureUsage.RENDER_ATTACHMENT});
      depthW=w;depthH=h;
    }
    const color=[{view:c.color,loadOp:'clear',storeOp:'store',clearValue:[.085,.115,.108,1]}];
    const sheet={view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:0};
    const floor=c.encoder.beginRenderPass({colorAttachments:color});
    floor.setPipeline(floorPipeline);
    floor.setBindGroup(0,floorGroup);
    floor.draw(3);
    floor.end();
    color[0].loadOp='load';

    let mesh=specimenPipeline,meshGroup=specimenGroup;
    if(mode==='tile'){
      if(!tilePipeline){
        tilePipeline=pipeline(surface(tileSource),'shade',{mesh:true});
        tileGroup=group(tilePipeline,[tile.texture.createView(),tileSampler]);
      }
      mesh=tilePipeline;meshGroup=tileGroup;
    }
    const prism=c.encoder.beginRenderPass({colorAttachments:color,depthStencilAttachment:sheet});
    prism.setPipeline(mesh);
    prism.setBindGroup(0,meshGroup);
    prism.setVertexBuffer(0,vertices);
    prism.draw(shapes.data.length/(stride/4));
    prism.end();

    if(mode==='cloud'){
      if(!cloudPipeline){
        cloudPipeline=pipeline(volume,'chamber',{blend:cloudBlend});
        cloudGroup=group(cloudPipeline,[cloudAtlas.createView(),cloudSampler]);
      }
      const chamber=c.encoder.beginRenderPass({colorAttachments:color});
      chamber.setPipeline(cloudPipeline);
      chamber.setBindGroup(0,cloudGroup);
      chamber.draw(3);
      chamber.end();
    }
  }
  return {name:'noise-specimens',setup,onDeviceRestored,dispose:release,set,prepare,
    registerPasses(graph){graph.add({name:'display-noise-specimens',order:1,execute:draw});}};
}
