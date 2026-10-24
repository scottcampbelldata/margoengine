// Fixture for scripts/post-looks-gpu-check.js: post's SMAA, Glitch and Afterimage on the real GPU, built packages.
// A PostStack runs a pattern stage (a drawn test image), the effect under test, then a probe stage that copies what it
// is handed into an rgba32float texture for exact readback. ?samples=1 selects single-sampled scenes.
import { Engine, PbrMaterial, box } from '../packages/core/dist/index.js';
import { engineRuntime } from '../packages/core/dist/extension.js';
import { PostStack, SMAA, Glitch, Afterimage } from '../packages/post/dist/index.js';

globalThis.margoLow = new URLSearchParams(location.search).get('samples') === '1' ? 1 : undefined;
const canvas = document.querySelector('canvas'),
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [2.2, 1.6, 3.4], target: [0, 0, 0] } }),
  runtime = engineRuntime(engine),
  errors = [];
engine.stop();
let observed,
  sampleCount = 0;
runtime.frameGraph.add({
  name: 'post-looks:samples',
  order: -100,
  execute(c) {
    if (c.backend === 'webgpu') sampleCount = c.descriptor.multisample?.count ?? 1;
  },
});
const vertex =
  '@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}\n';
const copyShader =
  vertex +
  '@group(0) @binding(0) var image:texture_2d<f32>;@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {return textureLoad(image,vec2i(p.xy),0);}';
// mode 0: half-plane dot(p, line.xy) > line.z; 1: rectangle [line.xy, line.zw); 2: coordinates (x, y, 7x + 3y) / 255.
const patternShader =
  vertex +
  `struct P {mode:vec4f,line:vec4f,inside:vec4f,outside:vec4f}
@group(0) @binding(0) var<uniform> u:P;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let m=i32(u.mode.x);
 if(m==0){return select(u.outside,u.inside,dot(p.xy,u.line.xy)>u.line.z);}
 if(m==1){return select(u.outside,u.inside,all(p.xy>=u.line.xy)&&all(p.xy<u.line.zw));}
 let q=vec2u(p.xy);return vec4f(f32(q.x%256u),f32(q.y%256u),f32((q.x*7u+q.y*3u)%256u),255.0)/255.0;
}`;
const pipelines = new Map();
function pipeline(device, code, format, multisample) {
  const key = code.length + format + (multisample?.count ?? 1);
  let p = pipelines.get(key);
  if (p?.device !== device) {
    const module = device.createShaderModule({ code });
    p = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
      multisample,
    });
    p.device = device;
    pipelines.set(key, p);
  }
  return p;
}
function draw(c, p, entries, view) {
  const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(p);
  pass.setBindGroup(
    0,
    c.device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: entries.map((resource, binding) => ({ binding, resource })),
    }),
  );
  pass.draw(3);
  pass.end();
}
function pattern(kind) {
  const values = new Float32Array(16);
  let buffer;
  return {
    name: 'pattern',
    values,
    setup() {},
    dispose() {
      buffer?.destroy();
    },
    joinStack: () => ({
      kind,
      render(c, input, output) {
        if (buffer?.device !== c.device) {
          buffer = c.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          buffer.device = c.device;
        }
        c.device.queue.writeBuffer(buffer, 0, values);
        draw(c, pipeline(c.device, patternShader, output.format, output.multisample), [{ buffer }], output.view);
      },
    }),
  };
}
function probe(kind) {
  let texture;
  return {
    name: 'probe',
    setup() {},
    dispose() {
      texture?.destroy();
    },
    joinStack: () => ({
      kind,
      render(c, input, output) {
        if (texture?.device !== c.device || texture.width !== c.width || texture.height !== c.height) {
          texture?.destroy();
          texture = c.device.createTexture({
            size: [c.width, c.height],
            format: 'rgba32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
          texture.device = c.device;
        }
        draw(c, pipeline(c.device, copyShader, 'rgba32float'), [input], texture.createView());
        draw(c, pipeline(c.device, copyShader, output.format, output.multisample), [input], output.view);
      },
    }),
    async read() {
      const device = texture.device,
        buffer = device.createBuffer({
          size: texture.width * texture.height * 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: texture.width * 16 }, [
        texture.width,
        texture.height,
      ]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const result = Array.from(new Float32Array(buffer.getMappedRange()));
      buffer.destroy();
      return result;
    },
  };
}
let stack,
  current,
  meshes = [];
function observe() {
  const device = runtime.gpu;
  if (device !== observed) {
    observed = device;
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  }
  return device;
}
async function render() {
  const device = observe();
  device.pushErrorScope('validation');
  try {
    engine.render({ delta: 1 / 60 }); // fixed 60 Hz frames, so Afterimage fades the same every run
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
}
function clear() {
  stack?.dispose();
  current?.dispose?.();
  stack = current = undefined;
  for (const mesh of meshes) mesh.dispose?.();
  meshes = [];
}
const make = {
  pattern: (d) => pattern(d.kind),
  probe: (d) => probe(d.kind),
  smaa: (d) => new SMAA(d.options),
  glitch: (d) => new Glitch(d.options),
  afterimage: (d) => new Afterimage(d.options),
};
window.looks = {
  errors,
  /** Replaces the stack with one built from descriptors ({type, kind | options}); `width` sets the canvas size. */
  configure(list, width = 160, height = 120) {
    clear();
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const effects = list.map((d) => make[d.type](d));
    stack = PostStack.attach(engine, effects);
    window.looks.effects = effects;
  },
  /** Renders a frame with the pattern's 16 uniform values; returns the probe's pixels (rgba, linear float) if any. */
  async frame(values) {
    const effects = window.looks.effects;
    effects.find((e) => e.name === 'pattern')?.values.set(values);
    await render();
    const glitch = effects.find((e) => e.name === 'glitch');
    return {
      pixels: await effects.find((e) => e.name === 'probe')?.read(),
      active: glitch?.active,
      width: canvas.width,
      height: canvas.height,
      sampleCount,
    };
  },
  async reboot() {
    await engine.rebootDevice();
    observe();
  },
  /** A core scene (a turned box on a floor) with SMAA alone, Glitch alone or neither. */
  async scene(effect, options) {
    clear();
    canvas.style.width = '160px';
    canvas.style.height = '120px';
    const material = new PbrMaterial({ color: '#d8d0c0', roughness: 0.6 }),
      dark = new PbrMaterial({ color: '#202830', roughness: 0.9 });
    meshes.push(
      engine
        .createMesh()
        .setGeometry(box(6, 0.1, 6))
        .setPosition([0, -0.55, 0])
        .setMaterial(dark),
      engine
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setRotation([0.3, 0.6, 0.1])
        .setMaterial(material),
    );
    if (effect === 'smaa') current = SMAA.attach(engine, options);
    if (effect === 'glitch') current = Glitch.attach(engine, options);
    for (let i = 0; i < 2; i++) await render();
    return { sampleCount };
  },
  dispose() {
    clear();
    engine.dispose();
  },
};
