// Generated animated background scenes are stand-ins; all values are read from a real GPU.
export async function liveChecks() {
  const { Engine } = await import('../../core/dist/extension.js');
  const { LiveTransitions } = await import('../dist/live.js');
  const { webglRenderer } = await import('../../webgl2-compat/dist/preview.js');
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const glCanvas = document.createElement('canvas');
  glCanvas.width = glCanvas.height = 4;
  const fallback = await Engine.create(glCanvas, { backend: 'webgl2', fallback: webglRenderer });
  try {
    let refused = false;
    try {
      LiveTransitions.attach(fallback, fallback.scene, fallback.createScene());
    } catch (e) {
      refused = e.code === 'unsupported' && /https:/.test(e.message);
    }
    assert(refused, 'native fallback refuses live scenes with help');
  } finally {
    fallback.dispose();
  }
  let pixels = 0;
  for (const samples of [1, 4]) {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 4;
    const engine = await Engine.create(canvas, samples === 1 ? { exactSize: true } : {});
    const errors = [];
    const watch = () => engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    watch();
    engine.onError = (e) => errors.push(e.message);
    const before = engine.createScene('before'),
      after = engine.createScene('after');
    let colorA = '#ff0000',
      colorB = '#0000ff',
      updatesA = 0,
      updatesB = 0,
      timeA = 0,
      timeB = 0;
    before.use({
      name: 'animate',
      setup() {},
      onPreUpdate(d) {
        updatesA++;
        timeA += d;
        before.background = colorA;
      },
    });
    after.use({
      name: 'animate',
      setup() {},
      onPreUpdate(d) {
        updatesB++;
        timeB += d;
        after.background = colorB;
      },
    });
    const effect = LiveTransitions.attach(engine, before, after);
    effect.start(1);
    let target;
    const allocate = (width, height) => {
      target?.destroy();
      target = engine.gpu.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    };
    const frame = async (delta, expected) => {
      const a = updatesA,
        b = updatesB;
      effect.render({ delta, target });
      assert(updatesA === a + 1 && updatesB === b + 1, 'both scenes update once');
      assert(timeA === timeB, 'both scenes receive same delta');
      const read = engine.gpu.createBuffer({
        size: 256 * target.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = engine.gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: 256 }, [
          target.width,
          target.height,
        ]);
        engine.gpu.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(read.getMappedRange());
        for (let y = 0; y < target.height; y++)
          for (let x = 0; x < target.width; x++) {
            for (let ch = 0; ch < 4; ch++)
              assert(
                Math.abs(bytes[y * 256 + x * 4 + ch] - Math.round(expected[ch] * 255)) <=
                  (effect.progress === 0 || effect.progress === 1 ? 0 : 1),
                `live ${samples}x p=${effect.progress} ${x},${y},${ch}: ${bytes[y * 256 + x * 4 + ch]}`,
              );
            pixels++;
          }
        read.unmap();
      } finally {
        read.destroy();
      }
    };
    try {
      assert(engine.renderTarget.samples === samples, 'requested sample mode');
      for (const format of [
        'rgba8uint',
        'rgba8sint',
        'r32uint',
        'depth32float',
        'depth24plus-stencil8',
        ...(samples === 4 ? ['rgba32float', 'rg32float', 'r32float'] : []),
      ]) {
        const invalid = engine.gpu.createTexture({ size: [8, 4], format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        const a = updatesA,
          b = updatesB,
          progress = effect.progress;
        engine.gpu.pushErrorScope('validation');
        let refused = false;
        try {
          effect.render({ delta: 0.25, target: invalid });
        } catch (error) {
          refused = error instanceof TypeError;
        }
        const error = await engine.gpu.popErrorScope();
        invalid.destroy();
        assert(refused && !error, `reject ${format} before GPU submission: ${error?.message}`);
        assert(
          updatesA === a && updatesB === b && effect.progress === progress,
          `${format} leaves both sources and progress unchanged`,
        );
      }
      // Already-valid float/normalized render attachments are accepted, including single-channel outputs.
      for (const format of [
        'r8unorm',
        'rg8unorm',
        'r16float',
        'rg16float',
        'rgba16float',
        'rgb10a2unorm',
        'rgba8unorm-srgb',
        'bgra8unorm',
        'bgra8unorm-srgb',
        ...(samples === 1 ? ['r32float', 'rg32float', 'rgba32float'] : []),
      ]) {
        const output = engine.gpu.createTexture({ size: [8, 4], format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        engine.gpu.pushErrorScope('validation');
        effect.render({ target: output });
        const error = await engine.gpu.popErrorScope();
        output.destroy();
        assert(!error, `${samples}x output ${format}: ${error?.message}`);
      }
      allocate(8, 4);
      await frame(0, [1, 0, 0, 1]);
      await frame(0.25, [0.75, 0, 0.25, 1]);
      colorA = '#00ff00';
      colorB = '#ff0000';
      await frame(0, [0.25, 0.75, 0, 1]); // Both source images changed at fixed progress.
      allocate(7, 3);
      await frame(0.25, [0.5, 0.5, 0, 1]);
      assert(effect.progress === 0.5, 'resize preserves progress');
      const old = engine.gpu;
      old.destroy();
      await old.lost;
      await engine.rebootDevice();
      watch();
      assert(engine.gpu !== old, 'real device replaced');
      allocate(5, 7);
      await frame(0, [0.5, 0.5, 0, 1]);
      assert(effect.progress === 0.5, 'device replacement retains live progress');
      await frame(0.5, [1, 0, 0, 1]);
      // The canvas path also draws; caller-owned exact-size canvases can resize between frames.
      canvas.width = 9;
      canvas.height = 5;
      effect.render();
      effect.dispose();
      effect.dispose();
      assert(engine.scenes.size === 3, 'only owned composite scene removed');
      engine.render({ views: [{ scene: before, camera: engine.camera, viewport: [0, 0, 1, 1] }] });
      const ownedByEngine = LiveTransitions.attach(engine, before, after);
      ownedByEngine.start();
      ownedByEngine.render({ delta: 0.1, target });
      engine.dispose();
      let disposed = false;
      try {
        ownedByEngine.render();
      } catch (e) {
        disposed = e.code === 'disposed';
      }
      assert(disposed, 'engine disposal releases its live transition');
      assert(errors.length === 0, errors.join('\n'));
    } finally {
      effect.dispose();
      target?.destroy();
      engine.dispose();
    }
  }
  return { livePixels: pixels, liveSamples: [1, 4], liveFallback: 'unsupported', liveRestoration: true };
}
