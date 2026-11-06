// Real-browser proof of the WebGL2 preview's optional entries (from the repository root after building packages;
// check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/webgl/test/browser-check.mjs
// `/pick`: real read-pixels picks through CSS pixels, depth, faces, views and layers, with the canvas left as it was.
// Results: test-results/webgl-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/webgl/test/browser-check.html', port: 'free' }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  const picks = await page.evaluate(async () => {
    const { Engine, PbrMaterial, Camera, box } = await import('/packages/core/dist/index.js');
    const { webglRenderer } = await import('/packages/webgl/dist/index.js');
    const { webglPicking } = await import('/packages/webgl/dist/pick.js');
    const canvas = document.getElementById('gl');
    // Half the CSS size: picks take CSS pixels whatever the drawing buffer is.
    const engine = await Engine.create(canvas, {
      backend: 'webgl2',
      fallback: webglRenderer,
      exactSize: [96, 64],
      camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
    });
    const shape = box(1.6, 1.6, 1.6),
      red = new PbrMaterial({ color: [1, 0.05, 0.05], roughness: 0.6 }),
      blue = new PbrMaterial({ color: [0.05, 0.05, 1], roughness: 0.6 }),
      make = (position, material = red) =>
        engine.createMesh().setGeometry(shape).setMaterial(material).setPosition(position);
    const left = make([-1.4, 0, 0]),
      right = make([1.4, 0, 0], blue);
    const refused = await engine.pick(50, 60).then(
      () => 'resolved',
      (error) => error.code,
    );
    const plugin = webglPicking();
    engine.use(plugin);
    const gl = canvas.getContext('webgl2'),
      name = (mesh) => (mesh === left ? 'left' : mesh === right ? 'right' : mesh ? 'other' : null),
      at = async (x, y, view) => name(await engine.pick(x, y, view)),
      pixel = () => {
        const out = new Uint8Array(4);
        gl.readPixels(26, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return [...out];
      };
    const out = { refused };
    out.before = await at(52, 64);
    engine.render();
    const drawn = pixel(),
      first = await Promise.all([at(52, 64), at(140, 64), at(4, 4), at(-1, 4), at(192, 4)]);
    out.hits = first;
    out.same = pixel().join() === drawn.join();
    out.bad = await engine.pick(Number.NaN, 0).catch((error) => error.name);
    // Moved with no frame between: the pick sees the scene as it is now.
    left.setPosition([-1.4, 5, 0]);
    out.moved = await at(52, 64);
    left.setPosition([-1.4, 0, 0]);
    right.visible = false;
    out.hidden = await at(140, 64);
    right.visible = true;
    // Nearer wins, whichever draws first.
    const near = make([-1.4, 0, 2]);
    out.nearer = await at(52, 64);
    near.dispose();
    // Inside a single-sided box its back faces do not count, as in the draw; a double-sided one is hit.
    const shell = engine
      .createMesh()
      .setGeometry(box(20, 20, 20))
      .setMaterial(new PbrMaterial({ color: [0, 1, 0], doubleSided: false }));
    out.shell = await at(4, 4);
    shell.material.set({ doubleSided: true });
    out.doubleSided = await at(4, 4);
    shell.dispose();
    // Views: the point's view answers, through that view's own camera and rectangle.
    const camera = new Camera({ position: [1.4, 0, 6], target: [1.4, 0, 0], near: 0.1, far: 100 }),
      full = new Camera({ position: [-1.4, 0, 6], target: [-1.4, 0, 0], near: 0.1, far: 100 }),
      views = [
        { camera: full, viewport: [0, 0, 0.5, 1] },
        { camera, viewport: [0.5, 0, 0.5, 1] },
      ];
    engine.render({ views });
    out.views = [await at(48, 64), await at(144, 64), await at(48, 64, views[1]), await at(144, 64, views[1])];
    out.layers = await at(144, 64, { ...views[1], layers: 0 });
    engine.render();
    // The frame after a pick draws as before.
    out.again = pixel().join() === drawn.join();
    engine.removePlugin(plugin.name);
    out.removed = await engine.pick(52, 64).then(
      () => 'resolved',
      (error) => error.code,
    );
    engine.dispose();
    out.disposed = await engine.pick(52, 64).then(
      () => 'resolved',
      (error) => error.code,
    );
    return out;
  });
  assert.equal(picks.refused, 'unsupported', 'without the plugin core still refuses');
  assert.equal(picks.before, 'left', 'a pick before the first frame works');
  assert.deepEqual(picks.hits, ['left', 'right', null, null, null]);
  assert.equal(picks.same, true, 'picking leaves the canvas as it was');
  assert.equal(picks.bad, 'RangeError');
  assert.equal(picks.moved, null, 'a mesh moved away is missed with no frame between');
  assert.equal(picks.hidden, null, 'a hidden mesh is missed');
  assert.equal(picks.nearer, 'other', 'the nearer mesh wins');
  assert.equal(picks.shell, null, 'back faces of a single-sided mesh do not count');
  assert.equal(picks.doubleSided, 'other', 'back faces of a double-sided mesh do');
  assert.deepEqual(picks.views, ['left', 'right', null, 'right'], 'each view answers through its own camera');
  assert.equal(picks.layers, null, 'a view with no layers finds nothing');
  assert.equal(picks.again, true, 'the frame after a pick draws the same pixels');
  assert.equal(picks.removed, 'unsupported', 'removing the plugin gives the engine back its own pick');
  assert.equal(picks.disposed, 'disposed');
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/webgl-browser.json', `${JSON.stringify({ picks }, null, 2)}\n`);
  console.log('WebGL2 preview browser check passed');
} finally {
  await context.close();
}
