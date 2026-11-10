import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    const result = await browser.page.evaluate(async () => {
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { cinematicVolume } = await import('/packages/sciviz/dist/cinematic.js');
      const { fusionVolume } = await import('/packages/sciviz/dist/labels.js');
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      canvas.style.cssText = 'width:64px;height:64px';
      document.body.append(canvas);
      const f = await Figure.create(canvas, {
        axes: false,
        controls: false,
        aspect: [1, 1, 1],
        limits: [0, 1, 0, 1, 0, 1],
      });
      f.engine.stop();
      f.engine.camera.position = [0, 0, 4];
      f.engine.camera.target = [0, 0, 0];
      f.engine.scene.background = '#000000';
      const gpuErrors = [];
      f.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const green = f.volume(new Float32Array(8).fill(0.5), {
        dims: [2, 2, 2],
        bounds: [0, 1, 0, 1, 0, 1],
        range: [0, 1],
        colormap: ['#00ff00', '#00ff00'],
      });
      green.visible = false;
      const plane = green.slice('y', 0.5);
      await f.ready();
      async function pixel() {
        const b = await createImageBitmap(await f.toPNG({ overlays: false }));
        const c = new OffscreenCanvas(64, 64),
          g = c.getContext('2d');
        g.drawImage(b, 0, 0);
        b.close();
        return [...g.getImageData(32, 32, 1, 1).data.slice(0, 3)];
      }
      const base = await pixel(),
        options = {
          dims: [8, 8, 8],
          bounds: [0, 1, 0, 1, 0, 1],
          range: [0, 1],
          opacity: () => 20 / 255,
          colormap: ['#ff0000', '#ff0000'],
          shading: false,
          quality: 4,
        };
      let volume = f.volume(new Float32Array(8 ** 3).fill(0.5), options);
      const ordinary = await pixel(),
        a = 1 - (1 - 20 / 255) ** 4;
      const expected = base.map((x, k) => Math.round((k === 0 ? 255 : 0) * a + x * (1 - a)));
      const cinematic = cinematicVolume(f, volume, { ambient: [1, 1, 1], light: [0, 0, 0] });
      const lit = await pixel(),
        a7 = 1 - (1 - 20 / 255) ** 3.5;
      const expected7 = base.map((x, k) => Math.round((k === 0 ? 255 : 0) * a7 + x * (1 - a7)));
      cinematic.configure({
        pathTracing: { bounces: 32, samples: 128, albedo: 1 },
        ambient: [1, 1, 1],
        light: [0, 0, 0],
      });
      for (let i = 0; i < 128; i++) f.engine.render();
      // Move geometry in front of the volume after accumulation is saturated.
      plane.position = 0;
      const afterMove = await pixel();
      volume.visible = false;
      cinematic.visible = false;
      const frontBase = await pixel();
      const resetError = Math.max(...afterMove.map((n, k) => Math.abs(n - frontBase[k])));
      cinematic.dispose();
      f.remove(volume);
      plane.position = 0.5;
      const fusion = fusionVolume(
        f,
        [
          {
            kind: 'components',
            ...options,
            data: new Float32Array(8 ** 3).fill(0.5),
            components: [{ range: [0, 1], transfer: () => [1, 0, 0, 20 / 255] }],
          },
        ],
        { quality: 4 },
      );
      const fused = await pixel();
      f.remove(fusion);
      // A volume created before the opaque scientific layer must produce the same result.
      f.remove(plane);
      volume = f.volume(new Float32Array(8 ** 3).fill(0.5), options);
      green.slice('y', 0.5);
      const insertion = await pixel();
      await f.engine.rebootDevice();
      f.engine.stop();
      await f.ready();
      const reboot = await pixel();
      f.dispose();
      return { base, ordinary, expected, lit, expected7, fused, resetError, insertion, reboot, gpuErrors };
    });
    console.log(JSON.stringify({ compat, ...result }));
    assert.deepEqual(errors, []);
    assert.deepEqual(result.gpuErrors, []);
    const error = (a, b) => Math.max(...a.map((x, k) => Math.abs(x - b[k])));
    assert.ok(error(result.ordinary, result.expected) <= 2, JSON.stringify(result));
    assert.ok(
      error(result.lit, result.expected7) <= 2 && error(result.fused, result.expected7) <= 2,
      JSON.stringify(result),
    );
    assert.equal(result.resetError, 0);
    assert.deepEqual(result.insertion, result.ordinary);
    assert.deepEqual(result.reboot, result.ordinary);
    reports.push({ compat, ...result });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch173-volume-depth.json', JSON.stringify(reports, null, 2) + '\n');
