// Real-GPU check of RenderGraph, built packages (WebGPU, or the WebGL2 layer with --compat). A scene captured by the
// graph and blitted to the screen matches the plain frame; clear and copy reach the screen without a scene; a custom
// task feeding a history texture back into itself accumulates frame by frame; a post effect runs as a task.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';

await postBrowser(
  'post-render-graph' + (compatRun() ? '-compat' : ''),
  compatRun() ? 5421 : 5420,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const graphs = await import('/packages/post/dist/render-graph.js');
      const { Pixelate } = await import('/packages/post/dist/pixelate.js');
      const { Afterimage } = await import('/packages/post/dist/afterimage.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(2, 2, 2))
        .setRotation([0.4, 0.6, 0])
        .setMaterial(new PbrMaterial({ color: '#d08040', roughness: 0.5 }));
      // Adds 0.25 to last frame's value: a feedback loop through a history texture.
      const add = {
        create: () => {
          let pipeline, sampler;
          const groups = new Map();
          return {
            inputs: { previous: 'color' },
            outputs: { target: 'color' },
            execute(c, io) {
              const source = io.input('previous'),
                target = io.output('target');
              if (!pipeline) {
                const module = c.device.createShaderModule({
                  code: `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i]; return vec4f(p,0,1);}
@group(0) @binding(0) var previous:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 return textureLoad(previous,vec2i(at.xy),0)+vec4f(0.25,0.25,0.25,0.25);}`,
                });
                pipeline = c.device.createRenderPipeline({
                  layout: 'auto',
                  vertex: { module, entryPoint: 'vertex' },
                  fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format }] },
                });
              }
              let bindings = groups.get(source.view);
              if (!bindings)
                groups.set(
                  source.view,
                  (bindings = c.device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [{ binding: 0, resource: source.view }],
                  })),
                );
              void sampler;
              const pass = c.encoder.beginRenderPass({
                colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }],
              });
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, bindings);
              pass.draw(3);
              pass.end();
            },
          };
        },
      };
      window.t = { engine, graphs, Pixelate, Afterimage, add, graph: undefined };
    });
    const frame = async (description, tasks) => {
      await page.evaluate(
        async ([description, tasks]) => {
          const t = window.t;
          if (description === 'stack') {
            // The PostStack reference: one HDR effect that only tonemaps (a half-life too short to leave a trail).
            t.graph?.dispose();
            t.graph = t.Afterimage.attach(t.engine, { halfLife: 1e-6 });
          } else if (description !== 'keep') {
            t.graph?.dispose();
            t.graph = undefined;
            if (description) {
              const types = {};
              if (tasks.includes('add')) types.add = t.add;
              if (tasks.includes('pixelate')) types.pixelate = t.graphs.effectTask(t.Pixelate);
              t.graph = t.graphs.RenderGraph.attach(t.engine, description, { tasks: types });
            }
          }
          t.engine.render({ delta: 1 / 60 });
          await t.engine.gpu.queue.onSubmittedWorkDone();
        },
        [description, tasks ?? []],
      );
      return shot();
    };
    const at = (image, x, y) => {
      const i = 4 * (y * image.width + x);
      return [...image.data.subarray(i, i + 3)];
    };
    const differs = (a, b) => a.data.reduce((max, v, i) => Math.max(max, Math.abs(v - b.data[i])), 0);
    const scene = { name: 'scene', type: 'scene', outputs: { color: 'hdr', depth: 'depth' } };

    const plain = await frame(null);
    const captured = await frame({
      version: 1,
      tasks: [scene, { name: 'present', type: 'blit', inputs: { source: 'hdr' }, outputs: { target: 'screen' } }],
    });
    const stacked = await frame('stack');
    const diff = differs(stacked, captured);
    assert.ok(
      diff <= 2,
      `scene task then blit draws what a PostStack's HDR capture draws (largest difference ${diff})`,
    );
    assert.ok(differs(plain, await frame(null)) <= 3, 'disposing the graph gives the plain frame back');

    const red = await frame({
      version: 1,
      textures: { a: { format: 'rgba8unorm', scale: 0.5 } },
      tasks: [
        { name: 'fill', type: 'clear', params: { color: [1, 0, 0, 1] }, outputs: { target: 'a' } },
        { name: 'show', type: 'copy', inputs: { source: 'a' }, outputs: { target: 'screen' } },
      ],
    });
    assert.deepEqual(at(red, 160, 120), [255, 0, 0], 'clear and copy reach the screen');

    const feedback = {
      version: 1,
      textures: { sum: { format: 'rgba8unorm', history: true } },
      tasks: [
        { name: 'add', type: 'add', inputs: { previous: 'sum@previous' }, outputs: { target: 'sum' } },
        { name: 'show', type: 'copy', inputs: { source: 'sum' }, outputs: { target: 'screen' } },
      ],
    };
    const levels = [await frame(feedback, ['add'])];
    levels.push(await frame('keep'), await frame('keep'));
    const values = levels.map((image) => at(image, 100, 100)[0]);
    for (const [i, expected] of [64, 128, 191].entries())
      assert.ok(
        Math.abs(values[i] - expected) <= 1,
        `frame ${i + 1} of the feedback loop: ${values} (expected 64, 128, 191)`,
      );

    const pixels = await frame(
      {
        version: 1,
        tasks: [
          scene,
          { name: 'present', type: 'blit', inputs: { source: 'hdr' }, outputs: { target: 'ldr' } },
          {
            name: 'pixels',
            type: 'pixelate',
            params: { pixelSize: 16, depthEdgeStrength: 0, normalEdgeStrength: 0 },
            inputs: { source: 'ldr' },
            outputs: { target: 'screen' },
          },
        ],
      },
      ['pixelate'],
    );
    assert.ok(differs(pixels, plain) > 20, 'the pixelate effect task changed the frame');
    // Every pixel of a 16 px cell holds one colour.
    assert.deepEqual(at(pixels, 161, 113), at(pixels, 174, 126));
    await page.evaluate(() => {
      window.t.graph?.dispose();
      window.t.engine.dispose();
    });
  },
);
console.log('post render graph: ok');
