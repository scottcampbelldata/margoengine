import test from 'node:test';
import assert from 'node:assert/strict';
import { SMAA, FXAA, Bloom, PostStack } from '../dist/index.js';
import { harness, modules, written } from './support.js';

const passes = (log) => log.filter((e) => e[0] === 'beginRenderPass').map((e) => e[1]);
/** Fullscreen draws into colour targets (leaves out the capture's depth copies). */
function draws(log) {
  let n = 0,
    color = false;
  for (const e of log)
    if (e[0] === 'beginRenderPass') color = e[1].colorAttachments.length > 0;
    else if (e[0] === 'pass.draw' && color) n++;
  return n;
}
/** The bytes of each writeTexture in `log`, with its size. */
const uploads = (log) =>
  log
    .filter((e) => e[0] === 'writeTexture')
    .map((e) => ({ bytes: Buffer.from(e[2].slice(e[2].indexOf(':') + 1), 'hex'), size: e[4] }));

test('SMAA builds its area and search tables from the morphological model', () => {
  const h = harness(),
    log = h.gpu.record(() => SMAA.attach(h.engine));
  const [area, search] = uploads(log);
  assert.deepEqual(
    [area.size, search.size],
    [
      [260, 260],
      [33, 33],
    ],
  );
  // Texel (c0 * 65 + d0, c1 * 65 + d1): red = area on the far side, green = on the owner's side, both times 510.
  const at = (c0, d0, c1, d1) => {
    const i = ((c1 * 65 + d1) * 260 + c0 * 65 + d0) * 2;
    return [area.bytes[i] / 510, area.bytes[i + 1] / 510];
  };
  // A Z of 8 pixels from the far side (+0.5) to the owner's side (-0.5): the line 0.5 - t / 8 over each pixel.
  for (let d = 0; d < 8; d++) {
    const mean = 0.5 - (d + 0.5) / 8;
    assert.deepEqual(
      at(2, d, 1, 7 - d).map((v) => Math.round(v * 510)),
      [Math.round(Math.max(mean, 0) * 510), Math.round(Math.max(-mean, 0) * 510)],
    );
  }
  // A U of one pixel on the owner's side: two triangles of 0.125; an L reaches the middle only.
  assert.deepEqual(at(1, 0, 1, 0), [0, 128 / 510]);
  assert.deepEqual(at(0, 3, 1, 4), [0, 0], 'pixel 3 of 8 lies in the half without a crossing');
  assert.ok(at(0, 5, 1, 2)[1] > 0);
  // No crossing at either end, or a junction (both sides): no slope, no blending.
  for (const [c0, c1] of [
    [0, 0],
    [3, 0],
    [3, 3],
    [0, 3],
  ])
    for (const [d0, d1] of [
      [0, 0],
      [5, 9],
      [64, 64],
    ])
      assert.deepEqual(at(c0, d0, c1, d1), [0, 0]);
  // Search: texel (main, crossing) sums in 32nds of four flags each (21, 7, 3, 1); red walking back, green forward.
  const decode = (main, crossing) => [
    ...search.bytes.subarray((crossing * 33 + main) * 2, (crossing * 33 + main) * 2 + 2),
  ];
  assert.deepEqual(decode(28, 0), [2, 2], 'both pixels on the edge, no crossing');
  assert.deepEqual(decode(31, 0), [2, 2], 'flags of the row across do not count as edge');
  assert.deepEqual(decode(21, 0), [1, 1], 'the second pixel is off the edge');
  assert.deepEqual(decode(0, 0), [0, 0]);
  assert.deepEqual(decode(28, 21), [1, 0], "a crossing at the first pixel's own side");
  assert.deepEqual(decode(28, 3), [1, 0], 'a crossing on the far side counts the same');
  assert.deepEqual(decode(28, 7), [2, 1], "a crossing at the second pixel's own side");
  h.engine.removePlugin('smaa');
});

for (const samples of [4, 1])
  test(`SMAA alone wraps the finished frame in three passes and keeps steady frames free of uploads (${samples}x)`, async () => {
    const h = harness({ samples }),
      log = h.gpu.record(() => {
        SMAA.attach(h.engine);
        h.frame();
      });
    const p = passes(log);
    assert.equal(p.at(-1).colorAttachments[0].view, h.gpu.snap(h.view.c.color), 'SMAA presents last');
    assert.equal(draws(log), 3, 'edges, weights, blend');
    assert.equal(h.view.c.shader, h.view.state.shader, 'SMAA keeps the core shader');
    const code = modules(log);
    assert.ok(code.some((c) => c.includes('fn contrast(') && c.includes('2*d')));
    assert.ok(code.some((c) => c.includes('fn walk(') && c.includes('texture_2d<u32>')));
    assert.ok(code.some((c) => c.includes('max(left,right)>max(up,down)')));
    assert.deepEqual([...written(log, 16)], [0.1, 16, 0.25, 0].map(Math.fround), 'high preset by default');
    const count = h.live().length,
      steady = h.gpu.record(() => h.frame());
    assert.equal(h.live().length, count);
    assert.ok(!steady.some(([name]) => /^(writeBuffer|writeTexture|texture|group|renderPipeline|module)$/.test(name)));
    assert.equal(draws(steady), 3);
    h.engine.removePlugin('smaa');
    await null;
    assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
  });

