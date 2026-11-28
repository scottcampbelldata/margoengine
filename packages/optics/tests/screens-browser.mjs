// @margoengine/optics/screens on a real GPU, native WebGPU and then the WebGL2 compatibility layer, in one page:
// node scripts/run-with-timeout.mjs -- node packages/optics/tests/screens-browser.mjs (after building the packages).
// A red beam is brightest and reddest on its axis; a fringe screen is bright at its centre with cycles 0 and dark with
// cycles 0.5 (I = I0 (1 + V cos(2 pi cycles)) / 2); a plate, a spot, a lens face, a reticle and an opaque facet draw; hiding a part removes it;
// no GPU validation error escapes; and both backends give the same picture.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5241 }),
  errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  const result = await browser.page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { OpticsScreens } = await import('/packages/optics/dist/screens.js');
    const { isCompatDevice } = await import('/packages/webgl2-compat/dist/device.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const W = 160,
      H = 120;
    async function scene(backend) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${W}px;height:${H}px`;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          capacity: 64,
          camera: { position: [0, 0, 3], target: [0, 0, 0], near: 0.01, far: 100 },
        }),
        device = engine.gpu;
      engine.scene.background = '#000000';
      device.pushErrorScope('validation');
      const glow = OpticsScreens.attach(engine),
        solid = OpticsScreens.attach(engine, { blending: 'none' });
      // A beam along +x at the top: the parent's +z turned onto +x, 0.08 wide, 2.4 long.
      const beamAnchor = engine
        .createMesh()
        .setPosition([-1.2, 0.6, 0])
        .setQuaternion([0, Math.SQRT1_2, 0, Math.SQRT1_2])
        .setScale([0.08, 0.08, 2.4]);
      const beam = glow.beam(beamAnchor);
      const detector = glow.fringes(engine.createMesh().setPosition([0.8, -0.4, 0]), 0.5, { frequency: 1, markWeight: 0 });
      glow.plate(engine.createMesh().setPosition([-0.8, -0.4, 0]), 0.35, 0.3);
      glow.spot(engine.createMesh().setPosition([0, -0.4, 0]), 0.15, 0.15, { fade: 1, innerFalloff: 2 });
      // A lens face and a reticle off to the sides: their WGSL (derivatives in uniform control flow) must compile.
      glow.lens(engine.createMesh().setPosition([1.3, 0.5, 0]), 0.2, {}, { sagU: -0.002 });
      const reticle = glow.reticle(engine.createMesh().setPosition([-1.3, 0.1, 0]), 0.15, 0.12);
      reticle.set({ spotRadius: [0.03, 0.01], hueMix: 0.2 });
      solid.facet(engine.createMesh().setPosition([0, 0.1, 0]), [[-0.1, 0, 0], [0.1, 0, 0], [0, 0.15, 0]], [0, 0, 1]);
      const copy = new OffscreenCanvas(W, H),
        context = copy.getContext('2d', { willReadFrequently: true });
      const frame = async () => {
        engine.render({ delta: 0, culling: false });
        if (isCompatDevice(device)) await device.queue.onSubmittedWorkDone();
        context.drawImage(canvas, 0, 0, W, H);
        return context.getImageData(0, 0, W, H).data;
      };
      await waitForPipelines(async () => {
        await frame();
        await device.queue.onSubmittedWorkDone();
      });
      await glow.ready();
      await solid.ready();
      // Pixel of a world point on the z = 0 plane (camera 3 away, default vertical field of view read back from
      // where the parts land): find them by scanning instead, columns and rows by brightest red.
      const shown = await frame();
      const at = (p, x, y) => [...p.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
      const sum = (c) => c[0] + c[1] + c[2];
      let beamRow = 0,
        best = -1;
      for (let y = 0; y < H / 2; y++) {
        const v = sum(at(shown, W / 2, y));
        if (v > best) (best = v), (beamRow = y);
      }
      const axis = at(shown, W / 2, beamRow),
        off = at(shown, W / 2, Math.max(0, beamRow - 6));
      // The detector's centre: brightest pixel in the lower right quarter.
      let cx = 0,
        cy = 0;
      best = -1;
      for (let y = H / 2; y < H; y++)
        for (let x = W / 2; x < W; x++) {
          const v = sum(at(shown, x, y));
          if (v > best) (best = v), (cx = x), (cy = y);
        }
      const bright = sum(at(shown, cx, cy));
      detector.set({ cycles: 0.5 });
      const dark = sum(at(await frame(), cx, cy));
      detector.set({ cycles: 0 });
      beam.mesh.visible = false;
      const hidden = sum(at(await frame(), W / 2, beamRow));
      beam.mesh.visible = true;
      const final = await frame();
      const facet = sum(at(final, W / 2, Math.round(H / 2 - 0.15 * H * 0.4)));
      const lit = (() => {
        let n = 0;
        for (let i = 0; i < final.length; i += 4) if (final[i] + final[i + 1] + final[i + 2] > 30) n++;
        return n;
      })();
      const validation = (await device.popErrorScope())?.message ?? null;
      glow.dispose();
      solid.dispose();
      engine.dispose();
      canvas.remove();
      return { backend, compat: isCompatDevice(device), axis, off, bright, dark, hidden, facet, lit, validation, pixels: [...final] };
    }
    const native = await scene('webgpu');
    const { install } = await import('/packages/webgl2-compat/dist/index.js');
    await install({ force: true });
    const compat = await scene('webgl2');
    let total = 0;
    for (let i = 0; i < native.pixels.length; i++) if (i % 4 !== 3) total += Math.abs(native.pixels[i] - compat.pixels[i]);
    const meanDiff = total / ((native.pixels.length / 4) * 3);
    for (const r of [native, compat]) delete r.pixels;
    return { native, compat, meanDiff };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.native.compat, false, 'the first run is native WebGPU');
  assert.equal(result.compat.compat, true, 'the second run is the WebGL2 compatibility layer');
  for (const r of [result.native, result.compat]) {
    const name = r.backend;
    assert.equal(r.validation, null, `${name}: no validation error`);
    assert.ok(r.axis[0] > 150 && r.axis[0] > r.axis[1] && r.axis[1] > r.axis[2], `${name}: red beam axis ${r.axis}`);
    assert.ok(r.axis[0] + r.axis[1] + r.axis[2] > r.off[0] + r.off[1] + r.off[2] + 60, `${name}: Gaussian falloff`);
    assert.ok(r.hidden < 15, `${name}: a hidden beam draws nothing (${r.hidden})`);
    assert.ok(r.bright > 300 && r.dark < r.bright / 3, `${name}: fringe at cycles 0 ${r.bright}, at 0.5 ${r.dark}`);
    assert.ok(r.facet > 30, `${name}: the opaque facet draws (${r.facet})`);
    assert.ok(r.lit > 1500, `${name}: plate, spot, facet and screen draw (${r.lit} lit pixels)`);
  }
  assert.ok(result.meanDiff < 1.5, `WebGPU and WebGL2 agree (mean channel difference ${result.meanDiff})`);
  console.log('optics/screens: beams, fringes, plates, spots and facets on WebGPU and WebGL2');
} finally {
  await browser.close();
}
