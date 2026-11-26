import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderGraph, effectTask } from '@margoengine/post/render-graph';
import { Pixelate } from '@margoengine/post/pixelate';
import { harness } from './support.js';

const calls = (log, name) => log.filter((e) => e[0] === name);
const code = (c) => (error) =>
  error instanceof TypeError && error.code === c && /errors#render-graph/.test(error.message);
const blit = (from) => ({ name: 'present', type: 'blit', inputs: { source: from }, outputs: { target: 'screen' } });

test('build orders tasks topologically and shares transient textures by lifetime', async () => {
  // Listed out of order on purpose: d reads c, c reads a, b reads a; a and c are the same kind of texture.
  const json = {
    version: 1,
    tasks: [
      { name: 'last', type: 'copy', inputs: { source: 'c' }, outputs: { target: 'd' } },
      { name: 'present', type: 'blit', inputs: { source: 'd' }, outputs: { target: 'screen' } },
      { name: 'mid', type: 'copy', inputs: { source: 'a' }, outputs: { target: 'c' } },
      { name: 'first', type: 'clear', params: { color: [1, 0, 0, 1] }, outputs: { target: 'a' } },
    ],
  };
  const graph = new RenderGraph(json);
  assert.deepEqual(graph.order, ['first', 'mid', 'last', 'present']);
  // a dies when mid has read it, so d takes its texture; c needs its own: two textures for three.
  assert.equal(graph.textureCount, 2);
  assert.deepEqual(graph.toJSON(), json);
  assert.notEqual(graph.toJSON(), graph.toJSON());
  const h = harness();
  h.frame(); // the harness makes its canvas textures on its first frame
  h.engine.use(graph);
  const log = h.gpu.record(() => h.frame());
  assert.equal(calls(log, 'texture').length, 2, 'two physical textures');
  assert.equal(calls(log, 'pass.draw').length, 3, 'mid, last and present draw; clear only clears');
  const steady = h.gpu.record(() => h.frame());
  for (const kind of ['texture', 'renderPipeline', 'group']) assert.equal(calls(steady, kind).length, 0, kind);
  // A resize makes the textures again; nothing else.
  h.view.state.width = 640;
  const resized = h.gpu.record(() => h.frame());
  assert.deepEqual(
    calls(resized, 'texture')
      .filter((e) => e[2].format === 'rgba16float')
      .map((e) => e[2].size[0]),
    [640, 640],
  );
  graph.dispose();
  await null;
  assert.deepEqual(h.live(), []);
});

test('validation refuses cycles, missing inputs, type mismatches and bad descriptions with codes', () => {
  const cases = [
    [
      'cycle',
      [
        { name: 'x', type: 'copy', inputs: { source: 'b' }, outputs: { target: 'a' } },
        { name: 'y', type: 'copy', inputs: { source: 'a' }, outputs: { target: 'b' } },
      ],
    ],
    ['missing-input', [{ name: 'x', type: 'copy', inputs: { source: 'nowhere' }, outputs: { target: 'a' } }]],
    ['missing-input', [{ name: 'x', type: 'copy', outputs: { target: 'a' } }]],
    ['type-mismatch', [{ name: 's', type: 'scene', outputs: { color: 'c', depth: 'd' } }, blit('d')]],
    ['type-mismatch', [{ name: 's', type: 'scene', outputs: { color: 'screen', depth: 'd' } }]],
    ['unknown-task', [{ name: 'x', type: 'warp', outputs: { target: 'a' } }]],
    ['unknown-slot', [{ name: 'x', type: 'clear', outputs: { target: 'a', extra: 'b' } }]],
    [
      'duplicate-writer',
      [
        { name: 'x', type: 'clear', outputs: { target: 'a' } },
        { name: 'y', type: 'clear', outputs: { target: 'a' } },
      ],
    ],
    ['missing-input', [{ name: 's', type: 'scene', outputs: { color: 'c', depth: 'd' } }]],
    ['invalid-graph', [{ name: 'x', type: 'clear', params: { color: [1] }, outputs: { target: 'a' } }]],
  ];
  for (const [expected, tasks] of cases)
    assert.throws(
      () => RenderGraph.validate({ version: 1, tasks }),
      code(expected),
      `${expected}: ${JSON.stringify(tasks)}`,
    );
  assert.throws(() => RenderGraph.validate({ version: 2, tasks: [] }), code('invalid-graph'));
  // A history texture breaks the loop: reading last frame's value is no dependency.
  RenderGraph.validate({
    version: 1,
    textures: { trail: { history: true } },
    tasks: [
      { name: 'fold', type: 'copy', inputs: { source: 'trail@previous' }, outputs: { target: 'trail' } },
      blit('trail'),
    ],
  });
  assert.throws(
    () =>
      RenderGraph.validate({
        version: 1,
        tasks: [{ name: 'x', type: 'copy', inputs: { source: 'a@previous' }, outputs: { target: 'a' } }],
      }),
    code('missing-input'),
  );
  // A refused load keeps the running graph.
  const graph = new RenderGraph({ version: 1, tasks: [{ name: 'x', type: 'clear', outputs: { target: 'screen' } }] });
  assert.throws(
    () => graph.load({ version: 1, tasks: [{ name: 'x', type: 'nope', outputs: {} }] }),
    code('unknown-task'),
  );
  assert.deepEqual(graph.order, ['x']);
});

