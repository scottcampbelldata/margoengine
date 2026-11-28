export const horizontal=4.72;
export const extent=15200;
export const heightOf=elevation=>(elevation-500)*.00068;
const frac=(v)=>Math.max(0,Math.min(1,v));

export function at(values,n,x,y){
  const a=frac((x/extent*n-.5)/(n-1))*(n-1),b=frac((y/extent*n-.5)/(n-1))*(n-1);
  const i=Math.min(n-2,Math.floor(a)),j=Math.min(n-2,Math.floor(b));
  const u=a-i,v=b-j;
  return (values[j*n+i]*(1-u)+values[j*n+i+1]*u)*(1-v)+
    (values[(j+1)*n+i]*(1-u)+values[(j+1)*n+i+1]*u)*v;
}
export const position=(x,y,elevation)=>[(x/extent-.5)*horizontal,heightOf(elevation),(y/extent-.5)*horizontal];

function model(values,n){
  const points=[],indices=[];
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const x=(i+.5)/n*extent,y=(j+.5)/n*extent,h=values[j*n+i];
    const dx=values[j*n+Math.min(n-1,i+1)]-values[j*n+Math.max(0,i-1)];
    const dz=values[Math.min(n-1,j+1)*n+i]-values[Math.max(0,j-1)*n+i];
    const s=horizontal/(n*2),nx=-dx*.00068*s,nz=-dz*.00068*s,ny=4*s*s;
    const length=Math.hypot(nx,ny,nz);
    points.push(...position(x,y,h),nx/length,ny/length,nz/length,h,0);
    if(i&&j){
      const d=j*n+i,a=d-n-1;
      indices.push(a,d,d-n,a,d-1,d);
    }
  }
  const edges=[
    Array.from({length:n},(_,i)=>i),
    Array.from({length:n},(_,i)=>i*n+n-1),
    Array.from({length:n},(_,i)=>n*n-1-i),
    Array.from({length:n},(_,i)=>(n-1-i)*n),
  ];
  for(let side=0;side<4;side++){
    const normal=[[0,0,-1],[1,0,0],[0,0,1],[-1,0,0]][side],edge=edges[side];
    const first=points.length/8;
    edge.forEach((vertex,i)=>{
      const at=vertex*8, p=points.slice(at,at+3);
      points.push(...p,...normal,values[vertex],1,p[0],-.23,p[2],...normal,500,1);
      if(i){
        const a=first+(i-1)*2,b=a+1,c=a+2,d=a+3;
        indices.push(a,c,b,c,d,b);
      }
    });
  }
  return {points:Float32Array.from(points),indices:Uint32Array.from(indices)};
}
const code=`
struct Frame { matrix:mat4x4f, view:vec4f, style:vec4f };
@group(0) @binding(0) var<uniform> frame:Frame;
struct Vertex { @builtin(position) clip:vec4f,@location(0) world:vec3f,
  @location(1) normal:vec3f,@location(2) scalar:vec2f };
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) data:vec2f)->Vertex {
  return Vertex(frame.matrix*vec4f(p,1.),p,n,data);
}
fn elevColor(t:f32)->vec3f {
  let a=vec3f(.123,.285,.296); let b=vec3f(.27,.47,.45); let c=vec3f(.58,.66,.48);
  let d=vec3f(.85,.693,.45); let e=vec3f(.98,.85,.674);
  if(t<.25){return mix(a,b,t*4.);}
  if(t<.5){return mix(b,c,(t-.25)*4.);}
  if(t<.75){return mix(c,d,(t-.5)*4.);}
  return mix(d,e,(t-.75)*4.);
}
@fragment fn fragment(in:Vertex)->@location(0) vec4f {
  let elev=in.scalar.x;
  let interval=frame.style.x;
  let line=(elev-600.)/interval;
  let level=max(537.5,600.+(floor(line)+.5)*interval);
  let q=clamp((level-570.)/1980.,0.,1.);
  let base=elevColor(q);
  let norm=normalize(in.normal);
  let lamp=normalize(vec3f(-.71,.71,-.36));
  let light=max(0.,dot(norm,lamp));
  let sampleWidth=min(.22,max(.012,fwidth(line)));
  let distance=abs(fract(line+.5)-.5);
  let contour=(1.-smoothstep(sampleWidth*.16,sampleWidth*1.46,distance))*frame.style.y;
  var paint=base*(.68+.36*light)+vec3f(.045,.047,.039)*light;
  paint=mix(paint,vec3f(.115,.215,.209),contour*.56);
  if(in.scalar.y>.5){
    let rings=sin(in.world.y*140.+in.world.x*2.5+in.world.z*.72)*.5+.5;
    paint=mix(vec3f(.18,.225,.216),vec3f(.29,.32,.267),rings*.65)*(.58+.26*light);
  }
  return vec4f(paint,1.);
}
`;
export function installTerrain(engine,values,n){
  const {points,indices}=model(values,n);
  const frame=new Float32Array(24);
  let graphics,interval=200,ink=1;
  function release(){
    if(graphics)for(const buffer of [graphics.vertices,graphics.index,graphics.frame])buffer.destroy();
  }
  function make(context){
    const {device,format,descriptor}=context;
    const upload=(src,usage)=>{
      const b=device.createBuffer({size:src.byteLength,usage:usage|GPUBufferUsage.COPY_DST});
      device.queue.writeBuffer(b,0,src);return b;
    };
    const mod=device.createShaderModule({code,label:'Mount St. Helens relief bands'});
    const pipeline=device.createRenderPipeline({
      layout:'auto',vertex:{module:mod,entryPoint:'vertex',buffers:[{arrayStride:32,attributes:[
        {shaderLocation:0,format:'float32x3',offset:0},{shaderLocation:1,format:'float32x3',offset:12},
        {shaderLocation:2,format:'float32x2',offset:24},
      ]}]},
      fragment:{module:mod,entryPoint:'fragment',targets:[{format}]},
      primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:descriptor.depthStencil.format,depthCompare:'greater-equal',depthWriteEnabled:true},
    });
    const uniform=upload(frame,GPUBufferUsage.UNIFORM);
    return {device,pipeline,frame:uniform,vertices:upload(points,GPUBufferUsage.VERTEX),index:upload(indices,GPUBufferUsage.INDEX),
      group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]})};
  }
  const remove=engine.scene.frameGraph.add({name:'USGS contour relief',order:2,execute(context){
    if(context.backend!=='webgpu')return;
    if(graphics?.device!==context.device){release();graphics=make(context);}
    const {device,pipeline,group,vertices,index}=graphics;
    frame.set(context.camera.matrix);
    frame.set(context.camera.position,16);
    frame.set([interval,ink,0,0],20);
    device.queue.writeBuffer(graphics.frame,0,frame);
    const pass=context.encoder.beginRenderPass({
      colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}],
      depthStencilAttachment:{view:context.depth,depthLoadOp:'load',depthStoreOp:'store',
        ...(context.descriptor.depthStencil.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})},
    });
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setVertexBuffer(0,vertices);
    pass.setIndexBuffer(index,'uint32');pass.drawIndexed(indices.length);pass.end();
  }});
  return {
    style(spacing,lines){interval=spacing;ink=lines?1:0;},
    dispose(){remove();release();},
  };
}
