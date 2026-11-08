// The own 2D kernel's shipped Wasm build (simd128) in a page that renders: the pinned-bits scenes of
// kernel/tests/bits.rs are stepped between frames of an engine on WebGPU or on the WebGL2 fallback, so the physics is
// shown to give the same bits whichever renderer the page draws with; then the 100-row pyramid is timed in this
// kernel, in Rapier 2D's Wasm build and, when the run names one, in a Box2D v3 Wasm build (a black box built outside
// the repository, docs/whitepaper/reproduce.md), side by side in one page. Run by scripts/physics2d-kernel-browsers.mjs.
import { Engine, PbrMaterial, box } from '/packages/core/dist/index.js';
import { webglRenderer } from '/packages/webgl/dist/index.js';

const DT = 1 / 60;

/** The fastest of `timed` steps after `settle` steps, in ms; `step` steps once. */
function bestStep(step, settle, timed) {
  for (let i = 0; i < settle; i++) step();
  let best = Infinity;
  for (let i = 0; i < timed; i++) {
    const t0 = performance.now();
    step();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** Rapier 2D's 100-row pyramid as physics-refs/scenes/rapier2d.mjs builds it (its defaults, friction 0.6 averaged). */
function rapierPyramid(R, rows) {
  const w = new R.World({ x: 0, y: -9.81 }),
    avg = R.CoefficientCombineRule.Average;
  w.timestep = DT;
  w.createCollider(R.ColliderDesc.cuboid(500, 0.5).setTranslation(0, -0.5).setFriction(0.6).setFrictionCombineRule(avg), w.createRigidBody(R.RigidBodyDesc.fixed()));
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < rows - r; i++) {
      const b = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(i - (rows - r - 1) / 2, 0.5 + r));
      w.createCollider(R.ColliderDesc.cuboid(0.5, 0.5).setFriction(0.6).setFrictionCombineRule(avg), b);
    }
  return w;
}

window.runKernel = async ({ backend, module, rapier, box2d, rounds }) => {
  const canvas = document.querySelector('canvas');
  const engine = await Engine.create(canvas, { backend, fallback: webglRenderer });
  engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: [1, 0.5, 0] }));
  const { instance } = await WebAssembly.instantiateStreaming(fetch(module));
  const k = instance.exports,
    checks = [];
  for (let i = 0; i < k.checks(); i++) {
    engine.render();
    const code = k.check(i);
    checks.push({ check: i, pass: code === 0, ...(code === 0 ? {} : { bits: BigInt.asUintN(64, k.bits(i)).toString(16) }) });
  }
  engine.render();
  const used = engine.backend;
  engine.dispose();
  const times = [];
  if (rounds > 0) {
    const R = (await import(rapier)).default;
    await R.init();
    // Box2D's harness (physics-refs wasm/box2d3/pyramid.c): bench_pyramid(rows), bench_step(), bench_top_y().
    const B = box2d ? await (await import(box2d)).default() : null;
    // Taking turns, a fresh world each round: 60 steps to settle, then the fastest of the next 40 (as tests/bits.rs).
    for (let r = 0; r < rounds; r++) {
      k.bench_pyramid(100);
      const margo = bestStep(() => k.bench_step(), 60, 40);
      const w = rapierPyramid(R, 100);
      const rapier2d = bestStep(() => w.step(), 60, 40);
      w.free();
      const round = { margo, rapier2d };
      if (B) {
        B._bench_pyramid(100);
        round.box2d = bestStep(() => B._bench_step(), 60, 40);
        // The top box of a pyramid that ran stands near its start, 99.5 m up (it sinks under a metre).
        round.box2dTop = B._bench_top_y();
      }
      times.push(round);
    }
  }
  return { backend: used, checks, times };
};
