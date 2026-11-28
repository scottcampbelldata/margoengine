import test from 'node:test';
import assert from 'node:assert/strict';
import { flowInk, flowInkDraws } from '@margoengine/sciviz/flow-ink';

const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} versus ${b}`);

test('flow ink breaks strokes at non-finite points and never joins across a break', () => {
  const [steady] = flowInkDraws([{ positions: [0, 0, 0, 1, 0, 0, NaN, 0, 0, 2, 0, 0, 3, 0, 0, 4, 1, 0] }]);
  // Runs [0..1] and [2..4]: one segment and two, as pairs of points.
  assert.deepEqual(Array.from(steady.positions), [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 3, 0, 0, 4, 1, 0]);
  assert.equal(steady.speed, null);
});

test('flow ink cuts a packed x, y, z, time trace at until, the last segment ending on the crossing', () => {
  const samples = [0, 0, 0, 0, 1, 0, 0, 1, 2, 2, 0, 2, 3, 0, 0, 3];
  const [steady] = flowInkDraws([{ positions: samples, stride: 4, until: 1.25 }]);
  // Points at t 0 and 1 kept, then a quarter of the way from (1, 0) to (2, 2).
  assert.deepEqual(Array.from(steady.positions), [0, 0, 0, 1, 0, 0, 1, 0, 0, 1.25, 0.5, 0]);
  assert.equal(flowInkDraws([{ positions: samples, stride: 4, until: -1 }]).length, 0);
});

test('flow ink colours values through the OKLab ramp end to end and leaves value-free strokes their colour', () => {
  const [steady] = flowInkDraws(
    [{ positions: [0, 0, 0, 1, 0, 0], values: [0, 10] }, { positions: [0, 1, 0, 1, 1, 0] }],
    { colors: ['#000000', '#ffffff'], color: '#ff0000' },
  );
  const c = steady.colors;
  // First stroke: black to white, alpha 1.
  [0, 0, 0, 1].forEach((v, i) => close(c[i], v));
  [1, 1, 1, 1].forEach((v, i) => close(c[4 + i], v, 1e-5));
  // Second stroke: sRGB red in linear light.
  [1, 0, 0, 1].forEach((v, i) => close(c[8 + i], v));
});

test('flow ink sorts strokes into pulse bands by mean value, each at speed + speedPerValue * band centre', () => {
  const strokes = [
    { positions: [0, 0, 0, 1, 0, 0], values: [0, 0] },
    { positions: [0, 1, 0, 1, 1, 0], values: [10, 10] },
  ];
  const draws = flowInkDraws(strokes, { range: [0, 10], pulse: { bands: 2, speed: 1, speedPerValue: 0.1, length: 0.1, gap: 0.3 } });
  assert.equal(draws.length, 3);
  close(draws[1].speed, 1 + 0.1 * 2.5);
  close(draws[2].speed, 1 + 0.1 * 7.5);
  // The second stroke (index 1) leads with an invisible spacer of golden-ratio phase within the 0.4 period.
  const band = draws[2];
  close(band.positions[3] - band.positions[0], 0.6180339887498949 * 0.4);
  assert.deepEqual(Array.from(band.colors.slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  // Stroke 0 has phase 0: no spacer, its one segment only.
  assert.equal(draws[1].positions.length, 6);
});

test('flow ink highlights blend toward the highlight colour, the steady ink keeps the ramp', () => {
  const strokes = [{ positions: [0, 0, 0, 1, 0, 0], values: [0, 0] }];
  const [steady, pulse] = flowInkDraws(strokes, {
    colors: ['#000000', '#000000'],
    pulse: { highlight: '#ffffff', amount: 1, bands: 1 },
  });
  close(steady.colors[0], 0);
  close(pulse.colors[0], 1, 1e-5);
});

test('flow ink rejects malformed strokes and options with coded range errors', () => {
  assert.throws(() => flowInkDraws([{ positions: [0, 0] }]), RangeError);
  assert.throws(() => flowInkDraws([{ positions: [0, 0, 0, 1, 0, 0], values: [1] }]), RangeError);
  assert.throws(() => flowInkDraws([{ positions: [0, 0, 0, 1, 0, 0], until: 1 }]), RangeError);
  assert.throws(() => flowInkDraws([], { width: 0 }), RangeError);
  assert.throws(() => flowInkDraws([], { colors: ['#fff'] }), RangeError);
  assert.throws(() => flowInkDraws([], { pulse: { bands: 0 } }), RangeError);
  assert.throws(() => flowInkDraws([], { range: [2, 1] }), RangeError);
});

test('flow ink on an engine adds its own lines plugin, seeks its dashes and removes the plugin on dispose', async () => {
  const plugins = new Map();
  const engine = { use(plugin) { plugins.set(plugin.name, plugin); return this; }, removePlugin(name) { plugins.delete(name); } };
  const ink = await flowInk(engine, {
    pulse: { length: 0.1, gap: 0.3, speed: 1, bands: 1 },
    strokes: [{ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], values: [1, 2, 3] }],
  });
  assert.equal(plugins.size, 1);
  assert.equal(ink.draws, 2);
  assert.equal(ink.segments, 2);
  assert.deepEqual(ink.bounds, [0, 2, 0, 0, 0, 0]);
  const pulse = [...[...plugins.values()][0].lines].find((line) => line.material.dashed);
  ink.seek(0.25);
  close(pulse.material.dashOffset, -0.25);
  ink.seek(0.5);
  close(pulse.material.dashOffset, -0.1);
  ink.show(false);
  assert.ok([...[...plugins.values()][0].lines].every((line) => !line.visible));
  ink.dispose();
  assert.equal(plugins.size, 0);
  assert.throws(() => ink.seek(1), { code: 'disposed' });
});
