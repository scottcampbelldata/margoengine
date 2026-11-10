import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-calc.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const report = await browser.page.evaluate(async () => {
      const { calcGrid, calcGridGPU } = await import('/packages/sciviz/dist/calc.js'),
        demo = await import('/examples/sciviz-calc.ts'),
        gpu = await demo.figure.renderer.compute();
      const check = (v, m) => {
          if (!v) throw new Error(m);
        },
        tetra = {
          points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
          connectivity: [0, 1, 2, 3],
          offsets: [4],
          types: [10],
          pointData: [1, 3, 4, 5],
          pointArrays: { v: [1, 0, 0, 0, 2, 0, 0, 0, 3, 1, 2, 2] },
          cellArrays: { c: [7, 8] },
        };
      const compare = async (g, op) => {
        const a = await calcGrid(g, op),
          b = await calcGridGPU(gpu, g, op);
        check(a.width === b.width && a.values.length === b.values.length, 'shape');
        let delta = 0;
        for (let i = 0; i < a.values.length; i++) {
          const d = Math.abs(a.values[i] - b.values[i]);
          check(
            Number.isFinite(d) && d <= a.floatBound[i],
            `${op.kind} ${i}: ${a.values[i]} / ${b.values[i]} delta ${d} > ${a.floatBound[i]}`,
          );
          delta = Math.max(delta, d);
        }
        return { count: a.values.length, delta };
      };
      const checks = [];
      for (const expression of [
        'vec(sin(value),cos(value),sqrt(value))',
        'mag(v)',
        'cross(v,iHat)',
        'dot(v,v)',
        'normalize(v)',
        '-2^2+2^3^2',
        '(-2)^3+pow(-2,2)',
        'vec(0^2,sqrt(0),0^0)',
        'exp(x)+log(1+value)+log2(value)',
        'atan2(y+1,x+1)+atan(value)+asin(0.5)+acos(0.5)',
        'min(value,3)+max(value,2)+floor(value/2)+ceil(value/2)+sign(-value)',
        'tan(x/3)+abs(x-2)+value%2',
      ])
        checks.push(await compare(tetra, { kind: 'expression', expression }));
      for (const kind of ['gradient', 'centers', 'connectivity', 'quality', 'pointToCell'])
        checks.push(await compare(tetra, { kind }));
      checks.push(await compare(tetra, { kind: 'cellToPoint', array: 'c' }));
      checks.push(await compare(tetra, { kind: 'elevation', low: [0, 0, 0], high: [0.5, 0, 0], range: [10, 0] }));
      const cube = {
        points: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
        connectivity: [0, 1, 2, 3, 4, 5, 6, 7],
        offsets: [8],
        types: [12],
        pointData: [0, 1, 3, 2, 4, 5, 7, 6],
      };
      const wedge = {
        points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1],
        connectivity: [0, 1, 2, 3, 4, 5],
        offsets: [6],
        types: [13],
        pointData: [0, 1, 2, 4, 5, 6],
      };
      const pyramid = {
        points: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 1],
        connectivity: [0, 1, 2, 3, 4],
        offsets: [5],
        types: [14],
        pointData: [0, 1, 3, 2, 5.5],
      };
      for (const g of [cube, wedge, pyramid])
        for (const kind of ['gradient', 'quality', 'centers']) checks.push(await compare(g, { kind }));
      const nasa = [];
      for (const kind of ['gradient', 'centers', 'connectivity', 'pointToCell', 'quality'])
        nasa.push(await compare(demo.grid, { kind }));
      const gradient = await calcGrid(demo.grid, { kind: 'gradient' });
      nasa.push(
        await compare(
          { ...demo.grid, cellArrays: { gradient: gradient.values } },
          { kind: 'expression', association: 'cell', expression: 'log(1+mag(gradient))' },
        ),
      );
      await demo.figure.ready();
      demo.figure.engine.render();
      const bitmap = await createImageBitmap(await demo.figure.toPNG({ overlays: false })),
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4)
        if (Math.max(...[0, 1, 2].map((k) => Math.abs(data[i + k] - data[k]))) > 30) lit++;
      check(lit > 100, 'NASA derived field pixels');
      demo.figure.dispose();
      return { checks, nasa, lit };
    });
    assert.deepEqual(errors, []);
    console.log(`calc ${compat ? 'WebGL2' : 'WebGPU'} ${JSON.stringify(report)}`);
  } finally {
    await browser.close();
  }
}
