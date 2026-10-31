// Scene targets demo: one pass writes four named outputs (albedo, world normal, camera distance and a custom WGSL
// output) from core meshes and from a materials mesh added with targets.add(). A pass after the main pass shows each
// output in a quarter of the canvas. Shapes turn (held still under prefers-reduced-motion, used by the visual check).
import { createStage } from 'margoengine';
import { torusKnotGeometry } from '@margoengine/geometry';
import { Material, createMesh } from '@margoengine/materials';
import { SceneTargets } from '@margoengine/post/mrt';
import type { FrameGraph, PassContext } from '@margoengine/core/extension';
import { still } from './multi-view.js';

declare global {
  interface Window {
    targetsDemo?: { targets: SceneTargets };
  }
}

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const life = new AbortController();
let dispose = () => {};
window.addEventListener(
  'pagehide',
  () => {
    life.abort();
    dispose();
  },
  { once: true },
);
// Shows output `k` of the four in its quarter (textureLoad at the matching pixel), with a per-output display mapping.
const showShader = /* wgsl */ `
@group(0) @binding(0) var albedo:texture_2d<f32>;
@group(0) @binding(1) var normal:texture_2d<f32>;
@group(0) @binding(2) var distance:texture_2d<f32>;
@group(0) @binding(3) var custom:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
fn encode(c:vec3f)->vec3f {return select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  let size=vec2f(textureDimensions(albedo));let half=size*0.5;let q=vec2u(p.xy>=half);
  let at=vec2i((p.xy-vec2f(q)*half)*2.0);
  if(q.x==0u&&q.y==0u){return vec4f(encode(textureLoad(albedo,at,0).rgb),1);}
  if(q.x==1u&&q.y==0u){return vec4f(textureLoad(normal,at,0).xyz*0.5+0.5,1);}
  if(q.x==0u&&q.y==1u){let d=textureLoad(distance,at,0).r;return vec4f(vec3f(select(0.0,1.0-clamp((d-4.0)/10.0,0.0,1.0),d>0.0)),1);}
  return vec4f(textureLoad(custom,at,0).rgb,1);
}`;
try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 4, 9], target: [0, 0.6, 0] },
    onError: (error) => {
      if (!life.signal.aborted) status.textContent = String(error);
    },
  });
  dispose = () => stage.dispose();
  life.signal.throwIfAborted();
  const engine = stage.engine;
  stage.box({ size: [14, 0.2, 10], position: [0, -0.1, 0], color: '#8a96a8', roughness: 0.9 });
  const boxes = [
    stage.box({ size: [1.4, 1.4, 1.4], position: [-3, 0.7, 0], color: '#e0663c', roughness: 0.3 }),
    stage.box({ size: [1, 2.4, 1], position: [3, 1.2, -0.5], color: '#3c8ee0', roughness: 0.7, metalness: 0.8 }),
  ];
  const knot = createMesh(
    engine,
    torusKnotGeometry(0.9, 0.3, 160, 20),
    new Material({ color: '#7ad06a', roughness: 0.5 }),
  );
  knot.root.setPosition([0, 1.4, 0]);
  const targets = SceneTargets.attach(engine, {
    outputs: {
      albedo: 'albedo',
      normal: 'normal',
      distance: 'distance',
      // Custom WGSL over the surface: roughness in red, metalness in green, and a height band in blue.
      custom: { wgsl: 'vec4f(t.roughness,t.metalness,fract(t.position.y*2.0),1)', format: 'rgba8unorm' },
    },
  });
  targets.add(knot);
  let pipeline: GPURenderPipeline | undefined, group: GPUBindGroup | undefined, texture: GPUTexture | undefined;
  stage.use({
    name: 'show-targets',
    setup() {},
    registerPasses(graph: FrameGraph) {
      graph.add({
        name: 'show-targets',
        order: 20,
        execute(c: PassContext) {
          if (c.backend !== 'webgpu' || !targets.texture('albedo')) return;
          if (!pipeline) {
            const module = c.device.createShaderModule({ code: showShader });
            pipeline = c.device.createRenderPipeline({
              layout: 'auto',
              vertex: { module, entryPoint: 'vertex' },
              fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
              multisample: c.descriptor.multisample,
            });
          }
          if (texture !== targets.texture('albedo')) {
            texture = targets.texture('albedo');
            group = c.device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: ['albedo', 'normal', 'distance', 'custom'].map((name, binding) => ({
                binding,
                resource: targets.view(name)!,
              })),
            });
          }
          const pass = c.encoder.beginRenderPass({
            colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group!);
          pass.draw(3);
          pass.end();
        },
      });
    },
  });
  let time = 0;
  if (!still)
    stage.use({
      name: 'targets-demo',
      setup() {},
      onPreUpdate(delta) {
        time += delta;
        boxes[0].rotation.y = time * 0.6;
        knot.root.setRotation([0, time * 0.4, 0]);
      },
    });
  window.targetsDemo = { targets };
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  status.textContent = 'Albedo, world normal, camera distance and a custom output, from one pass.';
  canvas.dataset.ready = 'true';
} catch (error) {
  if (!life.signal.aborted) status.textContent = String(error);
}
