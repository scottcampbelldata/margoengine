const shader = /* wgsl */ `
struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}
@group(0) @binding(0) var backdrop: texture_2d<f32>;
@group(0) @binding(1) var sampleBackdrop: sampler;
@group(0) @binding(2) var<uniform> projection: vec4f;
@vertex fn vertex(@builtin(vertex_index) vertexIndex: u32) -> Varyings {
  let corners = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  let xy = corners[vertexIndex];
  return Varyings(vec4f(xy, 0, 1), xy);
}
@fragment fn fragment(input: Varyings) -> @location(0) vec4f {
  let uv = vec2f(.5) + input.ndc * projection.xy;
  return vec4f(textureSample(backdrop, sampleBackdrop, uv).rgb, 1);
}
`;

// The atlas was rendered through the same fixed-view camera at a wider field of view.
// Scale by the current projection tangents to pick the same view ray at every aspect.
const atlasTangent=1.1;

export class MarshSky {
  name='marsh-sky-backdrop';
  constructor(bitmap){
    this.bitmap=bitmap;
    this.projection=new Float32Array(4);
  }

  setup(engine){
    this.engine=engine;
    const device=engine.gpu;
    const {width,height}=this.bitmap;
    this.texture=device.createTexture({size:{width,height},format:'rgba8unorm',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    device.queue.copyExternalImageToTexture({source:this.bitmap},{texture:this.texture},{width,height});
    this.uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
    this.module=device.createShaderModule({code:shader});
  }

  registerPasses(graph){
    graph.add({name:this.name,order:2,execute:context=>{
      if(context.backend==='webgpu')this.draw(context);
    }});
  }

  draw(context){
    const {device,format,descriptor,camera}=context;
    const depth=descriptor.depthStencil.format;
    const samples=descriptor.multisample?.count??1;
    const target=format+':'+depth+':'+samples;
    if(this.target!==target){
      this.pipeline=device.createRenderPipeline({
        layout:'auto',vertex:{module:this.module,entryPoint:'vertex'},
        fragment:{module:this.module,entryPoint:'fragment',targets:[{format}]},
        depthStencil:{format:depth,depthCompare:'greater-equal',depthWriteEnabled:false},
        multisample:{count:samples},
      });
      this.group=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:this.texture.createView()},{binding:1,resource:this.sampler},
        {binding:2,resource:{buffer:this.uniform}},
      ]});
      this.target=target;
    }
    const canvas=this.engine.canvas;
    const tangent=.5*Math.tan(camera.fov*Math.PI/360)/atlasTangent;
    this.projection[0]=tangent*canvas.width/canvas.height;
    this.projection[1]=-tangent;
    device.queue.writeBuffer(this.uniform,0,this.projection);
    const pass=context.encoder.beginRenderPass({
      colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}],
      depthStencilAttachment:{view:context.depth,depthReadOnly:true,stencilReadOnly:true},
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0,this.group);
    pass.draw(3);
    pass.end();
  }

  release(){
    this.texture?.destroy();
    this.uniform?.destroy();
    this.target=undefined;
    this.group=this.pipeline=this.sampler=this.module=this.texture=this.uniform=undefined;
  }

  onDeviceRestored(engine){
    this.release();
    this.setup(engine);
  }

  dispose(){
    this.release();
    this.bitmap.close();
  }
}
