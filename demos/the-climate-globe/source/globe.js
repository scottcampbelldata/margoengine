import {project} from '@margoengine/sciviz/geo';

export const polar=.9966471893352525;
export const palette=['#213b68','#336487','#61a9ac','#e5e0c8','#e4a76d','#cb5a4a','#7e2445'];
export const scaleMin=-3,scaleMax=3;
export const world=(lon,lat,height=0)=>{
  const [x,y,z]=project(lon,lat,height,'globe');
  return [x,z,-y];
};
const colours=palette.map(hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)));
export function mapPixels(values){
  const result=new Uint8Array(values.length*4);
  for(let row=0;row<90;row++)for(let col=0;col<180;col++){
    const value=values[(89-row)*180+col],at=(row*180+col)*4;
    if(!Number.isFinite(value))continue;
    const t=Math.max(0,Math.min(6,(value-scaleMin)/(scaleMax-scaleMin)*6));
    const lower=Math.min(5,Math.floor(t));
    for(let k=0;k<3;k++)result[at+k]=Math.round(colours[lower][k]+(colours[lower+1][k]-colours[lower][k])*(t-lower));
    result[at+3]=255;
  }
  return result;
}
function globeGeometry(){
  const rows=96,cols=192,data=[],index=[];
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    const lon=i/cols*360-180, lat=j/rows*180-90;
    const xyz=world(lon,lat);
    data.push(...xyz,i/cols,1-j/rows);
    if(i&&j){
      const d=j*(cols+1)+i,a=d-cols-2;
      index.push(a,a+1,d,a,d,d-1);
    }
  }
  return {positions:Float32Array.from(data),indices:Uint32Array.from(index)};
}
const model=globeGeometry();
const wgsl=`
struct View { matrix:mat4x4f, eye:vec4f, options:vec4f };
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(1) var temperatures:texture_2d<f32>;
@group(0) @binding(2) var coasts:texture_2d<f32>;
@group(0) @binding(3) var filtering:sampler;
struct Vertex { @builtin(position) clip:vec4f,@location(0) world:vec3f,@location(1) uv:vec2f };
@vertex fn vertex(@location(0) point:vec3f,@location(1) uv:vec2f)->Vertex {
  return Vertex(view.matrix*vec4f(point,1.),point,uv);
}
@fragment fn fragment(in:Vertex)->@location(0) vec4f {
  let n=normalize(in.world*vec3f(1.,1.00674,1.));
  let look=normalize(view.eye.xyz-in.world);
  let diffuse=max(0.,dot(n,normalize(vec3f(-.46,.67,.59))));
  let fresnel=pow(1.-max(0.,dot(look,n)),3.5);
  let anomaly=textureSample(temperatures,filtering,in.uv);
  var colour=mix(vec3f(.12,.19,.23),anomaly.rgb/max(.02,anomaly.a),anomaly.a);
  let longitude=abs(fract(in.uv.x*12.+.5)-.5);
  let latitude=abs(fract(in.uv.y*6.+.5)-.5);
  let rule=1.-min(smoothstep(.002,.013,longitude),smoothstep(.002,.011,latitude));
  colour=mix(colour,vec3f(.18,.25,.30),rule*.19*view.options.y);
  let shore=textureSample(coasts,filtering,in.uv).r;
  colour=mix(colour,vec3f(.07,.125,.165),shore*.76*view.options.x);
  colour=colour*(.79+.21*diffuse)+fresnel*vec3f(.11,.21,.24);
  return vec4f(colour,1.);
}
`;

export function installGlobe(engine){
  let state, data, shore, fieldChanged=true, shoreChanged=false, showGrid=true, showShore=true;
  const uniforms=new Float32Array(24);
  function alloc(device,raw,flag){
    const b=device.createBuffer({size:raw.byteLength,usage:flag|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(b,0,raw);
    return b;
  }
  function make(context){
    const {device,format,descriptor}=context;
    const module=device.createShaderModule({code:wgsl,label:'GISTEMP globe raster'});
    const pipeline=device.createRenderPipeline({
      layout:'auto',label:'GISTEMP globe raster',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:20,attributes:[
        {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x2'},
      ]}]},
      fragment:{module,entryPoint:'fragment',targets:[{format}]},
      primitive:{topology:'triangle-list',cullMode:'back'},
      depthStencil:{format:descriptor.depthStencil.format,depthCompare:'greater-equal',depthWriteEnabled:true},
    });
    const usage=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST;
    const frame=alloc(device,uniforms,GPUBufferUsage.UNIFORM);
    const field=device.createTexture({size:[180,90],format:'rgba8unorm',usage});
    const coast=device.createTexture({size:[1024,512],format:'rgba8unorm',usage});
    const sampler=device.createSampler({addressModeU:'repeat',minFilter:'linear',magFilter:'linear'});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:frame}},{binding:1,resource:field.createView()},
      {binding:2,resource:coast.createView()},{binding:3,resource:sampler},
    ]});
    return {device,pipeline,frame,field,coast,group,positions:alloc(device,model.positions,GPUBufferUsage.VERTEX),
      indices:alloc(device,model.indices,GPUBufferUsage.INDEX)};
  }
  function release(){
    if(!state)return;
    for(const value of [state.frame,state.field,state.coast,state.positions,state.indices])value.destroy();
  }
  const remove=engine.scene.frameGraph.add({name:'surface temperature anomaly globe',order:2,execute(context){
    if(context.backend!=='webgpu'||!data)return;
    if(state?.device!==context.device){
      release();state=make(context);fieldChanged=true;shoreChanged=!!shore;
    }
    const {device,field,coast,frame,group,pipeline,positions,indices}=state;
    if(fieldChanged){device.queue.writeTexture({texture:field},data,{bytesPerRow:720,rowsPerImage:90},[180,90]);fieldChanged=false;}
    if(shoreChanged){device.queue.writeTexture({texture:coast},shore,{bytesPerRow:4096,rowsPerImage:512},[1024,512]);shoreChanged=false;}
    uniforms.set(context.camera.matrix);
    uniforms.set(context.camera.position,16);
    uniforms.set([shore&&showShore?1:0,showGrid?1:0,0,0],20);
    device.queue.writeBuffer(frame,0,uniforms);
    const pass=context.encoder.beginRenderPass({colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}],
      depthStencilAttachment:{view:context.depth,depthLoadOp:'load',depthStoreOp:'store',
        ...(context.descriptor.depthStencil.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})}});
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setVertexBuffer(0,positions);
    pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(model.indices.length);pass.end();
  }});
  return {
    field(values){data=mapPixels(values);fieldChanged=true;},
    shoreline(data){shore=data;shoreChanged=true;},
    style(grid,coast){showGrid=grid;showShore=coast;},
    dispose(){remove();release();},
  };
}
