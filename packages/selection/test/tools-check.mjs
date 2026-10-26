// Real-adapter check for the selection tools, run by xray.browser.mjs in its browser (node packages/selection/test/xray.browser.mjs).
// Three boxes on a real WebGPU canvas. Marquee and lasso pick the same boxes the GPU draws, pickElement agrees with the
// GPU pick on the box under the pointer, and the hover highlight outlines only that box in magenta (and clears on leave).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { decodePNG } from '../../../tests/support/png.js';

const magenta = (d, i) => d[i] > 150 && d[i + 1] < 90 && d[i + 2] > 150;
/** Magenta pixel counts in the left, middle and right thirds of the canvas screenshot. */
async function thirds(page, file) {
  const png = await page.locator('#tools').screenshot();
  if (file) await writeFile(file, png);
  const image = await decodePNG(png),
    counts = [0, 0, 0];
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      if (magenta(image.data, (y * image.width + x) * 4)) counts[Math.min(2, Math.floor((x / image.width) * 3))]++;
  return counts;
}
export async function checkTools({ page, hardware }) {
  const report = await page.evaluate(async () => {
    const { Engine, box, PbrMaterial } = await import('/packages/core/dist/extension.js'),
      { Selection, Picking, HoverHighlight, selectInRect, selectInPolygon, pickElement } = await import(
        '/packages/selection/dist/index.js'
      );
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:480px;height:320px;display:block';
    canvas.id = 'tools';
    document.body.prepend(canvas);
    const e = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 0, 10], target: [0, 0, 0], fov: 50 },
      }),
      gpuErrors = [];
    e.gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    const grey = new PbrMaterial({ color: '#7a8088', roughness: 0.8 });
    const boxes = [-3, 0, 3].map((x) => e.createMesh().setGeometry(box()).setMaterial(grey).setPosition([x, 0, 0]));
    e.render();
    const picking = Picking.attach(e),
      outline = Selection.attach(e, { name: 'hover', color: [1, 0, 1], width: 3 });
    const half = canvas.clientHeight / (2 * 10 * Math.tan((50 * Math.PI) / 360)),
      at = (x) => [canvas.clientWidth / 2 + x * half, canvas.clientHeight / 2];
    const index = (list) => list.map((m) => boxes.indexOf(m));
    const marquee = index(
        selectInRect(e, { x: 0, y: 0, width: canvas.clientWidth / 2 + 20, height: canvas.clientHeight }),
      ),
      lasso = index(
        selectInPolygon(e, [
          [canvas.clientWidth / 2 + 60, 20],
          [canvas.clientWidth - 5, 20],
          [canvas.clientWidth - 5, canvas.clientHeight - 20],
          [canvas.clientWidth / 2 + 60, canvas.clientHeight - 20],
        ]),
      );
    const centre = at(0),
      element = pickElement(e, centre[0], centre[1]),
      gpuPick = await e.pick(centre[0], centre[1]);

    const hover = HoverHighlight.attach(e, { picking, outline });
    window.hover = async (x, expect) => {
      const p = at(x),
        rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { clientX: rect.left + p[0], clientY: rect.top + p[1], pointerType: 'mouse' }),
      );
      for (let i = 0; i < 40 && boxes.indexOf(hover.mesh) !== expect; i++) {
        await new Promise((r) => setTimeout(r, 20));
        e.render();
      }
      await new Promise((r) => setTimeout(r, 50));
      e.render();
      await e.gpu.queue.onSubmittedWorkDone();
    };
    window.leave = async () => {
      canvas.dispatchEvent(new PointerEvent('pointerleave'));
      e.render();
      await e.gpu.queue.onSubmittedWorkDone();
    };
    return {
      marquee,
      lasso,
      element: element && { mesh: boxes.indexOf(element.mesh), z: element.point[2], distance: element.distance },
      gpuPick: boxes.indexOf(gpuPick),
      gpuErrors,
    };
  });
  assert.deepEqual(report.gpuErrors, []);
  assert.deepEqual(report.marquee.sort(), [0, 1], 'marquee over the left half picks the left and middle boxes');
  assert.deepEqual(report.lasso, [2], 'lasso over the right side picks the right box');
  assert.equal(report.element.mesh, 1, 'pickElement finds the middle box');
  assert.equal(report.element.mesh, report.gpuPick, 'pickElement agrees with the GPU pick');
  assert.ok(
    Math.abs(report.element.z - 0.5) < 1e-3 && Math.abs(report.element.distance - 9.5) < 1e-2,
    JSON.stringify(report.element),
  );

  await page.evaluate(() => window.hover(0, 1));
  const middle = await thirds(page, 'test-results/selection-hover.png');
  assert.ok(middle[1] > 50 && middle[0] === 0 && middle[2] === 0, `hover outlines only the middle box ${middle}`);
  await page.evaluate(() => window.hover(3, 2));
  const right = await thirds(page);
  assert.ok(right[2] > 50 && right[2] > 5 * right[1] && right[0] === 0, `hover moves to the right box ${right}`);
  await page.evaluate(() => window.leave());
  const none = await thirds(page);
  assert.deepEqual(none, [0, 0, 0], 'leaving clears the outline');

  await writeFile('test-results/selection-tools.json', JSON.stringify({ hardware, middle, right }, null, 2));
  console.log('selection tools browser check passed');
}
