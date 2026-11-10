import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { skinnedStrip } from '../test/fixture.js';
const fixture = skinnedStrip({ columns: 17 }),
  browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5238 }),
  errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  const result = await browser.page.evaluate(
    async ({ doc, buffers }) => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { parseGLTF, loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
      const { Animation, LoopPingPong } = await import('/packages/animation/dist/playback.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:128px;height:128px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          capacity: 1024,
          camera: { position: [1, 0, 5], target: [1, 0, 0], near: 0.01, far: 30 },
        }),
        device = engine.gpu;
      device.pushErrorScope('validation');
      const model = parseGLTF(
          engine,
          doc,
          buffers.map((b) => new Uint8Array(b)),
        ),
        animation = Animation.attach(model, { loopMode: LoopPingPong, repetitions: 2 });
      animation.play();
      const events = [];
      animation.on('loop', (e) => events.push(['loop', e.loopDelta]));
      animation.on('finished', () => events.push(['finished', animation.time]));
      const times = [0, 0.5, 1, 0.5, 0];
      let checks = 0,
        worst = 0;
      for (let step = 0; step < times.length; step++) {
        if (step) animation.onPreUpdate(0.5);
        engine.render({ culling: false, delta: 0 });
        await device.queue.onSubmittedWorkDone();
        const p = model.primitives[0],
          size = p.vertices.byteLength,
          read = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(p.deformed, p.deformedOffset, read, 0, size);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const actual = new Float32Array(read.getMappedRange()),
          angle = (times[step] * Math.PI) / 2;
        for (let v = 0; v < p.vertices.length; v += 20) {
          const x = p.vertices[v],
            y = p.vertices[v + 1],
            expected =
              x < 1
                ? [x, y, 0]
                : [
                    1 + (x - 1) * Math.cos(angle) - y * Math.sin(angle),
                    (x - 1) * Math.sin(angle) + y * Math.cos(angle),
                    0,
                  ];
          for (let c = 0; c < 3; c++) {
            worst = Math.max(worst, Math.abs(actual[v + c] - expected[c]));
            checks++;
          }
        }
        read.unmap();
        read.destroy();
      }
      await animation.finished;
      animation.dispose();
      model.dispose();
      const fox = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb'),
        player = Animation.attach(fox, { loopMode: LoopPingPong, repetitions: 2 });
      player.play();
      const duration = player.clips[0].duration;
      player.onPreUpdate(duration);
      const endpoint = player.time;
      engine.render({ culling: false, delta: 0 });
      await device.queue.onSubmittedWorkDone();
      const deformed = fox.primitives.every((p) => !!p.deformed);
      player.onPreUpdate(duration);
      await player.finished;
      const foxState = { duration, endpoint, final: player.time, deformed },
        validation = (await device.popErrorScope())?.message ?? null;
      player.dispose();
      fox.dispose();
      engine.dispose();
      return { checks, worst, events, foxState, validation };
    },
    {
      doc: fixture.doc,
      buffers: fixture.buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]),
    },
  );
  console.log(JSON.stringify(result));
  assert.equal(result.checks, 510);
  assert.ok(result.worst < 1e-5, JSON.stringify(result));
  assert.deepEqual(result.events, [
    ['loop', 1],
    ['finished', 0],
  ]);
  assert.equal(result.foxState.endpoint, result.foxState.duration);
  assert.equal(result.foxState.final, 0);
  assert.equal(result.foxState.deformed, true);
  assert.equal(result.validation, null);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
