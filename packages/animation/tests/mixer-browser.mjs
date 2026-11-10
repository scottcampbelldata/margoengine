import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { skinnedStrip } from '../test/fixture.js';

const fixture = skinnedStrip({ columns: 17 });
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5237 });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  const result = await browser.page.evaluate(
    async ({ doc, buffers }) => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { parseGLTF, loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
      const { Animation } = await import('/packages/animation/dist/index.js');
      const { AnimationMixer, LoopOnce } = await import('/packages/animation/dist/mixer.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:128px;height:128px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 1024,
        camera: { position: [1, 0, 5], target: [1, 0, 0], near: 0.01, far: 30 },
      });
      const device = engine.gpu;
      device.pushErrorScope('validation');
      const model = parseGLTF(
        engine,
        doc,
        buffers.map((b) => new Uint8Array(b)),
      );
      const animation = Animation.attach(model),
        mixer = new AnimationMixer(animation);
      const action = mixer.clipAction('bend').setLoop(LoopOnce).setEffectiveWeight(0.5).play();
      action.clampWhenFinished = true;
      let checks = 0,
        worst = 0;
      for (const time of [0, 0.25, 0.5, 0.75, 1]) {
        action.reset().play();
        mixer.setTime(time);
        engine.render({ culling: false, delta: 0 });
        await device.queue.onSubmittedWorkDone();
        const p = model.primitives[0],
          size = p.vertices.byteLength;
        const readback = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(p.deformed, p.deformedOffset, readback, 0, size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const actual = new Float32Array(readback.getMappedRange());
        for (let v = 0; v < p.vertices.length; v += 20) {
          const x = p.vertices[v],
            y = p.vertices[v + 1],
            angle = (time * Math.PI) / 4;
          const expected =
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
        readback.unmap();
        readback.destroy();
      }
      mixer.dispose();
      animation.dispose();
      model.dispose();
      // Existing licensed Khronos Fox data exercises independent action clocks on an exported rig.
      const fox = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb');
      const foxAnimation = Animation.attach(fox),
        foxMixer = new AnimationMixer(foxAnimation);
      const a = foxMixer.clipAction(foxAnimation.clips[0]).play();
      const b = foxMixer.clipAction(foxAnimation.clips[1]).play();
      a.crossFadeTo(b, 1, true);
      foxMixer.update(0.5);
      engine.render({ culling: false, delta: 0 });
      await device.queue.onSubmittedWorkDone();
      const foxState = {
        weights: [a.getEffectiveWeight(), b.getEffectiveWeight()],
        times: [a.time, b.time],
        deformed: fox.primitives.every((p) => !!p.deformed),
      };
      const validation = (await device.popErrorScope())?.message ?? null;
      foxMixer.dispose();
      foxAnimation.dispose();
      fox.dispose();
      engine.dispose();
      return { checks, worst, foxState, validation };
    },
    {
      doc: fixture.doc,
      buffers: fixture.buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]),
    },
  );
  console.log(JSON.stringify(result));
  assert.equal(result.validation, null);
  assert.equal(result.checks, 17 * 2 * 3 * 5);
  assert.ok(result.worst < 1e-5, JSON.stringify(result));
  assert.deepEqual(result.foxState.weights, [0.5, 0.5]);
  assert.ok(result.foxState.times.every((t) => t > 0));
  assert.equal(result.foxState.deformed, true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
