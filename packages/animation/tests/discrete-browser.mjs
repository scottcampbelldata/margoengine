import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5239 }),
  errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  const result = await browser.page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { AnimationMixer, LoopOnce } = await import('/packages/animation/dist/mixer.js');
    const { BooleanKeyframeTrack, StringKeyframeTrack, createDiscreteClip } = await import(
      '/packages/animation/dist/discrete-tracks.js'
    );
    const { isCompatDevice } = await import('/packages/webgl2-compat/dist/device.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:128px;height:128px';
    document.body.append(canvas);
    const label = document.createElement('span');
    label.textContent = 'original';
    document.body.append(label);
    const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 1024,
        camera: { position: [0, 0, 5], target: [0, 0, 0], near: 0.01, far: 100 },
      }),
      device = engine.gpu;
    device.pushErrorScope('validation');
    const fox = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb');
    const b = fox.bounds,
      scale = 2 / Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    fox.root
      .setScale([scale, scale, scale])
      .setPosition([(-(b[0] + b[3]) * scale) / 2, (-(b[1] + b[4]) * scale) / 2, (-(b[2] + b[5]) * scale) / 2]);
    const copy = new OffscreenCanvas(128, 128),
      context = copy.getContext('2d', { willReadFrequently: true });
    const frame = async () => {
      engine.render({ delta: 0, culling: false });
      if (isCompatDevice(device)) await device.queue.onSubmittedWorkDone();
      context.drawImage(canvas, 0, 0, 128, 128);
      return context.getImageData(0, 0, 128, 128).data;
    };
    await waitForPipelines(async () => {
      await frame();
      await device.queue.onSubmittedWorkDone();
    });
    fox.root.visible = false;
    const background = await frame();
    fox.root.visible = true;
    const mixer = new AnimationMixer(fox),
      clip = createDiscreteClip('visible text', [
        new BooleanKeyframeTrack('visible', [0, 0.5, 1], [true, false, true]).bind(fox.root),
        new StringKeyframeTrack('textContent', [0, 0.5, 1], ['start', 'hidden', 'end']).bind(label),
      ]),
      action = mixer.clipAction(clip).setLoop(LoopOnce).play();
    action.clampWhenFinished = true;
    const rows = [];
    for (const time of [0, 0.49, 0.5, 0.99, 1]) {
      mixer.setTime(time);
      const pixels = await frame();
      let changed = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          Math.abs(pixels[i] - background[i]) +
            Math.abs(pixels[i + 1] - background[i + 1]) +
            Math.abs(pixels[i + 2] - background[i + 2]) >
          12
        )
          changed++;
      rows.push({ time, visible: fox.root.visible, text: label.textContent, draws: engine.stats.drawCalls, changed });
    }
    action.stop();
    const restored = { visible: fox.root.visible, text: label.textContent };
    mixer.dispose();
    fox.dispose();
    const validation = (await device.popErrorScope())?.message ?? null;
    engine.dispose();
    return { rows, restored, validation };
  });
  console.log(JSON.stringify(result));
  assert.equal(result.validation, null);
  assert.deepEqual(result.restored, { visible: true, text: 'original' });
  for (const row of result.rows) {
    const visible = row.time < 0.5 || row.time >= 1;
    assert.equal(row.visible, visible);
    assert.equal(row.text, row.time < 0.5 ? 'start' : row.time < 1 ? 'hidden' : 'end');
    if (visible) {
      assert.ok(row.draws > 0, JSON.stringify(row));
      assert.ok(row.changed > 25, JSON.stringify(row));
    } else {
      assert.equal(row.draws, 0);
      assert.equal(row.changed, 0);
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
