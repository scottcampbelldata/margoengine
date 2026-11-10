import { Engine } from '@margoengine/core';
import { GPULabelLayer } from '@margoengine/labels/gpu';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { install, uninstall } from '@margoengine/webgl2-compat';
const assert = (v, m) => {
  if (!v) throw new Error(m);
};
function bounds(canvas) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
  let left = Infinity,
    right = -1,
    top = Infinity,
    bottom = -1,
    count = 0;
  for (let y = 0; y < copy.height; y++)
    for (let x = 0; x < copy.width; x++) {
      const o = (y * copy.width + x) * 4;
      if (pixels[o] > 150 && pixels[o + 1] > 150 && pixels[o + 2] > 150) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        count++;
      }
    }
  return { left, right, top, bottom, count, width: right - left + 1, height: bottom - top + 1 };
}
async function scenario(backend, compat = false) {
  if (compat) await install();
  const canvas = document.createElement('canvas');
  canvas.style.width = '400px';
  canvas.style.height = '300px';
  canvas.width = 400;
  canvas.height = 300;
  document.body.append(canvas);
  const engine = await Engine.create(canvas, {
    backend,
    fallback: webglRenderer,
    background: '#000000',
    camera: { position: [0, 0, 5], target: [0, 0, 0], near: 0.1, far: 1000 },
  });
  const errors = [];
  engine.gpu?.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  engine.gpu?.pushErrorScope('validation');
  const layer = await GPULabelLayer.create({ declutter: false });
  engine.use(layer);
  try {
    layer.setLabels([{ text: 'Margo', position: [0, 0, 0], fontSize: 32 }]);
    engine.render();
    const near = bounds(canvas);
    if (engine.gpu) {
      await engine.gpu.queue.onSubmittedWorkDone();
      const error = await engine.gpu.popErrorScope();
      if (error) throw new Error(error.message);
      engine.gpu.pushErrorScope('validation');
    }
    assert(
      near.count > 50,
      `${backend}/${compat}: missing pixels ${JSON.stringify({ near, stats: layer.stats, errors })}`,
    );
    engine.camera.position = [0, 0, 50];
    engine.render();
    const far = bounds(canvas);
    assert(
      Math.abs(near.width - far.width) <= 1 && Math.abs(near.height - far.height) <= 1,
      `distance changed pixel size ${JSON.stringify({ near, far })}`,
    );
    layer.setLabels([{ text: 'Margo', position: [0, 0, 100], fontSize: 32 }]);
    engine.render();
    assert(layer.stats.drawCalls === 0 && bounds(canvas).count === 0, 'behind-camera text remained');
    engine.camera.position = [0, 0, 5];
    layer.setLabels(
      Array.from({ length: 100000 }, (_, i) => ({
        text: 'A',
        position: [((i % 400) - 200) * 0.001, (Math.floor(i / 400) - 125) * 0.001, 0],
      })),
    );
    engine.render();
    assert(
      layer.stats.labels === 100000 && layer.stats.glyphs === 100000 && layer.stats.drawCalls === 1,
      '100k collection did not use one draw',
    );
    const batch = { ...layer.stats };
    assert(bounds(canvas).count > 0, '100k batch missing');
    const grid = await GPULabelLayer.create({ name: 'grid-labels' });
    engine.removePlugin(layer.name);
    engine.use(grid);
    grid.setLabels(Array.from({ length: 100000 }, () => ({ text: 'A', position: [0, 0, 0] })));
    engine.render();
    assert(
      grid.stats.labels === 1 &&
        grid.stats.hidden === 99999 &&
        grid.stats.comparisons === 99999 &&
        grid.stats.drawCalls === 1,
      'grid failed to declutter 100k',
    );
    const declutter = { ...grid.stats };
    engine.removePlugin(grid.name);
    engine.render();
    assert(bounds(canvas).count === 0, 'removal left pixels');
    if (engine.gpu) {
      await engine.gpu.queue.onSubmittedWorkDone();
      const error = await engine.gpu.popErrorScope();
      if (error) errors.push(error.message);
    }
    assert(errors.length === 0, errors.join('\n'));
    return { backend, compat, near, far, batch, declutter };
  } finally {
    engine.dispose();
    canvas.remove();
    if (compat) uninstall();
  }
}
window.runGPULabelTests = async () => [
  await scenario('webgpu'),
  await scenario('webgl2'),
  await scenario('webgpu', true),
];
