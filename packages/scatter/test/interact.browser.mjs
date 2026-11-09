// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/scatter/test/interact.browser.mjs
// @margoengine/scatter/interact bends grass away from interactors and lets it recover:
// 1. Stamp: after one frame with two interactors, every cell of the push field is the CPU's push for its centre
//    (away from the nearer-pressing interactor, amount strength * (1 - (d / radius)^2), the stronger one kept).
// 2. Recover: with the interactors gone, each frame of delta t scales every cell by exp(-3 t / recover), and a cell
//    below 1e-3 is upright (0).
// 3. Follow: a camera moved by whole cells moves the field with it; each world cell keeps its push.
// 4. Pixels: pressed grass draws differently from a plain Scatter with the same options, and once recovered the frame
//    is the plain one byte for byte.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/interact.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const call = async (name, ...args) => {
  const { field, errors } = await page.evaluate(([name, args]) => window.check[name](...args), [name, args]);
  assert.deepEqual(errors, [], name);
  return field;
};
const frame = async () => decodePNG(await page.locator('canvas').screenshot());
const differing = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};
// The field's header (origin, cells per unit, resolution) and the push the update kernel gives one cell centre.
const header = (f) => ({ origin: [f[0], f[1]], cells: f[2], n: f[3], bend: f[4] });
const f32 = Math.fround;
function push(x, z, movers, ground = 0) {
  let v = [0, 0];
  for (const m of movers) {
    const o = [x - m.position[0], z - m.position[2]],
      horizontal = Math.hypot(o[0], o[1]),
      d = Math.hypot(o[0], ground - m.position[1], o[1]);
    if (d < m.radius && horizontal > 1e-6) {
      const s = (m.strength ?? 1) * (1 - (d / m.radius) ** 2);
      if (s > Math.hypot(v[0], v[1])) v = [(o[0] / horizontal) * s, (o[1] / horizontal) * s];
    }
  }
  return Math.hypot(v[0], v[1]) < 1e-3 ? [0, 0] : v;
}

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    await page.evaluate(async () => {
      const { Engine, box } = await import('/packages/core/dist/index.js');
      const { webglRenderer } = await import('/packages/webgl2-compat/dist/preview.js');
      const { TrampledScatter } = await import('/packages/scatter/dist/interact.js');
      const fallback = await Engine.create(document.createElement('canvas'), { backend: 'webgl2', fallback: webglRenderer });
      let refused = false;
      try {
        if (fallback.backend !== 'webgl2') throw new Error('Native WebGL2 was not selected');
        try { TrampledScatter.attach(fallback, box()); }
        catch (error) { refused = error.code === 'unsupported' && error.message.includes('https://margoengine.com/errors#scatter'); }
      } finally { fallback.dispose(); }
      if (!refused) throw new Error('Native WebGL2 must refuse interaction with a coded error and help link');
    });
    await call('make', 'plain');
    const plain = await frame();
    const empty = await call('make', 'trampled');
    assert.equal(differing(await frame(), plain), 0, 'an empty field draws as plain grass');
    assert.ok(empty.slice(6).every((v) => v === 0), 'nothing pressed yet');
    const movers = [
      { position: [0.3, 0, 0.1], radius: 3 },
      { position: [-4, 0.5, 2], radius: 1.5, strength: 0.6 },
    ];
    const pressed = await call('step', 0, movers);
    const h = header(pressed);
    assert.equal(h.n, 64);
    assert.equal(h.cells, 2);
    let worst = 0,
      touched = 0;
    for (let j = 0; j < h.n; j++)
      for (let i = 0; i < h.n; i++) {
        const want = push(f32(h.origin[0] + (i + 0.5) / h.cells), f32(h.origin[1] + (j + 0.5) / h.cells), movers),
          got = [pressed[6 + (j * h.n + i) * 2], pressed[7 + (j * h.n + i) * 2]];
        worst = Math.max(worst, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
        if (got[0] || got[1]) touched++;
      }
    assert.ok(worst < 1e-5, `stamp off by ${worst}`);
    assert.ok(touched > 100, `${touched} cells pressed`);
    const bent = await frame();
    assert.ok(differing(bent, plain) > 1000, 'pressed grass draws bent');
    // Recover: 0.1 s a frame, the cells scale by exp(-0.2) each frame.
    let last = pressed;
    for (let k = 0; k < 3; k++) {
      const next = await call('step', 0.1, []),
        keep = Math.exp((-3 * 0.1) / 1.5);
      let off = 0;
      for (let c = 6; c < next.length; c += 2) {
        let want = [last[c] * keep, last[c + 1] * keep];
        if (Math.hypot(want[0], want[1]) < 1e-3) want = [0, 0];
        off = Math.max(off, Math.abs(next[c] - want[0]), Math.abs(next[c + 1] - want[1]));
      }
      assert.ok(off < 1e-5, `recovery step ${k} off by ${off}`);
      last = next;
    }
    // Follow: three cells (1.5 units) along +x and two along +z, no time passing.
    const moved = await call('step', 0, null, [
      [1.5, 9, 10],
      [1.5, 0, 1],
    ]);
    const m = header(moved);
    assert.deepEqual(m.origin, [h.origin[0] + 1.5, h.origin[1] + 1]);
    for (let j = 0; j < h.n - 2; j++)
      for (let i = 0; i < h.n - 3; i++) {
        const a = 6 + (j * h.n + i + 3 + 2 * h.n) * 2,
          b = 6 + (j * h.n + i) * 2;
        assert.equal(moved[b], last[a]);
        assert.equal(moved[b + 1], last[a + 1]);
      }
    // Recovered: back at the start, long enough for every cell to reach 0.
    await call('step', 0, null, [
      [0, 9, 9],
      [0, 0, 0],
    ]);
    let done = null;
    for (let k = 0; k < 12; k++) done = await call('step', 0.5, []);
    assert.ok(done.slice(6).every((v) => v === 0), 'every cell upright again');
    assert.equal(differing(await frame(), plain), 0, 'recovered grass draws as plain grass');
    await call('step', 0, movers);
    const teleported = await call('step', 0, [], [
      [2 ** 31, 9, 9],
      [2 ** 31, 0, 0],
    ]);
    assert.ok(teleported.slice(6).every((v) => v === 0), 'a nonoverlapping teleport clears every old push without Int32 wrap');
    // Finite GPU floats can still overflow length's squares; a huge radius must also retain direction nearby.
    for (const mover of [
      { position: [1e30, 0, 0], radius: 2e30 },
      { position: [3, 0, 0], radius: 2e38 },
    ]) {
      const extreme = await call('step', 0, [mover], [[0, 9, 9], [0, 0, 0]]);
      const e = header(extreme);
      for (let j = 0; j < e.n; j++) for (let i = 0; i < e.n; i++) {
        const want = push(e.origin[0] + (i + 0.5) / e.cells, e.origin[1] + (j + 0.5) / e.cells, [mover]);
        const at = 6 + (j * e.n + i) * 2;
        assert.ok(Math.abs(extreme[at] - want[0]) < 1e-5 && Math.abs(extreme[at + 1] - want[1]) < 1e-5,
          `finite extreme push at ${i},${j}: ${extreme[at]},${extreme[at + 1]} != ${want}`);
      }
    }
    // Heightfields: a blast whose sphere does not reach the ground must leave every cell upright.
    // Check both an explicit texture rectangle and the area/centre rectangle, including the placement Y offset.
    for (const ground of [
      { heights: [1, 3, 5, 7], bounds: [-8, -8, 8, 8], center: [0, 2, 0] },
      { heights: [1, 3, 5, 7], center: [3, 2, -5] },
    ]) {
      await call('make', 'trampled', ground);
      const airborne = await call('step', 0, [{ position: [0, 20, 0], radius: 3 }]);
      assert.ok(airborne.slice(6).every((v) => v === 0), 'airborne explosion misses terrain');
      const movers = [{ position: [0.3, 6, 0.1], radius: 4 }];
      const field = await call('step', 0, movers), h = header(field);
      const bounds = ground.bounds ?? [ground.center[0]-20,ground.center[2]-20,ground.center[0]+20,ground.center[2]+20];
      let touched = 0;
      for (let j=0;j<h.n;j++) for(let i=0;i<h.n;i++) {
        const x=f32(h.origin[0]+(i+0.5)/h.cells),z=f32(h.origin[1]+(j+0.5)/h.cells);
        const u=Math.max(0,Math.min(1,(x-bounds[0])/(bounds[2]-bounds[0])*2-0.5));
        const v=Math.max(0,Math.min(1,(z-bounds[1])/(bounds[3]-bounds[1])*2-0.5));
        const y=(1-u)*(1-v)*ground.heights[0]+u*(1-v)*ground.heights[1]+(1-u)*v*ground.heights[2]+u*v*ground.heights[3]+ground.center[1];
        const want=push(x,z,movers,y),at=6+(j*h.n+i)*2;
        assert.ok(Math.abs(field[at]-want[0])<1e-5&&Math.abs(field[at+1]-want[1])<1e-5,`heightfield stamp ${i},${j}`);
        if(field[at]||field[at+1])touched++;
      }
      assert.ok(touched>20,'ground-level sphere bends grass on the sampled slope');
    }
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter trample', JSON.stringify({ touched, worst, bentPixels: differing(bent, plain) }));
  },
  () => context.close(),
);
watchExit();
