// The city's lamp lenses and occupied panes are scene-space light surfaces.
// Put their radiance into the same capture as the city so SSR and bloom see it.
const shader=`
struct Frame { camera: mat4x4<f32>, time: vec4f }
@group(0) @binding(0) var<uniform> frame: Frame;
struct Varying {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
  @location(1) start: f32,
  @location(2) pane: vec2f,
}
@vertex fn cityVertex(@builtin(vertex_index) corner: u32, @location(0) p: vec3f,
  @location(1) across: vec3f, @location(2) up: vec3f, @location(3) color: vec3f,
  @location(4) start: f32) -> Varying {
  let uv = vec2f(f32(corner & 1u), f32(corner >> 1u));
  let at = p + uv.x * across + uv.y * up;
  return Varying(frame.camera * vec4f(at, 1.0), color, start, uv);
}
@fragment fn cityFragment(v: Varying) -> @location(0) vec4f {
  let intensity = smoothstep(v.start, v.start + 7.0, frame.time.x);
  let blind = smoothstep(0.02, 0.12, v.pane.y);
  let interior = mix(0.56, 0.89, blind) * mix(1.0, 0.72, smoothstep(0.57, 1.0, v.pane.y));
  let frameV = 0.38 + 0.62 * smoothstep(0.008, 0.031, abs(v.pane.x - 0.5));
  let glass = select(interior * frameV, 1.0, max(max(v.color.x, v.color.y), v.color.z) > 4.0);
  return vec4f(v.color, intensity * glass);
}
`;

export function cityRadiance(vertices) {
  let resources,sourceDevice;
  const uniforms=new Float32Array(20);
  function release() {
    resources?.geometry.destroy();
    resources?.uniform.destroy();
    resources=undefined;
  }
  function draw(context) {
    if(context.backend!=='webgpu') return;
    const {device,descriptor,format,camera}=context;
    const depthFormat=descriptor.depthStencil.format;
    const sampleCount=descriptor.multisample?.count??4;
    if(!resources||sourceDevice!==device) {
      release();
      sourceDevice=device;
      const geometry=device.createBuffer({label:'City panes and lamps',size:vertices.byteLength,
        usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
      const uniform=device.createBuffer({label:'Solar clock',size:uniforms.byteLength,
        usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      device.queue.writeBuffer(geometry,0,vertices);
      resources={geometry,uniform,module:device.createShaderModule({code:shader}),key:'',bind:null,pipeline:null};
    }
    const key=format+'/'+depthFormat+'/'+sampleCount;
    if(resources.key!==key) {
      const {module,uniform}=resources;
      const pipeline=device.createRenderPipeline({
        layout:'auto',
        vertex:{module,entryPoint:'cityVertex',buffers:[{arrayStride:52,stepMode:'instance',attributes:[
          {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
          {shaderLocation:2,offset:24,format:'float32x3'},{shaderLocation:3,offset:36,format:'float32x3'},
          {shaderLocation:4,offset:48,format:'float32'},
        ]}]},
        fragment:{module,entryPoint:'cityFragment',targets:[{format,blend:{
          color:{srcFactor:'src-alpha',dstFactor:'one',operation:'add'},
          alpha:{srcFactor:'zero',dstFactor:'one',operation:'add'},
        }}]},
        primitive:{topology:'triangle-strip'},
        multisample:{count:sampleCount},
        depthStencil:{format:depthFormat,depthWriteEnabled:false,depthCompare:'greater-equal'},
      });
      resources.pipeline=pipeline;
      resources.bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),
        entries:[{binding:0,resource:{buffer:uniform}}]});
      resources.key=key;
    }
    uniforms.set(camera.matrix);
    uniforms[16]=pass.minute;
    device.queue.writeBuffer(resources.uniform,0,uniforms);
    const color={view:context.color,loadOp:'load',storeOp:'store'};
    const depth={view:context.depth,depthLoadOp:'load',depthStoreOp:'store'};
    if(depthFormat.includes('stencil')) {
      depth.stencilLoadOp='load';
      depth.stencilStoreOp='store';
    }
    const encoder=context.encoder.beginRenderPass({label:'City light surfaces',colorAttachments:[color],depthStencilAttachment:depth});
    encoder.setPipeline(resources.pipeline);
    encoder.setBindGroup(0,resources.bind);
    encoder.setVertexBuffer(0,resources.geometry);
    encoder.draw(4,vertices.length/13);
    encoder.end();
  }
  const pass={
    name:'city-radiance',
    minute:0,
    setup(){},
    registerPasses(graph) { graph.add({name:'city-radiance',order:4,execute:draw}); },
    dispose:release,
  };
  return pass;
}