test('SMAA presets, overrides, disabling, resize and restore', async () => {
  const h = harness(),
    smaa = SMAA.attach(h.engine, { quality: 'low' });
  assert.deepEqual(
    [
      ...written(
        h.gpu.record(() => h.frame()),
        16,
      ),
    ],
    [0.15, 4, 1, 0].map(Math.fround),
  );
  smaa.options.quality = 'ultra';
  assert.deepEqual(
    [
      ...written(
        h.gpu.record(() => h.frame()),
        16,
      ),
    ],
    [0.05, 32, 0.25, 0].map(Math.fround),
  );
  Object.assign(smaa.options, { threshold: 0.2, maxSearchSteps: 6, cornerRounding: 0, edgeDetection: 'color' });
  assert.deepEqual(
    [
      ...written(
        h.gpu.record(() => h.frame()),
        16,
      ),
    ],
    [0.2, 6, 0, 1].map(Math.fround),
  );
  // Disabled: the weights are cleared (a pass without a draw) and the blend passes every pixel through.
  const on = h.gpu.record(() => h.frame());
  smaa.enabled = false;
  const off = h.gpu.record(() => h.frame());
  assert.equal(draws(off), 1);
  assert.equal(passes(on).length - passes(off).length, 1, 'edges and weights passes become one clear');
  smaa.enabled = true;
  // A new size makes new edge and weight targets; a restored device re-uploads both tables.
  h.view.state.width = 320;
  const resized = h.gpu.record(() => h.frame());
  assert.ok(resized.some((e) => e[0] === 'texture' && e[2].format === 'rg8unorm' && e[2].size[0] === 320));
  h.engine.restore();
  assert.equal(uploads(h.gpu.record(() => h.frame())).length, 0, 'tables upload in setup, not per frame');
  const again = h.gpu.record(() => h.engine.restore());
  assert.equal(uploads(again).length, 2);
  h.frame();
  smaa.dispose();
  smaa.dispose();
  await null;
  assert.deepEqual(h.live(), []);
  for (const options of [
    { threshold: 0 },
    { threshold: 0.6 },
    { maxSearchSteps: 0 },
    { maxSearchSteps: 33 },
    { maxSearchSteps: 2.5 },
    { cornerRounding: -0.1 },
  ])
    assert.throws(() => new SMAA(options), RangeError);
  for (const options of [{ quality: 'best' }, { edgeDetection: 'depth' }, { enabled: 1 }])
    assert.throws(() => new SMAA(options), TypeError);
  assert.throws(() => (smaa.enabled = 'yes'), TypeError);
});

test('SMAA is an LDR effect of a PostStack and never runs next to FXAA', async () => {
  assert.throws(() => new PostStack([new SMAA(), new FXAA()]), { name: 'TypeError', message: /SMAA or FXAA/ });
  assert.throws(() => new PostStack([new SMAA(), new Bloom()]), RangeError);
  const h = harness(),
    smaa = new SMAA(),
    log = h.gpu.record(() => {
      h.engine.use(new PostStack([new Bloom(), smaa]));
      h.frame();
    });
  assert.equal(passes(log).at(-1).colorAttachments[0].view, h.gpu.snap(h.view.c.color), 'SMAA writes the frame');
  assert.throws(() => h.engine.use(smaa), /Invalid plugin|already attached/);
  h.engine.removePlugin('post:stack');
  await null;
  assert.deepEqual(h.live(), []);
  for (const [first, second] of [
    [FXAA, SMAA],
    [SMAA, FXAA],
  ]) {
    const g = harness();
    first.attach(g.engine);
    assert.throws(() => second.attach(g.engine), { name: 'MargoError', code: 'attached', message: /SMAA|FXAA/ });
  }
  const s = harness();
  PostStack.attach(s.engine, [new SMAA()]);
  assert.throws(() => FXAA.attach(s.engine), { code: 'attached' });
});

test('SMAA blends into the output only inside the current view, keeping the views drawn before it', () => {
  const h = harness(),
    smaa = SMAA.attach(h.engine);
  h.frame();
  for (const [index, scissor] of [
    [0, undefined],
    [1, [40, 0, 16, 32]],
  ]) {
    const log = h.gpu.record(() => {
      h.view.begin(index);
      h.view.c.view = { id: 'v' + index, camera: h.view.camera, viewport: [32 * index, 0, 32, 32], scissor, index, count: 2 };
      h.engine.frameGraph.execute(h.view.c);
    });
    const starts = log.flatMap((e, i) => (e[0] === 'beginRenderPass' ? [i] : [])),
      last = log.slice(starts.at(-1));
    assert.equal(last[0][1].colorAttachments[0].loadOp, index ? 'load' : 'clear', 'a later view keeps the earlier ones');
    // The recorder keeps the first five arguments of a call.
    const at = (name, n) => last.find((e) => e[0] === 'pass.' + name)?.slice(1, 1 + n);
    assert.deepEqual(at('setViewport', 5), [32 * index, 0, 32, 32, 0]);
    assert.deepEqual(at('setScissorRect', 4), scissor ?? [32 * index, 0, 32, 32]);
  }
  smaa.dispose();
});
