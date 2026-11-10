// MinIP in the AMR, curvilinear, tetrahedral and quality volumes against the exact grey of a hidden low block. Each
// kind holds 0.8 in a shell around a region of 0.2 that a ray through the centre crosses on a plateau (the low nodes or
// cells span several samples, so every interpolation scheme reaches 0.2 exactly). With an opaque grey classifier,
// MinIP at the centre must be grey(0.2), MIP at the centre grey(0.8), and a ray just inside the silhouette, which only
// crosses the shell, grey(0.8) in both modes. AMR puts the low region in a refined level 1 block, so the minimum comes
// from the finer level. WebGPU and the WebGL2 compatibility path.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/tetvolume.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(180000);
  try {
    const result = await browser.page.evaluate(async () => {
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { colormap } = await import('/packages/sciviz/dist/colormaps.js');
      const { createAMR, amrVolume } = await import('/packages/sciviz/dist/amr.js');
      const { curvilinearVolume } = await import('/packages/sciviz/dist/curvilinear.js');
      const { tetrahedralVolume } = await import('/packages/sciviz/dist/tetvolume.js');
      const { qualityVolume } = await import('/packages/sciviz/dist/volume-quality.js');
      const size = 96,
        mid = size / 2;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.style.cssText = `width:${size}px;height:${size}px`;
      document.body.append(canvas);
      const f = await Figure.create(canvas, { axes: false, controls: false, aspect: [1, 1, 1], limits: [-1, 1, -1, 1, -1, 1] });
      f.engine.stop();
      f.engine.camera.position = [0, 0, 4];
      f.engine.camera.target = [0, 0, 0];
      f.engine.scene.background = '#000000';
      const gpuErrors = [];
      f.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const row = async () => {
        await f.ready();
        const b = await createImageBitmap(await f.toPNG({ overlays: false })),
          c = new OffscreenCanvas(size, size),
          g = c.getContext('2d');
        g.drawImage(b, 0, 0);
        b.close();
        return g.getImageData(0, mid, size, 1).data;
      };
      const pixel = (p, x) => [...p.slice(x * 4, x * 4 + 4)];
      // Leftmost lit pixel of the centre row, then two inward: inside the silhouette, outside the low region.
      const beside = (p) => {
        for (let x = 0; x < mid; x++) if (p[x * 4] + p[x * 4 + 1] + p[x * 4 + 2] > 60) return x + 2;
        return -1;
      };
      const classifier = { range: [0, 1], colormap: 'gray', opacity: [[0, 1], [1, 1]], shading: false };
      // Nodes at -1, -0.75, ..., 1 on each axis; the 5^3 nodes with every |coordinate| <= 0.5 hold 0.2.
      const n = 9,
        at = (i) => -1 + (2 * i) / (n - 1),
        low = (i, j, k) => [i, j, k].every((v) => Math.abs(at(v)) <= 0.5 + 1e-9);
      const nodes = new Float32Array(n ** 3),
        points = [];
      for (let k = 0; k < n; k++)
        for (let j = 0; j < n; j++)
          for (let i = 0; i < n; i++) {
            nodes[(k * n + j) * n + i] = low(i, j, k) ? 0.2 : 0.8;
            points.push(at(i), at(j), at(k));
          }
      const measure = async (source) => {
        const out = {};
        for (const mode of ['minip', 'mip']) {
          source.mode = mode;
          const p = await row(),
            x = beside(p);
          out[mode] = { centre: pixel(p, mid), beside: x < 0 ? null : pixel(p, x), x };
        }
        return out;
      };
      const report = {};
      // AMR: a coarse 8^3 level 0 of 0.8 and a refined level 1 over [-0.5, 0.5]^3 whose central 4^3 cells hold 0.2.
      const fine = new Float32Array(512).fill(0.8);
      for (let k = 2; k < 6; k++) for (let j = 2; j < 6; j++) for (let i = 2; i < 6; i++) fine[(k * 8 + j) * 8 + i] = 0.2;
      const amr = amrVolume(
        f,
        createAMR([
          { level: 0, dims: [8, 8, 8], bounds: [-1, 1, -1, 1, -1, 1], values: new Float32Array(512).fill(0.8) },
          { level: 1, dims: [8, 8, 8], bounds: [-0.5, 0.5, -0.5, 0.5, -0.5, 0.5], values: fine },
        ]),
        { ...classifier, density: 32 },
      );
      report.amr = await measure(amr.source);
      amr.dispose();
      const curvi = curvilinearVolume(f, { dims: [n, n, n], points }, nodes, classifier);
      report.curvilinear = await measure(curvi.source);
      curvi.dispose();
      // Kuhn split of every cell into six conforming tetrahedra.
      const connectivity = [];
      const id = (i, j, k) => (k * n + j) * n + i;
      const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
      for (let k = 0; k < n - 1; k++)
        for (let j = 0; j < n - 1; j++)
          for (let i = 0; i < n - 1; i++)
            for (const p of perms) {
              let bits = 0;
              const corners = [0, ...p.map((a) => (bits |= 1 << a))];
              for (const c of corners) connectivity.push(id(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2)));
            }
      const cells = connectivity.length / 4;
      const tet = tetrahedralVolume(
        f,
        {
          points,
          connectivity,
          offsets: Array.from({ length: cells }, (_, c) => 4 * (c + 1)),
          types: new Uint8Array(cells).fill(10),
          pointData: nodes,
        },
        classifier,
      );
      report.tetrahedral = await measure(tet.source);
      tet.dispose();
      const base = f.volume(nodes, { ...classifier, dims: [n, n, n], bounds: [-1, 1, -1, 1, -1, 1] });
      const quality = qualityVolume(f, base);
      report.quality = await measure(base);
      quality.dispose();
      f.remove(base);
      const map = colormap('gray'),
        grey = (t) => map.sample(t).map((v) => Math.round(v * 255));
      f.dispose();
      canvas.remove();
      return { report, low: grey(0.2), high: grey(0.8), gpuErrors };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(result.gpuErrors, []);
    const near = (pixel, rgb, what) =>
      assert.ok(pixel && rgb.every((v, i) => Math.abs(pixel[i] - v) <= 3) && pixel[3] === 255, `${what}: ${pixel} versus ${rgb}`);
    for (const [kind, r] of Object.entries(result.report)) {
      near(r.minip.centre, result.low, `${kind} MinIP through the low region is 0.2`);
      near(r.mip.centre, result.high, `${kind} MIP through the low region is the shell value`);
      near(r.minip.beside, result.high, `${kind} MinIP beside the low region sees only the shell`);
      near(r.mip.beside, result.high, `${kind} MIP beside the low region sees only the shell`);
    }
    console.log(JSON.stringify({ compat, ...result }));
  } finally {
    await browser.close();
  }
}
