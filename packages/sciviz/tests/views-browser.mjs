import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
for (const compat of [false, true]) {
  const app = await openBrowser({ startPath: '/examples/sciviz-views.html', port: 'free', compat });
  const errors = [];
  app.page.on('pageerror', (e) => errors.push(e.message));
  app.page.setDefaultTimeout(120000);
  try {
    await app.page.waitForFunction(() => document.querySelector('#status').dataset.ready === 'true');
    const before = await app.page.evaluate(async () => {
      const d = await import('/examples/sciviz-views.ts');
      return d.grid.layout.figures[0].bounds;
    });
    const canvas = app.page.locator('#wind canvas').first();
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + box.width / 2 + 18, box.y + box.height / 2 + 7);
    await app.page.mouse.up();
    await app.page.waitForFunction(async (old) => {
      const d = await import('/examples/sciviz-views.ts');
      const bounds = d.grid.layout.figures.map((f) => JSON.stringify(f.bounds));
      return bounds[0] !== JSON.stringify(old) && bounds.every((v) => v === bounds[0]);
    }, before);
    await app.page.screenshot({
      path: `test-results/batch174/views-${compat ? 'webgl2' : 'native'}.png`,
      fullPage: true,
    });
    const report = await app.page.evaluate(async () => {
      const d = await import('/examples/sciviz-views.ts'),
        { linkCameras, FigureLayout, volumeSlice, VolumeQuad } = await import('/packages/sciviz/dist/views.js'),
        { decodeFigureValue } = await import('/packages/sciviz/dist/spec.js');
      const check = (v, m) => {
        if (!v) throw new Error(m);
      };
      for (const f of [...d.quad.layout.figures, ...d.grid.layout.figures]) f.engine.stop();
      const hash = async (f) => {
        const b = await createImageBitmap(await f.toPNG({ overlays: false })),
          c = new OffscreenCanvas(b.width, b.height),
          g = c.getContext('2d');
        g.drawImage(b, 0, 0);
        b.close();
        let n = 0;
        for (const v of g.getImageData(0, 0, c.width, c.height).data) n = (Math.imul(n, 31) + v) | 0;
        return n;
      };
      const { multiplyMatrices, projectPoint } = await import('/packages/math/dist/mat4.js');
      const isotropic = (f) => {
        f.render();
        const b = f.bounds,
          x = (b[0] + b[1]) / 2,
          y = (b[2] + b[3]) / 2,
          c = f.engine.canvas,
          m = multiplyMatrices(f.engine.camera.matrix, f.model),
          p = projectPoint(m, x, y, 0, c.clientWidth, c.clientHeight),
          px = projectPoint(m, x + 1, y, 0, c.clientWidth, c.clientHeight),
          py = projectPoint(m, x, y + 1, 0, c.clientWidth, c.clientHeight);
        return Math.abs(Math.hypot(px.x - p.x, px.y - p.y) / Math.hypot(py.x - p.x, py.y - p.y) - 1) < 1e-6;
      };
      check(
        d.quad.layout.figures.slice(0, 3).every(isotropic),
        'orthographic slices retain equal physical scale on both screen axes',
      );
      const resized = d.quad.layout.canvases[0],
        watched = d.quad.layout.figures[0],
        render = watched.render;
      // KB6438a: the view's observer (created before this one, so delivered first) must not render the canvases it
      // observes inside the delivery; WebKit reports that as a ResizeObserver loop. It renders on the next frame.
      let renders = 0,
        rendersAtDelivery = -1;
      watched.render = function (...args) {
        renders++;
        return render.apply(this, args);
      };
      await new Promise((resolve) => {
        const observer = new ResizeObserver(() => {
          if (resized.clientHeight === 360) {
            observer.disconnect();
            rendersAtDelivery = renders;
            requestAnimationFrame(resolve);
          }
        });
        observer.observe(resized);
        resized.style.height = '360px';
      });
      watched.render = render;
      check(rendersAtDelivery === 0, `the view rendered ${rendersAtDelivery} times inside its resize observer`);
      check(renders > 0, 'the view renders on the frame after a resize');
      check(isotropic(d.quad.layout.figures[0]), 'resize retains isotropic physical scale');
      const aborted = new AbortController(),
        firstFigure = d.quad.layout.figures[0],
        originalHeatmap = firstFigure.heatmap,
        previousCrosshair = d.quad.crosshair,
        layerCounts = d.quad.layout.figures.map((f) => f.layers.length);
      const heatmapDescriptor = Object.getOwnPropertyDescriptor(firstFigure, 'heatmap');
      Object.defineProperty(firstFigure, 'heatmap', {
        configurable: true,
        value: async function (...args) {
          const layer = await originalHeatmap.apply(this, args);
          aborted.abort();
          return layer;
        },
      });
      let cancelled = false,
        reason = '';
      try {
        await d.quad.setCrosshair([10, 20, 30], { signal: aborted.signal });
      } catch (error) {
        cancelled = error.name === 'AbortError';
        reason = error.name + ': ' + error.message;
      } finally {
        Object.defineProperty(firstFigure, 'heatmap', heatmapDescriptor);
      }
      check(
        cancelled &&
          JSON.stringify(d.quad.crosshair) === JSON.stringify(previousCrosshair) &&
          d.quad.layout.figures.every((f, i) => f.layers.length === layerCounts[i]),
        'aborted update removes unpublished slices without changing crosshair or leaking layers ' +
          JSON.stringify({
            cancelled,
            reason,
            previousCrosshair,
            current: d.quad.crosshair,
            layerCounts,
            after: d.quad.layout.figures.map((f) => f.layers.length),
          }),
      );
      check(
        await d.quad.ready().then(
          () => false,
          (e) => e.name === 'AbortError',
        ),
        'ready reports the last failed request',
      );
      const first = await Promise.all(d.quad.layout.figures.map(hash));
      await d.quad.setCrosshair([40, 60, 70]);
      const second = await Promise.all(d.quad.layout.figures.map(hash));
      check(
        first.every((v, i) => v !== second[i]),
        'all three slices and 3D planes change pixels',
      );
      check(JSON.stringify(d.quad.crosshair) === '[40,60,70]', 'physical shared crosshair');
      const spec = await d.quad.layout.figures[3].toJSON();
      const slices = await Promise.all(
        spec.resources
          .filter((r) => r.kind === 'slice')
          .map(async (r) => ({ args: r.args, state: await decodeFigureValue(r.state) })),
      );
      check(slices.length === 3, '3D view has three slice planes');
      for (const slice of slices) {
        const axis = ['x', 'y', 'z'].indexOf(slice.args[1]);
        check(
          Math.abs(
            slice.state.position -
              (d.quad.crosshair[axis] - d.t1Data.bounds[2 * axis]) /
                (d.t1Data.bounds[2 * axis + 1] - d.t1Data.bounds[2 * axis]),
          ) < 1e-12,
          '3D plane shares physical crosshair',
        );
      }
      const copy = d.quad.crosshair;
      copy[0] = 999;
      check(d.quad.crosshair[0] === 40, 'crosshair getter cannot mutate state');
      await d.quad.setCrosshair([41, 61, 71]);
      check(JSON.stringify(d.quad.crosshair) === '[42,62,72]', 'crosshair snaps to original nearest samples');
      const extracted = volumeSlice(d.t1Data, 'z', 72);
      check(extracted.data[500] === d.t1Data.data[extracted.indices[500]], 'slice values preserve original T1 voxels');
      check(
        d.grid.outputs.length === 4 && d.grid.outputs[0].some((v, i) => v !== d.grid.outputs[1][i]),
        'NOAA observed days produce distinct results',
      );
      check(
        d.grid.outputs[2].some((v) => Number.isNaN(v)) && d.grid.outputs[2].some((v) => Number.isFinite(v)),
        'pipeline parameter applies the minimum-speed filter',
      );
      check(
        d.grid.pipelines[0].toJSON().nodes[1].params.minimum === 0 &&
          d.grid.pipelines[2].toJSON().nodes[1].params.minimum === 15,
        'per-cell graph parameters remain independent',
      );
      const host = document.createElement('div');
      document.body.append(host);
      const layout = await FigureLayout.create(host, 1, {
        height: 160,
        figureOptions: () => ({ axes: false, controls: false }),
      });
      layout.figures[0].engine.stop();
      const source = d.quad.layout.figures[3],
        target = layout.figures[0];
      using links = linkCameras([source, target]);
      source.engine.camera.position = [4, 2, 3];
      source.engine.camera.fov = 43;
      links.sync(source);
      target.render();
      check(
        JSON.stringify(source.engine.camera.position) === JSON.stringify(target.engine.camera.position) &&
          target.engine.camera.fov === 43,
        'actual 3D figures share camera pose and field of view',
      );
      layout.dispose();
      host.remove();
      const dom = d.quad.layout.element;
      const pending = d.quad.setCrosshair([20, 30, 40]);
      d.quad.dispose();
      const rejected = await pending.then(
        () => false,
        (e) => e.code === 'disposed',
      );
      check(rejected && !dom.isConnected, 'disposing cancels queued slice work and removes all four figures');
      const gridDOM = d.grid.layout.element;
      d.grid.dispose();
      check(!gridDOM.isConnected, 'comparison disposal removes all cells and links');
      return { first, second, cells: 4, slices: slices.length, dims: d.t1Data.dims };
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ compat, ...report }));
  } finally {
    await app.close();
  }
}
