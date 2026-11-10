import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
await mkdir('test-results/sciviz-a11y', { recursive: true });
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-a11y.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready:'));
    const before = await browser.page.evaluate(async () => {
      const { ligo, weather, access } = await import('/examples/sciviz-a11y.ts');
      await Promise.all(access.map((a) => a.ready));
      return {
        ligo: access[0].series[0].count,
        weather: access[1].series[0].count,
        camera: [...ligo.engine.camera.position],
        selected: ligo.selection,
      };
    });
    await browser.page.locator('#strain').focus();
    await browser.page.keyboard.press('ArrowRight');
    await browser.page.keyboard.press('End');
    const focused = await browser.page.evaluate(async () => {
      const { ligo, access } = await import('/examples/sciviz-a11y.ts');
      return {
        focused: access[0].focused,
        caption: access[0].element.querySelector('caption').textContent,
        live: access[0].element.querySelector('[role=status]').textContent,
        selected: ligo.selection,
        camera: [...ligo.engine.camera.position],
        marker: [...document.querySelectorAll('span[aria-hidden=true]')].some(
          (e) => !e.hidden && e.style.borderRadius === '50%',
        ),
      };
    });
    assert.equal(focused.focused.index, before.ligo - 1);
    assert.match(focused.live, /LIGO Hanford/);
    assert.match(focused.caption, new RegExp(`of ${before.ligo}`));
    assert.equal(focused.selected, undefined);
    assert.deepEqual(focused.camera, before.camera);
    assert.equal(focused.marker, true);
    const root = browser.page.locator('[data-margo-a11y]').first();
    await root.locator(':scope > details > summary').click();
    await root.getByRole('button', { name: 'Listen to series' }).click();
    await root.getByRole('button', { name: 'Stop sound', exact: true }).click();
    await browser.page.waitForFunction(
      () => document.querySelector('[data-margo-a11y] [role=status]').textContent === 'Sonification stopped.',
    );
    const report = await browser.page.evaluate(async () => {
      const { ligo, weather, access } = await import('/examples/sciviz-a11y.ts');
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { playSonification, HIGH_CONTRAST_THEME, attachAccessibility } = await import(
        '/packages/sciviz/dist/a11y.js'
      );
      const { createCompute } = await import('/packages/compute/dist/index.js');
      let contexts = 0,
        closed = 0;
      const NativeAudio = AudioContext;
      globalThis.AudioContext = class extends NativeAudio {
        constructor(...a) {
          super(...a);
          contexts++;
        }
        async close() {
          closed++;
          return super.close();
        }
      };
      try {
        await playSonification([0, 0.5, 1], { duration: 0.08 });
      } finally {
        globalThis.AudioContext = NativeAudio;
      }
      if (contexts !== 1 || closed !== 1) throw new Error('Owned AudioContext did not close');
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      canvas.style.cssText = 'width:96px;height:96px';
      document.body.append(canvas);
      const scalar = await Figure.create(canvas, { axes: false, controls: false });
      scalar.engine.stop();
      const source = new Float64Array(64).fill(Math.PI);
      source[0] = -100;
      source[63] = 100;
      const volume = scalar.volume(source, { dims: [4, 4, 4], range: [-1, 1] });
      const read = await volume.readValues();
      if (read[1] !== Math.PI || read[0] !== -100) throw new Error('Scalar source was normalized or quantized');
      const a = attachAccessibility(scalar);
      await a.ready;
      if (a.series[0].count !== 64 || a.series[0].datum(1).value !== Math.PI)
        throw new Error('Volume table lost source values');
      a.dispose();
      const gpu = await createCompute({ device: scalar.engine.gpu });
      const input = gpu.array(new Float32Array(16).fill(0.25));
      const surface = scalar.surface(input, { nx: 4, ny: 4, range: [0, 1] });
      const values = await surface.readValues();
      if (values.length !== 16 || values[3] !== 0.25) throw new Error('GPU scalar values unavailable');
      const controller = new AbortController(),
        reason = { cancelled: true };
      controller.abort(reason);
      let exact = false;
      try {
        await surface.readValues({ signal: controller.signal });
      } catch (e) {
        exact = e === reason;
      }
      if (!exact) throw new Error('Scalar abort reason changed');
      scalar.dispose();
      input.dispose();
      gpu.dispose();
      canvas.remove();
      await ligo.setTheme(HIGH_CONTRAST_THEME);
      await weather.setTheme(HIGH_CONTRAST_THEME);
      const svg = await ligo.toSVG();
      if (!svg.includes('fill="#000000"')) throw new Error('High contrast export background differs');
      const nodes = access.map((a) => a.element);
      ligo.dispose();
      weather.dispose();
      if (nodes.some((n) => n.isConnected)) throw new Error('Figure did not own accessibility cleanup');
      return { contexts, closed, scalarCount: 64, gpuCount: 16, exactAbort: exact };
    });
    assert.deepEqual(errors, []);
    assert.equal(before.ligo, 3441);
    assert.ok(before.weather > 300);
    reports.push({ backend: compat ? 'webgl2' : 'webgpu', ...before, selected: undefined, ...report });
    console.log(JSON.stringify(reports.at(-1)));
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-a11y/results.json', JSON.stringify(reports, null, 2));
