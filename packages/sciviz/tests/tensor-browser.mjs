import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-tensor.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(180000);
  try {
    await browser.page.waitForFunction(
      () => document.querySelector('#ellipsoid')?.dataset.ready || document.querySelector('#ellipsoid')?.dataset.error,
    );
    assert.equal(await browser.page.locator('#ellipsoid').getAttribute('data-error'), null);
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-tensor.ts'),
        result = { fibers: demo.fiberCounts },
        check = (v, m) => {
          if (!v) throw new Error(m);
        };
      async function pixels(f) {
        await f.ready();
        f.engine.render();
        const bitmap = await createImageBitmap(await f.toPNG({ overlays: false })),
          c = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = c.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const p = ctx.getImageData(0, 0, c.width, c.height).data;
        const sum = [0, 0, 0];
        let lit = 0,
          hash = 2166136261;
        for (let i = 0; i < p.length; i += 4) {
          for (let k = 0; k < 3; k++) sum[k] += p[i + k];
          if (Math.max(...[0, 1, 2].map((k) => Math.abs(p[i + k] - p[k]))) > 25) lit++;
          hash = Math.imul(hash ^ p[i] ^ (p[i + 1] << 8) ^ (p[i + 2] << 16), 16777619);
        }
        return { lit, hash, mean: sum.map((v) => v / (p.length / 4)) };
      }
      for (const [name, f] of Object.entries(demo.figures)) result[name] = await pixels(f);
      const layer = demo.glyphs.superquadric,
        frames = await layer.eigen.frames.read();
      const draw = layer.draw.bind(layer);
      let measuredDraws = 0;
      layer.draw = (pass, context, renderer) => {
        let calls = 0;
        draw(
          {
            setPipeline: (p) => pass.setPipeline(p),
            setBindGroup: (...args) => pass.setBindGroup(...args),
            draw: (...args) => {
              calls++;
              check(args[1] === layer.ids.length, 'glyph draw includes every selected instance');
              pass.draw(...args);
            },
          },
          context,
          renderer,
        );
        check(calls === 1, 'tensor glyphs use one instanced draw');
        measuredDraws++;
      };
      let worst = 0;
      for (let i = 0; i < layer.ids.length; i++) {
        const id = layer.ids[i],
          t = Array.from(demo.field.tensors.slice(id * 6, id * 6 + 6)),
          a = [t[0], t[3], t[4], t[3], t[1], t[5], t[4], t[5], t[2]],
          scale = Math.max(...t.map(Math.abs));
        let residual = 0;
        for (let col = 0; col < 3; col++)
          for (let row = 0; row < 3; row++) {
            const v = frames.subarray(i * 16 + 4 + col * 4, i * 16 + 7 + col * 4);
            residual = Math.hypot(
              residual,
              a[row * 3] * v[0] + a[row * 3 + 1] * v[1] + a[row * 3 + 2] * v[2] - frames[i * 16 + col] * v[row],
            );
          }
        check(residual <= layer.eigen.residualBounds[i], 'GPU eigen residual exceeds its bound');
        worst = Math.max(worst, residual / scale);
        for (let col = 0; col < 3; col++)
          check(
            Math.abs(Math.hypot(...frames.subarray(i * 16 + 4 + col * 4, i * 16 + 7 + col * 4)) - 1) <= 128 * 2 ** -23,
            'GPU eigenvectors have unit length',
          );
      }
      result.relativeResidual = worst;
      result.instances = layer.ids.length;
      const { tensorSurfaceWGSL } = await import('/packages/sciviz/src/tensor-glyph.ts');
      const gpu = await demo.figures.superquadric.renderer.compute(),
        out = gpu.zeros([6, 4]);
      const kernel = gpu.kernel(
        tensorSurfaceWGSL +
          `
@group(0) @binding(0) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(1) fn main(){
result[0]=vec4f(surface(0.0,0.125,0.05,0.05,false),1.0);
result[1]=vec4f(surface(1.0,0.125,0.05,0.05,false),1.0);
result[2]=vec4f(surface(0.5,0.0,0.05,0.05,false),1.0);
result[3]=vec4f(surface(0.5,0.25,0.05,0.05,false),1.0);
result[4]=vec4f(surface(0.5,0.5,0.05,0.05,false),1.0);
result[5]=vec4f(surface(0.5,0.75,0.05,0.05,false),1.0);
}`,
      );
      try {
        kernel.run({ result: out }, { workgroups: 1 });
        const p = await out.read();
        const expected = [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
          [0, -1, 0],
          [0, 0, -1],
        ];
        for (let i = 0; i < 6; i++)
          for (let k = 0; k < 3; k++)
            check(
              p[i * 4 + k] === expected[i][k],
              'sharp superquadric poles and quarter turns must retain exact analytic symmetry',
            );
      } finally {
        kernel.dispose();
        out.dispose();
      }
      const before = await pixels(demo.figures.superquadric);
      await layer.restore();
      result.restored = await pixels(demo.figures.superquadric);
      result.before = before;
      result.measuredDraws = measuredDraws;
      const { tensorGlyphs } = await import('/packages/sciviz/dist/tensor.js');
      const empty = await tensorGlyphs(demo.figures.superquadric, { positions: [], tensors: [] });
      check(empty.ids.length === 0, 'empty glyph set');
      empty.dispose();
      layer.dispose();
      const testCanvas = document.createElement('canvas');
      testCanvas.style.width = '320px';
      testCanvas.style.height = '240px';
      document.body.append(testCanvas);
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const stressFigure = await Figure.create(testCanvas, { axes: false, controls: false });
      const positive = await tensorGlyphs(
        stressFigure,
        { positions: [0, 0, 0], tensors: [1, 2, 3, 0, 0, 0] },
        { shape: 'superquadric', color: 'fa' },
      );
      result.positive = await pixels(stressFigure);
      positive.dispose();
      const large = await tensorGlyphs(
        stressFigure,
        { positions: [0, 0, 0], tensors: [1, 2, 3, 0, 0, 0] },
        { shape: 'superquadric', color: 'fa', size: 0.4 * 2 ** 40 },
      );
      result.largeUnits = await pixels(stressFigure);
      large.dispose();
      check(
        result.positive.mean.every((v, k) => Math.abs(v - result.largeUnits.mean[k]) < 1),
        'glyph normals and lighting must be invariant to physical unit scale',
      );
      const negative = await tensorGlyphs(
        stressFigure,
        { positions: [0, 0, 0], tensors: [-1, -2, -3, 0, 0, 0] },
        { shape: 'superquadric', color: 'fa' },
      );
      result.negative = await pixels(stressFigure);
      negative.dispose();
      check(
        result.positive.mean.every((v, k) => Math.abs(v - result.negative.mean[k]) < 1),
        'signed tensors must share the geometry and FA colour of their absolute spectral tensor',
      );
      stressFigure.dispose();
      testCanvas.remove();
      for (const f of Object.values(demo.figures)) f.dispose();
      return result;
    });
    for (const name of ['ellipsoid', 'superquadric', 'tracking'])
      assert.ok(report[name].lit > 100, `${name} renders real data`);
    assert.notEqual(report.ellipsoid.hash, report.superquadric.hash);
    assert.equal(report.before.hash, report.restored.hash);
    assert.ok(report.instances > 100);
    assert.ok(report.fibers.every((n) => n > 0));
    assert.deepEqual(errors, []);
    assert.equal(await browser.page.evaluate(() => window.__margoWGSLErrors?.length ?? 0), 0);
    console.log(compat ? 'webgl2-compat' : 'webgpu', JSON.stringify(report));
  } finally {
    await browser.close();
  }
}
