import {fixture,normals,faceKinds} from './fixture.mjs';

const stride=9;
const kindValue={body:0,lip:1,mouth:1,liner:2};
const rgba=(point,normal,uv,kind)=>[...point,...normal,...uv,kind];
const shift=(point,normal,scale)=>point.map((value,axis)=>value+normal[axis]*scale);
const difference=(a,b)=>a.map((n,i)=>n-b[i]);
const cross=([a,b,c],[x,y,z])=>[b*z-c*y,c*x-a*z,a*y-b*x];
const normalize=v=>{const length=Math.hypot(...v);return v.map(n=>n/length);};

export function surface(uv,seams){
  const output=[];
  fixture.faces.forEach((face,index)=>{
    const kind=kindValue[faceKinds[index]];
    for(const corner of [0,1,2,0,2,3]){
      const id=face.vertices[corner];
      output.push(...rgba(fixture.vertices[id],normals[id],uv[index][corner],kind));
    }
  });
  for(const seam of seams){
    const [a,b]=seam.split(':').map(Number);
    const p=shift(fixture.vertices[a],normals[a],.013);
    const q=shift(fixture.vertices[b],normals[b],.013);
    const direction=normalize(difference(q,p));
    const reference=Math.abs(direction[2])>.9?[0,1,0]:[0,0,1];
    const horizontal=normalize(cross(direction,reference));
    const vertical=cross(direction,horizontal);
    const points=[];
    for(let side=0;side<6;side++){
      const angle=side*Math.PI/3;
      points.push(horizontal.map((n,i)=>n*Math.cos(angle)+vertical[i]*Math.sin(angle)));
    }
    const ring=points.map(n=>[rgba(shift(p,n,.007),n,[0,0],3),rgba(shift(q,n,.007),n,[0,0],3)]);
    ring.forEach((section,j)=>{
      const adjacent=ring[(j+1)%ring.length];
      output.push(...section[0],...section[1],...adjacent[1],...section[0],...adjacent[1],...adjacent[0]);
    });
  }
  return Float32Array.from(output);
}

const code=`
struct Frame { matrix:mat4x4f, eye:vec4f, settings:vec4f };
@group(0) @binding(0) var<uniform> frame:Frame;
struct Vertex { @builtin(position) clip:vec4f, @location(0) world:vec3f,
  @location(1) normal:vec3f, @location(2) uv:vec2f, @location(3) kind:f32 };
@vertex fn vert(@location(0) point:vec3f,@location(1) normal:vec3f,
  @location(2) uv:vec2f,@location(3) kind:f32)->Vertex {
  return Vertex(frame.matrix*vec4f(point,1.),point,normal,uv,kind);
}
fn border(p:vec2f, fw:vec2f)->f32 {
  let d=min(fract(p), 1.-fract(p));
  return 1.-min(smoothstep(.012,.032+fw.x,d.x),smoothstep(.012,.032+fw.y,d.y));
}
@fragment fn frag(in:Vertex)->@location(0) vec4f {
  let n=normalize(in.normal);
  let k=normalize(vec3f(-.47,.80,.36));
  let r=normalize(vec3f(.62,.36,-.70));
  let v=normalize(frame.eye.xyz-in.world);
  let grid=in.uv*frame.settings.x;
  let derivatives=clamp(fwidth(grid),vec2f(.001),vec2f(.18));
  let dark=vec3f(.192,.271,.274);
  let pale=select(vec3f(.85,.73,.48),vec3f(.67,.80,.79),frame.settings.y>.5);
  let cell=(floor(grid.x)+floor(grid.y))*.5;
  let wash=.97+.03*sin(in.world.y*55.2+sin(in.world.z*27.3));
  var base=mix(dark,pale,step(.25,fract(cell)))*wash;
  let pin=border(grid,derivatives);
  base=mix(base,vec3f(.16,.21,.21),pin*.55);
  if(in.kind>.5 && in.kind<1.5){
    base=mix(base,vec3f(.79,.58,.34),.14);
  }
  if(in.kind>1.5 && in.kind<2.5){
    base*=.68;
  }
  let key=max(0.,dot(n,k));
  let back=max(0.,dot(n,r));
  let sheen=pow(max(0.,dot(n,normalize(k+v))),32.);
  let rim=pow(1.-max(0.,dot(n,v)),3.);
  var value=base*(.55+.51*key+.20*back)+vec3f(.21,.20,.16)*sheen+vec3f(.08,.13,.16)*rim;
  if(in.kind>2.5){
    value=vec3f(.50,.88,.91)*(.79+.23*key)+vec3f(.05,.04,.03)*rim;
  }
  return vec4f(clamp(value,vec3f(0.),vec3f(1.)),1.);
}`;

export function inspectSurface(engine){
  let data, layer, changed=false, active, matrix=new Float32Array(24);
  function make(context){
    const {device,format}=context;
    const module=device.createShaderModule({label:'checker manifold surface',code});
    const pipeline=device.createRenderPipeline({
      layout:'auto',label:'checker manifold surface',
      vertex:{module,entryPoint:'vert',buffers:[{arrayStride:stride*4,attributes:[
        {shaderLocation:0,format:'float32x3',offset:0},{shaderLocation:1,format:'float32x3',offset:12},
        {shaderLocation:2,format:'float32x2',offset:24},{shaderLocation:3,format:'float32',offset:32},
      ]}]},
      fragment:{module,entryPoint:'frag',targets:[{format}]},
      primitive:{topology:'triangle-list',cullMode:'back'},
      depthStencil:{format:context.descriptor.depthStencil.format,depthWriteEnabled:true,depthCompare:'greater-equal'},
    });
    const frame=device.createBuffer({size:matrix.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const groups=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}}]});
    return {device,pipeline,frame,groups,capacity:0,buffer:undefined,count:0};
  }
  function release(graphics){
    graphics?.frame.destroy();
    graphics?.buffer?.destroy();
  }
  const remove=engine.scene.frameGraph.add({
    name:'texture chart inspection',order:7,execute(context){
      if(context.backend!=='webgpu'||!data)return;
      if(active?.device!==context.device){
        release(active);
        active=make(context);
        changed=true;
      }
      const {device,pipeline,frame,groups}=active;
      if(changed){
        if(active.capacity<data.byteLength){
          const old=active.buffer;
          active.capacity=data.byteLength;
          active.buffer=device.createBuffer({size:active.capacity,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
          if(old)device.queue.onSubmittedWorkDone().then(()=>old.destroy(),()=>old.destroy());
        }
        device.queue.writeBuffer(active.buffer,0,data);
        active.count=data.length/stride;
        changed=false;
      }
      matrix.set(context.camera.matrix,0);
      matrix.set(context.camera.position,16);
      matrix.set([layer==='draft'?12:19,layer==='light'?1:0,0,0],20);
      device.queue.writeBuffer(frame,0,matrix);
      const pass=context.encoder.beginRenderPass({
        colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}],
        depthStencilAttachment:{view:context.depth,depthLoadOp:'load',depthStoreOp:'store',
          ...(context.descriptor.depthStencil.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})},
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0,groups);
      pass.setVertexBuffer(0,active.buffer);
      pass.draw(active.count);
      pass.end();
    },
  });
  return {
    show(uv,seams,mode){data=surface(uv,seams);layer=mode;changed=true;},
    dispose(){remove();release(active);},
  };
}
