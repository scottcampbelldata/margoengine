import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
for (const compat of [false, true]) {
  const app = await openBrowser({ startPath: '/examples/sciviz-annotate.html', port: 'free', compat });
  const errors = [];
  app.page.on('pageerror', (e) => errors.push(e.message));
  app.page.setDefaultTimeout(120000);
  try {
    await app.page.waitForFunction(() => document.querySelector('#status').dataset.ready === 'true');
    const before = await app.page.evaluate(async () => {
      const d = await import('/examples/sciviz-annotate.ts');
      d.ct.engine.stop();
      d.t1.engine.stop();
      d.ct.render();
      d.ctAnnotations.render();
      return d.ctAnnotations.annotations[0].points[0];
    });
    const handle = app.page.locator('#ct + svg [data-id="ruler"][data-handle="0"]');
    const box = await handle.boundingBox();
    assert.ok(box, 'visible draggable ruler handle');
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 3);
    await app.page.mouse.up();
    const after = await app.page.evaluate(async () => {
      const d = await import('/examples/sciviz-annotate.ts');
      return d.ctAnnotations.annotations[0].points[0];
    });
    assert.notDeepEqual(after, before, 'actual pointer drag edits physical handle');
    const report = await app.page.evaluate(async () => {
      const d = await import('/examples/sciviz-annotate.ts'),
        { Figure, decodeFigureValue } = await import('/packages/sciviz/dist/spec.js'),
        { annotate, annotationMeasure } = await import('/packages/sciviz/dist/annotate.js');
      const check = (v, m) => {
        if (!v) throw new Error(m);
      };
      d.ct.engine.stop();
      d.t1.engine.stop();
      d.ct.render();
      d.t1.render();
      d.ctAnnotations.render();
      d.t1Annotations.render();
      check(d.ctAnnotations.element.querySelectorAll('circle').length === 21, 'every handle is editable');
      check(
        d.ct.bounds[0] === Math.min(...d.ctData.bounds.slice(0, 2)) &&
          d.ct.bounds[1] === Math.max(...d.ctData.bounds.slice(0, 2)),
        'descending source axis fits canonical physical limits',
      );
      const original = d.ctAnnotations.annotations;
      const ruler = original.find((a) => a.kind === 'ruler');
      check(annotationMeasure(ruler) > 100, 'CT physical ruler in millimetres');
      const first = d.ctAnnotations.element.querySelector('[data-id="ruler"][data-handle="0"]');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      check(
        d.ctAnnotations.annotations[0].points[0][0] !== original[0].points[0][0],
        'keyboard handle moves in data units',
      );
      const next = d.ctAnnotations.element.querySelector('[data-id="ruler"][data-handle="0"]');
      check(
        Math.abs(Number(next.getAttribute('cx')) - Number(first.getAttribute('cx')) - 1) < 1e-6 &&
          Math.abs(Number(next.getAttribute('cy')) - Number(first.getAttribute('cy'))) < 1e-6,
        'reversed depth unprojects to the same camera plane at one CSS pixel',
      );
      check(document.activeElement?.getAttribute('data-id') === 'ruler', 'keyboard focus retained after repaint');
      d.ctAnnotations.restore(original);
      let rejected = false;
      try {
        d.ctAnnotations.restore([...original, { id: 'bad', kind: 'ruler', points: [[0, 0, 0]] }]);
      } catch {
        rejected = true;
      }
      check(rejected && d.ctAnnotations.annotations.length === original.length, 'invalid restore is atomic');
      d.ctAnnotations.add({ id: 'unsafe', kind: 'text', points: ruler.points.slice(0, 1), text: '<script>&"' });
      const svg = await d.ct.toSVG();
      check(
        svg.includes('&lt;script&gt;&amp;&quot;') && !svg.includes('data-handle='),
        'SVG escapes text and omits handles',
      );
      const image = async (overlays) => {
        const b = await createImageBitmap(await d.ct.toPNG({ overlays })),
          c = new OffscreenCanvas(b.width, b.height),
          g = c.getContext('2d');
        g.drawImage(b, 0, 0);
        b.close();
        return [...g.getImageData(0, 0, c.width, c.height).data];
      };
      const plain = await image(false),
        painted = await image(true);
      let changed = 0;
      for (let i = 0; i < plain.length; i++) if (plain[i] !== painted[i]) changed++;
      check(changed > 100, 'PNG paints annotations');
      const state = await d.ct.toJSON();
      const decoded = await decodeFigureValue(state.annotations);
      check(decoded.records.length === 11, 'portable state retains all annotation records');
      const c = document.createElement('canvas');
      c.width = 500;
      c.height = 440;
      c.style.cssText = 'width:500px;height:440px';
      document.body.append(c);
      const restored = await Figure.fromJSON(state, c);
      restored.engine.stop();
      restored.render();
      check((await restored.toSVG()).includes('&lt;script&gt;'), 'native figure restore recreates annotation renderer');
      check(
        JSON.stringify((await decodeFigureValue((await restored.toJSON()).annotations)).records) ===
          JSON.stringify(decoded.records),
        'annotation state roundtrip',
      );
      check(
        d.ctAnnotations.pickVolume(
          d.ctData,
          d.ctAnnotations.element.clientWidth / 2,
          d.ctAnnotations.element.clientHeight / 2,
          (v) => v > 100,
        ) !== null,
        'first-hit picking through displayed CT',
      );
      const ac = new AbortController(),
        blank = document.createElement('canvas');
      blank.width = 300;
      blank.height = 220;
      blank.style.cssText = 'width:300px;height:220px';
      document.body.append(blank);
      const f = await Figure.create(blank, { axes: false, controls: false });
      f.engine.stop();
      f.line([0, 1], [0, 1]);
      await f.ready();
      f.render();
      const controller = annotate(f, {
        signal: ac.signal,
        annotations: [
          {
            id: 'a',
            kind: 'line',
            points: [
              [0, 0, 0],
              [1, 1, 0],
            ],
          },
        ],
      });
      ac.abort();
      check(!controller.element.isConnected, 'abort removes overlay');
      annotate(f).dispose();
      const detached = d.t1Annotations.element;
      d.t1.dispose();
      check(!detached.isConnected, 'figure disposal removes controllers');
      f.dispose();
      restored.dispose();
      d.ct.dispose();
      return { changed, records: decoded.records.length, ctDims: d.ctData.dims, t1Dims: d.t1Data.dims };
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ compat, ...report }));
  } finally {
    await app.close();
  }
}
