import assert from 'node:assert/strict';
import test from 'node:test';
import { Lines, Line } from '../dist/index.js';
import { FlowPath } from '../dist/flow.js';

const positions = [0, 0, 0, 0.25, 0, 0, 0.25, 0, 0, 10, 0, 0];

test('end fades use arc length and preserve a visible middle even with two input points', () => {
  const lines = new Lines();
  using _flow = new FlowPath(lines, { positions, startFade: 0.2, endFade: 0.2 });
  const [guide, pulse] = lines.lines;
  const profile = (line) => Array.from({ length: line.count }, (_, i) => [line.points[i * 4], line.colors[i * 4 + 3]]);
  const points = profile(pulse);
  assert.deepEqual(profile(guide), points);
  assert.deepEqual(points[0], [0, 0]);
  assert.deepEqual(points.at(-1), [10, 0]);
  for (const [x, alpha] of [
    [1, 0.5],
    [2, 1],
    [8, 1],
    [9, 0.5],
  ])
    assert(points.some(([p, a]) => p === x && a === alpha));
  assert.equal(points.filter(([x]) => x === 0.25).length, 1);

  const two = new Lines();
  using _span = new FlowPath(two, { positions: [0, 0, 0, 10, 0, 0], guideOpacity: 0 });
  assert.equal(two.lines.size, 1);
  assert(profile([...two.lines][0]).some(([, alpha]) => alpha === 1));
});

test('absolute seeks move dashes in both directions, gate opacity and reuse geometry', () => {
  const lines = new Lines();
  using flow = new FlowPath(lines, {
    positions,
    speed: 0.25,
    phase: 0.125,
    dashSize: 0.25,
    gapSize: 0.75,
    opacity: 0.8,
  });
  const [guide, pulse] = lines.lines;
  const initial = pulse.version;
  assert.equal(pulse.material.dashOffset, -0.125);
  flow.seek(2, 0.5);
  assert.equal(pulse.material.dashOffset, -0.625);
  assert.equal(pulse.material.opacity, 0.4);
  assert.equal(guide.material.opacity, 0.14);
  flow.seek(8, 0);
  assert(!guide.visible && !pulse.visible);
  flow.seek(2, 0.5);
  assert.equal(pulse.material.dashOffset, -0.625);
  assert(guide.visible && pulse.visible);
  flow.seek(-1);
  assert.equal(pulse.material.dashOffset, 0.125);
  assert.equal(pulse.version, initial);

  const reverse = new Lines();
  using back = new FlowPath(reverse, { positions, speed: -0.25, guideOpacity: 0, dashSize: 0.25, gapSize: 0.75 });
  back.seek(1);
  assert.equal([...reverse.lines][0].material.dashOffset, 0.25);
});

test('rejects invalid paths or time before changing the owning renderer', () => {
  const lines = new Lines();
  for (const options of [
    { positions: [0, 0, 0] },
    { positions: [0, 0, 0, 0, 0, 0] },
    { positions: [0, 0, 0, 1e39, 0, 0] },
    { positions, speed: NaN },
    { positions, dashSize: 0 },
    { positions, gapSize: -1 },
    { positions, startFade: 0.9, endFade: 0.2 },
    { positions, guideOpacity: -0.1 },
    { positions, width: 0 },
  ])
    assert.throws(() => new FlowPath(lines, options), RangeError);
  assert.equal(lines.lines.size, 0);

  const existing = lines.add(new Line());
  {
    using flow = new FlowPath(lines, { positions });
    assert.equal(lines.lines.size, 3);
    assert.throws(() => flow.seek(Infinity), RangeError);
    assert.throws(() => flow.seek(1, 1.1), RangeError);
  }
  assert.deepEqual([...lines.lines], [existing]);
});
