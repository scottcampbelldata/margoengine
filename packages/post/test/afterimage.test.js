import test from 'node:test';
import assert from 'node:assert/strict';
import { Afterimage, PostStack } from '../dist/index.js';
import { harness, modules } from './support.js';

const uniforms = (log) =>
  log
    .filter((e) => e[0] === 'writeBuffer' && e[3].length === 32)
    .map((e) => [...new Float32Array(Uint8Array.from(Buffer.from(e[3], 'hex')).buffer)]);
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
  test(`Afterimage alone folds linear frames into a ping-pong history and presents through the display curve (${samples}x)`, () => {
    const h = harness({ samples }),
      after = Afterimage.attach(h.engine),
      first = h.gpu.record(() => h.frame());
    assert.ok(!h.view.c.shader.includes('let mapped=pbrNeutral('), 'HDR stage: the stack captures linear light');
    const history = first.filter(
      (e) => e[0] === 'texture' && e[2].format === 'rgba16float' && e[2].sampleCount === undefined,
    );
    assert.ok(history.length >= 2, 'two rgba16float history textures');
    assert.deepEqual(uniforms(first), [[Math.fround(0.96), 1, 0, 0]], 'the first frame starts the history');
    const code = modules(first);
    assert.ok(code.some((c) => c.includes('max(c,textureLoad(previous,q,0)*a.x)')));
    assert.ok(
      code.some((c) => c.includes('toDisplay(h.rgb),h.a')),
      'last stage: display-encoded, alpha kept',
    );
    const second = h.gpu.record(() => h.frame()),
      third = h.gpu.record(() => h.frame());
    assert.deepEqual(uniforms(second), [[Math.fround(0.96), 0, 0, 0]]);
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
    assert.deepEqual(uniforms(h.gpu.record(() => h.frame())), [[Math.fround(0.96), 1, 0, 0]]);
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
    assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
  });

test('Afterimage before a display effect hands it the history itself, in linear light', () => {
  const h = harness(),
    seen = [],
    stack = PostStack.attach(h.engine, [new Afterimage({ damp: 0.9 }), probe(seen)]),
    log = h.gpu.record(() => h.frame());
  const passes = log.filter((e) => e[0] === 'beginRenderPass' && e[1].colorAttachments.length);
  const fold = passes.at(-1)[1].colorAttachments[0].view;
  assert.equal(h.gpu.snap(seen[0]), fold, 'the display stage reads the fold target');
  assert.ok(!modules(log).some((c) => c.includes('toDisplay(h.rgb)')), 'no present pass before the display effect');
  h.frame();
  assert.notEqual(seen[1], seen[0]);
  stack.dispose();
  assert.deepEqual(h.live(), []);
  for (const options of [{ damp: -0.1 }, { damp: 1.1 }, { damp: NaN }])
    assert.throws(() => new Afterimage(options), RangeError);
  assert.throws(() => new Afterimage({ enabled: 0 }), TypeError);
  assert.throws(() => (new Afterimage().damp = 2), RangeError);
  assert.throws(() => new PostStack([probe([]), new Afterimage()]), RangeError, 'HDR effects come first');
  const alone = harness();
  assert.throws(() => alone.engine.use(new Afterimage()), { name: 'MargoError', code: 'state', message: /PostStack/ });
});
