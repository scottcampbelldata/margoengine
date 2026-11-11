// Real-GPU check that sciviz chrome leaves the scene it joined (KB6254c), natively and on the WebGL2 compatibility
// layer: a figure's axes are disposed while a second scene, holding a plugin under the axis labels' name, is active.
// From the repository root after building packages:
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sciviz/scripts/browser-root.mjs tests/scene-owner-browser.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/scene-owner.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    const report = await browser.page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Figure } = await import('/packages/sciviz/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, { backend: 'webgpu' });
      engine.stop?.();
      const figure = Figure.attach(engine, { controls: false });
      // Draws the axes now (they otherwise wait for the first layer's bounds), attaching their label renderer.
      await figure.setAxes({});
      await figure.ready();
      const name = 'margoengine-labels',
        labels = engine.scene.plugins.get(name),
        other = engine.createScene('other'),
        decoy = {
          name,
          disposed: 0,
          setup() {},
          dispose() {
            this.disposed++;
          },
        };
      engine.use(decoy, other);
      // The figure is disposed from a plugin of the other scene, so that scene is the active one while its axes go.
      engine.use({ name: 'sciviz-dispose-figure', setup() {}, dispose: () => figure.dispose() }, other);
      engine.removePlugin('sciviz-dispose-figure', other);
      const result = {
        labelsAttached: labels !== undefined,
        labelsLeft: !engine.scene.plugins.has(name),
        decoyKept: other.plugins.get(name) === decoy,
        decoyDisposed: decoy.disposed,
      };
      engine.dispose();
      return result;
    });
    console.log(JSON.stringify({ compat, ...report }));
    assert.deepEqual(errors, []);
    assert.deepEqual(report, { labelsAttached: true, labelsLeft: true, decoyKept: true, decoyDisposed: 0 });
  } finally {
    await browser.close();
  }
}
console.log('sciviz scene owner browser checks passed');
