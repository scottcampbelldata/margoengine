import { night } from '@margoengine/sky/night';

const triangle = /* wgsl */ `
struct Vertex { @builtin(position) position:vec4f, @location(0) point:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Vertex {
  let uv=vec2f(f32((i<<1u)&2u),f32(i&2u));
  let p=uv*2.0-1.0;
  return Vertex(vec4f(p,0,1),p);
}
`;

const blitShader = triangle + `
@group(0) @binding(0) var landscape:texture_2d<f32>;
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
  let source=textureLoad(landscape,vec2i(i.position.xy),0).rgb;
  let x=max(vec3f(0),source * 0.97);
  let mapped=clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),vec3f(0),vec3f(1));
  let display=select(12.92*mapped,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>vec3f(0.0031308));
  return vec4f(display,1);
}
`;

export function capturePresentation(engine, canvas) {
  const screen = engine.createScene('Mountain display');
  const viewport = [0,0,1,1];
  const camera = engine.camera;
  let target, pipeline, bind, gpu;
  const views = [{camera,viewport,id:'mountain'}, {camera,viewport,scene:screen,id:'display'}];

  screen.frameGraph.add({
    name: 'mountain-colour-copy',
    order: 1,
    execute(context) {
      if (context.backend !== 'webgpu') return;
      if (!pipeline) {
        const module = context.device.createShaderModule({code: blitShader});
        pipeline = context.device.createRenderPipeline({
          layout: 'auto', vertex: {module,entryPoint:'vertex'},
          fragment: {module,entryPoint:'fragment',targets:[{format:context.format}]},
        });
      }
      bind ??= context.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),
        entries:[{binding:0,resource:target.color.createView()}]});
      const pass = context.encoder.beginRenderPass({
        colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0,bind);
      pass.draw(3);
      pass.end();
    },
  });

  function release() {
    target?.color.destroy();
    target?.depth.destroy();
    target = bind = undefined;
  }

  return {
    depth: () => target?.depth,
    render() {
      const device = engine.gpu;
      if (device !== gpu) {
        release();
        gpu = device;
        pipeline = undefined;
      }
      if (target?.color.width !== canvas.width || target.color.height !== canvas.height) {
        release();
        const size = [canvas.width,canvas.height];
        const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
        target = {
          color: device.createTexture({size,format:'rgba16float',usage}),
          depth: device.createTexture({size,format:engine.renderTarget.depthFormat,usage}),
        };
        views[0].target = target;
      }
      engine.render({views});
    },
    dispose: release,
  };
}

const starsShader = triangle + /* wgsl */ `
struct NightView {
  forward:vec4f, right:vec4f, up:vec4f, sun:vec4f, sunlight:vec4f,
  nightZenith:vec4f, nightHorizon:vec4f, nightMoon:vec4f, nightMoonColor:vec4f, nightParams:vec4f,
}
@group(0) @binding(0) var<uniform> frame:NightView;
` + night.wgsl + /* wgsl */ `
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
  let d=normalize(frame.forward.xyz + i.point.x * frame.forward.w * frame.right.xyz + i.point.y * frame.right.w * frame.up.xyz);
  let footprint=max(length(dpdx(d)),length(dpdy(d)));
  let radiance=stylizedNight(d,footprint);
  return vec4f((1.0-exp(-radiance))*frame.up.w,0);
}
`;

const dotDifference = (a,b) => a.map((v,i) => v - b[i]);
const unit = a => { const m=Math.hypot(...a); return a.map(v=>v/m); };
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

export function addNight(engine) {
  const config = {
    zenithColor:[.011,.022,.053], horizonColor:[.038,.051,.093],
    moonDirection:[-.31,.31,-.91], moonPhase:'firstQuarter', moonLitBySun:false,
    moonSize:.009, glowIntensity:.16, starIntensity:3.8, starTwinkleIntensity:.24,
  };
  night.validate(config);
  const frame = new Float32Array(40), sky = new Float32Array(64);
  let level = 0, sun = [0,1,0], seconds = 0, device, uniform, pipeline, bind;
  engine.scene.frameGraph.add({
    name: 'sky:mountain-night-overlay',
    order: 2.5,
    execute(context) {
      if (level <= 0 || context.backend !== 'webgpu') return;
      if (device !== context.device) {
        uniform?.destroy();
        device = context.device;
        const module=device.createShaderModule({code:starsShader});
        const additive={operation:'add',srcFactor:'one',dstFactor:'one'};
        pipeline=device.createRenderPipeline({
          layout:'auto', vertex:{module,entryPoint:'vertex'}, fragment:{module,entryPoint:'fragment',
            targets:[{format:context.format,blend:{color:additive,alpha:additive}}]},
          depthStencil:{format:context.descriptor.depthStencil.format,depthWriteEnabled:false,depthCompare:'greater-equal'},
        });
        uniform=device.createBuffer({size:frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
        bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
      }
      const camera=context.camera;
      const forward=unit(dotDifference(camera.target,camera.position));
      const right=unit(cross(forward,camera.up));
      const up=cross(right,forward);
      const tangent=Math.tan(camera.fov*Math.PI/360);
      frame.set([...forward,tangent*context.width/context.height],0);
      frame.set([...right,tangent],4);
      frame.set([...up,level],8);
      frame.set(sun,12);
      night.write(sky,config,seconds);
      frame[19]=sky[63];
      frame.set(sky.subarray(40,60),20);
      device.queue.writeBuffer(uniform,0,frame);
      const pass=context.encoder.beginRenderPass({
        colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}],
        depthStencilAttachment:{view:context.depth,depthReadOnly:true,stencilReadOnly:true},
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0,bind);
      pass.draw(3);
      pass.end();
    },
  });
  return {
    set(state,time) { level=state.stars; sun=state.sun; seconds=time; },
    dispose() { uniform?.destroy(); },
  };
}