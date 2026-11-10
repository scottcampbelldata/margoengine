import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { writeFile, mkdir } from 'node:fs/promises';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const all = [];
for (const compat of [false, true]) {
  const context = await openBrowser({ startPath: '/packages/sciviz/tests/sciviz.html', port: 'free', compat });
  const errors = [];
  context.page.on('pageerror', (error) => errors.push(error.message));
  context.page.setDefaultTimeout(90000);
  try {
    const report = await context.page.evaluate(async () => {
      const { Figure } = await import('/packages/sciviz/dist/spec.js');
      const { FilterPipeline } = await import('/packages/sciviz/dist/pipeline.js');
      const { loadNRRD, nrrdGrid } = await import('/packages/sciviz/dist/nrrd.js');
      const { Engine } = await import('/packages/core/dist/index.js');
      const canvas = () => {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 240;
        c.style.cssText = 'width:320px;height:240px';
        document.body.append(c);
        return c;
      };
      const capture = async (fig) => {
        await fig.ready();
        fig.engine.stop();
        fig.engine.render();
        const bitmap = await createImageBitmap(await fig.toPNG({ overlays: false }));
        const c = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = c.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const compare = async (fig, name) => {
        fig.engine.stop();
        const spec = await fig.toJSON({ signal: AbortSignal.timeout(60000) });
        const before = await capture(fig);
        const target = canvas(),
          engine = await Engine.create(target, { backend: 'webgpu', exactSize: [320, 240] });
        engine.scene.background = fig.engine.scene.background;
        const copy = await Figure.fromJSON(JSON.parse(JSON.stringify(spec)), target, {
          engine,
          registry: { fixed: { kind: 'source', execute: () => 42 } },
          signal: AbortSignal.timeout(60000),
        });
        const after = await capture(copy);
        let different = 0,
          lit = 0;
        for (let i = 0; i < before.length; i++) {
          if (before[i] !== after[i]) different++;
          if (i % 4 !== 3 && before[i] > 60) lit++;
        }
        const result = { name, different, lit, layers: spec.layers.length, resources: spec.resources.length };
        copy.dispose();
        engine.dispose();
        target.remove();
        fig.dispose();
        fig.engine.canvas.remove();
        return result;
      };
      const make = async (options) => {
        const c = canvas(),
          engine = await Engine.create(c, { backend: 'webgpu', exactSize: [320, 240] });
        engine.camera.position = [2.6, 1.7, 2.9];
        engine.camera.near = 0.01;
        engine.camera.far = 100;
        return Figure.attach(engine, { axes: false, ...options });
      };
      const results = [];
      const root = await make();
      const scatter = await root.scatter({ x: [0, 1, 2], y: [2, 0, 1], z: [0, 1, 2], color: [0, 1, 2] }, { size: 7 });
      const line = await root.line({ x: [0, 1, 2], y: [0, 2, 1], z: [2, 1, 0] });
      const surface = root.surface(new Float32Array([0, 1, 0.4, 0.2, 2, 0, 1, 0, 1]), { nx: 3, ny: 3, contours: 4 });
      surface.setHeights(new Float32Array([0, 1, 0, 1, 2, 1, 0, 1, 0]));
      surface.range = [0, 3];
      await root.quiver({ x: [0, 2], y: [1, 2], z: [1, 2], u: [1, -1], v: [1, 0], w: [0, 1] });
      await root.streamlines(
        { dims: [2, 2, 2], u: new Float32Array(8).fill(1), v: new Float32Array(8).fill(0.2) },
        { seeds: 2, steps: 5 },
      );
      root.replace(scatter, await root.scatter({ x: [0, 2], y: [2, 0], z: [1, 2] }, { size: 10, color: '#ff0022' }));
      root.setSelection({
        region: { rect: [0, 0, 320, 240] },
        points: [{ layer: line, indices: new Uint32Array([0, 2]) }],
      });
      root.pipeline = new FilterPipeline({ fixed: { kind: 'source', execute: () => 42 } }).add({
        id: 'data',
        type: 'fixed',
      });
      root.annotations = [{ text: 'T1', anchor: [1, 2, 3] }];
      results.push(await compare(root, 'scatter-line-surface-quiver-streamlines-selection-pipeline'));
      const flat = await make({ mode: '2d' });
      await flat.bar({ x: [0, 1, 2], y: [1, 2, 1] });
      await flat.histogram([0, 0.1, 0.2, 1, 1.2, 1.6], { bins: 3 });
      await flat.heatmap(new Float32Array([1, 2, 3, 4]), { nx: 2, ny: 2 });
      const legendFields = new Float32Array([1, 2, 3, 4]);
      const firstNamed = await flat.heatmap(legendFields, { nx: 2, ny: 2, name: 'first field' });
      const secondNamed = await flat.heatmap(legendFields, { nx: 2, ny: 2, name: 'second field' });
      const legend = flat.legend.element;
      if (legend.hidden || getComputedStyle(legend).display === 'none') throw new Error('Two named fields need a visible legend');
      const rows = legend.querySelectorAll('[role=listitem]');
      if (rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom !== 3)
        throw new Error('Legend rows lost their three-pixel spacing');
      flat.remove(firstNamed);
      if (!legend.hidden || getComputedStyle(legend).display !== 'none' || legend.getClientRects().length !== 0)
        throw new Error('A single named field retained the stale two-row legend');
      const thirdNamed = await flat.heatmap(legendFields, { nx: 2, ny: 2, name: 'third field' });
      if (legend.hidden || getComputedStyle(legend).display === 'none' || legend.textContent !== 'second fieldthird field')
        throw new Error('Restored legend retained removed field labels');
      flat.remove(secondNamed);
      flat.remove(thirdNamed);
      flat.colorbar('viridis', [1, 4]);
      results.push(await compare(flat, 'bar-histogram-heatmap-colorbar'));
      const changed = await make();
      const gpu = await changed.renderer.compute();
      const field = gpu.array(new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]), { shape: [2, 2, 2] });
      const changedIso = await changed.isosurface(field, 0.5, { nx: 2, ny: 2, nz: 2, color: '#b5d9d3' });
      field.write(new Float32Array([0, 0, 0, 0, 1, 1, 1, 1]));
      await changedIso.update(0.5);
      results.push(await compare(changed, 'updated-GPU-isosurface-field'));
      field.dispose();
      const grid = nrrdGrid(
        await loadNRRD('/examples/assets/sciviz/head.nrrd', { signal: AbortSignal.timeout(60000) }),
      );
      const mri = await make({ aspect: [174 / 254, 1, 1] });
      const volume = mri.volume(grid.data, {
        ...grid,
        range: [0, 600],
        colormap: 'gray',
        density: 2,
        opacity: [
          [0, 0],
          [0.3, 0.03],
          [1, 0.2],
        ],
      });
      volume.clip = [{ normal: [-1, 0, 0], offset: 0.55 }];
      volume.slice('z', 0.6, { opacity: 0.8 });
      const iso = await mri.isosurface(grid.data, 300, { ...grid, color: '#b5d9d3' });
      await iso.update(350);
      iso.visible = false;
      results.push(await compare(mri, 'real-OpenNeuro-T1-volume-slice-isosurface'));
      return results;
    });
    for (const item of report) {
      assert.equal(item.different, 0, JSON.stringify(item));
      assert.ok(item.lit > 100, JSON.stringify(item));
    }
    assert.deepEqual(errors, []);
    all.push({ backend: compat ? 'webgl2-compat' : 'webgpu', report });
    console.log(JSON.stringify(all.at(-1)));
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/sciviz-spec.json', JSON.stringify(all, null, 2) + '\n');
