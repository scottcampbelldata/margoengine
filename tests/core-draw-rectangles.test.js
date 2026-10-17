import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuDrawHarness, glDrawHarness } from './support/core-draw-gpu.js';

const rectangles = (pass) => pass.commands.filter(([name]) => name === 'viewport' || name === 'scissor');

test('WebGPU applies independent readonly rectangles before an indexed draw', (t) => {
  const h = gpuDrawHarness(t),
    viewport = Object.freeze([8, 11, 40, 30]),
    scissor = Object.freeze([9, 13, 25, 17]);
  h.frame((draw) => draw({ viewport, scissor }));
  assert.deepEqual(
    h.draws()[0].commands.filter(([name]) => ['viewport', 'scissor', 'draw'].includes(name)),
    [
      ['viewport', 8, 11, 40, 30, 0, 1],
      ['scissor', 9, 13, 25, 17],
      ['draw', 36, 1],
    ],
  );
});

for (const [option, value, want] of [
  ['viewport', [8, 11, 40, 30], [['viewport', 8, 11, 40, 30, 0, 1]]],
  ['scissor', [9, 13, 25, 17], [['scissor', 9, 13, 25, 17]]],
])
  test(`WebGPU ${option} leaves the other rectangle at its implicit full-target default`, (t) => {
    const h = gpuDrawHarness(t);
    h.frame((draw) => draw({ [option]: value }));
    assert.deepEqual(rectangles(h.draws()[0]), want);
  });

test('WebGPU rectangles do not carry into the next draw or frame', (t) => {
  const h = gpuDrawHarness(t);
  h.frame((draw) => {
    draw({ viewport: [8, 11, 40, 30], scissor: [9, 13, 25, 17] });
    draw({ clear: false });
  });
  h.frame();
  const draws = h.draws();
  assert.equal(draws.length, 3, 'all three real indexed scene draws execute');
  assert.deepEqual(rectangles(draws[0]), [
    ['viewport', 8, 11, 40, 30, 0, 1],
    ['scissor', 9, 13, 25, 17],
  ]);
  assert.deepEqual(rectangles(draws[1]), []);
  assert.deepEqual(rectangles(draws[2]), []);
});

test('WebGPU ordinary draws keep a smaller custom attachment viewport implicit', (t) => {
  const h = gpuDrawHarness(t),
    color = { target: '32x24-color' },
    depth = { target: '32x24-depth' };
  h.frame((draw, context) => {
    context.color = color;
    context.depth = depth;
    context.width = 32;
    context.height = 24;
    draw();
  });
  const pass = h.draws()[0];
  assert.equal(pass.descriptor.colorAttachments[0].view, color);
  assert.equal(pass.descriptor.depthStencilAttachment.view, depth);
  assert.deepEqual(rectangles(pass), [], 'a canvas-sized viewport must not be forced onto this smaller target');
});

test('WebGPU rectangles preserve whole-attachment clears, later loads and MSAA storage', (t) => {
  const h = gpuDrawHarness(t, 4);
  h.frame((draw) => {
    draw({ viewport: [0, 0, 80, 120], scissor: [0, 0, 80, 120] });
    draw({ viewport: [80, 0, 80, 120], scissor: [80, 0, 80, 120], clear: false });
  });
  const draws = h.draws();
  assert.equal(draws.length, 2);
  assert.deepEqual(
    draws.map(({ descriptor: d }) => [
      d.colorAttachments[0].loadOp,
      d.depthStencilAttachment.depthLoadOp,
      d.colorAttachments[0].storeOp,
      d.depthStencilAttachment.depthStoreOp,
    ]),
    [
      ['clear', 'clear', 'store', 'store'],
      ['load', 'load', 'store', 'store'],
    ],
  );
  assert.ok(draws.every(({ descriptor: d }) => d.colorAttachments[0].resolveTarget?.canvas));
  const final = h.passes.at(-1);
  assert.deepEqual(final.commands, [['end']], 'the last pass only resolves the preserved samples');
  assert.equal(final.descriptor.colorAttachments[0].loadOp, 'load');
  assert.equal(final.descriptor.colorAttachments[0].storeOp, 'discard');
});

const invalidRectangles = [
  ['null', null],
  ['empty tuple', []],
  ['short tuple', [0, 0, 20]],
  ['long tuple', [0, 0, 20, 10, 1]],
  ['array-like object', { 0: 0, 1: 0, 2: 20, 3: 10, length: 4 }],
  ['nonfinite origin', [NaN, 0, 20, 10]],
  ['infinite size', [0, 0, Infinity, 10]],
  ['negative x', [-1, 0, 20, 10]],
  ['negative y', [0, -1, 20, 10]],
  ['zero width', [0, 0, 0, 10]],
  ['zero height', [0, 0, 20, 0]],
  ['negative size', [0, 0, -1, 10]],
  ['fractional origin', [0.5, 0, 20, 10]],
  ['fractional size', [0, 0, 20.5, 10]],
  ['string size', [0, 0, 20, '10']],
  ['right overflow', [150, 0, 20, 10]],
  ['bottom overflow', [0, 110, 20, 20]],
];

