// GAP-FILM-TIME: a TAA started at film time T jitters on the phase a continuous run has at T. Run A takes n + 1 live
// frames (update and draw); run B is fresh, replays n steps with `advanceTime` (what `seek` from
// @margoengine/cutscene/seek runs), then takes one live frame. The Halton phase, the jittered projection and the
// jitter offset must be equal. The history is view history (class C): a cut starts it empty, bounded in seek-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { TAAUpscale } from '../dist/upscale.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const FPS = 60;
function rig() {
  const h = optionalGPU(),
    c = h.context;
  h.engine.store.visible = new Uint8Array(16);
  for (const method of ['beginRenderPass', 'beginComputePass']) {
    const begin = c.encoder[method];
    c.encoder[method] = (...args) => ({ ...begin(...args), setViewport() {}, setScissorRect() {} });
  }
  const taa = new TAA();
  h.engine.use(taa);
  const draw = () => {
    c.color = h.originalColor;
    c.depth = h.originalDepth;
    c.shader = wgsl;
    c.bindings = [];
    h.engine.frameGraph.execute(c);
  };
  return {
    taa,
    draw,
    live() {
      taa.onPreUpdate(1 / FPS);
      draw();
    },
    state: () => ({ sample: taa['sample'], jittered: [...taa['jittered']], offset: [...taa['offset']] }),
  };
}

for (const n of [1, 601, 54001])
  test(`TAA replayed ${n} steps lands on the jitter phase of a continuous run`, () => {
    const a = rig(),
      b = rig(),
      c = rig();
    assert.equal(b.taa.time, 0, 'a fresh TAA starts at 0');
    for (let step = 0; step <= n; step++) a.live();
    for (let step = 0; step < n; step++) b.taa.advanceTime(1 / FPS);
    b.live();
    c.live();
    assert.ok(Object.is(b.taa.time, a.taa.time));
    assert.deepEqual(b.state(), a.state());
    assert.equal(a.state().sample, (n + 1) % 8, 'the frame drew phase n % 8 and moved on');
    assert.notDeepEqual(c.state(), a.state(), 'a fresh TAA without the replay starts the phase at 0');
  });

// KB-FILM-TAAPHASE1: a Reflector, Refractor or CubeCamera renders the scene with a delta of 0 before each frame, and
// every render calls onPreUpdate. Each of those stepped the phase, so with a mirror in view TAA drew only the even
// phases (4 jitter samples, not 8) and its still-view settle compared the wrong phases: the environment mirror check
// "TAA mirror after a move under history equals a fresh history" read p99 5 against 4.
test('a zero-delta update inside a frame (a capture) keeps the jitter phase of a run without it', () => {
  const plain = rig(),
    captured = rig();
  for (let frame = 0; frame < 19; frame++) {
    plain.live();
    captured.taa.onPreUpdate(0);
    captured.live();
    assert.deepEqual(captured.state(), plain.state(), `frame ${frame}`);
  }
  assert.ok(Object.is(captured.taa.time, plain.taa.time), 'a delta of 0 moves no time');
  const redraw = rig();
  for (let frame = 0; frame < 11; frame++) {
    redraw.taa.onPreUpdate(0);
    redraw.taa.onPreUpdate(0);
    redraw.draw();
  }
  assert.equal(redraw.taa['sample'], 11 % 8, 'a frame drawn after zero-delta updates only still takes one new phase');
});

test('with frame updates, reset restarts the history and keeps the phase; without them it restarts both', () => {
  const r = rig();
  for (let step = 0; step < 5; step++) r.live();
  r.taa.reset();
  r.live();
  assert.equal(r.taa['sample'], 6, 'the frame drew phase 5: the phase follows the updates');
  assert.equal(r.taa['valid'], true);
  const old = rig();
  for (let step = 0; step < 5; step++) old.draw();
  old.taa.reset();
  old.draw();
  assert.equal(old.taa['sample'], 1, 'a TAA no update reaches drew phase 0 after the reset, as before');
  const before = r.taa.time;
  r.taa.dispose();
  r.taa.advanceTime(1);
  assert.equal(r.taa.time, before, 'a disposed TAA does not move');
});

test('TAAUpscale counts its jitter phase on frame updates once it gets one', () => {
  const up = new TAAUpscale();
  assert.equal(up.time, 0);
  for (let step = 0; step < 601; step++) up.advanceTime(1 / FPS);
  up.onPreUpdate(1 / FPS);
  assert.equal(up['phase'], 601);
  assert.ok(up['clocked']);
  let t = 0;
  for (let step = 0; step < 602; step++) t += 1 / FPS;
  assert.equal(up.time, t);
  up.dispose();
  up.advanceTime(1);
  assert.equal(up.time, t);
});

test('TAAUpscale: a zero-delta update keeps the phase until the next drawn frame', () => {
  const up = new TAAUpscale();
  for (let step = 0; step < 5; step++) up.advanceTime(1 / FPS);
  up.onPreUpdate(0);
  assert.equal(up['phase'], 4, 'a capture inside the frame does not step the phase');
  assert.equal(up['pending'], true, 'the next drawn frame steps it if no timed update comes first');
  up.onPreUpdate(1 / FPS);
  assert.equal(up['phase'], 5);
  assert.equal(up['pending'], false);
});
