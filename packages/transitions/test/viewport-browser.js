// Generated spatial colors expose capture-addressing errors that solid full-frame images cannot.
export async function viewportChecks() {
  const { Engine } = await import('../../core/dist/extension.js');
  const { Transitions } = await import('../dist/index.js');
  const { createCustomTransition } = await import('../dist/custom.js');
  const { createMaskTransition } = await import('../dist/mask.js');
  const { fullscreen, render } = await import('../../shared/gpu.js');
  const { applyView } = await import('../../shared/view-rect.js');
  let pixels = 0;
  for (const samples of [1, 4]) {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 4;
    const engine = await Engine.create(canvas, samples === 1 ? { exactSize: true } : {});
    const device = engine.gpu;
    const underlay = engine.createScene('underlay');
    underlay.background = '#00ff00';
    const errors = [];
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const target = device.createTexture({
      size: [8, 4],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    engine.use({
      name: 'test:spatial-colors',
      setup() {},
      registerPasses(graph) {
        let pipeline;
        graph.add({
          name: 'test:spatial-colors',
          order: 5,
          execute(c) {
            pipeline ??= render(
              device,
              fullscreen +
                `
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 return vec4f(f32(u32(i.position.x)%3u)/2.0,f32(u32(i.position.y)%3u)/2.0,1,1);
}`,
              c.format,
              { multisample: c.descriptor.multisample },
            );
            const pass = c.encoder.beginRenderPass({
              colorAttachments: [
                {
                  view: c.color,
                  loadOp: 'load',
                  storeOp: 'store',
                },
              ],
            });
            pass.setPipeline(pipeline);
            applyView(pass, c);
            pass.draw(3);
            pass.end();
          },
        });
      },
    });
    let effect;
    let stacked = false;
    const frame = async (view, delta = 0) => {
      const views = stacked
        ? [{ scene: underlay, camera: engine.camera, target: { color: target }, viewport: [0, 0, 1, 1] }]
        : [];
      views.push({ scene: engine.scene, camera: engine.camera, target: { color: target }, ...view });
      engine.render({ delta, views });
      const read = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: 256 }, [8, 4]);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(read.getMappedRange()).slice();
        read.unmap();
        return bytes;
      } finally {
        read.destroy();
      }
    };
    try {
      for (const view of [
        { viewport: [0.5, 0, 0.5, 1] },
        { viewport: [0.25, 0.25, 0.5, 0.5], scissor: [0.375, 0.25, 0.25, 0.5] },
      ]) {
        stacked = !!view.scissor;
        const baseline = await frame(view);
        const [vx, vy, vw, vh] = (stacked ? [0, 0, 1, 1] : view.viewport).map((n, i) => n * (i % 2 ? 4 : 8));
        const compare = async (label, delta = 0) => {
          const actual = await frame(view, delta);
          for (let y = vy; y < vy + vh; y++)
            for (let x = vx; x < vx + vw; x++) {
              for (let ch = 0; ch < 4; ch++) {
                const at = y * 256 + x * 4 + ch;
                if (actual[at] !== baseline[at])
                  throw new Error(`${label} ${samples}x ${x},${y},${ch}: ${actual[at]} != ${baseline[at]}`);
              }
              pixels++;
            }
        };
        for (const kind of ['wipe', 'dissolve', 'radial', 'chromatic', 'custom', 'mask']) {
          effect =
            kind === 'custom'
              ? await createCustomTransition(
                  engine,
                  'fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f{return mix(sample(a,uv),sample(b,uv),p);}',
                )
              : kind === 'mask'
                ? createMaskTransition(engine, new ImageData(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1))
                : Transitions.attach(engine);
          await compare(`${kind} idle`);
          effect.start(kind === 'custom' || kind === 'mask' ? 'wipe' : kind, 1, 0);
          await compare(`${kind} start`);
          await compare(`${kind} middle`, 0.5);
          await compare(`${kind} end`, 0.5);
          effect.dispose();
          effect = undefined;
        }
      }
      if (errors.length) throw new Error(errors.join('\n'));
    } finally {
      effect?.dispose();
      target.destroy();
      engine.dispose();
    }
  }
  return { viewportPixels: pixels, viewportSamples: [1, 4] };
}
