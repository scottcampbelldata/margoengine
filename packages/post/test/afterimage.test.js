import test from 'node:test';
import assert from 'node:assert/strict';
import { Afterimage, PostStack } from '../dist/index.js';
import { harness, modules } from './support.js';

const uniforms = (log) =>
  log
    .filter((e) => e[0] === 'writeBuffer' && e[3].length === 32)
    .map((e) => [...new Float32Array(Uint8Array.from(Buffer.from(e[3], 'hex')).buffer)]);
// Default half-life 0.15 s at the harness's 1/60 s frames.
const KEEP = Math.fround(0.5 ** (1 / 60 / 0.15));
const targets = (log) => log.filter((e) => e[0] === 'beginRenderPass').map((e) => e[1].colorAttachments[0]?.view);
/** A display stage that records the view it is handed. */
function probe(seen) {
  return {
    name: 'probe',
    setup() {},
    dispose() {},
    joinStack: () => ({ kind: 'display', render: (c, input) => seen.push(input) }),
  };
}

for (const samples of [4, 1])
  test(`Afterimage alone folds linear frames into a ping-pong history and presents through the display curve (${samples}x)`, async () => {
    const h = harness({ samples }),
      after = Afterimage.attach(h.engine),
      first = h.gpu.record(() => h.frame());
    assert.ok(!h.view.c.shader.includes('let mapped=pbrNeutral('), 'HDR stage: the stack captures linear light');
    const history = first.filter(
      (e) => e[0] === 'texture' && e[2].format === 'rgba16float' && e[2].sampleCount === undefined,
    );
    assert.ok(history.length >= 2, 'two rgba16float history textures');
    assert.deepEqual(uniforms(first), [[KEEP, 1, 0, 0]], 'the first frame starts the history');
    const code = modules(first);
    assert.ok(code.some((c) => c.includes('max(now,textureLoad(history,p,0)*fade.x)')));
    assert.ok(
      code.some((c) => c.includes('toDisplay(linear.rgb),linear.a')),
      'last stage: display-encoded, alpha kept',
    );
    const second = h.gpu.record(() => h.frame()),
      third = h.gpu.record(() => h.frame());
    assert.deepEqual(uniforms(second), [[KEEP, 0, 0, 0]]);
    assert.deepEqual(uniforms(third), [], 'unchanged uniforms are not rewritten');
    // Fold then present each frame; the fold target alternates and the present reads it.
    const [a, b] = [second, third].map((log) => targets(log).slice(-2));
    assert.equal(a[1], h.gpu.snap(h.view.c.color));
    assert.notEqual(a[0], b[0], 'ping-pong');
    assert.ok(!second.some(([name]) => /^(texture|renderPipeline)$/.test(name)));
    // The second frame makes the other parity's bind groups; from then on frames create nothing.
    assert.ok(!third.some(([name]) => /^(texture|group|renderPipeline|module)$/.test(name)));
    // reset, disable, resize and restore each start a new history.
    after.reset();
    assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[KEEP, 1, 0, 0]]);
    h.frame();
    after.damp = 0.5;
    after.enabled = false;
    assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[0.5, 1, 0, 0]]);
    after.enabled = true;
    h.frame();
    h.view.state.width = 320;
    const resized = h.gpu.record(() => h.frame());
    assert.deepEqual(uniforms(resized), [[0.5, 1, 0, 0]]);
    assert.ok(resized.some((e) => e[0] === 'texture' && e[2].format === 'rgba16float' && e[2].size[0] === 320));
    h.frame();
    h.engine.restore();
    assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[0.5, 1, 0, 0]]);
    after.dispose();
    assert.ok(!h.engine.hasPlugin('post:stack'));
    await null;
    assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
  });

test('Afterimage before a display effect hands it the history itself, in linear light', async () => {
  const h = harness(),
    seen = [],
    stack = PostStack.attach(h.engine, [new Afterimage({ damp: 0.9 }), probe(seen)]),
    log = h.gpu.record(() => h.frame());
  const passes = log.filter((e) => e[0] === 'beginRenderPass' && e[1].colorAttachments.length);
  const fold = passes.at(-1)[1].colorAttachments[0].view;
  assert.equal(h.gpu.snap(seen[0]), fold, 'the display stage reads the fold target');
  assert.ok(
    !modules(log).some((c) => c.includes('toDisplay(linear.rgb)')),
    'no present pass before the display effect',
  );
  h.frame();
  assert.notEqual(seen[1], seen[0]);
  stack.dispose();
  await null;
  assert.deepEqual(h.live(), []);
  for (const options of [{ damp: -0.1 }, { damp: 1.1 }, { damp: NaN }])
    assert.throws(() => new Afterimage(options), RangeError);
  assert.throws(() => new Afterimage({ enabled: 0 }), TypeError);
  assert.throws(() => (new Afterimage().damp = 2), RangeError);
  assert.throws(() => new PostStack([probe([]), new Afterimage()]), RangeError, 'HDR effects come first');
  const alone = harness();
  assert.throws(() => alone.engine.use(new Afterimage()), { name: 'MargoError', code: 'state', message: /PostStack/ });
});

test('Afterimage fades by a half-life in seconds, whatever the frame rate; damp is a per-frame alias', async () => {
  const h = harness(),
    after = Afterimage.attach(h.engine, { halfLife: 0.5 }),
    keep = (delta) => {
      h.view.c.delta = delta;
      return uniforms(h.gpu.record(() => h.frame()));
    };
  // frame() rebuilds the context each frame, so set delta through the frame graph.
  const graph = h.engine.frameGraph,
    execute = graph.execute.bind(graph);
  let delta = 1 / 60;
  graph.execute = (c) => execute(Object.assign(c, { delta }));
  const at = (d) => {
    delta = d;
    return uniforms(h.gpu.record(() => h.frame()));
  };
  assert.deepEqual(at(1 / 60), [[Math.fround(0.5 ** (1 / 30)), 1, 0, 0]], 'fresh first frame');
  assert.deepEqual(at(1 / 30), [[Math.fround(0.5 ** (1 / 15)), 0, 0, 0]], 'a 30 Hz frame fades twice as much');
  assert.deepEqual(at(0.5), [[0.5, 0, 0, 0]], 'one half-life halves the trail');
  assert.deepEqual(at(0), [[1, 0, 0, 0]], 'a paused render keeps the trail');
  // Two 1/60 s frames fade as much as one 1/30 s frame.
  const sixty = Math.fround(0.5 ** (1 / 30));
  assert.ok(Math.abs(sixty * sixty - Math.fround(0.5 ** (1 / 15))) < 1e-6);
  assert.equal(after.halfLife, 0.5);
  assert.equal(after.damp, undefined);
  after.damp = 0.9;
  assert.deepEqual(at(1 / 30), [[Math.fround(0.9), 0, 0, 0]], 'damp wins over halfLife, per frame');
  assert.ok(
    Math.abs(after.halfLife - Math.log(0.5) / Math.log(0.9) / 60) < 1e-12,
    'damp reported as a 60 Hz half-life',
  );
  after.halfLife = 0.25;
  assert.equal(after.damp, undefined, 'setting halfLife clears damp');
  assert.deepEqual(at(0.25), [[0.5, 0, 0, 0]]);
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => (after.halfLife = value), RangeError);
    assert.throws(() => new Afterimage({ halfLife: value }), RangeError);
  }
  after.options.halfLife = -2;
  assert.throws(() => h.frame(), RangeError, 'options are checked every frame');
  after.options.halfLife = 1;
  after.dispose();
  await null;
  assert.deepEqual(h.live(), []);
  void keep;
});
