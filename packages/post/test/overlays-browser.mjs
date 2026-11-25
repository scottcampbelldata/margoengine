// Ramp, Grid, DepthView and TextureOverlay on a real GPU: every blend mode against a CPU reading of the W3C formulas,
// ramp and grid pixels against their geometry, the depth view against the analytic distance, image placement and resize.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

const soft = (b, s) =>
  s <= 0.5
    ? b - (1 - 2 * s) * b * (1 - b)
    : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
const hard = (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s));
const dodge = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const BLEND = {
  normal: (b, s) => s,
  add: (b, s) => Math.min(b + s, 1),
  subtract: (b, s) => Math.max(b - s, 0),
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => hard(s, b),
  'soft-light': soft,
  'hard-light': hard,
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': dodge,
  'color-burn': (b, s) => 1 - dodge(1 - b, 1 - s),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};

await postBrowser(
  'post-overlays',
  5402,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { PostStack } = await import('/packages/post/dist/stack.js');
      const overlays = await import('/packages/post/dist/overlays.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(2, 2, 2))
        .setMaterial(new PbrMaterial({ color: '#c08040' }));
      const stack = PostStack.attach(engine, []);
      // A 2 x 1 image: red on the left, half-covered blue on the right.
      const bitmap = await createImageBitmap(
        new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 128]), 2, 1),
        { premultiplyAlpha: 'none' },
      );
      window.t = { engine, stack, overlays, bitmap };
    });
    const render = async () => {
      await page.evaluate(async () => {
        window.t.engine.render({ delta: 1 / 60 });
        await window.t.engine.gpu.queue.onSubmittedWorkDone();
      });
      return shot();
    };
    const use = async (name, options) => {
      await page.evaluate(
        ([name, options]) => {
          const t = window.t;
          if (t.effect) t.stack.removeEffect(t.effect);
          if (options?.source === 'bitmap') options.source = t.bitmap;
          t.effect = name ? new t.overlays[name](options) : undefined;
          if (name) t.stack.addEffect(t.effect);
        },
        [name, options],
      );
      return render();
    };
    const at = (image, x, y) => {
      const i = 4 * (y * image.width + x);
      return [...image.data.subarray(i, i + 3)];
    };
    const close = (got, want, tolerance, label) =>
      assert.ok(
        got.every((v, i) => Math.abs(v - want[i]) <= tolerance),
        `${label}: ${got} != ${want.map(Math.round)}`,
      );
    const grey = (v) => [v * 255, v * 255, v * 255];
    const plain = await use();

    const layer = [64, 128, 230];
    const flat = {
      stops: [
        { at: 0, color: '#4080e6' },
        { at: 1, color: '#4080e6' },
      ],
    };
    for (const [blend, f] of Object.entries(BLEND)) {
      const image = await use('Ramp', { ...flat, blend });
      for (const [x, y] of [
        [160, 120],
        [5, 5],
        [190, 90],
      ]) {
        const want = at(plain, x, y).map((v, i) => f(v / 255, layer[i] / 255) * 255);
        close(at(image, x, y), want, 2, `${blend} at ${x},${y}`);
      }
    }
    assert.deepEqual((await use('Ramp', { ...flat, opacity: 0 })).data, plain.data, 'opacity 0 is the plain frame');
    assert.deepEqual((await use('Ramp', { ...flat, enabled: false })).data, plain.data, 'disabled is the plain frame');

    const linear = await use('Ramp', { blend: 'normal' });
    for (const x of [0, 80, 239, 319]) close(at(linear, x, 40), grey((x + 0.5) / 320), 2, `linear ${x}`);
    const down = await use('Ramp', {
      blend: 'normal',
      angle: 90,
      start: [0.125, 0.5],
      end: [0.875, 0.5],
    });
    for (const y of [60, 120, 200]) close(at(down, 10, y), grey((y + 0.5) / 240), 2, `turned ${y}`);
    const radial = await use('Ramp', { blend: 'normal', type: 'radial' });
    for (const [x, y] of [
      [200, 120],
      [160, 40],
    ])
      close(at(radial, x, y), grey(Math.hypot(x + 0.5 - 160, y + 0.5 - 120) / 160), 2, 'radial');
    const mirrored = await use('Ramp', {
      blend: 'normal',
      type: 'mirrored',
      invert: true,
    });
    close(at(mirrored, 160, 10), grey(1), 3, 'mirrored middle');
    close(at(mirrored, 80, 10), at(mirrored, 239, 10), 1, 'mirrored sides');
    const masked = await use('Ramp', {
      ...flat,
      blend: 'normal',
      mask: 'depth',
      maskRange: [4.9, 5],
    });
    close(at(masked, 160, 120), at(plain, 160, 120), 1, 'near face outside the depth mask');
    close(at(masked, 5, 5), layer, 1, 'background inside the depth mask');
    const bright = await use('Ramp', {
      ...flat,
      blend: 'normal',
      mask: 'luminance',
      maskRange: [0.2, 0.21],
    });
    close(at(bright, 5, 5), at(plain, 5, 5), 1, 'dark background outside the luminance mask');
    close(at(bright, 160, 120), layer, 1, 'bright box inside the luminance mask');

    const lines = await use('Grid', {
      opacity: 1,
      cellSize: 20,
      color: '#00ff00',
    });
    close(at(lines, 40, 7), [0, 255, 0], 1, 'vertical line');
    close(at(lines, 7, 60), [0, 255, 0], 1, 'horizontal line');
    close(at(lines, 41, 7), at(plain, 41, 7), 1, 'one pixel wide');
    const dots = await use('Grid', {
      opacity: 1,
      style: 'dots',
      cellSize: 20,
      color: '#00ff00',
    });
    close(at(dots, 40, 60), [0, 255, 0], 1, 'dot');
    close(at(dots, 40, 7), at(plain, 40, 7), 1, 'no line between dots');

    // The near face is 4 from the camera; the camera looks straight at it.
    const depth = await use('DepthView', { near: 2, far: 10 });
    close(at(depth, 160, 120), grey(2 / 8), 2, 'linear depth');
    close(at(depth, 5, 5), grey(1), 0, 'empty is far');
    const inverted = await use('DepthView', { near: 2, far: 10, invert: true });
    close(at(inverted, 160, 120), grey(6 / 8), 2, 'inverted depth');
    const raw = await use('DepthView', { mode: 'raw' });
    close(at(raw, 5, 5), grey(0), 0, 'raw empty');
    assert.ok(at(raw, 160, 120)[0] > 0, 'raw near surface');

    const filled = await use('TextureOverlay', {
      source: 'bitmap',
      fit: 'fill',
    });
    close(at(filled, 20, 120), [255, 0, 0], 1, 'left of the image');
    const half = at(plain, 300, 120).map((v, i) => v + ([0, 0, 255][i] - v) * (128 / 255));
    close(at(filled, 300, 120), half, 3, 'right of the image at half coverage');
    const contained = await use('TextureOverlay', {
      source: 'bitmap',
      fit: 'contain',
      scale: 0.5,
    });
    close(at(contained, 160, 20), at(plain, 160, 20), 1, 'outside the fitted image');
    close(at(contained, 100, 120), [255, 0, 0], 1, 'inside the fitted image');
    const turned = await use('TextureOverlay', {
      source: 'bitmap',
      fit: 'contain',
      scale: 0.5,
      rotation: 180,
    });
    close(at(turned, 220, 120), [255, 0, 0], 1, 'turned half round');
    const tiled = await use('TextureOverlay', {
      source: 'bitmap',
      fit: 'none',
      scale: 20,
      repeat: true,
    });
    close(at(tiled, 130, 5), at(tiled, 170, 5), 1, 'tiles repeat every 40 pixels');
    const maskedImage = await use('TextureOverlay', {
      source: 'bitmap',
      fit: 'fill',
      mask: 'depth',
      maskRange: [4.9, 5],
    });
    close(at(maskedImage, 140, 120), at(plain, 140, 120), 1, 'masked image');

    await use('Grid', { opacity: 1, cellSize: 20 });
    await page.evaluate(async () => {
      const canvas = document.querySelector('canvas');
      canvas.style.width = '200px';
      canvas.style.height = '100px';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const small = await render();
    assert.equal(small.width, 200);
    close(at(small, 40, 7), grey(1), 0, 'resized');
    await page.evaluate(() => window.t.engine.dispose());
    console.log('post-overlays: passed');
  },
);
