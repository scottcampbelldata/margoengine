// ASCII on a real GPU: the character grid against an independent CPU reading of the plain frame, the drawn glyphs
// against that grid, colour blocks, invert, edge characters at two box angles, a CSS font, resize and passthrough.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

const RAMP = ' .:-+=*%#@';

await postBrowser(
  'post-ascii',
  5396,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { ASCII } = await import('/packages/post/dist/ascii.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      engine.stop();
      const mesh = engine
        .createMesh()
        .setGeometry(box(2.2, 2.2, 0.1))
        .setMaterial(new PbrMaterial({ color: '#f0d0a0' }));
      const effect = ASCII.attach(engine, { enabled: false });
      window.t = { engine, effect, mesh };
    });
    const frame = async (options, angle = 0) => {
      const text = await page.evaluate(
        async ([options, angle]) => {
          const t = window.t;
          Object.assign(t.effect.options, options);
          t.mesh.setRotation([0, 0, angle]);
          t.engine.render({ delta: 1 / 60 });
          await t.engine.gpu.queue.onSubmittedWorkDone();
          return t.effect.options.enabled === false ? null : t.effect.text();
        },
        [options, angle],
      );
      return { image: await shot(), rows: text?.split('\n') };
    };
    const defaults = {
      enabled: true,
      cellSize: [12, 16],
      color: '#ffffff',
      background: '#000000',
      invert: false,
      edges: false,
      intensity: 1,
    };
    const plain = (await frame({ enabled: false })).image;
    const bytes = (image, x, y) => image.data.subarray(4 * (y * 320 + x), 4 * (y * 320 + x) + 3);

    // The grid read back against the same luminance rule applied to the plain screenshot.
    const grid = await frame(defaults);
    assert.equal(grid.rows.length, 15);
    assert.ok(grid.rows.every((row) => row.length === 27));
    let wrong = 0,
      far = 0;
    const patterns = new Map();
    let patternErrors = 0;
    for (let row = 0; row < 15; row++)
      for (let column = 0; column < 27; column++) {
        let sum = 0,
          n = 0;
        const pixels = [];
        for (let y = row * 16; y < Math.min(row * 16 + 16, 240); y++)
          for (let x = column * 12; x < Math.min(column * 12 + 12, 320); x++) {
            const p = bytes(plain, x, y);
            sum += (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
            n++;
            const out = bytes(grid.image, x, y);
            assert.ok((out[0] === 0 || out[0] === 255) && out[0] === out[1] && out[1] === out[2]);
            pixels.push(out[0] ? 1 : 0);
          }
        const expected = Math.min(Math.floor((sum / n) * 10), 9),
          got = RAMP.indexOf(grid.rows[row][column]);
        if (got !== expected) wrong++;
        if (Math.abs(got - expected) > 1) far++;
        // Whole cells showing one character draw one pattern.
        if (pixels.length === 192) {
          const key = pixels.join('');
          if (!patterns.has(got)) patterns.set(got, key);
          else if (patterns.get(got) !== key) patternErrors++;
        }
      }
    assert.ok(wrong <= 4, `${wrong} cells differ from the CPU reading`);
    assert.equal(far, 0);
    assert.equal(patternErrors, 0);
    assert.ok(patterns.size >= 2, 'the scene uses several characters');
    assert.equal(new Set(patterns.values()).size, patterns.size);
    if (patterns.has(0)) assert.ok(!patterns.get(0).includes('1'), 'a space draws nothing');

    const inverted = await frame({ invert: true });
    for (let row = 0; row < 15; row++)
      for (let column = 0; column < 27; column++)
        assert.equal(RAMP.indexOf(inverted.rows[row][column]), 9 - RAMP.indexOf(grid.rows[row][column]));

    // Colour blocks: ink and paper both the cell's average colour.
    const blocks = (await frame({ invert: false, color: 'scene', background: 'scene' })).image;
    let blockErrors = 0;
    for (let row = 0; row < 15; row++)
      for (let column = 0; column < 26; column++) {
        const mean = [0, 0, 0];
        for (let y = row * 16; y < row * 16 + 16; y++)
          for (let x = column * 12; x < column * 12 + 12; x++)
            for (let c = 0; c < 3; c++) mean[c] += bytes(plain, x, y)[c] / 192;
        for (let y = row * 16; y < row * 16 + 16; y++)
          for (let x = column * 12; x < column * 12 + 12; x++)
            for (let c = 0; c < 3; c++) if (Math.abs(bytes(blocks, x, y)[c] - mean[c]) > 1.5) blockErrors++;
      }
    assert.equal(blockErrors, 0);

    // Edge characters follow the box sides: upright, then turned 45 degrees.
    const edge = { cellSize: 8, color: '#ffffff', background: '#000000', edges: true, edgeThreshold: 0.15 };
    const count = (rows, character, where = () => true) =>
      rows.reduce((n, row, y) => n + [...row].filter((c, x) => c === character && where(x - 19.5, y - 14.5)).length, 0);
    const upright = (await frame(edge)).rows;
    assert.ok(count(upright, '|') >= 10, upright.join('\n'));
    assert.ok(count(upright, '-', (x, y) => Math.abs(y) > 5) >= 10, upright.join('\n'));
    assert.equal(count(upright, '/') + count(upright, '\\') <= 8, true, upright.join('\n'));
    const turned = (await frame({}, Math.PI / 4)).rows;
    // A diamond: rising sides upper left and lower right, falling sides upper right and lower left.
    assert.ok(count(turned, '/', (x, y) => x * y > 0) >= 10, turned.join('\n'));
    assert.ok(count(turned, '\\', (x, y) => x * y < 0) >= 10, turned.join('\n'));
    assert.ok(count(turned, '/', (x, y) => x * y < 0) === 0, turned.join('\n'));
    assert.ok(count(turned, '\\', (x, y) => x * y > 0) === 0, turned.join('\n'));
    const off = await frame({ edges: false });
    assert.equal(count(off.rows, '/', (x, y) => x * y > 0) < 10, true);

    // A CSS font drawn through OffscreenCanvas, with characters outside ASCII.
    const font = await frame({ characters: ' ░▒▓█', font: 'monospace', cellSize: [12, 16] });
    assert.ok(font.rows.join('').includes('█') || font.rows.join('').includes('▓'));
    assert.ok(font.image.data.some((v, i) => i % 4 === 0 && v > 128));

    const zero = (await frame({ intensity: 0 })).image;
    assert.deepEqual(zero.data, plain.data);
    assert.deepEqual((await frame({ intensity: 1, enabled: false })).image.data, plain.data);

    // Resize: the grid follows the drawing buffer, and an aborted read rejects with the caller's reason.
    const resized = await page.evaluate(async () => {
      const t = window.t,
        canvas = document.querySelector('canvas');
      Object.assign(t.effect.options, { enabled: true, intensity: 1, cellSize: 10 });
      canvas.style.width = '160px';
      canvas.style.height = '120px';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      t.engine.render({ delta: 1 / 60 });
      const rows = (await t.effect.text()).split('\n'),
        abort = new AbortController(),
        pending = t.effect.text({ signal: abort.signal });
      abort.abort(new Error('stop'));
      const reason = await pending.then(
        () => 'resolved',
        (error) => error.message,
      );
      return { size: [canvas.width, canvas.height], rows: rows.length, columns: rows[0].length, reason };
    });
    assert.deepEqual(resized, { size: [160, 120], rows: 12, columns: 16, reason: 'stop' });
    console.log({ wrong, characters: patterns.size, upright: count(upright, '|'), rising: count(turned, '/') });
    await page.evaluate(() => {
      window.t.effect.dispose();
      window.t.engine.dispose();
    });
  },
);