test('history textures ping-pong once a frame; persistent ones are never shared', () => {
  const h = harness();
  h.frame();
  const graph = RenderGraph.attach(h.engine, {
    version: 1,
    textures: { trail: { history: true, scale: 0.5 }, keep: { persistent: true } },
    tasks: [
      { name: 'fold', type: 'copy', inputs: { source: 'trail@previous' }, outputs: { target: 'trail' } },
      { name: 'hold', type: 'copy', inputs: { source: 'trail' }, outputs: { target: 'keep' } },
      blit('keep'),
    ],
  });
  assert.equal(graph.textureCount, 3);
  const sizes = calls(
    h.gpu.record(() => h.frame()),
    'texture',
  ).map((e) => e[2].size);
  assert.deepEqual(sizes, [
    [h.view.c.width / 2, h.view.c.height / 2],
    [h.view.c.width / 2, h.view.c.height / 2],
    [h.view.c.width, h.view.c.height],
  ]);
  // fold reads one half and writes the other; next frame they swap; a second execute in a frame does not.
  const targets = () => {
    const log = h.gpu.record(() => h.frame());
    return calls(log, 'beginRenderPass')[0][1].colorAttachments[0].view;
  };
  const a = targets(),
    b = targets(),
    c = targets();
  assert.notEqual(a, b);
  assert.equal(a, c);
  graph.dispose();
});

test('post effects run as tasks: effectTask registers a class, the scene task captures the frame', async () => {
  const h = harness(),
    graph = RenderGraph.attach(
      h.engine,
      {
        version: 1,
        tasks: [
          { name: 'scene', type: 'scene', outputs: { color: 'hdr', depth: 'depth' } },
          { name: 'present', type: 'blit', inputs: { source: 'hdr' }, outputs: { target: 'ldr' } },
          {
            name: 'pixels',
            type: 'pixelate',
            params: { pixelSize: 4 },
            inputs: { source: 'ldr' },
            outputs: { target: 'screen' },
          },
        ],
      },
      { tasks: { pixelate: effectTask(Pixelate) } },
    );
  assert.ok(h.engine.hasPlugin('pixelate'), 'the effect attached as a plugin');
  h.frame();
  const steady = h.gpu.record(() => h.frame());
  assert.ok(calls(steady, 'pass.draw').length >= 2);
  assert.throws(
    () =>
      graph.load({
        version: 1,
        textures: { small: { scale: 0.5 } },
        tasks: [
          { name: 'scene', type: 'scene', outputs: { color: 'hdr', depth: 'depth' } },
          { name: 'present', type: 'blit', inputs: { source: 'hdr' }, outputs: { target: 'small' } },
          { name: 'pixels', type: 'pixelate', inputs: { source: 'small' }, outputs: { target: 'screen' } },
        ],
      }),
    code('size-mismatch'),
  );
  graph.load({ version: 1, tasks: [{ name: 'x', type: 'clear', outputs: { target: 'screen' } }] });
  assert.ok(!h.engine.hasPlugin('pixelate'), 'a rebuild disposes the old tasks');
  h.frame();
  graph[Symbol.dispose]();
  await null;
  assert.deepEqual(h.live(), []);
});