for (const option of ['viewport', 'scissor']) {
  test(`WebGPU rejects invalid ${option} before opening a render pass`, (t) => {
    const h = gpuDrawHarness(t);
    for (const [label, rectangle] of invalidRectangles) {
      assert.throws(() => h.frame((draw) => draw({ [option]: rectangle })), `${option}: ${label}`);
      assert.equal(h.passes.length, 0, `${label} must not open a render pass`);
    }
  });

  test(`WebGPU ${option} uses dimensions reported by the custom target owner`, (t) => {
    const h = gpuDrawHarness(t),
      color = { target: '32x24-color' },
      depth = { target: '32x24-depth' };
    assert.throws(() =>
      h.frame((draw, context) => {
        context.color = color;
        context.depth = depth;
        context.width = 32;
        context.height = 24;
        draw({ [option]: [31, 0, 2, 1] });
      }),
    );
    assert.equal(h.passes.length, 0);
    h.frame((draw, context) => {
      context.color = color;
      context.depth = depth;
      context.width = 32;
      context.height = 24;
      draw({ [option]: [31, 23, 1, 1] });
    });
    assert.deepEqual(rectangles(h.draws()[0]), [
      option === 'viewport' ? ['viewport', 31, 23, 1, 1, 0, 1] : ['scissor', 31, 23, 1, 1],
    ]);
  });
}

test('WebGL converts top-left independent rectangles before its indexed draw', (t) => {
  const h = glDrawHarness(t);
  h.frame((draw) => draw({ viewport: Object.freeze([8, 11, 40, 30]), scissor: Object.freeze([9, 13, 25, 17]) }));
  assert.equal(h.draws.length, 1);
  assert.deepEqual(h.draws[0], {
    args: [4, 36, 5125, 0, 1],
    viewport: [8, 79, 40, 30],
    scissor: [9, 90, 25, 17],
    scissorEnabled: true,
  });
  const drawIndex = h.trace.findIndex(([name]) => name === 'draw');
  assert.ok(h.trace.findIndex(([name]) => name === 'viewport') < drawIndex);
  assert.ok(h.trace.findIndex(([name]) => name === 'scissor') < drawIndex);
});

for (const [option, rectangle, viewport, scissorEnabled] of [
  ['viewport', [8, 11, 40, 30], [8, 79, 40, 30], false],
  ['scissor', [9, 13, 25, 17], [0, 0, 160, 120], true],
])
  test(`WebGL ${option} does not implicitly enable the other rectangle`, (t) => {
    const h = glDrawHarness(t);
    h.frame((draw) => draw({ [option]: rectangle }));
    assert.deepEqual(h.draws[0].viewport, viewport);
    assert.equal(h.draws[0].scissorEnabled, scissorEnabled);
    if (option === 'scissor') assert.deepEqual(h.draws[0].scissor, [9, 90, 25, 17]);
  });

test('WebGL restores full-target drawing after a rected draw and on the next frame', (t) => {
  const h = glDrawHarness(t);
  h.frame((draw) => {
    draw({ viewport: [8, 11, 40, 30], scissor: [9, 13, 25, 17] });
    draw({ clear: false });
  });
  h.frame();
  assert.equal(h.draws.length, 3);
  assert.deepEqual(h.draws[0].viewport, [8, 79, 40, 30]);
  assert.equal(h.draws[0].scissorEnabled, true);
  for (const draw of h.draws.slice(1)) {
    assert.deepEqual(draw.viewport, [0, 0, 160, 120]);
    assert.equal(draw.scissorEnabled, false);
  }
});

test('WebGL clears the full attachment with scissor disabled and honors clear:false', (t) => {
  const h = glDrawHarness(t);
  h.frame((draw) => {
    draw({ scissor: [9, 13, 25, 17] });
    draw({ scissor: [80, 0, 80, 120], clear: false });
    draw({ scissor: [1, 2, 3, 4] });
  });
  assert.deepEqual(h.clears, [
    { mask: 16640, scissorEnabled: false },
    { mask: 16640, scissorEnabled: false },
  ]);
  assert.equal(h.draws.length, 3);
  assert.ok(
    h.draws.every((draw) => draw.scissorEnabled),
    'scissor is re-enabled for the actual indexed draws',
  );
});

for (const option of ['viewport', 'scissor'])
  test(`WebGL rejects invalid ${option} before clearing or drawing`, (t) => {
    const h = glDrawHarness(t);
    for (const [label, rectangle] of invalidRectangles) {
      assert.throws(() => h.frame((draw) => draw({ [option]: rectangle })), `${option}: ${label}`);
      assert.equal(h.trace.length, 0, `${label} must not change drawing state`);
      assert.equal(h.clears.length, 0);
      assert.equal(h.draws.length, 0);
    }
  });
