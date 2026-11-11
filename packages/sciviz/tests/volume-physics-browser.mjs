// Closed-form checks of the volume ray marches (batch 132 sciviz audit, docs/known-bugs.md KB0507a-e, h):
// absorption is measured in data units against the finest voxel, density scales extinction the same way on every
// path, bounds are voxel centres, the quality wrapper accepts a colour-scale map, and the multi-volume draws with the
// camera inside its box and stops at opaque scene depth.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    const r = await browser.page.evaluate(async () => {
      const { Figure } = await import('/packages/sciviz/dist/index.js'),
        { qualityVolume } = await import('/packages/sciviz/dist/volume-quality.js'),
        { multiVolume } = await import('/packages/sciviz/dist/multivolume.js'),
        { colorScale } = await import('/packages/sciviz/dist/colormaps.js');
      const gpuErrors = [];
      async function figure(limits) {
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 96;
        canvas.style.cssText = 'width:96px;height:96px';
        document.body.append(canvas);
        const f = await Figure.create(canvas, { axes: false, controls: false, aspect: [1, 1, 1], limits });
        f.engine.stop();
        f.engine.camera.position = [0, 0, 4];
        f.engine.camera.target = [0, 0, 0];
        f.engine.scene.background = '#000000';
        f.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        return f;
      }
      async function pixels(f) {
        await f.ready();
        const b = await createImageBitmap(await f.toPNG({ overlays: false })),
          c = new OffscreenCanvas(96, 96),
          g = c.getContext('2d');
        g.drawImage(b, 0, 0);
        b.close();
        return g.getImageData(0, 0, 96, 96).data;
      }
      const centre = (p) => [...p.slice((48 * 96 + 48) * 4, (48 * 96 + 48) * 4 + 4)];
      const red = { colormap: ['#ff0000', '#ff0000'], range: [0, 1], shading: false, quality: 8 };
      // 1. A [64, 8, 64] box of cubic voxels seen along its short axis (data y is the view axis: the figure is y-up
      // with data z up) crosses 7 voxel spacings, not 63.
      const flat = await figure([0, 63, 0, 7, 0, 63]),
        n = 64 * 64 * 8,
        box = { ...red, dims: [64, 8, 64], bounds: [0, 63, 0, 7, 0, 63], opacity: () => 0.1 };
      let layer = flat.volume(new Float32Array(n).fill(0.5), box);
      const shortAxis = centre(await pixels(flat))[0];
      let q = qualityVolume(flat, layer, { emptySpaceSkipping: false, adaptive: false, jitter: false });
      const shortAxisQuality = centre(await pixels(flat))[0];
      q.dispose();
      flat.remove(layer);
      // 2. Density scales extinction on both paths: alpha = 1 - (1 - a)^(density voxels).
      layer = flat.volume(new Float32Array(n).fill(0.5), { ...box, opacity: () => 0.3, density: 0.5 });
      const dense = centre(await pixels(flat))[0];
      q = qualityVolume(flat, layer, { emptySpaceSkipping: false, adaptive: false, jitter: false });
      const denseQuality = centre(await pixels(flat))[0];
      q.dispose();
      flat.remove(layer);
      // 5. The quality wrapper binds and reads a colour-scale (rgba32float) table.
      layer = flat.volume(new Float32Array(n).fill(0.5), {
        ...box,
        colormap: colorScale(['#ff0000', '#ff0000'], { domain: [0, 1] }),
      });
      const before = gpuErrors.length;
      q = qualityVolume(flat, layer, { emptySpaceSkipping: false, adaptive: false, jitter: false });
      const scaled = centre(await pixels(flat))[0],
        scaledErrors = gpuErrors.slice(before);
      q.dispose();
      flat.remove(layer);
      // 8. Opacity 1 is infinite extinction: opaque even when density makes each step a tiny fraction of a voxel
      // (KB5700a). The log clamp used to leave alpha 1 - 1e-6^(density / quality), near 0 here.
      layer = flat.volume(new Float32Array(n).fill(0.5), { ...box, opacity: () => 1, density: 1e-4 });
      const opaque = centre(await pixels(flat));
      q = qualityVolume(flat, layer, { emptySpaceSkipping: false, adaptive: false, jitter: false });
      const opaqueQuality = centre(await pixels(flat));
      q.dispose();
      flat.remove(layer);
      flat.dispose();
      // 3. Bounds are voxel centres. The centre ray (along data y) passes data x = 1.125: 0.125 of the way from voxel
      // 1 (value 0) to voxel 2 (value 1), so MIP reads 0.125. Sampling the box coordinate as a texture coordinate read
      // texel 1.5, exactly voxel 1, and showed 0.
      const ramp = await figure([-0.75, 3, 0, 1, 0, 3]),
        values = Float32Array.from({ length: 4 * 2 * 4 }, (_, i) => (i % 4 >= 2 ? 1 : 0));
      layer = ramp.volume(values, {
        dims: [4, 2, 4],
        bounds: [0, 3, 0, 1, 0, 3],
        range: [0, 1],
        colormap: ['#000000', '#ff0000'],
        opacity: () => 1,
        mode: 'mip',
        shading: false,
      });
      const plainRamp = centre(await pixels(ramp))[0];
      q = qualityVolume(ramp, layer, { emptySpaceSkipping: false, adaptive: false, jitter: false });
      const qualityRamp = centre(await pixels(ramp))[0];
      q.dispose();
      ramp.dispose();
      // 7. Shading: the view direction of an oblique ray goes through the model matrix, not the normal matrix. A linear
      // field is lit the same along every ray, so an opaque plain volume matches the quality path pixel for pixel on a
      // box whose figure scales its axes unequally.
      const lit = await figure([0, 7, 0, 7, 0, 7]);
      layer = lit.volume(Float32Array.from({ length: 8 * 8 * 8 }, (_, i) => (i % 8) / 7), {
        dims: [8, 8, 8],
        bounds: [0, 7, 0, 1, 0, 7],
        range: [0, 1],
        colormap: ['#c0c0c0', '#c0c0c0'],
        opacity: () => 1,
        shading: true,
      });
      const at = (p) => [36, 60].flatMap((y) => [36, 60].map((x) => [...p.slice((y * 96 + x) * 4, (y * 96 + x) * 4 + 4)]));
      const plainLit = at(await pixels(lit));
      q = qualityVolume(lit, layer, { emptySpaceSkipping: false, adaptive: false, jitter: false });
      const qualityLit = at(await pixels(lit));
      q.dispose();
      lit.dispose();
      // 6. Multi-volume: inside the box it still draws; outside, rays stop at an opaque slice halfway through.
      const multi = await figure([0, 7, 0, 7, 0, 7]),
        cube = { data: new Float32Array(512).fill(0.5), dims: [8, 8, 8], colormap: ['#ff0000', '#ff0000'], range: [0, 1] };
      const mv = multiVolume(multi, [{ ...cube, opacity: () => 0.1 }], { quality: 8 });
      const outsideFull = centre(await pixels(multi))[0];
      const green = multi.volume(new Float32Array(512).fill(0.5), {
        ...cube,
        colormap: ['#00ff00', '#00ff00'],
        opacity: () => 0,
      });
      green.slice('y', 0.5);
      const clipped = centre(await pixels(multi));
      multi.remove(green);
      multi.engine.camera.position = [0, 0, 0.2];
      multi.engine.camera.target = [0, 0, -1];
      const inside = centre(await pixels(multi))[0];
      mv.dispose();
      multi.engine.camera.position = [0, 0, 4];
      multi.engine.camera.target = [0, 0, 0];
      const opaqueMulti = multiVolume(multi, [{ ...cube, opacity: () => 1 }], { quality: 8, density: 1e-4 });
      const multiOpaque = centre(await pixels(multi));
      opaqueMulti.dispose();
      const clearMulti = multiVolume(multi, [{ ...cube, opacity: () => 1 }], { quality: 8, density: 0 });
      const multiClear = centre(await pixels(multi));
      clearMulti.dispose();
      multi.dispose();
      return {
        shortAxis,
        shortAxisQuality,
        dense,
        denseQuality,
        opaque,
        opaqueQuality,
        multiOpaque,
        multiClear,
        scaled,
        scaledErrors,
        plainRamp,
        qualityRamp,
        plainLit,
        qualityLit,
        outsideFull,
        clipped,
        inside,
        gpuErrors,
      };
    });
    const a = (x) => Math.round(x * 255) / 255,
      expect = (alpha, voxels) => 255 * (1 - (1 - a(alpha)) ** voxels);
    const near = (value, expected, tolerance, what) =>
      assert.ok(Math.abs(value - expected) <= tolerance, `${what}: ${value}, expected ${expected.toFixed(1)}`);
    near(r.shortAxis, expect(0.1, 7), 4, 'figure.volume along the short axis absorbs over 7 voxels');
    near(r.shortAxisQuality, expect(0.1, 7), 4, 'qualityVolume along the short axis absorbs over 7 voxels');
    near(r.dense, expect(0.3, 3.5), 4, 'figure.volume density 0.5 halves extinction');
    near(r.denseQuality, expect(0.3, 3.5), 4, 'qualityVolume density 0.5 halves extinction');
    assert.deepEqual(r.opaque, [255, 0, 0, 255], 'figure.volume opacity 1 is opaque at density 1e-4');
    assert.deepEqual(r.opaqueQuality, [255, 0, 0, 255], 'qualityVolume opacity 1 is opaque at density 1e-4');
    assert.deepEqual(r.multiOpaque, [255, 0, 0, 255], 'multi-volume opacity 1 is opaque at density 1e-4');
    assert.deepEqual(r.multiClear.slice(0, 3), [0, 0, 0], 'multi-volume density 0 stays clear at opacity 1');
    assert.deepEqual(r.scaledErrors, [], 'the quality wrapper binds a colour-scale table');
    near(r.scaled, expect(0.1, 7), 4, 'the quality wrapper reads row 0 of a colour-scale table');
    assert.ok(r.plainRamp > 15, `figure.volume samples voxel centres (red ${r.plainRamp} at 0.125 of a 0 to 1 step)`);
    assert.ok(Math.abs(r.plainRamp - r.qualityRamp) <= 3, `matches the quality path (${r.plainRamp} vs ${r.qualityRamp})`);
    r.plainLit.forEach((p, k) => {
      assert.equal(p[3], 255, `shaded pixel ${k} is covered`);
      const d = Math.max(...p.slice(0, 3).map((v, c) => Math.abs(v - r.qualityLit[k][c])));
      assert.ok(d <= 3, `oblique shading matches the quality path at pixel ${k}: ${p} vs ${r.qualityLit[k]}`);
    });
    near(r.outsideFull, expect(0.1, 7), 4, 'multi-volume absorbs over the cube');
    near(r.clipped[0], expect(0.1, 3.5), 4, 'multi-volume rays stop at the opaque slice');
    assert.ok(r.clipped[1] > 100, 'the opaque slice shows through the front half');
    assert.ok(r.inside > 20, `multi-volume draws with the camera inside its box (red ${r.inside})`);
    assert.deepEqual(r.gpuErrors, []);
    assert.deepEqual(errors, []);
    reports.push({ compat, ...r, hardware: browser.hardware });
    console.log(`volume physics ${compat ? 'WebGL2' : 'WebGPU'}: data-unit absorption, density, voxel centres, colour scale, multi-volume depth pass`);
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-volume-physics.json', JSON.stringify(reports, null, 2));
