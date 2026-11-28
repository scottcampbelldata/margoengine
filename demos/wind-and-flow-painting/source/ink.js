const shader=`
struct Vertex { @builtin(position) position:vec4f, @location(0) color:vec4f };
@vertex fn vertex(@location(0) point:vec2f,@location(1) color:vec4f)->Vertex {
  return Vertex(vec4f(point,0.,1.),color);
}
@fragment fn fragment(in:Vertex)->@location(0) vec4f { return in.color; }
`;

export function createInk(engine,bounds){
  const staging=new Float32Array(13200);
  let streak=[],path=[],graphics,changed=true;
  const projected=point=>[-1+2*(point[0]-bounds[0])/(bounds[1]-bounds[0]),
    -1+2*(point[1]-bounds[2])/(bounds[3]-bounds[2])];
  function update(width,height){
    let cursor=0;
    const put=(x,y,color)=>{
      staging[cursor++]=x;
      staging[cursor++]=y;
      for(const c of color)staging[cursor++]=c;
    };
    function strip(points,wide,color){
      for(let i=1;i<points.length;i++){
        const [a,b]=projected(points[i-1]), [x,y]=projected(points[i]);
        const dx=(x-a)*width,dy=(y-b)*height;
        const len=Math.hypot(dx,dy);
        if(len<1e-5)continue;
        const u=-dy/len*wide/width,v=dx/len*wide/height;
        put(a-u,b-v,color);put(a+u,b+v,color);put(x-u,y-v,color);
        put(x-u,y-v,color);put(a+u,b+v,color);put(x+u,y+v,color);
      }
    }
    strip(path,1.65,[.65,.96,.89,1]);
    strip(streak,2.5,[.96,.72,.44,1]);
    return cursor;
  }
  const remove=engine.scene.frameGraph.add({
    name:'dye tracer ink',order:80,
    execute(context){
      if(context.backend!=='webgpu')return;
      const {device,format}=context;
      if(graphics?.device!==device){
        graphics?.mesh.destroy();
        const mod=device.createShaderModule({code:shader,label:'dye tracer ink'});
        const pipeline=device.createRenderPipeline({
          layout:'auto',label:'dye tracer ink',
          vertex:{module:mod,entryPoint:'vertex',buffers:[{arrayStride:24,attributes:[
            {shaderLocation:0,format:'float32x2',offset:0},{shaderLocation:1,format:'float32x4',offset:8},
          ]}]},
          fragment:{module:mod,entryPoint:'fragment',targets:[{format}]},
          primitive:{topology:'triangle-list'},
        });
        const mesh=device.createBuffer({size:staging.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
        graphics={device,pipeline,mesh,count:0,width:0,height:0};
        changed=true;
      }
      if(changed||graphics.width!==context.width||graphics.height!==context.height){
        const css=engine.canvas.clientWidth&&context.width/engine.canvas.clientWidth||1;
        const elements=update(context.width/css,context.height/css);
        if(elements)device.queue.writeBuffer(graphics.mesh,0,staging.subarray(0,elements));
        graphics.count=elements/6;
        graphics.width=context.width;
        graphics.height=context.height;
        changed=false;
      }
      if(!graphics.count)return;
      const pass=context.encoder.beginRenderPass({colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}]});
      pass.setPipeline(graphics.pipeline);
      pass.setVertexBuffer(0,graphics.mesh);
      pass.draw(graphics.count);
      pass.end();
    },
  });
  return {
    show(nextStreak,nextPath){streak=nextStreak;path=nextPath;changed=true;},
    dispose(){remove();graphics?.mesh.destroy();},
  };
}
