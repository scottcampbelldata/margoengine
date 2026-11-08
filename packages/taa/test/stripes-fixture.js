// Browser fixture for TAA's GPU checks (served by Vite from the built packages): an engine on its own canvas with a
// world-space plane drawn by the jittered camera, so TAA reprojects it as any surface, and an optional white square
// (`alpha`, default half)
// that writes no velocity, as particles and splats do, with its coverage drawn into an r8unorm mask.
//   pattern 'sine': stripes 8 px across, 0.4 + 0.38 sin, which hold the 3x3 neighbourhood wide open;
//   pattern 'dots': a dark plane with a bright dot 1 px across every 4 px, one outlier in a 3x3 neighbourhood;
//   pattern 'line': a dark plane with one bright vertical line 0.4 px wide at the view's centre.
const { Engine } = await import('/packages/core/dist/index.js'),
  { engineRuntime } = await import('/packages/core/dist/extension.js'),
  { TAA } = await import('/packages/taa/dist/index.js');

export const WIDTH = 320,
  HEIGHT = 240,
  SIZE = 48;
// Pixels per world unit on the plane z = 0, camera at z = 9 with the default 60 degree field of view.
const PIXELS = HEIGHT / 2 / Math.tan(Math.PI / 6) / 9;

export async function rig(id, { taa = {}, mask = false, pattern = 'sine', alpha = 0.5 } = {}) {
  const canvas = Object.assign(document.createElement('canvas'), { id, width: WIDTH, height: HEIGHT });
  canvas.style.cssText = `display:inline-block;width:${WIDTH}px;height:${HEIGHT}px`;
  document.body.append(canvas);
  const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 9], target: [0, 0, 0] } });
  engine.stop();
  const device = engine.gpu,
    gpuErrors = [];
  device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
  const camera = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    square = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    coverage = device.createTexture({
      size: [WIDTH, HEIGHT],
      format: 'r8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  const quad = `struct Square {rect:vec4f}
@group(0) @binding(0) var<uniform> s:Square;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let corner=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[i];
  let px=s.rect.xy+corner*s.rect.zw;return vec4f(px.x/${WIDTH}.0*2.0-1.0,1.0-px.y/${HEIGHT}.0*2.0,0,1);}`;
  const shade = {
    line: `select(0.02,0.9,abs(i.x)*${PIXELS.toFixed(5)}<0.2)`,
    dots: `select(0.02,0.9,fract(i.x*${(PIXELS / 4).toFixed(5)})<0.25&&fract(i.y*${(PIXELS / 4).toFixed(5)})<0.25)`,
    sine: `0.4+0.38*sin(i.x*${((2 * Math.PI * PIXELS) / 8).toFixed(5)})`,
  }[pattern];
  const plane = `@group(0) @binding(0) var<uniform> camera:mat4x4f;
struct Out {@builtin(position) clip:vec4f,@location(0) x:f32,@location(1) y:f32}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let corner=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[i]*20.0;
  var o:Out;o.clip=camera*vec4f(corner,0,1);o.x=corner.x;o.y=corner.y;return o;}
@fragment fn fragment(i:Out)->@location(0) vec4f {return vec4f(vec3f(${shade}),1);}`;
  let pipelines;
  const make = (c) => {
    const multisample = c.descriptor.multisample,
      depthStencil = c.descriptor.depthStencil.format,
      module = (code) => device.createShaderModule({ code }),
      ground = module(plane),
      sq = module(quad + `\n@fragment fn fragment()->@location(0) vec4f {return vec4f(1,1,1,${alpha.toFixed(3)});}`),
      cover = module(quad + '\n@fragment fn fragment()->@location(0) vec4f {return vec4f(1);}');
    const background = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: ground, entryPoint: 'vertex' },
        fragment: { module: ground, entryPoint: 'fragment', targets: [{ format: c.format }] },
        depthStencil: { format: depthStencil, depthWriteEnabled: true, depthCompare: 'always' },
        multisample,
      }),
      blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} },
      particle = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: sq, entryPoint: 'vertex' },
        fragment: { module: sq, entryPoint: 'fragment', targets: [{ format: c.format, blend }] },
        multisample,
      }),
      covered = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: cover, entryPoint: 'vertex' },
        fragment: { module: cover, entryPoint: 'fragment', targets: [{ format: 'r8unorm' }] },
      }),
      group = (p, buffer) =>
        device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] });
    return {
      background,
      particle,
      covered,
      backgroundGroup: group(background, camera),
      particleGroup: group(particle, square),
      coverageGroup: group(covered, square),
      stencil: depthStencil.includes('stencil'),
    };
  };
  let x = 20,
    shown = false;
  engineRuntime(engine).use({
    name: 'taa-fixture',
    setup() {},
    registerPasses(graph) {
      graph.add({
        name: 'taa-fixture:plane',
        order: 0.5,
        execute(c) {
          pipelines ??= make(c);
          device.queue.writeBuffer(camera, 0, new Float32Array(c.camera.matrix));
          const pass = c.encoder.beginRenderPass({
            colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
            depthStencilAttachment: {
              view: c.depth,
              depthLoadOp: 'load',
              depthStoreOp: 'store',
              ...(pipelines.stencil ? { stencilReadOnly: true } : {}),
            },
          });
          pass.setPipeline(pipelines.background);
          pass.setBindGroup(0, pipelines.backgroundGroup);
          pass.draw(6);
          pass.end();
        },
      });
      graph.add({
        name: 'taa-fixture:square',
        order: 6,
        execute(c) {
          device.queue.writeBuffer(square, 0, new Float32Array([x, (HEIGHT - SIZE) / 2, shown ? SIZE : 0, SIZE]));
          const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] });
          pass.setPipeline(pipelines.particle);
          pass.setBindGroup(0, pipelines.particleGroup);
          pass.draw(6);
          pass.end();
          const masked = c.encoder.beginRenderPass({
            colorAttachments: [{ view: coverage.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
          });
          masked.setPipeline(pipelines.covered);
          masked.setBindGroup(0, pipelines.coverageGroup);
          masked.draw(6);
          masked.end();
        },
      });
    },
  });
  const effect = TAA.attach(engine, { ...taa, ...(mask ? { reactive: () => coverage } : {}) });
  return {
    gpuErrors,
    taa: effect,
    /** Render n frames, moving the square `step` px before each; `show` draws it. */
    async frames(n, step = 0, show = false) {
      shown = show;
      for (let i = 0; i < n; i++) {
        x += step;
        engine.render({ delta: 1 / 60 });
      }
      await device.queue.onSubmittedWorkDone();
    },
  };
}
