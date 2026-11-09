import test from 'node:test';
import assert from 'node:assert/strict';
import { DOF } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

test('temporal DOF on the full compatibility device uses independent pixel and tile kernels', async () => {
  const h = gpuHarness();
  h.engine.gpu.adapterInfo = { vendor: 'margo-webgl2' };
  const dof = DOF.attach(h.engine, { focalDistance: 5, temporal: true });
  try {
    for (let i = 0; i < 50 && h.counts.compute === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      h.frame();
    }
    assert.ok(h.counts.compute > 0);
    const halves = h.pipelines.filter((p) => p.compute?.module.code.includes('var halfScene:'));
    const active = halves.at(-1).compute.module.code;
    assert.ok(!active.includes('workgroupBarrier') && !active.includes('var<workgroup>'));
    assert.ok(active.includes('color*0.25') && active.includes('c.x*0.5'));
    const tileGroup = h.groups.find(
      (g) =>
        g.entries.length === 2 &&
        g.entries[0].resource.texture?.format === 'rg32float' &&
        g.entries[0].resource.texture?.width === 64,
    );
    assert.ok(tileGroup, 'tile maxima read the half CoC, not the full image');
    assert.deepEqual(
      [tileGroup.entries[1].resource.texture.width, tileGroup.entries[1].resource.texture.height],
      [8, 6],
    );
  } finally {
    dof.dispose();
  }
});
