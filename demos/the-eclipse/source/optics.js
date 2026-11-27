const code = /* wgsl */ `
struct Frame {
  offset:vec2f,
  radii:vec2f,
  view:vec4f
};
@group(0) @binding(0) var<uniform> f:Frame;
struct Varying {
  @builtin(position) position:vec4f,
  @location(0) image:vec2f
};
@vertex fn vertex(@builtin(vertex_index) i:u32) -> Varying {
  var v:Varying;
  let uv=vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  v.image=uv*2.0-vec2f(1.0);
  v.position=vec4f(v.image,0.0,1.0);
  return v;
}
fn hash(p:vec2f)->f32 {
  var h=fract(vec3f(p.xyx)*vec3f(0.1031,0.1197,0.1379));
  h+=dot(h,h.yzx+vec3f(19.19));
  return fract((h.x+h.y)*h.z);
}
fn noise(p:vec2f)->f32 {
  let i=floor(p);
  let a=fract(p);
  let u=a*a*(vec2f(3.0)-2.0*a);
  let n=mix(hash(i),hash(i+vec2f(1.0,0.0)),u.x);
  let m=mix(hash(i+vec2f(0.0,1.0)),hash(i+vec2f(1.0)),u.x);
  return mix(n,m,u.y);
}
fn color(c:vec3f)->vec3f {
  return pow(max(c,vec3f(0.0)),vec3f(0.45454545));
}
@fragment fn fragment(v:Varying)->@location(0) vec4f {
  let p = v.image*vec2f(f.view.x,1.0)*0.0122;
  let ray = normalize(vec3f(p,1.0));
  let moon = normalize(vec3f(f.offset,1.0));
  let sunAngle = atan2(length(p),1.0);
  let moonAngle = atan2(length(cross(ray,moon)),dot(ray,moon));
  let t = sunAngle/f.radii.x;
  let aa = f.view.y;
  let solar = 1.0-smoothstep(f.radii.x-aa,f.radii.x+aa,sunAngle);
  let lunar = 1.0-smoothstep(f.radii.y-aa,f.radii.y+aa,moonAngle);
  let theta=atan2(p.y,p.x+0.0000001);
  let phase=f.view.z;
  let exposure=1.0-smoothstep(0.001,0.055,phase);
  let background = vec3f(0.0019,0.0032,0.0069);
  var radiance = background + vec3f(0.011,0.0075,0.0054) * exp(-1.11*t*t)*phase;
  // Smooth polar plumes and brighter equatorial streamers are an optical illustration.
  let band=theta+0.27;
  let braid=theta+0.037*sin(2.19*t+6.0*theta);
  let eq=pow(abs(cos(band)),5.0);
  let streamer=(0.57+0.43*cos(7.0*braid+0.7))*(0.76+0.24*cos(19.0*braid-0.5));
  let fibers=0.72+0.28*cos(85.0*braid+0.42*t);
  let fine=0.78+0.22*cos(132.0*theta-2.6*t+1.1*sin(11.0*theta));
  let distance=max(0.0,t-1.0);
  let corona = (0.21+0.11*eq)*exp(-distance*(4.9-1.9*eq)) +
    (0.03+0.21*eq)*streamer*fibers*fine*exp(-distance*(3.1-0.9*eq)) +
    0.16*exp(-21.0*distance);
  radiance += vec3f(0.77,0.87,1.0)*corona*exposure*(1.0-solar*0.70);
  let prom = exp(-245.0*abs(t-1.016)) * pow(max(0.0,cos(theta-2.22)),260.0)
           + exp(-325.0*abs(t-1.012)) * pow(max(0.0,cos(theta+0.50)),370.0);
  radiance += vec3f(.86,.048,.035)*prom*exposure;
  let mu=sqrt(max(0.0,1.0-t*t));
  let granule=0.87 + 0.16*noise(p/f.radii.x*71.0) + 0.08*noise(p/f.radii.x*176.0);
  let fleck=0.96 + 0.04*noise(p/f.radii.x*12.0);
  let photo=vec3f(1.0,0.62+0.22*mu,0.20+0.40*mu)*granule*fleck*(0.40+0.60*mu);
  let earth=vec3f(0.0018,0.0026,0.0052)*(0.8+0.23*noise((p-f.offset)/f.radii.y*13.0));
  radiance=mix(radiance,earth,lunar*exposure);
  radiance=mix(radiance,photo,solar*(1.0-lunar));
  return vec4f(color(radiance),1.0);
}
`;

export function makeOptics(state) {
  let gpu, uniform, format, samples, pipeline, group;
  const values = new Float32Array(8);
  function dispose() { uniform?.destroy(); uniform = pipeline = group = undefined; }
  return {
    name: 'eclipse-optics',
    setup(engine) { gpu = engine.gpu; },
    onDeviceRestored(engine) { dispose(); gpu = engine.gpu; },
    dispose,
    registerPasses(graph) {
      graph.add({
        name: 'eclipse-optical-image', order: 1, joins: true,
        execute(context) {
          const samplesNow = context.descriptor.multisample?.count ?? 1;
          if (!pipeline || format !== context.format || samplesNow !== samples) {
            dispose();
            format = context.format;
            samples = samplesNow;
            const module = gpu.createShaderModule({ code });
            pipeline = gpu.createRenderPipeline({
              layout: 'auto',
              vertex: { module, entryPoint: 'vertex' },
              fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
              multisample: { count: samples },
            });
            uniform = gpu.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST });
            group = gpu.createBindGroup({
              layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }],
            });
          }
          const [x,y,width,height] = context.view.viewport;
          const current = state();
          values.set([current.moonX,current.moonY,current.sunRadius,current.moonRadius,width/height,.018/height,current.flux,0]);
          gpu.queue.writeBuffer(uniform,0,values);
          const color = { view:context.color,loadOp:'load',storeOp:'store' };
          const depth = { view:context.depth,depthLoadOp:'load',depthStoreOp:'store' };
          context.attach?.(color,depth,context.last);
          const pass = context.encoder.beginRenderPass({ colorAttachments:[color] });
          pass.setViewport(x,y,width,height,0,1);
          pass.setScissorRect(x,y,width,height);
          pass.setPipeline(pipeline);
          pass.setBindGroup(0,group);
          pass.draw(3);
          pass.end();
        },
      });
    },
  };
}
