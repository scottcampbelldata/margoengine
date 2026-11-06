// Real-browser proof of the WebGL2 preview's optional entries (from the repository root after building packages;
// check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/webgl/test/browser-check.mjs
// `/pick`: real read-pixels picks through CSS pixels, depth, faces, views and layers, with the canvas left as it was.
// `/restore`: a really lost context comes back with the same pixels and working picks, and rebootDevice works.
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
  const restore = await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
    const { webglRenderer } = await import('/packages/webgl/dist/index.js');
    const { webglPicking } = await import('/packages/webgl/dist/pick.js');
    const { webglRestore } = await import('/packages/webgl/dist/restore.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:96px;height:64px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgl2',
      fallback: webglRenderer,
      exactSize: [96, 64],
      camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
    });
    const errors = [];
    engine.onError = (error) => errors.push(error.code ?? String(error));
    const left = engine
        .createMesh()
        .setGeometry(box(1.6, 1.6, 1.6))
        .setMaterial(new PbrMaterial({ color: [1, 0.05, 0.05], roughness: 0.6 }))
        .setPosition([-1.4, 0, 0]),
      gl = canvas.getContext('webgl2'),
      lose = gl.getExtension('WEBGL_lose_context'),
      event = (name) => new Promise((resolve) => canvas.addEventListener(name, resolve, { once: true })),
      shot = () => {
        engine.render();
        const pixels = new Uint8Array(96 * 64 * 4);
        gl.readPixels(0, 0, 96, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels.join();
      },
      out = {};
    out.refused = await engine.rebootDevice().catch((error) => error.code);
    // Without the plugin a lost context stays an error.
    let lost = event('webglcontextlost');
    lose.loseContext();
    await lost;
    try {
      engine.render();
      out.lostFrame = 'drew';
    } catch (error) {
      out.lostFrame = error.code;
    }
    engine.dispose();

    const second = document.createElement('canvas');
    second.style.cssText = 'width:96px;height:64px';
    document.body.append(second);
    const live = await Engine.create(second, {
      backend: 'webgl2',
      fallback: webglRenderer,
      exactSize: [96, 64],
      camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
    });
    live.onError = (error) => errors.push(error.code ?? String(error));
    const hud = live.createScene('hud'),
      restored = [];
    for (const [scene, name] of [
      [live.scene, 'main'],
      [hud, 'hud'],
    ])
      scene.use({
        name: 'watch',
        setup() {},
        onDeviceRestored: (engine) => restored.push([name, engine.frameGraph === scene.frameGraph]),
      });
    const mesh = live
      .createMesh()
      .setGeometry(box(1.6, 1.6, 1.6))
      .setMaterial(new PbrMaterial({ color: [1, 0.05, 0.05], roughness: 0.6 }))
      .setPosition([-1.4, 0, 0]);
    const plugin = webglRestore();
    live.use(webglPicking()).use(plugin);
    const context = second.getContext('webgl2'),
      extension = context.getExtension('WEBGL_lose_context'),
      // A macrotask later: Chromium decides whether a restore is allowed only once the event has finished dispatching.
      wait = (name) =>
        new Promise((resolve) =>
          second.addEventListener(name, () => setTimeout(resolve), { once: true }),
        ),
      image = () => {
        live.render();
        const pixels = new Uint8Array(96 * 64 * 4);
        context.readPixels(0, 0, 96, 64, context.RGBA, context.UNSIGNED_BYTE, pixels);
        return pixels.join();
      };
    const clean = image();
    out.firstPick = (await live.pick(26, 32)) === mesh;
    // A live context rebuilds in place.
    await live.rebootDevice();
    out.liveReboot = image() === clean;
    out.liveNotified = restored.length;
    out.livePick = (await live.pick(26, 32)) === mesh;
    // A real loss: frames pass quietly, new geometry waits, and everything is back after the restore.
    lost = wait('webglcontextlost');
    extension.loseContext();
    await lost;
    live.render();
    out.lostPick = await live.pick(26, 32);
    const late = live
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setMaterial(new PbrMaterial({ color: [0.05, 0.05, 1], roughness: 0.6 }))
      .setPosition([1.4, 0, 0]);
    live.render();
    const rebooting = live.rebootDevice();
    out.samePromise = live.rebootDevice() === rebooting;
    extension.restoreContext();
    await rebooting;
    out.afterLoss = [(await live.pick(26, 32)) === mesh, (await live.pick(60, 32)) === late];
    late.dispose();
    out.pixelsBack = image() === clean;
    out.notified = restored;
    out.glError = context.getError();
    // A browser that never restores: the wait ends with a coded error, and a later restore still works.
    live.removePlugin(plugin.name);
    const short = webglRestore({ timeout: 20 });
    live.use(short);
    lost = wait('webglcontextlost');
    extension.loseContext();
    await lost;
    out.timeout = await live.rebootDevice().catch((error) => error.code);
    const back = wait('webglcontextrestored');
    extension.restoreContext();
    await back;
    out.lateRestore = image() === clean;
    live.removePlugin(short.name);
    out.removed = await live.rebootDevice().catch((error) => error.code);
    live.dispose();
    out.errors = errors;
    return out;
  });
  assert.equal(restore.refused, 'unsupported', 'without the plugin rebootDevice still refuses');
  assert.equal(restore.lostFrame, 'failed', 'without the plugin a lost context stays an error');
  assert.equal(restore.firstPick, true);
  assert.equal(restore.liveReboot, true, 'a reboot on a live context keeps the pixels');
  assert.equal(restore.liveNotified, 2, 'each scene hears of the reboot');
  assert.equal(restore.livePick, true);
  assert.equal(restore.lostPick, null, 'a pick while the context is gone answers null');
  assert.equal(restore.samePromise, true, 'one recovery at a time');
  assert.deepEqual(restore.afterLoss, [true, true], 'old and new meshes pick after the restore');
  assert.equal(restore.pixelsBack, true, 'the same pixels come back');
  assert.deepEqual(restore.notified.slice(2, 4), [
    ['main', true],
    ['hud', true],
  ]);
  assert.equal(restore.glError, 0, 'the restore leaves no GL error');
  assert.equal(restore.timeout, 'timeout', 'a context that never returns ends the wait');
  assert.equal(restore.lateRestore, true, 'a restore after the time limit still works');
  assert.equal(restore.removed, 'unsupported', 'removing the plugin gives the engine back its own rebootDevice');
  assert.deepEqual(restore.errors, ['timeout'], 'the automatic recovery reports the same time limit once');
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/webgl-browser.json', `${JSON.stringify({ picks, restore }, null, 2)}\n`);
  console.log('WebGL2 preview browser check passed');
} finally {
  await context.close();
}
