// Real-adapter check of the node editor (run from the repository root after building packages, under the GPU lock):
//   node scripts/gpu-lock.mjs run --owner=<id> -- node packages/shader/test/editor-check.mjs
// A browser mouse and keyboard build a surface graph in the editor: Shift+A opens the palette, typing finds a node,
// number fields take constants, dragging connects sockets. Each valid graph becomes a material on a plane that the GPU
// draws, and the canvas pixels are read back: (1, 0.5, 0.25) * 0.5, then * 1 after retyping a field (hot reload), the same
// after a node is dragged (no rebuild), and after undo. Incomplete or ill-typed edits are explained and keep the last
// valid material on screen.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/editor-check.html', port: 5287 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());
});
const pixel = async () => {
  const image = await decodePNG(await page.locator('#stage canvas').screenshot()),
    o = (Math.floor(image.height * 0.5) * image.width + Math.floor(image.width * 0.5)) * 4;
  return [...image.data.slice(o, o + 3)];
};
const near = (actual, expected, label, tolerance = 3) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${label}: ${actual} != ${expected}`,
  );
const centre = async (locator) => {
  const b = await locator.boundingBox();
  assert.ok(b, 'visible');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const status = async () => (await page.locator('#editor .status').textContent()).trim();
const render = async () => {
  const r = await page.evaluate(() => window.check.render());
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  return r.builds;
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const view = await page.locator('#editor .viewport').boundingBox();
  const addNode = async (search, dx, dy) => {
    await page.mouse.click(view.x + dx, view.y + dy); // empty canvas: focuses it and remembers the spot
    await page.keyboard.press('Shift+A');
    await page.keyboard.type(search);
    await page.keyboard.press('Enter');
  };
  const commit = (locator, value) =>
    locator
      .fill(String(value))
      .then(() => locator.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true }))));
  const drag = async (from, to) => {
    const a = await centre(from),
      b = await centre(to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 12, a.y + 6, { steps: 3 });
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
  };
  const socket = (node, kind, input) =>
    page.locator(
      `#editor [data-node="${node}"] .socket[data-socket="${kind}"]${input === undefined ? '' : `[data-input="${input}"]`}`,
    );
  const slot = (name) => page.locator(`#editor .socket[data-slot="${name}"]`);

  await addNode('constant vector', 30, 30);
  await addNode('multiply', 260, 70);
  assert.match(await status(), /incomplete/);
  const fields = page.locator('#editor [data-node="vec31"] input');
  for (const [i, v] of [1, 0.5, 0.25].entries()) await commit(fields.nth(i), v);
  await commit(page.locator('#editor [data-node="mul1"] input'), 0.5);
  await drag(socket('vec31', 'out'), socket('mul1', 'in', 0));
  assert.match(await status(), /Valid graph/);
  await drag(socket('mul1', 'out'), slot('color'));
  assert.match(await status(), /Valid graph driving color/);
  const first = await render();
  near(await pixel(), [188, 137, 99], 'vec3 (1, 0.5, 0.25) times 0.5, sRGB-encoded');

  // Hot reload: retyping the multiplier rebuilds the material from the new graph.
  await commit(page.locator('#editor [data-node="mul1"] input'), 1);
  const second = await render();
  assert.equal(second, first + 1, 'one rebuild for one edit');
  near(await pixel(), [255, 188, 137], 'times 1');

  // Dragging a node is layout only: no rebuild, same pixels.
  const head = await centre(page.locator('#editor [data-node="mul1"] .head'));
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(head.x + 20, head.y + 30, { steps: 4 });
  await page.mouse.move(head.x + 50, head.y + 60, { steps: 4 });
  await page.mouse.up();
  assert.equal(await render(), second, 'a move does not rebuild the material');
  near(await pixel(), [255, 188, 137], 'after a move');

  // Undo: the move first, then the retyped number, which rebuilds the material the way it was.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.equal(await render(), second + 1);
  near(await pixel(), [188, 137, 99], 'undo restores times 0.5');
  await page.keyboard.press('Control+y');
  assert.equal(await render(), second + 2);
  near(await pixel(), [255, 188, 137], 'redo');

  // An unwired node is explained and the last valid material stays on screen.
  await addNode('sine', 40, 200);
  const flagged = await status();
  assert.match(flagged, /connect a node to input 1 \(Value\) of sin1/);
  assert.equal(await page.locator('#editor [data-node="sin1"][data-invalid]').count(), 1);
  assert.equal(await render(), second + 2, 'an invalid graph builds nothing');
  near(await pixel(), [255, 188, 137], 'last valid material still drawn');
  await page.keyboard.press('Delete');
  assert.match(await status(), /Valid graph driving color/);

  // A vec3 into a number slot is refused by the validator with the slot named.
  await drag(socket('mul1', 'out'), slot('roughness'));
  assert.match(await status(), /roughness output must be f32/);
  assert.equal(await render(), second + 2);
  await page.keyboard.press('Control+z');
  assert.match(await status(), /Valid graph driving color/);

  const state = await page.evaluate(() => window.check.state());
  assert.equal(state.status.ok, true);
  const mul = state.graph.nodes.find((n) => n.id === 'mul1');
  assert.deepEqual(state.graph.nodes.find((n) => n.id === 'vec31').value, [1, 0.5, 0.25]);
  assert.equal(state.graph.nodes.find((n) => n.id === mul.inputs[1]).value, 1);
  assert.deepEqual(state.graph.outputs, { color: 'mul1' });
  assert.deepEqual(pageErrors, []);
  console.log('shader node editor browser check passed');
} finally {
  await context.close();
}
