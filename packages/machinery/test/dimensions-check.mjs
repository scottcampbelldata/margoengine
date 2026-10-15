// Real-adapter check for dimension callouts (run from the repository root after building packages): node packages/machinery/test/dimensions-check.mjs
// A green linear dimension over a box's top edge: the dimension line sits 24 CSS px above the edge and the SDF label keeps
// the same ink size at orthographic zoom 1 and 2 (the span doubles) and in perspective.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 5242 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /ValidationError|Error while parsing|Invalid .*Pipeline/.test(message.text()))
    errors.push(message.text());
});
const green = (d, i) => d[i + 1] > 120 && d[i] < 100 && d[i + 2] < 100;
try {
  await page.waitForFunction(() => window.modern);
  await page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/extension.js'),
      { Dimensions } = await import('/packages/machinery/dist/dimensions.js');
    const { CameraProjection } = await import('/packages/cameras/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:480px;height:320px;display:block';
    document.body.prepend(canvas);
    const e = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 50 },
      }),
      gpuErrors = [];
    e.gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    e.createMesh().setGeometry(box()).setScale([2, 1, 1]);
    const dims = Dimensions.attach(e, { color: [0, 1, 0], decimals: 1 });
    dims.add({ a: { point: [-1, 0.5, 0.5] }, b: { point: [1, 0.5, 0.5] } });
    const projection = new CameraProjection({ mode: 'orthographic', height: 4 });
    const pixel = (q) => {
      const m = e.camera.matrix,
        w = m[3] * q[0] + m[7] * q[1] + m[11] * q[2] + m[15];
      return [
        (((m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12]) / w) * 0.5 + 0.5) * canvas.clientWidth,
        (0.5 - ((m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13]) / w) * 0.5) * canvas.clientHeight,
      ];
    };
    window.view = async (mode, zoom) => {
      if (mode === 'orthographic' && !e.hasPlugin('cameras')) e.use(projection);
      if (mode === 'perspective' && e.hasPlugin('cameras')) e.removePlugin('cameras');
      projection.zoom = zoom;
      // Text glyphs rasterize on first use; render until the label's font is ready.
      for (let i = 0; i < 3; i++) {
        e.render();
        await e.gpu.queue.onSubmittedWorkDone();
        await new Promise((r) => setTimeout(r, 50));
      }
      return { a: pixel([-1, 0.5, 0.5]), b: pixel([1, 0.5, 0.5]), label: dims.label(dims.dimensions[0]), gpuErrors };
    };
  });
  const results = {};
  for (const [mode, zoom] of [
    ['orthographic', 1],
    ['orthographic', 2],
    ['perspective', 1],
  ]) {
    const { a, b, label, gpuErrors } = await page.evaluate(([m, z]) => window.view(m, z), [mode, zoom]);
    assert.deepEqual(gpuErrors, []);
    const png = await page.locator('canvas').screenshot(),
      image = await decodePNG(png),
      name = `${mode}-${zoom}`;
    await writeFile(`test-results/dimensions-${name}.png`, png);
    const at = (x, y) => green(image.data, (y * image.width + x) * 4);
    // Dimension line rows in the column 13 px in from the left anchor (past the extension line and arrowhead, clear of the label).
    const column = Math.round(a[0] + 13),
      rows = [];
    for (let y = 0; y < image.height; y++) if (at(column, y)) rows.push(y);
    // The lowest run of rows is the dimension line (a label wider than the span may sit above it in this column).
    let start = rows.length - 1;
    while (start > 0 && rows[start - 1] === rows[start] - 1) start--;
    const line = rows.length ? (rows[start] + rows.at(-1)) / 2 : NaN;
    // Label ink: green pixels around the midpoint above the line and its arrowheads (3.5 px half-width).
    const mid = Math.round((a[0] + b[0]) / 2),
      box = [Infinity, Infinity, -Infinity, -Infinity];
    for (let y = Math.max(0, Math.round(line - 34)); y < line - 4.5; y++)
      for (let x = mid - 40; x <= mid + 40; x++)
        if (at(x, y)) {
          box[0] = Math.min(box[0], x);
          box[1] = Math.min(box[1], y);
          box[2] = Math.max(box[2], x);
          box[3] = Math.max(box[3], y);
        }
    results[name] = {
      label,
      anchorY: +a[1].toFixed(2),
      span: +(b[0] - a[0]).toFixed(1),
      lineRows: rows,
      offset: +(a[1] - line - 0.5).toFixed(2),
      ink: { width: box[2] - box[0] + 1, height: box[3] - box[1] + 1 },
    };
    assert.ok(
      Math.abs(a[1] - (line + 0.5) - 24) <= 1.5,
      `${name}: dimension line not 24 px above the edge ${JSON.stringify(results[name])}`,
    );
    assert.ok(
      results[name].ink.width > 40 && results[name].ink.height >= 8 && results[name].ink.height <= 16,
      `${name}: label ink missing or wrong size ${JSON.stringify(results[name])}`,
    );
  }
  const [one, two, perspective] = Object.values(results);
  assert.ok(Math.abs(two.span / one.span - 2) < 0.02, 'zoom 2 doubles the span');
  for (const other of [two, perspective])
    assert.ok(
      Math.abs(other.ink.width - one.ink.width) <= 1 && Math.abs(other.ink.height - one.ink.height) <= 1,
      `label pixel size changed: ${JSON.stringify(results)}`,
    );
  assert.deepEqual(errors, []);
  await writeFile('test-results/dimensions.json', JSON.stringify({ hardware, results }, null, 2));
  console.log(JSON.stringify({ hardware: hardware.webgpu, results }, null, 2));
  console.log('dimension callouts browser check passed');
} finally {
  await browser.close();
}
